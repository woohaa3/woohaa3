/**
 * canvas room registry（任务 4.1 / 4.6 / design D1）。
 *
 * 按 canvasId 维护 room 实例、连接引用计数与空闲回收：
 * - 同 canvas 只有一个 room（因此同 room 命令天然串行）；
 * - 不同 canvas 各自独立 room（可并行）；
 * - 连接数归零后延迟回收，避免客户端短暂断开就丢弃已加载的文档。
 */
import type { MediaStorage } from "@woohaa3/contracts";
import type { ServerCanvas } from "@woohaa3/contracts";
import type { YjsDocumentRepository } from "./yjs-repository.js";
import { CanvasRoom, type RoomBroadcast } from "./room.js";

export type CanvasRoomRegistryOptions = {
  lifecycle?: import("@woohaa3/contracts").ManagedNodeLifecycleResolver;
  content?: import("@woohaa3/contracts").ContentContributionResolver;
  repository: YjsDocumentRepository;
  mediaStorage?: MediaStorage;
  now?: () => string;
  broadcast?: RoomBroadcast;
  verifyAssets?: boolean;
  /** 连接归零后回收 room 的延迟（毫秒）；0 表示立即回收。 */
  idleTtlMs?: number;
  /** 注入定时器（测试用同步驱动）。 */
  schedule?: (run: () => void, delayMs: number) => () => void;
  /** 新画布 bootstrap：Yjs 文档不存在时返回其规范聚合（见 `CanvasRoomOptions.bootstrap`）。 */
  bootstrap?: (canvasId: string) => Promise<ServerCanvas | null>;
  /** room epoch 生成器（测试用）。 */
  generateRoomEpoch?: () => string;
  /**
   * 命令 durable 成功后的观察者（change: 模型编辑历史）；
   * 透传给每个 `CanvasRoom`（见 `CanvasRoomOptions.onCommitted`）。
   */
  onCommitted?: (input: { canvasId: string; canvas: ServerCanvas; commands: readonly unknown[] }) => void;
  /**
   * room **第一次被客户端（浏览器会话）持有**时调用；返回值在 room 销毁时调用，
   * 用于挂接远端同步上游。
   *
   * 刻意不挂在「room 创建」上：任务对账、节点历史、片场转换这些**内部消费者**也会
   * `resolve()` 出 room（它们只读/写文档，不希望在无人观看时把整张画布推给远端）。
   * 2026-10-26 现场：启动期对账把三张「用户根本没打开」的画布都加载了，如果那时就挂
   * 上游，远端会看到三张画布同时「有变化」。只有真的有人在看，才值得同步。
   *
   * 语义是**粘性**的：一张画布在一次 room 生命周期内被打开过，就一直保持挂载，直到
   * room 被回收——这样「关掉标签页后后台任务刚出的结果」仍会推上去。
   */
  onClientAcquired?: (room: CanvasRoom) => (() => void) | void;
  /** 本地文档不存在时从远端同步上游取完整状态（见 `CanvasRoomOptions.seedFromUpstream`）。 */
  seedFromUpstream?: (canvasId: string) => Promise<Uint8Array | null>;
};

export type RoomLease = {
  room: CanvasRoom;
  canvasId: string;
  /** 释放该连接引用；归零后按 idleTtl 回收。 */
  release: () => void;
};

export class CanvasRoomRegistry {
  private readonly rooms = new Map<string, CanvasRoom>();
  private readonly refCounts = new Map<string, number>();
  private readonly pendingReclaim = new Map<string, () => void>();
  private readonly loadPromises = new Map<string, Promise<CanvasRoom>>();
  private readonly repository: YjsDocumentRepository;
  private readonly mediaStorage?: MediaStorage;
  private readonly now: () => string;
  private readonly broadcast: RoomBroadcast | undefined;
  private readonly verifyAssets: boolean;
  private readonly idleTtlMs: number;
  private readonly schedule: (run: () => void, delayMs: number) => () => void;
  private readonly bootstrap: ((canvasId: string) => Promise<ServerCanvas | null>) | undefined;
  private readonly generateRoomEpoch: (() => string) | undefined;
  private readonly onCommitted: ((input: { canvasId: string; canvas: ServerCanvas; commands: readonly unknown[] }) => void) | undefined;
  private readonly onClientAcquired: CanvasRoomRegistryOptions["onClientAcquired"];
  private readonly seedFromUpstream: CanvasRoomRegistryOptions["seedFromUpstream"];
  private readonly roomDetachers = new Map<string, () => void>();

  private readonly lifecycle: import("@woohaa3/contracts").ManagedNodeLifecycleResolver | undefined;
  private readonly content: import("@woohaa3/contracts").ContentContributionResolver | undefined;
  constructor(options: CanvasRoomRegistryOptions) {
    this.lifecycle = options.lifecycle;
    this.content = options.content;
    this.repository = options.repository;
    this.mediaStorage = options.mediaStorage;
    this.now = options.now ?? (() => new Date().toISOString());
    this.broadcast = options.broadcast;
    this.verifyAssets = options.verifyAssets ?? true;
    this.idleTtlMs = options.idleTtlMs ?? 30_000;
    this.bootstrap = options.bootstrap;
    this.generateRoomEpoch = options.generateRoomEpoch;
    this.onCommitted = options.onCommitted;
    this.onClientAcquired = options.onClientAcquired;
    this.seedFromUpstream = options.seedFromUpstream;
    this.schedule = options.schedule ?? ((run, delayMs) => {
      const handle = setTimeout(run, delayMs);
      return () => clearTimeout(handle);
    });
  }

  /** 当前活跃 room 数（测试/指标用）。 */
  get size(): number {
    return this.rooms.size;
  }

  /** 某 room 的引用计数（测试用）。 */
  refCount(canvasId: string): number {
    return this.refCounts.get(canvasId) ?? 0;
  }

  /**
   * 获取（或加载）room 并占用一个连接引用。
   *
   * 同 canvas 的并发 acquire 共享同一次加载（`loadPromises` 去重），避免重复恢复同一文档。
   */
  async acquire(canvasId: string): Promise<RoomLease> {
    const room = await this.loadRoom(canvasId);
    const previousCount = this.refCounts.get(canvasId) ?? 0;
    this.refCounts.set(canvasId, previousCount + 1);
    // 第一个客户端持有 = 真的有人在看这张画布：这时才挂远端同步上游。
    // 同一 room 生命周期内只挂一次（粘性），release 到 0 也不拆——room 回收时才拆。
    if (previousCount === 0 && !this.roomDetachers.has(canvasId)) {
      const detach = this.onClientAcquired?.(room);
      if (detach) this.roomDetachers.set(canvasId, detach);
    }
    // 有连接了：取消待回收。
    const cancel = this.pendingReclaim.get(canvasId);
    if (cancel) {
      cancel();
      this.pendingReclaim.delete(canvasId);
    }

    let released = false;
    return {
      room,
      canvasId,
      release: () => {
        if (released) return;
        released = true;
        const next = Math.max(0, (this.refCounts.get(canvasId) ?? 1) - 1);
        this.refCounts.set(canvasId, next);
        if (next === 0) this.scheduleReclaim(canvasId);
      }
    };
  }

  /** 热获取已加载 room；不存在返回 null（不触发加载）。 */
  peek(canvasId: string): CanvasRoom | null {
    return this.rooms.get(canvasId) ?? null;
  }

  /**
   * 获取 room 但**不占用连接引用**（供内部 projector/run 使用）。
   *
   * 与 `acquire` 的差别：不增加 refCount，因此不会因为内部调用就把 room 钉在内存里；
   * 空闲回收仍按真实连接数进行。回收后再次调用会重新加载。
   */
  async resolve(canvasId: string): Promise<CanvasRoom> {
    return this.loadRoom(canvasId);
  }

  /** 显式销毁 room（切换/回滚时使用）。 */
  async destroy(canvasId: string): Promise<void> {
    const cancel = this.pendingReclaim.get(canvasId);
    if (cancel) {
      cancel();
      this.pendingReclaim.delete(canvasId);
    }
    this.roomDetachers.get(canvasId)?.();
    this.roomDetachers.delete(canvasId);
    const room = this.rooms.get(canvasId);
    room?.dispose();
    this.rooms.delete(canvasId);
    this.refCounts.delete(canvasId);
    this.loadPromises.delete(canvasId);
  }

  /** 销毁全部 room（进程退出）。 */
  async destroyAll(): Promise<void> {
    for (const canvasId of [...this.rooms.keys()]) {
      await this.destroy(canvasId);
    }
  }

  private async loadRoom(canvasId: string): Promise<CanvasRoom> {
    const existing = this.rooms.get(canvasId);
    if (existing) return existing;

    const inFlight = this.loadPromises.get(canvasId);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const room = new CanvasRoom({
        canvasId,
        repository: this.repository,
        mediaStorage: this.mediaStorage,
        now: this.now,
        broadcast: this.broadcast,
        verifyAssets: this.verifyAssets,
      lifecycle: this.lifecycle,
        ...(this.content ? { content: this.content } : {}),
        ...(this.bootstrap ? { bootstrap: () => this.bootstrap!(canvasId) } : {}),
        ...(this.seedFromUpstream ? { seedFromUpstream: () => this.seedFromUpstream!(canvasId) } : {}),
        ...(this.generateRoomEpoch ? { generateRoomEpoch: this.generateRoomEpoch } : {}),
        ...(this.onCommitted
          ? {
              onCommitted: (input: { canvas: ServerCanvas; commands: readonly unknown[] }) =>
                this.onCommitted!({ canvasId, ...input })
            }
          : {})
      });
      const loaded = await room.load();
      if (!loaded.ok) {
        // 加载失败仍放入 map（quarantined 状态），以便诊断可被观察；
        // 但它不会接受写入。
        this.rooms.set(canvasId, room);
        return room;
      }
      // 只创建，不挂上游：内部消费者（对账/历史/转换）也会走到这里。
      this.rooms.set(canvasId, room);
      return room;
    })();

    this.loadPromises.set(canvasId, promise);
    try {
      return await promise;
    } finally {
      this.loadPromises.delete(canvasId);
    }
  }

  private scheduleReclaim(canvasId: string): void {
    if (this.idleTtlMs <= 0) {
      void this.destroy(canvasId);
      return;
    }
    const cancel = this.schedule(() => {
      this.pendingReclaim.delete(canvasId);
      // 回收前再确认无人引用（期间可能又来了连接）。
      if ((this.refCounts.get(canvasId) ?? 0) === 0) void this.destroy(canvasId);
    }, this.idleTtlMs);
    this.pendingReclaim.set(canvasId, cancel);
  }
}
