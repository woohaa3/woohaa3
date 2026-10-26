/**
 * 页面级画布编辑历史 Service（change: 2026-10-09-improve-canvas-workflow，任务 1.5）。
 *
 * 把 Edit Journal 接到画布会话：用共享 `planCanvasEdit` 从规范状态派生 forward/inverse，
 * 经受保护 `edit.apply` 提交，按 commandLifecycle 结算后才入栈；提供 undo/redo、冲突跳过、
 * 参数条目与工具/快捷键共享的可用态。
 *
 * 本模块只依赖注入的会话与选择读取，不直接触碰 DOM/Yjs，便于组件与单元测试。
 */
import type { CanvasCommand, ServerCanvas } from "@woohaa3/contracts";
import { planCanvasEdit, type EditPlan } from "@woohaa3/contracts";
import type { CanvasSession } from "../../../contracts.js";
import { EditJournal, type EditJournalSnapshot, type JournalEntry, type JournalPlannedEdit } from "./edit-journal.js";

export type CanvasEditServiceOptions = {
  lifecycle?: import("@woohaa3/contracts").ManagedNodeLifecycleResolver;
  session: CanvasSession;
  /** 当前规范画布（working projection 的 committed 部分）。 */
  getCanvas: () => ServerCanvas | null;
  /** 监听外部变化（可选）。 */
  onChange?: (snapshot: CanvasEditSnapshot) => void;
  generateCommandId?: () => string;
  now?: () => number;
};

export type CanvasEditSnapshot = {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  busy: boolean;
  writable: boolean;
  blockedReason: string | null;
  size: number;
  /**
   * 最近一次可撤销动作的类型（`delete` 用于删除提示；change: 2026-10-09，任务 1.7）。
   * 及其条目 id，提示按钮据此绑定具体动作身份，避免误撤销后来动作。
   */
  lastAction: { kind: "delete" | "other"; label: string; entryId: string } | null;
};

export type CanvasEditRecordResult =
  | { ok: true; entry: JournalEntry }
  | { ok: false; reason: string };

/**
 * 记录一个结构动作并提交受保护前向编辑。`commands` 是 planner 产出的结构命令批；
 * 若无法规划 forward/inverse（无净变化/不支持记录）则不入栈。
 */
export interface CanvasEditService {
  record(commands: readonly CanvasCommand[], label: string): Promise<CanvasEditRecordResult>;
  recordParameter(input: {
    label: string;
    nodeId: string;
    modelKey: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    /** 应用本地草稿（撤销/重做回放）。 */
    apply: (values: Record<string, unknown>) => void;
  }): void;
  undo(): Promise<{ ok: true } | { ok: false; reason: string }>;
  redo(): Promise<{ ok: true } | { ok: false; reason: string }>;
  skipConflict(entryId: string): boolean;
  getSnapshot(): CanvasEditSnapshot;
  subscribe(listener: (snapshot: CanvasEditSnapshot) => void): () => void;
  /** 切画布 / 刷新 / dispose。 */
  clear(): void;
}

export function createCanvasEditService(options: CanvasEditServiceOptions): CanvasEditService {
  const listeners = new Set<(snapshot: CanvasEditSnapshot) => void>();
  let busy = false;

  const journal = new EditJournal({
    isWritable: () => options.session.isWritable(),
    hasNetChange: (commandId) => {
      const handle = options.session.commandLifecycle()?.get(commandId);
      // handle 可能已被 prune；提交已 committed 才会到达这里，因此缺失视为已确认。
      return handle === undefined || handle.state === "committed";
    },
    submitGuarded: (input) => {
      const result = options.session.submitCommands(
        [{ type: "edit.apply", preconditions: input.edit.preconditions, operations: input.edit.operations }],
        input.commandId
      );
      if (!result.ok) return { ok: false, reason: result.reason, code: result.code };
      const handle = result.handle;
      return {
        ok: true,
        settled: handle.settled.then((settled: { state: string; error: string | null }) =>
          settled.state === "committed"
            ? { ok: true as const, committed: true }
            : settled.state === "rejected"
              ? { ok: false as const, reason: settled.error ?? "操作被拒绝" }
              : { ok: true as const, committed: false }
        )
      };
    },
    ...(options.generateCommandId ? { generateCommandId: options.generateCommandId } : {}),
    ...(options.now ? { now: options.now } : {})
  });

  const parameterAppliers = new Map<string, (values: Record<string, unknown>) => void>();

  // `useSyncExternalStore` 需要稳定引用：仅在记录/状态实际变化时重建快照。
  let cachedSnapshot: CanvasEditSnapshot | null = null;
  const invalidate = () => {
    cachedSnapshot = null;
  };

  const computeSnapshot = (): CanvasEditSnapshot => {
    const base = journal.snapshot();
    const next = base.entries[base.undoIndex];
    const redo = base.entries[base.undoIndex + 1];
    const lastAction = next
      ? {
          kind: (next.label.includes("删除") ? "delete" : "other") as "delete" | "other",
          label: next.label,
          entryId: next.id
        }
      : null;
    return {
      canUndo: base.canUndo,
      canRedo: base.canRedo,
      undoLabel: next?.label ?? null,
      redoLabel: redo?.label ?? null,
      busy,
      writable: options.session.isWritable(),
      blockedReason: base.blockedReason,
      size: base.entries.length,
      lastAction
    };
  };

  const snapshot = (): CanvasEditSnapshot => {
    if (!cachedSnapshot) cachedSnapshot = computeSnapshot();
    return cachedSnapshot;
  };

  const publish = () => {
    invalidate();
    const value = snapshot();
    for (const listener of listeners) listener(value);
    options.onChange?.(value);
  };

  const plan = (commands: readonly CanvasCommand[]): { ok: true } & EditPlan | { ok: false; reason: string } => {
    const canvas = options.getCanvas();
    if (!canvas) return { ok: false, reason: "画布尚未加载" };
    const planned = planCanvasEdit(canvas, commands, { lifecycle: options.lifecycle });
    if (!planned.ok) return { ok: false, reason: planned.reason };
    return { ok: true, forward: planned.forward, inverse: planned.inverse };
  };

  const applyEdit = async (
    edit: JournalPlannedEdit,
    commandId: string
  ): Promise<{ ok: true; committed: boolean } | { ok: false; reason: string }> => {
    const result = options.session.submitCommands(
      [{ type: "edit.apply", preconditions: edit.preconditions, operations: edit.operations }],
      commandId
    );
    if (!result.ok) return { ok: false, reason: result.reason };
    const settled = await result.handle.settled;
    if (settled.state === "rejected") return { ok: false, reason: settled.error ?? "操作被拒绝" };
    return { ok: true, committed: settled.state === "committed" };
  };

  const handler = {
    apply: async (entry: JournalEntry, direction: -1 | 1): Promise<{ ok: true } | { ok: false; reason: string }> => {
      if (entry.kind === "parameter") {
        const applier = parameterAppliers.get(entry.id);
        if (!applier) return { ok: false, reason: "参数记录所属草稿已不可用" };
        applier(direction === -1 ? entry.before : entry.after);
        return { ok: true };
      }
      const edit = direction === -1 ? entry.inverse : entry.forward;
      const commandId = `edit-${direction === -1 ? "undo" : "redo"}:${entry.id}:${nextSeq()}`;
      const result = await applyEdit(edit, commandId);
      if (!result.ok) {
        // 权威拒绝（冲突）：标记冲突而非自动跳过（design D5.1）。
        journal.markConflict(entry.id);
        return { ok: false, reason: result.reason };
      }
      return { ok: true };
    }
  };

  let seq = 0;
  const nextSeq = () => {
    seq += 1;
    return seq.toString(36);
  };

  return {
    async record(commands, label) {
      if (!options.session.isWritable()) return { ok: false, reason: "当前不可写，无法记录操作" };
      const planned = plan(commands);
      if (!planned.ok) return { ok: false, reason: planned.reason };
      busy = true;
      publish();
      try {
        const result = await journal.recordAndSubmit({
          label,
          forward: { preconditions: planned.forward.preconditions, operations: planned.forward.operations },
          inverse: { preconditions: planned.inverse.preconditions, operations: planned.inverse.operations }
        });
        if (!result.ok) return { ok: false, reason: result.reason };
        return { ok: true, entry: result.entry };
      } finally {
        busy = false;
        publish();
      }
    },

    recordParameter(input) {
      journal.recordParameter({
        label: input.label,
        nodeId: input.nodeId,
        modelKey: input.modelKey,
        before: input.before,
        after: input.after
      });
      // 记录后把 applier 绑定到该条目 id（最近一条）。
      const entries = journal.snapshot().entries;
      const last = entries[entries.length - 1];
      if (last) parameterAppliers.set(last.id, input.apply);
      publish();
    },

    async undo() {
      const result = await journal.undo(handler);
      publish();
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },

    async redo() {
      const result = await journal.redo(handler);
      publish();
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },

    skipConflict(entryId) {
      const result = journal.skipConflict(entryId);
      publish();
      return result;
    },

    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    clear() {
      journal.clear();
      parameterAppliers.clear();
      publish();
    }
  };
}

export type { EditJournalSnapshot };
