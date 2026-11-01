/**
 * 页面级 Edit Journal（change: 2026-10-09-improve-canvas-workflow，任务 1.5 / design D5.1）。
 *
 * 记录**已结算**的可撤销画布动作与本地参数动作，提供撤销/重做、冲突检测与跳过。
 *
 * 关键不变量：
 * - 画布动作只在 command handle `committed`、有净变化且规范结果可验证后才入栈；
 * - 撤销/重做不是新用户动作（不再压栈），确认后才移动栈指针；每个反向/重做使用新 commandId；
 * - 响应丢失重试沿用同一 commandId；
 * - 新净修改成功后清空 redo；拒绝/no-op 不清空；
 * - 冲突条目不自动跳过，用户显式“跳过此记录”后移除阻塞项；
 * - 有界：最多 100 条、合计 16 MiB，先移除最旧已结算记录；单次超限在提交前拒绝。
 *
 * 本模块是纯逻辑：命令提交通过注入的 `submit` 回调完成，便于单测无 DOM/Yjs。
 */
import type { EditOperation, EditPrecondition } from "@woohaa3/contracts";

export type JournalPlannedEdit = {
  preconditions: EditPrecondition[];
  operations: EditOperation[];
};

export type JournalEntryKind = "canvas" | "parameter";

export type JournalEntryState = "pending" | "committed" | "rejected" | "conflict";

export type JournalSubmitOutcome =
  | { ok: true; settled: Promise<JournalSettleOutcome> }
  | { ok: false; reason: string; code?: string };

export type JournalSettleOutcome =
  | { ok: true; committed: boolean }
  | { ok: false; reason: string };

export type CanvasJournalEntry = {
  kind: "canvas";
  id: string;
  label: string;
  forward: JournalPlannedEdit;
  inverse: JournalPlannedEdit;
  /** 已提交且可撤销。 */
  state: JournalEntryState;
};

export type ParameterJournalEntry = {
  kind: "parameter";
  id: string;
  label: string;
  /** 参数分区身份。 */
  nodeId: string;
  modelKey: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  state: JournalEntryState;
};

export type JournalEntry = CanvasJournalEntry | ParameterJournalEntry;

/** 单次载荷上限 16 MiB（design D5.1）。 */
export const EDIT_JOURNAL_MAX_BYTES = 16 * 1024 * 1024;
/** 最多记录 100 条（design D5.1）。 */
export const EDIT_JOURNAL_MAX_ENTRIES = 100;
export const EDIT_JOURNAL_MAX_ADOPTED_IDS = 1000;

export type EditJournalDependencies = {
  /** 提交一个受保护编辑批次；返回 settled promise。 */
  submitGuarded: (input: {
    commandId: string;
    edit: JournalPlannedEdit;
  }) => JournalSubmitOutcome;
  /** 当前是否可写（pending/只读时禁止继续记录写动作）。 */
  isWritable: () => boolean;
  /** 规范画布是否有净变化（用于命令结算后复核）。 */
  hasNetChange: (commandId: string) => boolean;
  /** 生成 commandId。 */
  generateCommandId?: () => string;
  now?: () => number;
};

export type EditJournalSnapshot = {
  entries: readonly JournalEntry[];
  /** 下一个可撤销的入口索引；-1 表示无可撤销项。 */
  undoIndex: number;
  redoIndex: number;
  canUndo: boolean;
  canRedo: boolean;
  bytes: number;
  blockedReason: string | null;
};

export class EditJournal {
  private readonly entries: JournalEntry[] = [];
  private readonly deps: EditJournalDependencies;
  /** 栈指针：entries[0..undoCursor] 可撤销；>undoCursor 为 redo 区。 */
  private undoCursor = -1;
  private currentBytes = 0;
  private busy = false;
  private generation = 0;
  private readonly adopted = new Set<string>();

  constructor(deps: EditJournalDependencies) {
    this.deps = deps;
  }

  async adoptExternal(id: string, run: () => Promise<{ ok: true; label: string; forward: JournalPlannedEdit; inverse: JournalPlannedEdit } | { ok: false; reason: string }>): Promise<{ ok: true; entry: CanvasJournalEntry } | { ok: false; reason: string }> {
    if (this.busy) return { ok: false, reason: "正在结算上一次操作，请稍候" };
    if (!this.deps.isWritable()) return { ok: false, reason: "当前不可写，无法记录操作" };
    if (id.length > 256 || (!this.adopted.has(id) && this.adopted.size >= EDIT_JOURNAL_MAX_ADOPTED_IDS)) return { ok: false, reason: "操作历史身份已达上限，请重新打开画布" };
    const generation = this.generation;
    this.busy = true;
    try {
      const result = await run();
      if (generation !== this.generation) return { ok: false, reason: "页面已切换" };
      if (!result.ok) return result;
      if (!this.deps.isWritable()) return { ok: false, reason: "当前不可写，无法记录操作" };
      if (this.adopted.has(id)) {
        const existing = this.entries.find((entry): entry is CanvasJournalEntry => entry.kind === "canvas" && entry.id === id);
        return existing ? { ok: true, entry: existing } : { ok: false, reason: "该操作已不在撤销历史中" };
      }
      if (estimateBytes(result.forward) + estimateBytes(result.inverse) > EDIT_JOURNAL_MAX_BYTES) return { ok: false, reason: "操作内容过多，请分批处理" };
      const entry: CanvasJournalEntry = { kind: "canvas", id, label: result.label, forward: result.forward, inverse: result.inverse, state: "committed" };
      this.pushCommitted(entry);
      this.adopted.add(id);
      return { ok: true, entry };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "操作失败" };
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }

  /**
   * 提交一个用户结构动作。`commands` 由调用方的 planner 产出；这里只负责：
   * 1. 规划 forward/inverse（调用方已完成）；
   * 2. 受保护提交；
   * 3. 结算通过后入栈。
   *
   * 返回 `ok:false` 时不产生可撤销记录（不宣称成功）。
   */
  async recordAndSubmit(input: {
    label: string;
    id?: string;
    forward: JournalPlannedEdit;
    inverse: JournalPlannedEdit;
  }): Promise<{ ok: true; entry: CanvasJournalEntry } | { ok: false; reason: string }> {
    if (this.busy) return { ok: false, reason: "正在结算上一次操作，请稍候" };
    if (!this.deps.isWritable()) return { ok: false, reason: "当前不可写，无法记录操作" };

    const estimated = estimateBytes(input.forward) + estimateBytes(input.inverse);
    if (estimated > EDIT_JOURNAL_MAX_BYTES) {
      return { ok: false, reason: "操作内容过多，请分批处理" };
    }

    const id = input.id ?? this.generateId();
    const commandId = `edit-forward:${id}`;
    const entry: CanvasJournalEntry = {
      kind: "canvas",
      id,
      label: input.label,
      forward: input.forward,
      inverse: input.inverse,
      state: "pending"
    };

    this.busy = true;
    const outcome = this.deps.submitGuarded({ commandId, edit: input.forward });
    if (!outcome.ok) {
      this.busy = false;
      return { ok: false, reason: outcome.reason };
    }
    const settled = await outcome.settled;
    this.busy = false;
    if (!settled.ok) {
      return { ok: false, reason: settled.reason };
    }
    if (!settled.committed || !this.deps.hasNetChange(commandId)) {
      // 拒绝 / no-op：不入栈、不清 redo（design D5.1）。
      return { ok: false, reason: "操作未产生可撤销的净变化" };
    }

    entry.state = "committed";
    this.pushCommitted(entry);
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
  }): void {
    if (this.busy) return;
    const top = this.entries[this.undoCursor];
    if (
      top?.kind === "parameter"
      && this.undoCursor === this.entries.length - 1
      && top.nodeId === input.nodeId
      && top.modelKey === input.modelKey
    ) {
      top.after = { ...input.after };
      this.currentBytes = this.entries.reduce((sum, entry) => sum + estimateBytes(entry), 0);
      this.enforceCapacity();
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
      state: "committed"
    };
    this.pushCommitted(entry);
  }

  /**
   * 撤销栈顶记录。依赖调用方注入的 undo/redo 执行器（本地参数条目直接回放草稿）；
   * 画布条目经受保护反向命令提交。成功确认后才移动指针。
   */
  async undo(handlers: JournalHandlers): Promise<{ ok: true; entry: JournalEntry } | { ok: false; reason: string }> {
    return this.step(-1, handlers);
  }

  async redo(handlers: JournalHandlers): Promise<{ ok: true; entry: JournalEntry } | { ok: false; reason: string }> {
    return this.step(1, handlers);
  }

  private async step(
    direction: -1 | 1,
    handlers: JournalHandlers
  ): Promise<{ ok: true; entry: JournalEntry } | { ok: false; reason: string }> {
    if (this.busy) return { ok: false, reason: "正在结算，请稍候" };
    const target = this.undoCursor + direction;
    // redo 区是 (undoCursor, entries.length)；entries[undoCursor] 本身是「已撤销」的边界。
    const index = direction === -1 ? this.undoCursor : this.undoCursor + 1;
    if (direction === -1 && index < 0) return { ok: false, reason: "没有可撤销的操作" };
    if (direction === 1 && index >= this.entries.length) return { ok: false, reason: "没有可重做的操作" };
    const entry = this.entries[index]!;
    if (entry.state === "conflict") {
      return { ok: false, reason: "该操作已被其他修改影响，无法撤销，请先跳过此记录" };
    }
    void target;

    this.busy = true;
    const result = await handlers.apply(entry, direction);
    this.busy = false;
    if (!result.ok) {
      // 指针保持不变；冲突标记由 handler 负责。
      return { ok: false, reason: result.reason };
    }
    this.undoCursor += direction;
    return { ok: true, entry };
  }

  /** 显式跳过一条冲突记录（移除阻塞项，不自动撤销更早记录）。 */
  skipConflict(entryId: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === entryId && entry.state === "conflict");
    if (index < 0) return false;
    // 被跳过的记录从栈中移除；若位于 redo 区则一并裁剪。
    const [removed] = this.entries.splice(index, 1);
    if (removed) this.currentBytes = this.entries.reduce((sum, entry) => sum + estimateBytes(entry), 0);
    if (index <= this.undoCursor) this.undoCursor -= 1;
    return true;
  }

  /** 标记一条记录为冲突（handler 在撤销被权威拒绝时调用）。 */
  markConflict(entryId: string): void {
    const entry = this.entries.find((candidate) => candidate.id === entryId);
    if (entry) entry.state = "conflict";
  }

  snapshot(): EditJournalSnapshot {
    const canUndo = this.undoCursor >= 0 && this.entries[this.undoCursor]?.state !== "conflict";
    const canRedo = this.undoCursor + 1 < this.entries.length;
    return {
      entries: [...this.entries],
      undoIndex: this.undoCursor,
      redoIndex: this.undoCursor + 1,
      canUndo,
      canRedo,
      bytes: this.currentBytes,
      blockedReason: this.entries[this.undoCursor]?.state === "conflict"
        ? "最近的记录已被其他修改影响，请先跳过此记录"
        : null
    };
  }

  /** 清空（切画布 / 刷新 / page dispose）。 */
  clear(): void {
    this.generation += 1;
    this.adopted.clear();
    this.entries.length = 0;
    this.undoCursor = -1;
    this.currentBytes = 0;
    this.busy = false;
  }

  get size(): number {
    return this.entries.length;
  }

  private pushCommitted(entry: JournalEntry): void {
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

  private generateId(): string {
    if (this.deps.generateCommandId) return this.deps.generateCommandId();
    const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (typeof cryptoRef?.randomUUID === "function") return cryptoRef.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** 撤销/重做执行器：对画布条目提交受保护反向/重做命令；对参数条目回放本地草稿。 */
export type JournalHandlers = {
  apply: (
    entry: JournalEntry,
    direction: -1 | 1
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
};

function estimateBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}
