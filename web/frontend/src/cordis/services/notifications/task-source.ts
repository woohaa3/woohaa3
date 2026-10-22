/**
 * 任务结果事实源（change: 2026-10-17-move-settings-into-canvas-dialog，任务 7.1/7.2 / design D8）。
 *
 * 只做**事实筛选**，不做呈现：把任务历史只读面（快照 watermark + 增量订阅）折叠成
 * 「本次新完成的成功/失败」，并负责首次基线、断线补偿、resync 与去重。
 *
 * 规则（对应 `task-notifications` 规格）：
 * - 首次快照中的终态只建基线，**不通知**；
 * - 基线之后**首次出现**的 succeeded/failed 可通知，不要求先观察到 running；
 * - 断线由 reader 自身按确认 cursor 续读；要求 resync 时重建基线，不遍历历史补发；
 * - 去重键为「数据范围 + taskKey + 执行轮次」，recordRevision 变化不算新完成；
 * - 排除主动取消、本地提交拒绝与过程进度。
 *
 * 纯逻辑：注入 reader 与时钟，便于无渲染回归。
 */
import type { TaskExecutionSummary, TaskHistoryPage } from "@woohaa3/contracts";
import type { TaskHistoryReader } from "../../../shared/task-history/client.js";

/** 一次可提醒的终态。 */
export type TaskResultEvent = {
  taskKey: string;
  state: "succeeded" | "failed";
  /** 权威执行轮次（缺失为 null）。 */
  attempt: number | null;
  /** 稳定跳转目标（不含 prompt/参数/媒体地址）。 */
  target: { taskKey: string; canvasId?: string; nodeId?: string };
  summary: TaskExecutionSummary;
};

export type TaskResultSourceStatus = {
  status: "idle" | "starting" | "live" | "unavailable";
  /** 安全原因（授权不足/读面不可用）；live 时为 null。 */
  reason: string | null;
};

export type TaskResultSource = {
  getStatus(): TaskResultSourceStatus;
  subscribe(listener: () => void): () => void;
  /** 启动：读一次快照建基线，再从水位订阅。幂等。 */
  start(): Promise<void>;
  /** 数据范围变化：释放旧订阅并为新范围重新建基线。 */
  restart(): Promise<void>;
  stop(): void;
  /** 已提醒的去重键数量（诊断/回归；有界）。 */
  trackedCount(): number;
};

const MAX_TRACKED = 512;
/** 首次快照只用于建基线；分页读取上限防止一次拉全库。 */
const BASELINE_PAGE_LIMIT = 200;
const MAX_BASELINE_PAGES = 5;

function isTerminalState(state: string): state is "succeeded" | "failed" {
  return state === "succeeded" || state === "failed";
}

/** 去重键：任务身份 + 执行轮次（缺失时退化为任务身份）。 */
function resultKey(scope: string, record: TaskExecutionSummary): string {
  const attempt = typeof record.attempt === "number" ? `#${record.attempt}` : "";
  return `${scope}\u0000${record.taskKey}${attempt}`;
}

/** 从摘要投影稳定目标；不复制 prompt/参数/媒体。 */
function targetOf(record: TaskExecutionSummary): TaskResultEvent["target"] {
  return {
    taskKey: record.taskKey,
    ...(record.canvasId ? { canvasId: record.canvasId } : {}),
    ...(record.nodeId ? { nodeId: record.nodeId } : {})
  };
}

export function createTaskResultSource(options: {
  /** 任务历史只读面（App scope 注入；不可用时服务显示 unavailable）。 */
  reader: TaskHistoryReader | null;
  /** 当前数据范围（实例/basePath/数据范围）；变化时必须重启。 */
  scope: () => string;
  /** 是否接受该记录（授权/主体过滤）。缺省接受全部。 */
  accept?: (record: TaskExecutionSummary) => boolean;
  /** 新终态回调（只在基线之后、去重通过时触发）。 */
  onResult: (event: TaskResultEvent) => void;
  logger?: (event: Record<string, unknown>) => void;
}): TaskResultSource {
  let status: TaskResultSourceStatus = options.reader
    ? { status: "idle", reason: null }
    : { status: "unavailable", reason: "任务历史读面不可用，通知暂不生效" };
  const listeners = new Set<() => void>();
  /** 已提醒的终态键（有界 FIFO）。 */
  const tracked = new Set<string>();
  /** 基线是否已建立（首次快照的终态不通知）。 */
  let baselined = false;
  let cursor = 0;
  let unsubscribe: (() => void) | null = null;
  let started = false;
  let disposed = false;
  let generation = 0;

  const publish = (next: TaskResultSourceStatus) => {
    if (disposed) return;
    if (status.status === next.status && status.reason === next.reason) return;
    status = next;
    for (const listener of listeners) listener();
  };

  const remember = (key: string) => {
    tracked.add(key);
    if (tracked.size > MAX_TRACKED) {
      // 有界：丢弃最早的一条（Set 保持插入顺序）。
      const oldest = tracked.values().next().value;
      if (oldest !== undefined) tracked.delete(oldest);
    }
  };

  const handleRecord = (record: TaskExecutionSummary, nextCursor: number) => {
    if (disposed) return;
    cursor = nextCursor;
    // 非终态（含 cancelled）不进入提醒；过程进度不产生事件。
    if (!isTerminalState(record.state)) return;
    if (options.accept && !options.accept(record)) return;
    const key = resultKey(options.scope(), record);
    // 首次基线：只记入去重集合，不通知（避免把存量历史当新完成）。
    if (!baselined) {
      remember(key);
      return;
    }
    if (tracked.has(key)) return;
    remember(key);
    options.onResult({
      taskKey: record.taskKey,
      state: record.state,
      attempt: typeof record.attempt === "number" ? record.attempt : null,
      target: targetOf(record),
      summary: record
    });
  };

  const readBaseline = async (run: number): Promise<boolean> => {
    const reader = options.reader;
    if (!reader) return false;
    let pageCursor: string | undefined;
    let watermark = 0;
    for (let page = 0; page < MAX_BASELINE_PAGES; page += 1) {
      const result: TaskHistoryPage = await reader.list({ limit: BASELINE_PAGE_LIMIT, ...(pageCursor ? { cursor: pageCursor } : {}) });
      if (disposed || run !== generation) return false;
      watermark = result.watermark;
      for (const record of result.items) {
        if (!isTerminalState(record.state)) continue;
        if (options.accept && !options.accept(record)) continue;
        remember(resultKey(options.scope(), record));
      }
      if (!result.nextCursor) break;
      pageCursor = result.nextCursor;
    }
    cursor = watermark;
    baselined = true;
    return true;
  };

  const subscribeFrom = (run: number) => {
    const reader = options.reader;
    if (!reader) return;
    unsubscribe?.();
    unsubscribe = reader.subscribe({
      cursor,
      onRecord: (record, nextCursor) => {
        if (disposed || run !== generation) return;
        publish({ status: "live", reason: null });
        handleRecord(record, nextCursor);
      },
      onStatus: (connection) => {
        if (disposed || run !== generation) return;
        if (connection.state === "offline") publish({ status: "live", reason: connection.error ?? null });
      },
      onResync: () => {
        if (disposed || run !== generation) return;
        // 水位失效：重建基线，禁止把存量历史当新完成。
        baselined = false;
        void establish(run);
      },
      onError: (error) => {
        options.logger?.({ event: "task-result-source-error", message: error instanceof Error ? error.message : String(error) });
      }
    });
  };

  const establish = async (run: number) => {
    try {
      const ok = await readBaseline(run);
      if (!ok || disposed || run !== generation) return;
      publish({ status: "live", reason: null });
      subscribeFrom(run);
    } catch (error) {
      if (disposed || run !== generation) return;
      // 授权不足/读面不可用：保留偏好可用，但明确不产生提醒。
      publish({
        status: "unavailable",
        reason: error instanceof Error && error.message ? error.message : "无法读取任务历史，通知暂不生效"
      });
    }
  };

  return {
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start() {
      if (disposed || started) return;
      started = true;
      const run = ++generation;
      if (!options.reader) {
        publish({ status: "unavailable", reason: "任务历史读面不可用，通知暂不生效" });
        return;
      }
      publish({ status: "starting", reason: null });
      await establish(run);
    },
    async restart() {
      if (disposed) return;
      // 数据范围切换：旧订阅、旧基线、旧去重键都不能带到新范围。
      generation += 1;
      unsubscribe?.();
      unsubscribe = null;
      tracked.clear();
      baselined = false;
      cursor = 0;
      started = true;
      const run = generation;
      if (!options.reader) {
        publish({ status: "unavailable", reason: "任务历史读面不可用，通知暂不生效" });
        return;
      }
      publish({ status: "starting", reason: null });
      await establish(run);
    },
    stop() {
      generation += 1;
      unsubscribe?.();
      unsubscribe = null;
      started = false;
    },
    trackedCount: () => tracked.size
  };
}
