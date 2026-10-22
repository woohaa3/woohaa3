/**
 * Canvas Activity Relay（change: unify-canvas-session-websocket，任务 3.1 / 3.2 / 3.3 / design D4）。
 *
 * 每个**有 task-activity 订阅者**的 canvas 只运行一个 Task 增量读取循环，把已持久化的
 * 画布活动按单调 cursor 扇出到该 canvas 的所有 Canvas Session。这样把「N 个浏览器轮询」
 * 变成「每个活跃 canvas 一个 poller」，同时保留服务依赖方向：Task 只提供 durable 读取，
 * Canvas 主动拉取并负责浏览器扇出（Task 绝不回调 Canvas）。
 *
 * 关键语义：
 * - 首个订阅者启动循环，最后一个订阅者停止后允许关闭；
 * - **首个订阅者的 `after` 就是本 relay 的起点基线**：进入页面只补它之后的事实，
 *   不得把该 canvas 已持久化的历史记录当作新活动重放给订阅者；
 * - cursor 只在校验过响应后推进（不忙循环、不跳读）；
 * - 一次 tick 有工作上限，大 backlog 不会饿死 Yjs 流量；
 * - 追赶期间仍接收 live 广播，重复/乱序由前端幂等合并收敛。
 */
import type { CanvasTaskActivity, CanvasTaskActivityEventBatch } from "@woohaa3/contracts";

export type ActivityRelayOptions = {
  canvasId: string;
  /** 受认证的 Task 增量读取；cursor 单调。 */
  readChanges: (canvasId: string, after: number, limit?: number) => Promise<CanvasTaskActivityEventBatch>;
  /** 扇出一条已持久化记录（hub → 订阅会话）。 */
  onRecord: (canvasId: string, record: CanvasTaskActivity, cursor: number) => void;
  /** 订阅就绪时报告当前高水位（可选；用于 ready 消息）。 */
  onReady?: (canvasId: string, cursor: number) => void;
  /** 拉取间隔（毫秒，默认 1s，与旧浏览器事件流一致）。 */
  intervalMs?: number;
  /** 单次 Task 读取的页大小。 */
  pageSize?: number;
  /** 单次 tick 最多读取的页数（工作上限）。 */
  maxPagesPerTick?: number;
  /** 错误退避基数（毫秒）；实际延迟为 `base * attempt` 并夹住上限。 */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  logger?: (event: { event: string; canvasId: string; cursor?: number; code?: string }) => void;
  schedule?: (run: () => void, delayMs: number) => () => void;
};

export type CanvasActivityRelay = {
  readonly canvasId: string;
  /** 订阅者数量。 */
  subscriberCount(): number;
  /** 增加一个订阅者（携带 `after` cursor）；首个订阅者启动循环。 */
  subscribe(after: number): void;
  /** 减少一个订阅者；最后一个离开时停止循环。 */
  unsubscribe(): void;
  /** 停止循环（不等待在途 tick 完成）。 */
  stop(): void;
};

export type ActivityRelayRegistryOptions = Omit<ActivityRelayOptions, "canvasId">;

export type CanvasActivityRelayRegistry = {
  /** 为某 canvas 登记一个订阅并返回退订函数；首个订阅者懒启动该 canvas 的 relay。 */
  subscribe(canvasId: string, after: number): () => void;
  /** 当前活跃的 relay 数（测试/指标用）。 */
  activeRelayCount(): number;
  /** 某 canvas 的订阅者数（测试用）。 */
  subscriberCount(canvasId: string): number;
  /** 停止全部 relay（进程退出）。 */
  stopAll(): void;
};

/**
 * 每个 canvas 一个 relay 的注册表（ref-counted）。
 *
 * 最后一个订阅者离开时停止并移除该 canvas 的 relay，避免「最后连接释放后仍轮询」的泄漏。
 */
export function createCanvasActivityRelayRegistry(
  options: ActivityRelayRegistryOptions
): CanvasActivityRelayRegistry {
  const relays = new Map<string, CanvasActivityRelay>();

  return {
    subscribe(canvasId, after) {
      let relay = relays.get(canvasId);
      if (!relay) {
        relay = createCanvasActivityRelay({ ...options, canvasId });
        relays.set(canvasId, relay);
      }
      relay.subscribe(after);
      return () => {
        const current = relays.get(canvasId);
        if (!current) return;
        current.unsubscribe();
        if (current.subscriberCount() === 0) {
          current.stop();
          relays.delete(canvasId);
        }
      };
    },
    activeRelayCount: () => relays.size,
    subscriberCount: (canvasId) => relays.get(canvasId)?.subscriberCount() ?? 0,
    stopAll() {
      for (const relay of relays.values()) relay.stop();
      relays.clear();
    }
  };
}

const DEFAULT_OPTIONS = {
  intervalMs: 1_000,
  pageSize: 200,
  maxPagesPerTick: 5,
  backoffBaseMs: 500,
  backoffMaxMs: 10_000
} as const;

export function createCanvasActivityRelay(options: ActivityRelayOptions): CanvasActivityRelay {
  const canvasId = options.canvasId;
  const intervalMs = options.intervalMs ?? DEFAULT_OPTIONS.intervalMs;
  const pageSize = options.pageSize ?? DEFAULT_OPTIONS.pageSize;
  const maxPagesPerTick = options.maxPagesPerTick ?? DEFAULT_OPTIONS.maxPagesPerTick;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_OPTIONS.backoffBaseMs;
  const backoffMaxMs = options.backoffMaxMs ?? DEFAULT_OPTIONS.backoffMaxMs;
  const log = options.logger ?? (() => undefined);
  const schedule = options.schedule ?? ((run, delayMs) => {
    const handle = setTimeout(run, delayMs);
    return () => clearTimeout(handle);
  });

  let subscribers = 0;
  /** 已确认投递的高水位；只在校验响应后推进。也是本 relay 的起点基线。 */
  let cursor = 0;
  let running = false;
  let failureStreak = 0;
  let cancelScheduled: (() => void) | null = null;
  /**
   * 后加入订阅者的补课下限：只有它比 `cursor` 更旧时才有意义。
   *
   * 首个订阅者的 `after` 直接成为 `cursor`（基线），因此本 relay 永不从 0 回放该 canvas
   * 已持久化的历史；之后进来的订阅者若带更旧 cursor，才回退到它补齐中间事实。
   */
  let pendingFloor: number | null = null;

  const has = () => subscribers > 0;

  const scheduleTick = (delayMs: number) => {
    if (cancelScheduled || !running) return;
    cancelScheduled = schedule(() => {
      cancelScheduled = null;
      void tick();
    }, delayMs);
  };

  const tick = async (): Promise<void> => {
    if (!running) return;
    let pages = 0;
    let progressed = false;
    try {
      while (pages < maxPagesPerTick) {
        // 起点恒为「已确认高水位」，只有更旧订阅者存在时才回退到它的 cursor。
        const from = pendingFloor !== null && pendingFloor < cursor ? pendingFloor : cursor;
        const batch = await options.readChanges(canvasId, from, pageSize);
        // 校验通过后才推进（先投递再推进，投递本身同步且幂等）。
        for (const record of batch.items) {
          options.onRecord(canvasId, record, batch.cursor);
        }
        if (batch.cursor > cursor) {
          cursor = batch.cursor;
          progressed = true;
        }
        if (pendingFloor !== null && cursor >= pendingFloor) pendingFloor = null;
        pages += 1;
        // 未填满一页 → 已追平，停止本轮。
        if (batch.items.length < pageSize) break;
      }
      failureStreak = 0;
      void progressed;
      // 有订阅者时持续轮询（追平后为新记录保持活性）。
      if (running && has()) scheduleTick(intervalMs);
    } catch (error) {
      failureStreak += 1;
      const code = error instanceof Error ? error.name : "unavailable";
      log({ event: "activity-relay-error", canvasId, cursor, code });
      if (running && has()) {
        const delay = Math.min(backoffBaseMs * failureStreak, backoffMaxMs);
        scheduleTick(delay);
      }
    }
  };

  return {
    canvasId,
    subscriberCount: () => subscribers,
    subscribe(after) {
      // 首个订阅者定义基线：只补 `after` 之后的事实，不回放历史。
      if (subscribers === 0) {
        subscribers = 1;
        cursor = Math.max(0, after);
        pendingFloor = null;
        options.onReady?.(canvasId, cursor);
        running = true;
        log({ event: "activity-relay-start", canvasId, cursor: after });
        scheduleTick(0);
        return;
      }
      subscribers += 1;
      // 已有订阅者时，更旧的 cursor 才需要补课（较新的直接跟随当前高水位）。
      if (after < cursor) pendingFloor = pendingFloor === null ? after : Math.min(pendingFloor, after);
      options.onReady?.(canvasId, cursor);
    },
    unsubscribe() {
      subscribers = Math.max(0, subscribers - 1);
      if (subscribers === 0) {
        const lastCursor = cursor;
        running = false;
        cancelScheduled?.();
        cancelScheduled = null;
        // 无订阅者即丢弃基线：下次进入页面重新以当时的快照高水位为起点。
        cursor = 0;
        pendingFloor = null;
        log({ event: "activity-relay-stop", canvasId, cursor: lastCursor });
      }
    },
    stop() {
      subscribers = 0;
      cursor = 0;
      pendingFloor = null;
      running = false;
      cancelScheduled?.();
      cancelScheduled = null;
    }
  };
}
