/**
 * Edit Journal 的公开模型、依赖类型与快照计算
 * （change: 2026-11-06-nonblocking-canvas-edit-history）。
 *
 * 从 `edit-journal.ts` 拆出：本文件保持纯类型与纯函数，便于单测并满足单文件行数守卫。
 */
import type { EditOperation, EditPrecondition } from "@woohaa3/contracts";

export type JournalPlannedEdit = {
  preconditions: EditPrecondition[];
  operations: EditOperation[];
};

export type JournalEntryKind = "canvas" | "parameter";

export type JournalEntryState = "pending" | "committed" | "conflict" | "dropped" | "unknown";

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
  /** 入队时固定的 wire commandId；重试复用同一个值。 */
  commandId?: string;
  forward: JournalPlannedEdit;
  inverse: JournalPlannedEdit;
  /** 冲突/失败原因（用于界面展示）。 */
  error?: string;
  /** 已入队的撤销/重做尚未确认（不重复排队，也不提前移动指针）。 */
  undoPending?: boolean;
  redoPending?: boolean;
  /** 只有正式撤销栈中的记录才是 `committed`。 */
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

/**
 * Entry whose forward/inverse edits are owned by another authoritative authority
 * (scene-area receipts, camera settings). The journal only stores verified
 * callbacks; a rejected, cancelled or version-conflicted callback leaves the
 * cursor in place, so an uncertain receipt never advances global history.
 */
export type ExternalJournalEntry = {
  kind: "external";
  id: string;
  label: string;
  undo: () => Promise<ExternalJournalOutcome>;
  redo: () => Promise<ExternalJournalOutcome>;
  state: JournalEntryState;
};

export type ExternalJournalOutcome = { ok: true } | { ok: false; reason: string };

export type JournalEntry = CanvasJournalEntry | ParameterJournalEntry | ExternalJournalEntry;

/** 等待结算/等待对账的记录（只显示状态，不参与已确认历史）。 */
export type JournalPendingEntry = {
  kind: "canvas";
  id: string;
  commandId: string;
  label: string;
  state: "pending" | "unknown" | "conflict" | "dropped";
  enqueuedAt: number;
  submittedAt: string | null;
  /** 等待时间超过提示阈值（只影响提示，不改变终态）。 */
  slow: boolean;
  undoRequested: boolean;
  redoRequested: boolean;
  /** 拒绝/失败原因。 */
  error: string | null;
};

/** 连接可用性：ready 才 drain；interrupted 保留队列等待对账；unavailable 永久不可写。 */
export type JournalConnectionState = "ready" | "interrupted" | "unavailable";

/** 单次载荷上限 16 MiB（design D5.1 / 本 change D6）。 */
export const EDIT_JOURNAL_MAX_BYTES = 16 * 1024 * 1024;
/** 正式历史最多 100 条（design D5.1）。 */
export const EDIT_JOURNAL_MAX_ENTRIES = 100;
/** pending 队列独立上限：32 条（本 change D6）。 */
export const EDIT_JOURNAL_MAX_PENDING_ENTRIES = 32;
/** pending 队列独立上限：4 MiB（本 change D6）。 */
export const EDIT_JOURNAL_MAX_PENDING_BYTES = 4 * 1024 * 1024;
/** 结算等待提示阈值；只触发提示/连接探测，不把超时解释为成功或拒绝（本 change 3.4）。 */
export const EDIT_JOURNAL_SETTLEMENT_HINT_MS = 12_000;

export type EditJournalDependencies = {
  /** 提交一个受保护编辑批次；返回 settled promise。 */
  submitGuarded: (input: {
    commandId: string;
    edit: JournalPlannedEdit;
  }) => JournalSubmitOutcome;
  /** 当前是否可写（只读/未连接时禁止记录新的持久化动作）。 */
  isWritable: () => boolean;
  /** 规范画布是否有净变化（命令结算后复核）。 */
  hasNetChange: (commandId: string) => boolean;
  /** 同步连接状态（默认 ready，便于纯逻辑单测）。 */
  connectionState?: () => JournalConnectionState;
  /**
   * 命令后置条件是否已出现在 canonical。`null` 表示无法判断。
   * 用于重连对账：已生效转 committed，未生效用原 commandId 重发。
   */
  isEffectObserved?: (edit: JournalPlannedEdit) => boolean | null;
  /** 等待提示触发时的连接探测（可选；不改变记录终态）。 */
  onSettlementTimeout?: () => void;
  /** 任一记录/队列状态变化后回调（宿主刷新 UI）。 */
  onChange?: () => void;
  /** 生成 commandId。 */
  generateCommandId?: () => string;
  now?: () => number;
  /** 等待提示阈值（测试可调小）。 */
  settlementHintMs?: number;
  /** pending 队列上限（默认 32 条，可配置）。 */
  maxPendingEntries?: number;
  /** pending 队列字节上限（默认 4 MiB，可配置）。 */
  maxPendingBytes?: number;
};

export type EditJournalSnapshot = {
  entries: readonly JournalEntry[];
  /** 尚未结算的记录（等待/未知/冲突），按提交顺序。 */
  pending: readonly JournalPendingEntry[];
  /** 下一个可撤销的入口索引；-1 表示无可撤销项。 */
  undoIndex: number;
  redoIndex: number;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  bytes: number;
  pendingBytes: number;
  blockedReason: string | null;
};

export type PendingRecord = {
  entry: CanvasJournalEntry;
  commandId: string;
  bytes: number;
  enqueuedAt: number;
  submittedAt: string | null;
  slow: boolean;
  undoRequested: boolean;
  redoRequested: boolean;
  error: string | null;
};

export type JournalTaskDirection = "forward" | "undo" | "redo";

export type JournalTask = {
  direction: JournalTaskDirection;
  commandId: string;
  entry: CanvasJournalEntry;
  edit: JournalPlannedEdit;
  /** forward 与 pending undo/redo 关联的记录；已 committed 记录的 undo/redo 为 null。 */
  record: PendingRecord | null;
  state: "queued" | "sending" | "unknown" | "done";
  settled: boolean;
  slow: boolean;
  startedAt: number | null;
};

export const INTERRUPTED = Symbol("edit-journal-interrupted");

/** 由 EditJournal 的当前状态生成对外快照（纯函数，便于逐项验证状态机）。 */
export function buildJournalSnapshot(input: {
  entries: readonly JournalEntry[];
  pendingRecords: readonly PendingRecord[];
  undoCursor: number;
  bytes: number;
  pendingBytes: number;
}): EditJournalSnapshot {
  const { entries, pendingRecords, undoCursor, bytes, pendingBytes } = input;
  const lastPending = pendingRecords[pendingRecords.length - 1];
  const topCommitted = entries[undoCursor];
  const redoEntry = lastPending === undefined ? entries[undoCursor + 1] : undefined;
  const blocked = topCommitted?.state === "conflict"
    || lastPending?.entry.state === "conflict"
    || redoEntry?.state === "conflict";
  const topUndoPending = topCommitted?.kind === "canvas" && topCommitted.undoPending === true;
  const redoPending = redoEntry?.kind === "canvas" && redoEntry.redoPending === true;
  const undoLabel = lastPending && !lastPending.undoRequested && lastPending.entry.state !== "conflict"
    ? lastPending.entry.label
    : lastPending === undefined && undoCursor >= 0 && topCommitted?.state !== "conflict" && !topUndoPending
      ? topCommitted?.label ?? null
      : null;
  const canRedo = lastPending
    ? lastPending.undoRequested && !lastPending.redoRequested && lastPending.entry.state !== "conflict"
    : redoEntry !== undefined && !redoPending;
  return {
    entries: [...entries],
    pending: pendingRecords.map((record) => ({
      kind: "canvas",
      id: record.entry.id,
      commandId: record.commandId,
      label: record.entry.label,
      state: record.entry.state === "committed" ? "pending" : record.entry.state,
      enqueuedAt: record.enqueuedAt,
      submittedAt: record.submittedAt,
      slow: record.slow,
      undoRequested: record.undoRequested,
      redoRequested: record.redoRequested,
      error: record.error
    })),
    undoIndex: undoCursor,
    redoIndex: undoCursor + 1,
    canUndo: undoLabel !== null,
    canRedo,
    undoLabel,
    redoLabel: lastPending
      ? lastPending.undoRequested && !lastPending.redoRequested ? lastPending.entry.label : null
      : redoEntry && !redoPending ? redoEntry.label : null,
    bytes,
    pendingBytes,
    blockedReason: blocked ? "最近的记录已被其他修改影响，请先跳过此记录" : null
  };
}

export type JournalHandlers = {
  apply: (
    entry: JournalEntry,
    direction: -1 | 1
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
};

/** 从受保护编辑中提取涉及的稳定实体 ID，用于判定后续记录是否依赖。 */
export function editNodeIds(edit: JournalPlannedEdit): Set<string> {
  const ids = new Set<string>();
  for (const precondition of edit.preconditions) {
    const scope = precondition as { nodeId?: string; nodeIds?: readonly string[] };
    if (typeof scope.nodeId === "string") ids.add(scope.nodeId);
    if (Array.isArray(scope.nodeIds)) for (const nodeId of scope.nodeIds) ids.add(nodeId);
  }
  for (const operation of edit.operations) {
    switch (operation.kind) {
      case "node-add":
        ids.add(operation.node.id);
        break;
      case "node-remove":
        for (const nodeId of operation.nodeIds) ids.add(nodeId);
        break;
      case "edge-add":
        ids.add(operation.edge.source);
        ids.add(operation.edge.target);
        break;
      case "node-update":
      case "node-data-set":
      case "node-data-unset":
      case "extension.edit":
        ids.add(operation.nodeId);
        break;
      default:
        break;
    }
  }
  return ids;
}

export function estimateBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    // External entries store callbacks; they do not contribute a serializable payload.
    return encoded === undefined ? 0 : new TextEncoder().encode(encoded).length;
  } catch {
    return 0;
  }
}

