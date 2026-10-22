/**
 * 关闭与离开的结算规划（纯逻辑）
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 4.1 / design D6）。
 *
 * 关闭单个 tab 或离开页面/切换画布时，需要按文档汇总「有净变化」「保存中」「未知回执」
 * 与活动操作门禁，并决定：
 * - 可以直接关闭（无净变化）；
 * - 需要用户选择（保存并关闭 / 不保存 / 取消）；
 * - 必须拒绝（活动操作未结束、保存结果未知需先核对）。
 *
 * 本模块只做决策，不执行保存、不释放资源；调用方按计划逐项结算，失败即停止并定位失败项。
 */
import type { EditorDocumentEntry } from "@woohaa3/photocraft-editor";

export type DocumentSettlementItem = {
  documentId: string;
  name: string;
  /** 是否有内容净变化（需要保存或明确放弃）。 */
  dirty: boolean;
  /** 未确认的受控草稿原因（门禁）。 */
  pendingDraft: string | null;
  /** 当前保存阶段。 */
  phase: string;
  /** 保存失败/冲突原因。 */
  message: string | null;
  /** 节点文档为 true；独立文件文档为 false。 */
  nodeDocument: boolean;
  /** 是否已有权威回执待核对（未知回执）。 */
  receiptUnknown: boolean;
};

export type ClosePlan =
  /** 无净变化、无未结算项：直接销毁。 */
  | { kind: "close" }
  /** 需要用户确认：保存/不保存/取消。 */
  | { kind: "confirm"; reason: string; canSave: boolean }
  /** 必须拒绝（活动操作未结束或回执未知）。 */
  | { kind: "block"; reason: string };

/**
 * 单个文档的关闭计划。
 *
 * 活动操作（笔迹/未确认草稿）优先于保存选择：先要求结束操作，不隐式提交或丢弃。
 * 未知回执也先拒绝：核对是权威操作，不能当普通草稿放弃。
 */
export function planCloseDocument(item: DocumentSettlementItem): ClosePlan {
  if (item.pendingDraft) return { kind: "block", reason: item.pendingDraft };
  if (item.receiptUnknown) return { kind: "block", reason: "上次保存结果未知，请先核对保存结果再关闭" };
  if (item.phase === "saving" || item.phase === "freezing") {
    return { kind: "block", reason: "文档正在保存，请等待完成后再关闭" };
  }
  if (!item.dirty) return { kind: "close" };
  return {
    kind: "confirm",
    reason: item.nodeDocument ? "该文档有未保存的修改" : "该独立文档有未保存的修改",
    canSave: true
  };
}

export type LeavePlan =
  /** 全部干净：可以直接离开。 */
  | { kind: "leave" }
  /** 需要逐项结算（可能有保存选择）；`items` 是需要处理的项。 */
  | { kind: "settle"; items: DocumentSettlementItem[] }
  /** 必须先结束某个活动操作或核对回执。 */
  | { kind: "block"; reason: string; documentId: string };

/**
 * 离开页面/切换画布的汇总计划。
 *
 * 任一文档有未结束操作或未知回执即拒绝（先定位该项）；否则列出所有需要结算的文档，由调用方
 * 串行处理，失败即停止并保留现场。
 */
export function planLeave(items: readonly DocumentSettlementItem[]): LeavePlan {
  for (const item of items) {
    if (item.pendingDraft) return { kind: "block", reason: item.pendingDraft, documentId: item.documentId };
    if (item.receiptUnknown) {
      return { kind: "block", reason: "有文档的保存结果未知，请先核对保存结果", documentId: item.documentId };
    }
    if (item.phase === "saving" || item.phase === "freezing") {
      return { kind: "block", reason: "有文档正在保存，请等待完成", documentId: item.documentId };
    }
  }
  const pending = items.filter((item) => item.dirty || item.phase === "failed" || item.message !== null);
  if (pending.length === 0) return { kind: "leave" };
  return { kind: "settle", items: pending };
}

/**
 * 结算结果：逐项串行，失败即停止。
 *
 * 返回停止位置与已成功项（已成功项保留推进后的基线，不回滚、不重复写版本）。
 */
export type SettlementOutcome =
  | { ok: true; settled: string[]; abandoned: string[] }
  | { ok: false; reason: string; failedDocumentId: string; settled: string[]; abandoned: string[] };

export type SettlementDecision = "save" | "discard" | "cancel";

export async function settleSerially(
  items: readonly DocumentSettlementItem[],
  decide: (item: DocumentSettlementItem) => Promise<SettlementDecision>,
  save: (item: DocumentSettlementItem) => Promise<{ ok: boolean; message?: string }>
): Promise<SettlementOutcome> {
  const settled: string[] = [];
  const abandoned: string[] = [];
  for (const item of items) {
    const decision = await decide(item);
    if (decision === "cancel") {
      return { ok: false, reason: "已取消离开", failedDocumentId: item.documentId, settled, abandoned };
    }
    if (decision === "discard") {
      // 放弃只丢未提交修改，不回滚已权威提交内容。
      abandoned.push(item.documentId);
      continue;
    }
    const outcome = await save(item);
    if (!outcome.ok) {
      return { ok: false, reason: outcome.message ?? "保存失败", failedDocumentId: item.documentId, settled, abandoned };
    }
    settled.push(item.documentId);
  }
  return { ok: true, settled, abandoned };
}

/** 由条目与文档状态构造结算项。 */
export function settlementItemOf(
  entry: EditorDocumentEntry,
  state: { dirty: boolean; pendingDraft: string | null; phase: string; message: string | null },
  receiptUnknown = false
): DocumentSettlementItem {
  return {
    documentId: entry.id,
    name: entry.name,
    dirty: state.dirty || entry.status === "dirty" || entry.status === "error" || entry.status === "conflict",
    pendingDraft: state.pendingDraft,
    phase: state.phase,
    message: state.message ?? entry.message,
    nodeDocument: entry.source.kind === "node",
    receiptUnknown
  };
}
