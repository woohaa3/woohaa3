/**
 * 有界异步通道的真实生命周期计数
 * （change: 2026-10-23-scale-canvas-media-residency，design D2/D3/D8）。
 *
 * 关键区别（相对既有缺陷）：名额在**发出异步请求的函数返回时**不归还，只在任务真正终结
 * （完成、失败、超时、取消清理）后归还一次。不可中止的工作记为 `draining`，仍占在途预算，
 * 否则「先释放额度、旧任务继续占用」会启动同量新任务并突破上限。
 *
 * 队列按 purpose 优先级 + 原始排队年龄排序：同优先级里先排队的先执行，投影重置不会让尾部
 * 需求永久饥饿（design D3/D8）。
 */

export type LeaseState = "active" | "draining" | "released";

/** 一次准入的释放句柄；`settle` / `drain` 幂等。 */
export type ResidencyLease = {
  /** 唯一准入身份（诊断/测试）。 */
  readonly id: number;
  readonly channel: string;
  readonly purpose: string;
  /** 本次准入的 reservation 字节。 */
  readonly bytes: number;
  /** 当前状态；`draining` 表示结果已作废但底层工作仍不可中止，仍占在途名额。 */
  state(): LeaseState;
  /** 结束本次准入并归还名额（幂等）。 */
  settle(): void;
  /** 标记为 draining：结果作废，但名额保持占用直到底层工作真正终结。 */
  drain(): void;
  /** 取消令牌：撤销后不得再发布结果。 */
  readonly signal: AbortSignal;
  /** 主动取消；底层可中止时立即 settle，否则转 draining。 */
  cancel(): void;
};

export type ResidencyQueueOptions = {
  /** 并发上限。 */
  concurrency: number;
  /** 字节预算（reservation 上限）。 */
  byteBudget?: number;
  /**
   * 单帧字节额度（上传通道用）。
   *
   * 只有调用过 `beginFrame()` 的通道受逐帧额度约束；其它通道只受 `byteBudget` 约束。
   */
  perFrameBytes?: number;
  now?: () => number;
};

export type ResidencyRequest<T> = {
  /** 稳定内容身份；同 key 的在途任务合并为一份工作。 */
  key: string;
  /** 用途优先级（数值越小越优先）。 */
  purpose: string;
  /** 预计字节成本（reservation）；缺省 0。 */
  bytes?: number;
  /** 底层工作是否可中止；缺省 true。不可中止的任务取消后转 draining。 */
  abortable?: boolean;
  run: (context: { lease: ResidencyLease }) => Promise<T>;
};

export type ResidencyOutcome<T> =
  | { status: "settled"; value: T }
  | { status: "failed"; error: unknown }
  | { status: "cancelled" };

export type ResidencySnapshot = {
  channel: string;
  inFlight: number;
  pending: number;
  draining: number;
  reservedBytes: number;
  started: number;
  settled: number;
  cancelled: number;
  failed: number;
  merged: number;
  concurrency: number;
  /** 累计排队等待（ms，自入队到真正启动）。 */
  waitMsTotal: number;
  /** 最大单次排队等待（ms）。 */
  waitMsMax: number;
  /** 累计真正执行时长（ms，自启动到终结，含 draining）。 */
  execMsTotal: number;
  /** 最大单次执行时长（ms）。 */
  execMsMax: number;
};

type LeaseRecord = {
  id: number;
  channel: string;
  purpose: string;
  bytes: number;
  state: LeaseState;
  controller: AbortController;
  abortable: boolean;
};

type Pending<T> = {
  key: string;
  purpose: string;
  bytes: number;
  abortable: boolean;
  run: ResidencyRequest<T>["run"];
  seq: number;
  enqueuedAt: number;
  record: LeaseRecord | null;
  resolve: (outcome: ResidencyOutcome<T>) => void;
  followers: Array<(outcome: ResidencyOutcome<T>) => void>;
};

/**
 * 单通道准入队列。
 *
 * 调用方必须先 `admit()` 取得 lease，再创建媒体对象或启动准备；先准入再创建是 spec 的硬
 * 门禁，本类不创建任何媒体对象。
 */
export class ResidencyChannelQueue {
  private readonly pending: Pending<unknown>[] = [];
  private readonly inFlight = new Map<string, Pending<unknown>>();
  private readonly records = new Map<number, LeaseRecord>();
  private readonly concurrency: number;
  private readonly byteBudget: number;
  private readonly perFrameBytes: number | null;
  private readonly now: () => number;
  private seq = 0;
  private nextId = 1;
  private reservedBytes = 0;
  private frameBytesUsed = 0;
  private frameActive = false;
  private draining = 0;
  private started = 0;
  private settled = 0;
  private cancelled = 0;
  private failed = 0;
  private merged = 0;
  private waitMsTotal = 0;
  private waitMsMax = 0;
  private execMsTotal = 0;
  private execMsMax = 0;

  constructor(private readonly channel: string, options: ResidencyQueueOptions) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency));
    this.byteBudget = options.byteBudget ?? Number.POSITIVE_INFINITY;
    this.perFrameBytes = options.perFrameBytes ?? null;
    this.now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  }

  name(): string {
    return this.channel;
  }

  /** 提交一份需求；同 key 在途任务合并，只启动一份工作。 */
  admit<T>(request: ResidencyRequest<T>): Promise<ResidencyOutcome<T>> {
    const existing = this.inFlight.get(request.key) as Pending<T> | undefined;
    if (existing) {
      this.merged += 1;
      return new Promise<ResidencyOutcome<T>>((resolve) => existing.followers.push(resolve));
    }
    const pending: Pending<T> = {
      key: request.key,
      purpose: request.purpose,
      bytes: Math.max(0, request.bytes ?? 0),
      abortable: request.abortable ?? true,
      run: request.run,
      seq: ++this.seq,
      enqueuedAt: this.now(),
      record: null,
      resolve: () => undefined,
      followers: []
    };
    const promise = new Promise<ResidencyOutcome<T>>((resolve) => { pending.resolve = resolve; });
    const shared = pending as unknown as Pending<unknown>;
    this.inFlight.set(request.key, shared);
    this.pending.push(shared);
    this.pump();
    return promise;
  }

  /** 撤销某内容身份的等待与在途需求（删除/换源/失权/切画布）。 */
  cancelKey(key: string): void {
    const pending = this.inFlight.get(key);
    if (pending) {
      this.cancelled += 1;
      this.inFlight.delete(key);
      const record = pending.record;
      if (record) {
        record.controller.abort();
        if (record.abortable) this.settleRecord(record);
        else this.toDraining(record);
      }
      this.settlePending(pending, { status: "cancelled" });
    }
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index].key !== key) continue;
      const [removed] = this.pending.splice(index, 1);
      this.cancelled += 1;
      this.settlePending(removed, { status: "cancelled" });
    }
  }

  /** 撤销全部等待与在途需求。 */
  cancelAll(): void {
    for (const key of [...this.inFlight.keys()]) this.cancelKey(key);
    while (this.pending.length) {
      const removed = this.pending.shift()!;
      this.cancelled += 1;
      this.settlePending(removed, { status: "cancelled" });
    }
  }

  /** 逐帧额度重置（上传通道由帧前导调用；其它通道无需调用）。 */
  beginFrame(): void {
    if (this.perFrameBytes === null) return;
    this.frameActive = true;
    this.frameBytesUsed = 0;
  }

  inFlightCount(): number {
    return this.records.size;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  reserved(): number {
    return this.reservedBytes;
  }

  /** 是否已无任何等待或在途任务（含 draining）。 */
  idle(): boolean {
    return this.pending.length === 0 && this.records.size === 0;
  }

  snapshot(): ResidencySnapshot {
    return {
      channel: this.channel,
      inFlight: this.records.size,
      pending: this.pending.length,
      draining: this.draining,
      reservedBytes: this.reservedBytes,
      started: this.started,
      settled: this.settled,
      cancelled: this.cancelled,
      failed: this.failed,
      merged: this.merged,
      concurrency: this.concurrency,
      waitMsTotal: this.waitMsTotal,
      waitMsMax: this.waitMsMax,
      execMsTotal: this.execMsTotal,
      execMsMax: this.execMsMax
    };
  }

  private pump(): void {
    // 每轮按 purpose + 原始排队年龄选最高优先级需求；若它因 reservation 放不下，就找同队列里
    // 放得下且优先级不低于它的需求。同优先级仍严格按排队年龄，后来者不能插队。
    for (;;) {
      const index = this.pickNext();
      if (index < 0) return;
      let chosen = this.canStart(this.pending[index]) ? index : -1;
      if (chosen < 0) {
        const rank = purposeRankOf(this.pending[index].purpose);
        chosen = this.pending.findIndex(
          (entry, entryIndex) => entryIndex !== index
            && purposeRankOf(entry.purpose) <= rank
            && this.canStart(entry)
        );
      }
      if (chosen < 0) return;
      const [next] = this.pending.splice(chosen, 1);
      this.start(next);
    }
  }

  private start(pending: Pending<unknown>): void {
    const record: LeaseRecord = {
      id: this.nextId++,
      channel: this.channel,
      purpose: pending.purpose,
      bytes: pending.bytes,
      state: "active",
      controller: new AbortController(),
      abortable: pending.abortable
    };
    pending.record = record;
    this.records.set(record.id, record);
    this.reservedBytes += record.bytes;
    this.frameBytesUsed += record.bytes;
    this.started += 1;
    const startedAt = this.now();
    const waited = Math.max(0, startedAt - pending.enqueuedAt);
    this.waitMsTotal += waited;
    if (waited > this.waitMsMax) this.waitMsMax = waited;
    const lease = this.leaseFor(record);
    // 名额只在真实终结后归还：await 覆盖 run 返回的 promise，而非同步返回。
    void (async () => {
      let outcome: ResidencyOutcome<unknown>;
      try {
        const value = await pending.run({ lease });
        outcome = record.controller.signal.aborted ? { status: "cancelled" } : { status: "settled", value };
        if (outcome.status === "cancelled") this.cancelled += 1;
      } catch (error) {
        outcome = record.controller.signal.aborted
          ? { status: "cancelled" }
          : { status: "failed", error };
        if (outcome.status === "cancelled") this.cancelled += 1;
        else this.failed += 1;
      } finally {
        const elapsed = Math.max(0, this.now() - startedAt);
        this.execMsTotal += elapsed;
        if (elapsed > this.execMsMax) this.execMsMax = elapsed;
        this.settleRecord(record);
        if (this.inFlight.get(pending.key) === pending) this.inFlight.delete(pending.key);
      }
      this.settlePending(pending, outcome);
    })();
  }

  private settlePending(pending: Pending<unknown>, outcome: ResidencyOutcome<unknown>): void {
    pending.resolve(outcome);
    for (const follower of pending.followers) follower(outcome);
    pending.followers.length = 0;
  }

  private pickNext(): number {
    if (!this.pending.length) return -1;
    let best = 0;
    for (let index = 1; index < this.pending.length; index += 1) {
      const candidate = this.pending[index];
      const current = this.pending[best];
      const rankA = purposeRankOf(candidate.purpose);
      const rankB = purposeRankOf(current.purpose);
      if (rankA < rankB || (rankA === rankB && candidate.seq < current.seq)) best = index;
    }
    return best;
  }

  private canStart(pending: Pending<unknown>): boolean {
    if (this.records.size >= this.concurrency) return false;
    if (this.reservedBytes + pending.bytes > this.byteBudget) return false;
    if (this.frameActive && this.perFrameBytes !== null) {
      if (this.frameBytesUsed + pending.bytes > this.perFrameBytes) return false;
    }
    return true;
  }

  private leaseFor(record: LeaseRecord): ResidencyLease {
    return {
      id: record.id,
      channel: record.channel,
      purpose: record.purpose,
      bytes: record.bytes,
      state: () => record.state,
      settle: () => this.settleRecord(record),
      drain: () => this.toDraining(record),
      signal: record.controller.signal,
      cancel: () => {
        if (record.state === "released") return;
        record.controller.abort();
        if (record.abortable) this.settleRecord(record);
        else this.toDraining(record);
      }
    };
  }

  private toDraining(record: LeaseRecord): void {
    if (record.state !== "active") return;
    record.state = "draining";
    this.draining += 1;
  }

  private settleRecord(record: LeaseRecord): void {
    if (record.state === "released") return;
    if (record.state === "draining") this.draining = Math.max(0, this.draining - 1);
    record.state = "released";
    this.records.delete(record.id);
    this.reservedBytes = Math.max(0, this.reservedBytes - record.bytes);
    this.frameBytesUsed = Math.max(0, this.frameBytesUsed - record.bytes);
    this.settled += 1;
    this.pump();
  }
}

/** purpose → 优先级序号（与 policy.PURPOSE_RANK 一致；保持本模块无依赖）。 */
function purposeRankOf(purpose: string): number {
  switch (purpose) {
    case "interactive": return 0;
    case "visible": return 1;
    case "prefetch": return 2;
    case "warm": return 3;
    default: return 4;
  }
}

/** 便于测试与诊断：把当前毫秒时间作为排队年龄基准。 */
export function queueClockNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
