/**
 * 关闭与离开的结算执行器
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 4.1 / design D6）。
 *
 * 把 `document-close` 的纯决策接到真实会话上：询问用户、保存或放弃、失败停止并保留现场。
 * 决策与执行分开，便于对“多项部分成功”“取消不改变活动项”“失败定位”做无渲染回归。
 */
import type { ClosePlan, DocumentSettlementItem } from "./document-close.js";
import { planCloseDocument } from "./document-close.js";

/** UI 交互端口：保存/放弃/取消及下载确认（生产宿主经受控 Dialog 栈呈现）。 */
export type SettlementUi = {
  /** 询问“保存并关闭”；返回 false 表示用户取消（保留现场）。 */
  confirm?: (reason: string) => Promise<boolean>;
  /** 三选项关闭对话框；优先于旧版confirm。 */
  choose?: (reason:string) => Promise<"save"|"discard"|"cancel">;
  /** 询问“不保存并关闭”；返回 false 表示用户取消。 */
  abandon: (reason: string) => Promise<boolean>;
};

export type SettleInput = DocumentSettlementItem & {
  ui: SettlementUi;
  /**
   * 保存实现（节点写回原节点；独立文件走本地交付）。
   *
   * 独立文件只能发起浏览器下载：这种情况下 `save` 仍返回 `ok`，但调用方必须随后用
   * `ui.abandon` 让用户明确确认关闭——下载启动不等于磁盘写入。
   */
  save: () => Promise<{ ok: boolean; message?: string; downloadOnly?: boolean }>;
  /** 作用域：关闭单个文档或离开页面（决定是否要求用户对下载做明确确认）。 */
  scope?: "close" | "leave";
  /** 每个异步边界后确认资源身份与关闭操作仍有效。 */
  isCurrent?:()=>boolean;
};

export type SettleOutcome =
  | { ok: true; action: "closed" | "abandoned" }
  | { ok: false; reason: string };

/**
 * 结算一个文档。
 *
 * - 活动操作未结束 / 回执未知 / 正在保存：拒绝并说明（现场保留）；
 * - 无净变化：直接关闭；
 * - 有净变化：选择保存/放弃/取消；保存失败即停止，不丢草稿；
 * - 仅能发起下载时：要求用户再明确确认一次「已保存并关闭」。
 */
export async function settleDocument(input: SettleInput): Promise<SettleOutcome> {
  const isCurrent=input.isCurrent??(()=>true);
  if(!isCurrent())return {ok:false,reason:"文档已变化，请重新关闭"};
  const item: DocumentSettlementItem = {
    documentId: input.documentId,
    name: input.name,
    dirty: input.dirty,
    pendingDraft: input.pendingDraft,
    phase: input.phase,
    message: input.message,
    nodeDocument: input.nodeDocument,
    receiptUnknown: input.receiptUnknown
  };
  const plan = planCloseDocument(item);
  if (plan.kind === "block") return { ok: false, reason: plan.reason };
  if (plan.kind === "close") return { ok: true, action: "closed" };

  const choice=input.ui.choose?await input.ui.choose(plan.reason):await input.ui.confirm?.(plan.reason)?"save":"cancel";
  if(!isCurrent())return {ok:false,reason:"文档已变化，请重新关闭"};
  if(choice==="discard")return {ok:true,action:"abandoned"};
  if (choice!=="save") {
    // 取消关闭：活动项不变，现场保留。
    return { ok: false, reason: "已取消" };
  }
  const saved = await input.save();
  if(!isCurrent())return {ok:false,reason:"文档已变化，请重新关闭"};
  if (!saved.ok) return { ok: false, reason: saved.message ?? "保存失败，文档仍保留" };
  if (saved.downloadOnly) {
    // 浏览器下载不能证明写入磁盘：必须再确认一次，不能把下载启动当磁盘写入。
    const acknowledged = await input.ui.abandon("已发起下载，但无法确认文件是否已保存到目标位置。确认已保存并关闭吗？");
    if(!isCurrent())return {ok:false,reason:"文档已变化，请重新关闭"};
    if (!acknowledged) return { ok: false, reason: "已取消" };
  }
  return { ok: true, action: "closed" };
}

/** 无用户交互的关闭计划（供 UI 呈现关闭按钮的可关闭性）。 */
export function closePlanOf(item: DocumentSettlementItem): ClosePlan {
  return planCloseDocument(item);
}
