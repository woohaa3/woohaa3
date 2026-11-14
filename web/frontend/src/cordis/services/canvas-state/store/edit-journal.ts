/**
 * 页面级 Edit Journal
 * （change: 2026-10-09-improve-canvas-workflow，任务 1.5 / design D5.1；
 *  change: 2026-11-06-nonblocking-canvas-edit-history，design D1–D7）。
 *
 * 记录画布结构与本地参数动作，提供撤销/重做、冲突检测与跳过。
 *
 * 关键不变量：
 * - 结构动作**入队即返回**，不再以“上一条命令未结算”拒绝后续动作；
 * - 队列按用户提交顺序单飞 drain：前一条 settled 后才发下一条；
 * - 每条记录独立维护 `pending / committed / conflict / dropped / unknown`；
 *   只有 committed 且有净变化的记录进入正式撤销栈；
 * - forward/inverse 在入队时基于调用方给出的 workingCanvas 规划，commandId 入队即固定；
 * - 断线/只读/宿主重连时把在途记录标为 `unknown`、停止 drain，保留 working effect 与队列；
 *   重连后按 canonical 后置条件对账，必要时用**原 commandId 与原 payload** 重发；
 * - 迟到 rejected/failed 回滚对应 working effect（由会话负责），并把依赖同一实体的后续记录
 *   标为 conflict，不静默保留错误结果；
 * - 冲突记录不自动跳过，用户显式“跳过此记录”后才移除阻塞项；
 * - 响应丢失重试沿用同一 commandId；同一 commandId 只对应一个 payload；
 * - 新净修改成功后清空 redo；失败/no-op 不清空；
 * - 有界：正式历史最多 100 条、合计 16 MiB；pending 队列独立限制 32 条 / 4 MiB。
 *
 * 本模块是纯逻辑：命令提交通过注入的 `submit` 回调完成，便于单测无 DOM/Yjs。
 */
import {
  buildJournalSnapshot,
  EDIT_JOURNAL_MAX_BYTES,
  EDIT_JOURNAL_MAX_ENTRIES,
  EDIT_JOURNAL_MAX_PENDING_BYTES,
  EDIT_JOURNAL_MAX_PENDING_ENTRIES,
  EDIT_JOURNAL_SETTLEMENT_HINT_MS,
  editNodeIds,
  estimateBytes,
  INTERRUPTED,
  type CanvasJournalEntry,
  type EditJournalDependencies,
  type EditJournalSnapshot,
  type ExternalJournalEntry,
  type ExternalJournalOutcome,
  type JournalConnectionState,
  type JournalEntry,
  type JournalHandlers,
  type JournalPlannedEdit,
  type JournalSettleOutcome,
  type JournalTask,
  type JournalTaskDirection,
  type ParameterJournalEntry,
  type PendingRecord
} from "./edit-journal-model.js";

export * from "./edit-journal-model.js";

export class EditJournal {
  private readonly entries: JournalEntry[] = [];
  private readonly pendingRecords: PendingRecord[] = [];
  private queue: JournalTask[] = [];
  private readonly deps: EditJournalDependencies;
  /** 栈指针：entries[0..undoCursor] 可撤销；>undoCursor 为 redo 区。 */
  private undoCursor = -1;
  private currentBytes = 0;
  /** 仅长操作采纳（外部权威回执）互斥，不再作为用户入口门禁。 */
  private adopting = false;
  /** Prevent overlapping asynchronous replays from targeting the same cursor. */
  private replaying = false;
  private generation = 0;
  private connection: JournalConnectionState = "ready";
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private activeTask: JournalTask | null = null;
  private interruptWaiter: (() => void) | null = null;
  /** 结算通道可疑（watchdog 触发）时暂停自动重发；连接恢复或定时探测后继续。 */
  private paused = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private readonly maxPendingEntries: number;
  private readonly maxPendingBytes: number;

  constructor(deps: EditJournalDependencies) {
    this.deps = deps;
    this.connection = deps.connectionState?.() ?? "ready";
    this.maxPendingEntries = deps.maxPendingEntries ?? EDIT_JOURNAL_MAX_PENDING_ENTRIES;
    this.maxPendingBytes = deps.maxPendingBytes ?? EDIT_JOURNAL_MAX_PENDING_BYTES;
  }

  async adoptExternal(id: string, run: () => Promise<{ ok: true; label: string; forward: JournalPlannedEdit; inverse: JournalPlannedEdit; allowNew?: boolean } | { ok: false; reason: string }>): Promise<{ ok: true; entry: CanvasJournalEntry } | { ok: false; reason: string }> {
    if (this.adopting) return { ok: false, reason: "正在结算上一次操作，请稍候" };
    if (!this.deps.isWritable()) return { ok: false, reason: "当前不可写，无法记录操作" };
    if (id.length > 256) return { ok: false, reason: "操作身份过长" };
    const generation = this.generation;
    this.adopting = true;
    try {
      const result = await run();
      if (generation !== this.generation) return { ok: false, reason: "页面已切换" };
      if (!result.ok) return result;
      if (!this.deps.isWritable()) return { ok: false, reason: "当前不可写，无法记录操作" };
      const existing = this.entries.find((entry): entry is CanvasJournalEntry => entry.kind === "canvas" && entry.id === id);
      if (existing) return { ok: true, entry: existing };
      if (result.allowNew === false) return { ok: false, reason: "该操作已不在撤销历史中" };
      if (estimateBytes(result.forward) + estimateBytes(result.inverse) > EDIT_JOURNAL_MAX_BYTES) return { ok: false, reason: "操作内容过多，请分批处理" };
      const entry: CanvasJournalEntry = { kind: "canvas", id, label: result.label, forward: result.forward, inverse: result.inverse, state: "committed" };
      this.pushCommitted(entry);
      this.notify();
      return { ok: true, entry };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "操作失败" };
    } finally {
      if (generation === this.generation) this.adopting = false;
    }
  }

  /**
   * Adopt an already-verified authoritative action into the same undo timeline.
   *
   * The caller must have checked the authoritative receipt/canonical result first.
   * Nothing is submitted here; the stored callbacks re-run the authority's own
   * undo/redo operation. Duplicate ids are idempotent, matching `adoptExternal`.
   */
  recordExternal(input: {
    id: string;
    label: string;
    revision?: number;
    undo: () => Promise<ExternalJournalOutcome>;
    redo: () => Promise<ExternalJournalOutcome>;
  }): { ok: true; entry: ExternalJournalEntry } | { ok: false; reason: string } {
    if (!this.deps.isWritable()) return { ok: false, reason: "当前不可写，无法记录操作" };
    if (!input.id || input.id.length > 256) return { ok: false, reason: "操作身份无效" };
    const existing = this.entries.find((entry): entry is ExternalJournalEntry => entry.kind === "external" && entry.id === input.id);
    if (existing) return { ok: true, entry: existing };
    const entry: ExternalJournalEntry = {
      kind: "external",
      id: input.id,
      label: input.label,
      ...(input.revision !== undefined ? { revision: input.revision } : {}),
      undo: input.undo,
      redo: input.redo,
      state: "committed"
    };
    this.pushCommitted(entry);
    this.notify();
    return { ok: true, entry };
  }

  /**
   * 提交一个用户结构动作：本地校验通过后**立即入队并返回**，不等待网络结算。
   *
   * 返回 `ok:false` 时表示该动作没能进入队列（只读、载荷超限、队列背压），
   * 不产生可撤销记录。入队成功的记录随后由后台单飞 drain 结算。
   */
  async recordAndSubmit(input: {
    label: string;
    id?: string;
    /** 调用方需要固定 wire commandId 时传入；省略时按 entry id 生成。 */
    commandId?: string;
    forward: JournalPlannedEdit;
    inverse: JournalPlannedEdit;
  }): Promise<{ ok: true; entry: CanvasJournalEntry } | { ok: false; reason: string; code?: string }> {
    if (!this.deps.isWritable()) return { ok: false, reason: "当前不可写，无法记录操作", code: "not-writable" };

    const estimated = estimateBytes(input.forward) + estimateBytes(input.inverse);
    if (estimated > EDIT_JOURNAL_MAX_BYTES) {
      return { ok: false, reason: "操作内容过多，请分批处理", code: "payload-too-large" };
    }
    if (
      this.pendingRecords.length >= this.maxPendingEntries
      || this.pendingBytes() + estimated > this.maxPendingBytes
    ) {
      return { ok: false, reason: "等待保存的操作过多，请稍候", code: "journal-full" };
    }

    const id = input.id ?? this.generateId();
    const commandId = input.commandId ?? `edit-forward:${id}`;
    const entry: CanvasJournalEntry = {
      kind: "canvas",
      id,
      label: input.label,
      commandId,
      forward: input.forward,
      inverse: input.inverse,
      state: "pending"
    };
    const record: PendingRecord = {
      entry,
      commandId,
      bytes: estimated,
      enqueuedAt: this.now(),
      submittedAt: null,
      slow: false,
      undoRequested: false,
      redoRequested: false,
      error: null
    };
    this.pendingRecords.push(record);
    this.queue.push({
      direction: "forward",
      commandId,
      entry,
      edit: input.forward,
      record,
      state: "queued",
      settled: false,
      slow: false,
      startedAt: null
    });
    this.notify();
    this.scheduleDrain();
    return { ok: true, entry };
  }

  /**
   * 记录一个本地参数动作（task 1.6）。参数条目不经服务端；只校验分区仍符合预期。
   *
   * 同一 `{nodeId, modelKey}` 分区的连续变更合并为一条记录：拖动滑块时 `after` 持续更新，
   * `before` 保持手势开始时值，直至其它动作打断（等价于「一次手势一次撤销」）。
   */
  recordParameter(input: {
    label: string;
    nodeId: string;
    modelKey: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    revision?: number;
  }): void {
    // pending 结构动作尚未确认时不插入本地参数记录：否则参数会排到更早的结构动作之前，
    // 撤销顺序与实际操作顺序相反（旧实现用全局 busy 同样拒绝）。
    if (this.pendingRecords.length > 0) return;
    const top = this.entries[this.undoCursor];
    if (
      top?.kind === "parameter"
      && this.undoCursor === this.entries.length - 1
      && top.nodeId === input.nodeId
      && top.modelKey === input.modelKey
      && top.revision === input.revision
    ) {
      top.after = { ...input.after };
      this.currentBytes = this.entries.reduce((sum, entry) => sum + estimateBytes(entry), 0);
      this.enforceCapacity();
      this.notify();
      return;
    }
    const entry: ParameterJournalEntry = {
      kind: "parameter",
      id: this.generateId(),
      label: input.label,
      nodeId: input.nodeId,
      modelKey: input.modelKey,
      before: { ...input.before },
      after: { ...input.after },
      ...(input.revision !== undefined ? { revision: input.revision } : {}),
      state: "committed"
    };
    this.pushCommitted(entry);
    this.notify();
  }

  /**
   * 撤销栈顶记录。
   *
   * - pending 记录：把反向动作排在该正向动作之后（FIFO 队列），历史指针不动；
   * - 已 committed 画布记录：同样经受保护命令队列提交反向动作，确认后才移动指针；
   * - 参数/外部权威记录：即时回放，成功后才移动指针。
   *
   * 不要求全局空闲：drain 正在处理其它命令时也可以入队撤销。
   */
  async undo(handlers: JournalHandlers): Promise<{ ok: true; entry: JournalEntry } | { ok: false; reason: string }> {
    if (this.replaying) return { ok: false, reason: "撤销或重做尚未确认，请稍候" };
    const lastPending = this.pendingRecords[this.pendingRecords.length - 1];
    if (lastPending) {
      if (lastPending.entry.state === "conflict") {
        return { ok: false, reason: "该操作已被其他修改影响，无法撤销，请先跳过此记录" };
      }
      if (lastPending.undoRequested) return { ok: false, reason: "撤销尚未确认，请稍候" };
      lastPending.undoRequested = true;
      this.enqueueTask(lastPending, "undo", lastPending.entry.inverse, `edit-undo:${lastPending.entry.id}:${this.nextSeq()}`);
      this.notify();
      this.scheduleDrain();
      return { ok: true, entry: lastPending.entry };
    }

    const index = this.undoCursor;
    if (index < 0) return { ok: false, reason: "没有可撤销的操作" };
    const entry = this.entries[index]!;
    if (entry.state === "conflict") {
      return { ok: false, reason: "该操作已被其他修改影响，无法撤销，请先跳过此记录" };
    }
    if (entry.kind === "canvas") {
      if (entry.undoPending) return { ok: false, reason: "撤销尚未确认，请稍候" };
      entry.undoPending = true;
      this.enqueueTask(null, "undo", entry.inverse, `edit-undo:${entry.id}:${this.nextSeq()}`, entry);
      this.notify();
      this.scheduleDrain();
      return { ok: true, entry };
    }
    const generation = this.generation;
    this.replaying = true;
    let result: Awaited<ReturnType<JournalHandlers["apply"]>>;
    try {
      result = await handlers.apply(entry, -1);
    } finally {
      if (generation === this.generation) this.replaying = false;
    }
    if (generation !== this.generation) return { ok: false, reason: "页面已切换" };
    if (!result.ok) {
      // 指针保持不变；冲突标记由 handler 负责。
      return { ok: false, reason: result.reason };
    }
    const observed = entry.kind === "parameter" ? this.deps.currentRevision?.() : undefined;
    entry.undoRevision = result.revision ?? (observed === undefined ? undefined : observed + 0.5);
    this.finishUndo(entry);
    this.notify();
    return { ok: true, entry };
  }

  async redo(handlers: JournalHandlers): Promise<{ ok: true; entry: JournalEntry } | { ok: false; reason: string }> {
    if (this.replaying) return { ok: false, reason: "撤销或重做尚未确认，请稍候" };
    const lastPending = this.pendingRecords[this.pendingRecords.length - 1];
    if (lastPending) {
      if (lastPending.entry.state === "conflict") {
        return { ok: false, reason: "该操作已被其他修改影响，无法重做，请先跳过此记录" };
      }
      if (!lastPending.undoRequested) return { ok: false, reason: "没有可重做的操作" };
      if (lastPending.redoRequested) return { ok: false, reason: "重做尚未确认，请稍候" };
      lastPending.redoRequested = true;
      this.enqueueTask(lastPending, "redo", lastPending.entry.forward, `edit-redo:${lastPending.entry.id}:${this.nextSeq()}`);
      this.notify();
      this.scheduleDrain();
      return { ok: true, entry: lastPending.entry };
    }

    const index = this.undoCursor + 1;
    if (index >= this.entries.length) return { ok: false, reason: "没有可重做的操作" };
    const entry = this.entries[index]!;
    if (entry.state === "conflict") {
      return { ok: false, reason: "该操作已被其他修改影响，无法重做，请先跳过此记录" };
    }
    if (entry.kind === "canvas") {
      if (entry.redoPending) return { ok: false, reason: "重做尚未确认，请稍候" };
      entry.redoPending = true;
      this.enqueueTask(null, "redo", entry.forward, `edit-redo:${entry.id}:${this.nextSeq()}`, entry);
      this.notify();
      this.scheduleDrain();
      return { ok: true, entry };
    }
    const generation = this.generation;
    this.replaying = true;
    let result: Awaited<ReturnType<JournalHandlers["apply"]>>;
    try {
      result = await handlers.apply(entry, 1);
    } finally {
      if (generation === this.generation) this.replaying = false;
    }
    if (!result.ok) return { ok: false, reason: result.reason };
    if (generation !== this.generation) return { ok: false, reason: "页面已切换" };
    const observed = entry.kind === "parameter" ? this.deps.currentRevision?.() : undefined;
    this.finishRedo(entry, result.revision ?? (observed === undefined ? undefined : observed + 0.5));
    this.notify();
    return { ok: true, entry };
  }

  /** 显式跳过一条冲突记录（移除阻塞项，不自动撤销更早记录）。 */
  skipConflict(entryId: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === entryId && entry.state === "conflict");
    if (index >= 0) {
      // 被跳过的记录从栈中移除；若位于 redo 区则一并裁剪。
      this.entries.splice(index, 1);
      this.currentBytes = this.entries.reduce((sum, entry) => sum + estimateBytes(entry), 0);
      if (index <= this.undoCursor) this.undoCursor -= 1;
      this.notify();
      return true;
    }
    const pendingIndex = this.pendingRecords.findIndex((record) => record.entry.id === entryId && record.entry.state === "conflict");
    if (pendingIndex < 0) return false;
    const [record] = this.pendingRecords.splice(pendingIndex, 1);
    if (!record) return false;
    this.dropTasksForRecord(record);
    this.notify();
    this.scheduleDrain();
    return true;
  }

  /** 标记一条记录为冲突（handler 在撤销被权威拒绝时调用）。 */
  markConflict(entryId: string): void {
    const entry = this.entries.find((candidate) => candidate.id === entryId);
    if (entry) {
      entry.state = "conflict";
      this.notify();
      return;
    }
    const pending = this.pendingRecords.find((record) => record.entry.id === entryId);
    if (pending) {
      pending.entry.state = "conflict";
      this.notify();
    }
  }

  /**
   * 同步连接状态。
   *
   * `interrupted`：把当前在途记录标为 unknown、停止 drain，保留队列与 working effect；
   * `ready`：恢复 drain，对 unknown 记录按 canonical 后置条件对账后重发。
   */
  notifyConnection(state: JournalConnectionState): void {
    if (state === this.connection) return;
    this.connection = state;
    if (state === "interrupted") {
      const active = this.activeTask;
      if (active && !active.settled) this.markUnknown(active);
      this.interruptWaiter?.();
    } else if (state === "ready") {
      this.resumeDrain();
    }
    this.notify();
  }

  /** 等待当前 drain 收敛（测试/诊断用；断线暂停时立即返回）。 */
  async flush(): Promise<void> {
    for (let guard = 0; this.draining && guard < 1_000; guard += 1) await this.drainPromise;
  }

  snapshot(): EditJournalSnapshot {
    return buildJournalSnapshot({
      entries: this.entries,
      pendingRecords: this.pendingRecords,
      undoCursor: this.undoCursor,
      bytes: this.currentBytes,
      pendingBytes: this.pendingBytes()
    });
  }

  /** 清空（切画布 / 刷新 / page dispose）。 */
  clear(): void {
    this.generation += 1;
    this.entries.length = 0;
    this.pendingRecords.length = 0;
    this.queue = [];
    this.undoCursor = -1;
    this.currentBytes = 0;
    this.adopting = false;
    this.replaying = false;
    this.activeTask = null;
    this.draining = false;
    this.drainPromise = null;
    this.paused = false;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.interruptWaiter?.();
    this.interruptWaiter = null;
    this.notify();
  }

  get size(): number { return this.entries.length; }

  get pendingSize(): number { return this.pendingRecords.length; }

  private enqueueTask(
    record: PendingRecord | null,
    direction: JournalTaskDirection,
    edit: JournalPlannedEdit,
    commandId: string,
    entry?: CanvasJournalEntry
  ): void {
    this.queue.push({
      direction,
      commandId,
      entry: entry ?? record!.entry,
      edit,
      record,
      state: "queued",
      settled: false,
      slow: false,
      startedAt: null
    });
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    if (this.paused) return;
    if (this.connection === "interrupted") return;
    if (!this.queue.some((task) => !task.settled && task.state !== "done")) return;
    this.draining = true;
    const generation = this.generation;
    const promise = this.drain(generation).finally(() => {
      if (generation !== this.generation) {
        this.draining = false;
        this.drainPromise = null;
        return;
      }
      this.draining = false;
      this.drainPromise = null;
      if (!this.paused && this.connection !== "interrupted" && this.queue.some((task) => !task.settled && task.state !== "done")) {
        this.scheduleDrain();
      }
    });
    this.drainPromise = promise;
  }

  /** 连接恢复/定时探测后继续 drain（清掉 watchdog 暂停）。 */
  private resumeDrain(): void {
    this.paused = false;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.scheduleDrain();
  }

  /** 暂停自动重发并在一个提示周期后再探测，避免等待通道失效时忙等。 */
  private pauseForRetry(): void {
    this.paused = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    const hintMs = this.deps.settlementHintMs ?? EDIT_JOURNAL_SETTLEMENT_HINT_MS;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.paused = false;
      this.scheduleDrain();
    }, hintMs);
  }

  /**
   * 单飞 drain：一次只提交队首命令，settled 后再发下一条。
   *
   * 断线/超时只把当前记录标为 unknown 并停止等待，不伪造终态；重连后由
   * `observe()` 对账，必要时用原 commandId 重发。
   */
  private async drain(generation: number): Promise<void> {
    while (this.queue.length > 0) {
      if (generation !== this.generation) return;
      if (this.connection === "interrupted") return;
      const task = this.queue[0]!;
      if (task.settled || task.state === "done") {
        this.queue.shift();
        continue;
      }
      if (task.state === "unknown") {
        const observed = this.observe(task);
        if (observed === true) {
          this.queue.shift();
          this.finishTask(task, { ok: true, committed: true });
          continue;
        }
        // 无法判断或确认未生效：连接已 ready 时按原 commandId/原 payload 重发（幂等）。
        task.state = "queued";
      }
      if (!this.deps.isWritable()) {
        if (this.connection === "unavailable") {
          this.queue.shift();
          this.failTask(task, "当前不可写，无法记录操作");
          continue;
        }
        // 连接/写入门禁暂时不可用：保留记录等待对账，不伪造拒绝。
        task.state = "unknown";
        this.markUnknown(task);
        this.pauseForRetry();
        return;
      }

      task.state = "sending";
      task.startedAt = this.now();
      this.activeTask = task;
      this.notify();
      const outcome = this.deps.submitGuarded({ commandId: task.commandId, edit: task.edit });
      if (!outcome.ok) {
        this.activeTask = null;
        if (outcome.code === "host-reconnecting" || outcome.code === "not-connected" || this.isInterrupted()) {
          this.markUnknown(task);
          return;
        }
        this.queue.shift();
        this.failTask(task, outcome.reason);
        continue;
      }
      if (task.record) task.record.submittedAt = new Date(this.now()).toISOString();

      const settled = await this.waitForSettlement(task, outcome.settled, generation);
      if (generation !== this.generation) return;
      this.activeTask = null;
      if (settled === INTERRUPTED) {
        this.markUnknown(task);
        return;
      }
      task.settled = true;
      this.queue.shift();
      this.finishTask(task, settled);
    }
  }

  /**
   * 等待 settled，或等待中断/超时提示。
   *
   * 超时只标记等待提示并结束本次等待（记录保持 unknown），由连接状态/对账决定后续；
   * 迟到的真实结果仍通过 `handleLateSettlement` 落到记录上。
   */
  private waitForSettlement(
    task: JournalTask,
    settled: Promise<JournalSettleOutcome>,
    generation: number
  ): Promise<JournalSettleOutcome | typeof INTERRUPTED> {
    const hintMs = this.deps.settlementHintMs ?? EDIT_JOURNAL_SETTLEMENT_HINT_MS;
    return new Promise((resolve) => {
      let done = false;
      let interrupted = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: JournalSettleOutcome | typeof INTERRUPTED) => {
        if (done) return;
        done = true;
        if (this.interruptWaiter === onInterrupt) this.interruptWaiter = null;
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      };
      const onInterrupt = () => {
        interrupted = true;
        finish(INTERRUPTED);
      };
      this.interruptWaiter = onInterrupt;
      timer = setTimeout(() => {
        if (done) return;
        task.slow = true;
        if (task.record) task.record.slow = true;
        this.deps.onSettlementTimeout?.();
        // 不把超时解释为成功/拒绝：暂停自动重发，稍后再探测，避免忙等。
        this.pauseForRetry();
        this.notify();
        // 结算通道迟迟不返回：保留记录为 unknown，停止本次等待。
        interrupted = true;
        finish(INTERRUPTED);
      }, hintMs);
      settled.then(
        (value) => {
          finish(value);
          if (interrupted) this.handleLateSettlement(task, value, generation);
        },
        () => {
          finish({ ok: false, reason: "操作结算失败" });
        }
      );
    });
  }

  private handleLateSettlement(
    task: JournalTask,
    settled: JournalSettleOutcome,
    generation: number
  ): void {
    if (generation !== this.generation || task.settled) return;
    if (this.queue[0] !== task) return;
    task.settled = true;
    this.paused = false;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.queue.shift();
    if (this.activeTask === task) this.activeTask = null;
    this.finishTask(task, settled);
    this.scheduleDrain();
  }

  private observe(task: JournalTask): boolean | null {
    const observeEffect = this.deps.isEffectObserved;
    if (!observeEffect) return null;
    try {
      return observeEffect(task.edit);
    } catch {
      return null;
    }
  }

  private finishTask(task: JournalTask, settled: JournalSettleOutcome): void {
    if (task.direction === "forward") {
      const record = task.record;
      if (!record) return;
      if (!settled.ok) {
        this.failTask(task, settled.reason);
        return;
      }
      if (!settled.committed || !this.deps.hasNetChange(task.commandId)) {
        // 拒绝 / no-op：不入栈、不清 redo（design D5.1）。
        record.entry.state = "dropped";
        this.removePending(record);
        // 依赖该 forward 的 pending undo/redo 不得再发送。
        this.dropTasksForRecord(record);
        this.notify();
        return;
      }
      record.entry.state = "committed";
      const revision = settled.revision ?? this.deps.committedRevision?.(task.commandId);
      if (revision !== undefined) record.entry.revision = revision;
      this.removePending(record);
      this.pushCommitted(record.entry);
      this.notify();
      return;
    }

    if (!settled.ok) {
      this.failTask(task, settled.reason);
      return;
    }
    if (!settled.committed) {
      this.failTask(task, "操作尚未结算");
      return;
    }
    if (task.direction === "undo") {
      task.entry.undoPending = false;
      task.entry.undoRevision = settled.revision ?? this.deps.committedRevision?.(task.commandId);
    }
    else {
      task.entry.redoPending = false;
      this.finishRedo(task.entry, settled.revision ?? this.deps.committedRevision?.(task.commandId));
      this.notify();
      return;
    }
    this.moveCursor(task);
    this.notify();
  }

  private isInterrupted(): boolean {
    return this.connection === "interrupted";
  }

  private failTask(task: JournalTask, reason: string): void {
    task.entry.undoPending = false;
    task.entry.redoPending = false;
    task.entry.state = "conflict";
    task.entry.error = reason;
    if (task.record) {
      task.record.entry.state = "conflict";
      task.record.entry.error = reason;
      task.record.error = reason;
    }
    if (task.direction === "forward") this.markDependentsConflict(task);
    this.dropDependentTasks(task);
    this.notify();
  }

  /** 前序 forward 被拒绝：依赖同一实体的后续记录标为 conflict，不再发送。 */
  private markDependentsConflict(task: JournalTask): void {
    const touched = editNodeIds(task.edit);
    if (touched.size === 0) return;
    for (const record of this.pendingRecords) {
      if (record === task.record) continue;
      if (record.entry.state === "conflict" || record.entry.state === "dropped") continue;
      const related = editNodeIds(record.entry.forward);
      if (![...related].some((nodeId) => touched.has(nodeId))) continue;
      record.entry.state = "conflict";
      record.entry.error = "依赖的操作被拒绝，未保存";
      record.error = record.entry.error;
      this.dropTasksForRecord(record);
    }
  }

  /** 丢弃与失败记录关联的后续 undo/redo 任务（forward 已被标记）。 */
  private dropDependentTasks(task: JournalTask): void {
    if (!task.record) return;
    this.dropTasksForRecord(task.record);
  }

  private dropTasksForRecord(record: PendingRecord): void {
    this.queue = this.queue.filter((candidate) => {
      if (candidate.record !== record) return true;
      candidate.state = "done";
      candidate.settled = true;
      return false;
    });
  }

  private markUnknown(task: JournalTask): void {
    task.state = "unknown";
    if (task.entry.state === "pending") task.entry.state = "unknown";
    this.notify();
  }

  private moveCursor(task: JournalTask): void {
    const index = this.entries.indexOf(task.entry);
    if (index < 0) return;
    if (task.direction === "undo") {
      this.finishUndo(task.entry);
    } else if (index === this.undoCursor + 1) {
      this.undoCursor = index;
    }
  }

  private finishUndo(entry: JournalEntry): void {
    const index = this.entries.indexOf(entry);
    if (index < 0 || index > this.undoCursor) return;
    // A later edit may have arrived before the undo response. It branches the
    // history if it actually committed after this undo, even though the undo
    // entry was still on the applied side when that edit was registered.
    const branched = this.entries.slice(index + 1, this.undoCursor + 1).some(item =>
      entry.undoRevision === undefined || item.revision === undefined || item.revision > entry.undoRevision
    );
    this.entries.splice(index, 1);
    this.undoCursor--;
    if (branched) this.currentBytes -= estimateBytes(entry);
    else this.entries.splice(this.undoCursor + 1, 0, entry);
  }

  private finishRedo(entry: JournalEntry, revision: number | undefined): void {
    const index = this.entries.indexOf(entry);
    if (index >= 0) {
      this.entries.splice(index, 1);
      this.currentBytes -= estimateBytes(entry);
      if (index <= this.undoCursor) this.undoCursor--;
    }
    entry.revision = revision;
    entry.undoRevision = undefined;
    if (index < 0) {
      // A new commit may have discarded the redo while its request was in
      // flight. The successful replay is itself an authoritative commit.
      this.pushCommitted(entry);
      return;
    }
    const later = revision === undefined ? -1 : this.entries.findIndex((item, i) => i <= this.undoCursor && item.revision !== undefined && item.revision > revision);
    this.entries.splice(later < 0 ? this.undoCursor + 1 : later, 0, entry);
    this.undoCursor++;
    this.currentBytes += estimateBytes(entry);
    this.enforceCapacity();
  }

  private removePending(record: PendingRecord): void {
    const index = this.pendingRecords.indexOf(record);
    if (index >= 0) this.pendingRecords.splice(index, 1);
  }

  private pendingBytes(): number {
    return this.pendingRecords.reduce((sum, record) => sum + record.bytes, 0);
  }

  private pushCommitted(entry: JournalEntry): void {
    if (entry.revision !== undefined && this.undoCursor + 1 < this.entries.length) {
      // A receipt can arrive after an undo even though its write preceded that
      // undo. Keep only redo entries whose undo is known to be later than it.
      const start = this.undoCursor + 1;
      const cut = this.entries.findIndex((item, index) => index >= start && (item.undoRevision === undefined || item.undoRevision <= entry.revision!));
      if (cut >= 0) {
        const removed = this.entries.splice(cut);
        for (const item of removed) this.currentBytes -= estimateBytes(item);
      }
      if (start < this.entries.length) {
        const laterApplied = this.entries.findIndex((item, index) => index < start && item.revision !== undefined && item.revision > entry.revision!);
        const index = laterApplied < 0 ? start : laterApplied;
        this.entries.splice(index, 0, entry);
        this.currentBytes += estimateBytes(entry);
        this.undoCursor++;
        this.enforceCapacity();
        return;
      }
    }
    // External receipts may arrive after newer commits. Insert them before the
    // first known later revision instead of making an older edit the undo tip.
    if (entry.revision !== undefined) {
      const index = this.entries.findIndex(item => item.revision !== undefined && item.revision > entry.revision!);
      if (index >= 0) {
        this.entries.splice(index, 0, entry);
        this.currentBytes += estimateBytes(entry);
        if (index <= this.undoCursor + 1) this.undoCursor++;
        this.enforceCapacity();
        return;
      }
    }
    // 新净修改成功：清空 redo 区。
    if (this.undoCursor + 1 < this.entries.length) {
      const removed = this.entries.splice(this.undoCursor + 1);
      for (const item of removed) this.currentBytes -= estimateBytes(item);
    }
    this.entries.push(entry);
    this.currentBytes += estimateBytes(entry);
    this.undoCursor = this.entries.length - 1;
    this.enforceCapacity();
  }

  /** 容量控制：先移除最旧已结算记录，保持界内。 */
  private enforceCapacity(): void {
    while (this.entries.length > EDIT_JOURNAL_MAX_ENTRIES || this.currentBytes > EDIT_JOURNAL_MAX_BYTES) {
      this.entries.shift();
      this.currentBytes = this.entries.reduce((sum, entry) => sum + estimateBytes(entry), 0);
      this.undoCursor = Math.max(-1, this.undoCursor - 1);
      if (this.entries.length === 0) break;
    }
  }

  private notify(): void {
    this.deps.onChange?.();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private nextSeq(): string {
    this.seq += 1;
    return this.seq.toString(36);
  }

  private generateId(): string {
    if (this.deps.generateCommandId) return this.deps.generateCommandId();
    const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (typeof cryptoRef?.randomUUID === "function") return cryptoRef.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** 撤销/重做执行器：对参数/外部权威条目回放；画布条目由队列提交。 */
