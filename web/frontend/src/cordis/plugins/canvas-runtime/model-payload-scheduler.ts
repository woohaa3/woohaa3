/**
 * 有界模型 payload 准备调度
 * （change: 2026-10-23-scale-canvas-media-residency，design D3 / 任务 6.1）。
 *
 * 为什么单独成模块：一次 `setScene` 会引用几十个模型，若在这一次同步调用里把它们全部派生
 * IR、装配 mesh 并上传，主线程片预算形同不存在。本调度器把「准备」变成**按帧有界**的队列：
 * 每帧最多推进 `concurrency` 项，且一旦累计耗时超过 `budgetMs` 就停到下一帧。
 *
 * 预算按**帧**结算，不是按 `drain()` 的调用次数：一次 `setScene` 内会先声明 descriptor、再按
 * lease 补准备，若每次调用各自重置预算，一次提交仍可能装配数十个模型。`beginFrame()` 只在
 * 每帧推进入口重置一次。
 *
 * 调度器不持有资源、不跨边界调用：`prepare` 由调用方注入，失败也只回调，不抛出到帧路径。
 */

export type ModelPayloadSchedulerOptions = {
  /** 时间源（宿主可注入 `performance.now`）。 */
  now: () => number;
  /** 单帧推进数量上限。 */
  concurrency: number;
  /** 单帧累计耗时预算（ms）。 */
  budgetMs: number;
  /** 该 key 是否已驻留（幂等跳过）。 */
  isResident: (key: string) => boolean;
  /** 该 key 是否有可准备的内容（没有就不入队，避免堆积无效项）。 */
  hasContent: (key: string) => boolean;
  /**
   * 当前需求集合；`null` 表示尚未收到需求投影（保守语义：引用即准备）。
   *
   * 投影后只有需求内的待办被保留，离屏内容不再补做无用重活。
   */
  wanted: () => ReadonlySet<string> | null;
  /** 真正执行一次准备；抛错由调度器隔离。 */
  prepare: (key: string) => void;
  /** 单项准备完成（含真实耗时，供超预算诊断）。 */
  onPrepared?: (key: string, costMs: number) => void;
  /** 单项准备失败（按内容隔离，不阻断其它模型）。 */
  onFailed?: (key: string, error: unknown) => void;
};

/** 单帧可推进的硬上界（注入值再大也不在一个帧内无限装配）。 */
const MAX_CONCURRENCY = 32;
/** 单帧耗时预算硬上界（ms）。 */
const MAX_BUDGET_MS = 1000;

export class ModelPayloadScheduler {
  private readonly options: ModelPayloadSchedulerOptions;
  private concurrency: number;
  private budgetMs: number;
  private startedThisFrame = 0;
  private deadline = 0;
  /** 待准备 key（按需求顺序）。 */
  private order: string[] = [];
  private readonly queued = new Set<string>();

  constructor(options: ModelPayloadSchedulerOptions) {
    this.options = options;
    this.concurrency = clampConcurrency(options.concurrency);
    this.budgetMs = clampBudget(options.budgetMs);
  }

  /** 开始推进一帧：重置本帧计数与截止时刻。 */
  beginFrame(): void {
    this.startedThisFrame = 0;
    this.deadline = this.options.now() + this.budgetMs;
  }

  /**
   * 由页面集中策略注入并发与片段预算（design D3：唯一来源）。
   *
   * 非法或越界值只收紧不放宽：`Infinity`/负数/NaN 一律忽略（保持当前值），合法值按硬上界
   * 截断，避免注入把一帧变成无界装配。
   */
  configure(input: { concurrency?: number; budgetMs?: number }): void {
    if (input.concurrency !== undefined && Number.isFinite(input.concurrency)) {
      this.concurrency = input.concurrency > 0 ? clampConcurrency(input.concurrency) : 1;
    }
    if (input.budgetMs !== undefined && Number.isFinite(input.budgetMs)) {
      this.budgetMs = input.budgetMs > 0 ? clampBudget(input.budgetMs) : 1;
    }
  }

  /** 当前生效预算（诊断/测试）。 */
  budget(): { concurrency: number; budgetMs: number } {
    return { concurrency: this.concurrency, budgetMs: this.budgetMs };
  }

  /** 待准备项数量（诊断/测试）。 */
  pendingCount(): number {
    return this.order.length;
  }

  /** 把单个内容身份加入队列（幂等；不立即准备）。 */
  enqueue(key: string): void {
    if (!key || this.queued.has(key) || this.options.isResident(key)) return;
    if (!this.options.hasContent(key)) return;
    this.queued.add(key);
    this.order.push(key);
  }

  /** 批量入队（当前需求）。 */
  enqueueAll(keys: Iterable<string>): void {
    for (const key of keys) this.enqueue(key);
  }

  /** 放弃已不在需求内的待办（离屏内容不在返回时补做重活）。 */
  cancelUnwanted(): void {
    const wanted = this.options.wanted();
    if (wanted === null || this.order.length === 0) return;
    this.order = this.order.filter((key) => wanted.has(key));
    for (const key of [...this.queued]) if (!this.order.includes(key)) this.queued.delete(key);
  }

  /**
   * 按本帧预算推进待办。
   *
   * 返回本帧实际启动的准备数（0 表示无待办或预算已用尽）。
   */
  drain(): number {
    let started = 0;
    while (this.order.length) {
      if (this.startedThisFrame >= this.concurrency) break;
      // 单项就可能超预算的工作仍允许各帧开一项（否则永远无法完成），但不会连续越界。
      if (this.startedThisFrame > 0 && this.options.now() >= this.deadline) break;
      const key = this.order.shift()!;
      if (!this.queued.delete(key) || this.options.isResident(key)) continue;
      this.runOne(key);
      this.startedThisFrame += 1;
      started += 1;
    }
    this.cancelUnwanted();
    return started;
  }

  private runOne(key: string): void {
    const startedAt = this.options.now();
    try {
      this.options.prepare(key);
      this.options.onPrepared?.(key, Math.max(0, this.options.now() - startedAt));
    } catch (error) {
      this.options.onFailed?.(key, error);
    }
  }
}

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(value)));
}

function clampBudget(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(MAX_BUDGET_MS, value);
}
