import type { EditorResult } from "../../editor-wasm.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import { selectionSessionHandle } from "./session-gate.js";
import { decodeDraftState, quickMaskStrokeParams } from "./draft-state.js";
import type { DocumentPoint } from "../../photo-editor-tools.js";

/**
 * 选区/蒙版领域会话（U17–U24）。
 *
 * 生命周期仍归工作区控制器：这里只做三件事——共用活动草稿门禁、在成功后取回视图、让确认走
 * 一次 `afterWrite()`。内容写入永远由内核草稿完成，本层不缓存第二份文档。
 */

/** 打开草稿前的通用门禁：无会话、缺活动文档或已有其他草稿时拒绝。 */
function canBeginDraft(context: WorkspaceFeatureContext): EditorResult<unknown> {
  if (!context.handle) return context.unavailable();
  if (!context.view.document) return { ok: false, code: "no-document", message: "没有可编辑的文档" };
  const blocked = context.blockingDraft();
  if (blocked) return blocked;
  return { ok: true, value: null };
}

/** 草稿成功打开后标记会话状态（供 `hasActiveDraft()` 与保存门禁使用）。 */
function started(context: WorkspaceFeatureContext, result: EditorResult<unknown>): EditorResult<unknown> {
  if (result.ok) context.selectionModifyActive = true;
  return result;
}

/** 确认：内核只提交一次，随后统一刷新视图与命令表。 */
function commit(context: WorkspaceFeatureContext): EditorResult<EditorViewModel> {
  const handle = context.handle;
  if (!handle || !context.selectionModifyActive) return context.unavailable();
  const result = handle.features.selections.commitSelectionDraft();
  if (!result.ok) return context.fail(result);
  context.selectionModifyActive = false;
  return context.afterWrite();
}

function cancel(context: WorkspaceFeatureContext): void {
  if (context.selectionModifyActive) context.handle?.features.selections.cancelSelectionDraft();
  context.selectionModifyActive = false;
}

function draftState(context: WorkspaceFeatureContext): EditorResult<unknown> {
  if (!context.handle) return context.unavailable();
  return context.handle.features.selections.selectionDraftState();
}

/**
 * 草稿的真实候选轮廓（U18/U22/U23 的"预览用实际结果"）。
 *
 * 只读投影：不推进修订、不写历史；没有草稿时内核返回空数组，面板据此退回只显示包围盒。
 */
function draftOutline(context: WorkspaceFeatureContext): EditorResult<unknown> {
  if (!context.handle) return context.unavailable();
  return context.handle.features.selections.selectionDraftOutline();
}

/** U17 单行/单列：一次性命内历史，不进入草稿。 */
export function selectLine(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const result = handle.features.selections.selectLine(params);
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

/** U18 多边形/磁性套索草稿。 */
export function beginMagneticLasso(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<unknown> {
  const ready = canBeginDraft(this);
  if (!ready.ok) return ready;
  return started(this, this.handle!.features.selections.beginMagneticLasso(params));
}

export function updateMagneticLasso(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<unknown> {
  if (!this.handle || !this.selectionModifyActive) return this.unavailable();
  return this.handle.features.selections.updateMagneticLasso(params);
}

/** U19 命名选区保存/加载：不是草稿，一次命令即一步历史。 */
export function saveNamedSelection(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const result = handle.features.selections.saveNamedSelection(params);
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

export function loadNamedSelection(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const result = handle.features.selections.loadNamedSelection(params);
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

/** U19 按颜色扩大/选取相似草稿（区别于几何 Expand）。 */
export function beginColorGrow(this: WorkspaceFeatureContext, similar: boolean, params: Record<string, unknown>): EditorResult<unknown> {
  const ready = canBeginDraft(this);
  if (!ready.ok) return ready;
  return started(this, this.handle!.features.selections.beginColorGrow(similar, params));
}

export function updateColorGrow(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<unknown> {
  if (!this.handle || !this.selectionModifyActive) return this.unavailable();
  return this.handle.features.selections.updateColorGrow(params);
}

/** U20 快速蒙版会话。 */
export function beginQuickMask(this: WorkspaceFeatureContext): EditorResult<unknown> {
  const ready = canBeginDraft(this);
  if (!ready.ok) return ready;
  return started(this, this.handle!.features.selections.beginQuickMask());
}

export function paintQuickMask(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<unknown> {
  if (!this.handle || !this.selectionModifyActive) return this.unavailable();
  return this.handle.features.selections.paintQuickMask(params);
}

/**
 * 画布手势的快速蒙版笔迹：点位+笔刷在这里编译成内核参数。
 *
 * 参数编译留在本域（`quickMaskStrokeParams`），共享画布/外壳只转发原始点位与笔刷，
 * 不各自拼一份 `target: "quickMask"`；否则画布那条路径很容易漏掉目标字段而写到图层像素上。
 */
export function paintQuickMaskStroke(
  this: WorkspaceFeatureContext,
  points: readonly DocumentPoint[],
  brush: { size: number; hardness?: number; opacity?: number; color?: string }
): EditorResult<unknown> {
  const params = quickMaskStrokeParams(points, { ...brush, color: maskStrokeColor(brush.color) });
  if (!params) return { ok: false, code: "invalid-params", message: "快速蒙版笔迹参数非法" };
  return paintQuickMask.call(this, params);
}

/**
 * 快速蒙版是**灰度**临时通道：白色加入选区、黑色遮出。
 *
 * 任意前景色直接送进内核只会被按灰度阈值吸附，用户看到"颜色不对、像是没生效"。
 * 这里按相对亮度显式归到黑白两档，与面板的两档笔迹是同一语义，也不静默保留第三种状态。
 */
function maskStrokeColor(color: string | undefined): "#ffffff" | "#000000" {
  const match = /^#([0-9a-f]{6})$/i.exec(color ?? "");
  if (!match) return "#ffffff";
  const value = Number.parseInt(match[1], 16);
  const [r, g, b] = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 >= 0.5 ? "#ffffff" : "#000000";
}

/** 退出快速蒙版：确认转回选区（一步历史），取消恢复进入前的选区。 */
export function exitQuickMask(this: WorkspaceFeatureContext, cancelMask: boolean): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle || !this.selectionModifyActive) return this.unavailable();
  if (cancelMask) {
    const result = handle.features.selections.exitQuickMask(true);
    if (!result.ok) return this.fail(result);
    this.selectionModifyActive = false;
    return this.afterWrite();
  }
  const result = handle.features.selections.exitQuickMask(false);
  if (!result.ok) return this.fail(result);
  this.selectionModifyActive = false;
  return this.afterWrite();
}

/** U21 传统分割草稿（object/sky/focusArea/removeBackground）。 */
export function beginSmartSelect(this: WorkspaceFeatureContext, kind: string, params: Record<string, unknown>): EditorResult<unknown> {
  const ready = canBeginDraft(this);
  if (!ready.ok) return ready;
  return started(this, this.handle!.features.selections.beginSmartSelect(kind, params));
}

/** U22 色彩范围草稿。 */
export function beginColorRange(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<unknown> {
  const ready = canBeginDraft(this);
  if (!ready.ok) return ready;
  return started(this, this.handle!.features.selections.beginColorRange(params));
}

export function updateColorRange(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<unknown> {
  if (!this.handle || !this.selectionModifyActive) return this.unavailable();
  return this.handle.features.selections.updateColorRange(params);
}

/** U23 选择并遮住草稿。 */
export function beginRefineEdge(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<unknown> {
  const ready = canBeginDraft(this);
  if (!ready.ok) return ready;
  return started(this, this.handle!.features.selections.beginRefineEdge(params));
}

export function updateRefineEdge(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<unknown> {
  if (!this.handle || !this.selectionModifyActive) return this.unavailable();
  return this.handle.features.selections.updateRefineEdge(params);
}

/** U24 像素蒙版 density/feather（内容属性，一步历史）。 */
export function editLayerMask(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const result = handle.features.selections.editLayerMask(params);
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

/** U24 蒙版属性视图（只读）。 */
export function layerMaskProperties(this: WorkspaceFeatureContext, layer?: number): EditorResult<unknown> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.selections.layerMaskProperties(layer);
}

/** U24 独立/叠加查看蒙版：查看是会话状态，成功后仍是 `afterWrite()`（内容指纹不变）。 */
export function viewLayerMask(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const result = handle.features.selections.viewLayerMask(params);
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

/** 切文档/切标签前给用户看的原因（本域独占的文案，宿主只负责拦截）。 */
export const SELECTION_DRAFT_SWITCH_REASON = "请先确认或取消选区草稿";

/**
 * 是否存在必须先结算的本域草稿（切文档/切标签/关闭的门禁判定）。
 *
 * 只做只读判定，不改草稿、不写历史；返回原因而不是布尔值，避免调用方各自编一份文案。
 * 内核的 `draftState` 是唯一依据——`selectionModifyActive` 只说明"本域以为自己有草稿"，
 * 万一与内核不同步（例如过期草稿已被丢弃），以内核为准，不误拦用户的切换。
 */
export function unsettledDraftReason(this: WorkspaceFeatureContext): string | null {
  if (!this.handle || !this.view.document) return null;
  const result = this.handle.features.selections.selectionDraftState();
  if (!result.ok) return null;
  const decoded = decodeDraftState(result.value);
  return decoded?.active === true ? SELECTION_DRAFT_SWITCH_REASON : null;
}

/** 草稿是否仍属于同一文档（切换文档后旧候选一律丢弃）。 */
export function draftOwnsDocument(this: WorkspaceFeatureContext, state: unknown, document: number): boolean {
  if (!this.handle || !this.view.document) return false;
  const decoded = decodeDraftState(state);
  if (decoded?.active !== true) return false;
  // `stale` 由内核判定（活动 `DocState::doc.id` 与草稿归属不一致），比界面对 document 号的猜测更可靠。
  return !decoded.stale && decoded.document === document;
}

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    selectLine: (...args: Parameters<OmitThisParameter<typeof selectLine>>) => selectLine.apply(context(), args),
    beginMagneticLasso: (...args: Parameters<OmitThisParameter<typeof beginMagneticLasso>>) => beginMagneticLasso.apply(context(), args),
    updateMagneticLasso: (...args: Parameters<OmitThisParameter<typeof updateMagneticLasso>>) => updateMagneticLasso.apply(context(), args),
    saveNamedSelection: (...args: Parameters<OmitThisParameter<typeof saveNamedSelection>>) => saveNamedSelection.apply(context(), args),
    loadNamedSelection: (...args: Parameters<OmitThisParameter<typeof loadNamedSelection>>) => loadNamedSelection.apply(context(), args),
    beginColorGrow: (...args: Parameters<OmitThisParameter<typeof beginColorGrow>>) => beginColorGrow.apply(context(), args),
    updateColorGrow: (...args: Parameters<OmitThisParameter<typeof updateColorGrow>>) => updateColorGrow.apply(context(), args),
    beginQuickMask: (...args: Parameters<OmitThisParameter<typeof beginQuickMask>>) => beginQuickMask.apply(context(), args),
    paintQuickMask: (...args: Parameters<OmitThisParameter<typeof paintQuickMask>>) => paintQuickMask.apply(context(), args),
    paintQuickMaskStroke: (...args: Parameters<OmitThisParameter<typeof paintQuickMaskStroke>>) => paintQuickMaskStroke.apply(context(), args),
    exitQuickMask: (...args: Parameters<OmitThisParameter<typeof exitQuickMask>>) => exitQuickMask.apply(context(), args),
    beginSmartSelect: (...args: Parameters<OmitThisParameter<typeof beginSmartSelect>>) => beginSmartSelect.apply(context(), args),
    beginColorRange: (...args: Parameters<OmitThisParameter<typeof beginColorRange>>) => beginColorRange.apply(context(), args),
    updateColorRange: (...args: Parameters<OmitThisParameter<typeof updateColorRange>>) => updateColorRange.apply(context(), args),
    beginRefineEdge: (...args: Parameters<OmitThisParameter<typeof beginRefineEdge>>) => beginRefineEdge.apply(context(), args),
    updateRefineEdge: (...args: Parameters<OmitThisParameter<typeof updateRefineEdge>>) => updateRefineEdge.apply(context(), args),
    editLayerMask: (...args: Parameters<OmitThisParameter<typeof editLayerMask>>) => editLayerMask.apply(context(), args),
    layerMaskProperties: (...args: Parameters<OmitThisParameter<typeof layerMaskProperties>>) => layerMaskProperties.apply(context(), args),
    viewLayerMask: (...args: Parameters<OmitThisParameter<typeof viewLayerMask>>) => viewLayerMask.apply(context(), args),
    draftState: () => draftState(context()),
    unsettledDraftReason: () => unsettledDraftReason.call(context()),
    draftOutline: () => draftOutline(context()),
    draftOwnsDocument: (state: unknown, document: number) => draftOwnsDocument.call(context(), state, document),
    commitSelectionDraft: () => commit(context()),
    cancelSelectionDraft: () => cancel(context()),
    // 既有 P5 契约（选区修改草稿）继续走同一套门禁。
    beginSelectionModify: (...args: Parameters<OmitThisParameter<typeof beginSelectionModify>>) => beginSelectionModify.apply(context(), args),
    updateSelectionModify: (...args: Parameters<OmitThisParameter<typeof updateSelectionModify>>) => updateSelectionModify.apply(context(), args),
    commitSelectionModify: (...args: Parameters<OmitThisParameter<typeof commitSelectionModify>>) => commitSelectionModify.apply(context(), args),
    cancelSelectionModify: (...args: Parameters<OmitThisParameter<typeof cancelSelectionModify>>) => cancelSelectionModify.apply(context(), args),
    prepareRefineEdge: (...args: Parameters<OmitThisParameter<typeof prepareRefineEdge>>) => prepareRefineEdge.apply(context(), args),
  };
}

// ------------------------------------------------------------------ 既有 P5 契约

export function beginSelectionModify(this: WorkspaceFeatureContext, params: { operation: "expand" | "contract" | "smooth" | "border" | "feather"; radius: number }): EditorResult<unknown> {
  const ready = selectionSessionHandle(this);
  if (!ready.ok) return ready;
  const result = ready.value.beginSelectionModify(params);
  if (result.ok) this.selectionModifyActive = true;
  return result;
}

export function updateSelectionModify(this: WorkspaceFeatureContext, params: { radius: number }): EditorResult<unknown> {
  if (!this.handle || !this.selectionModifyActive) return this.unavailable();
  return this.handle.updateSelectionModify(params);
}

export function commitSelectionModify(this: WorkspaceFeatureContext): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle || !this.selectionModifyActive) return this.unavailable();
  const result = handle.commitSelectionModify();
  if (!result.ok) return this.fail(result);
  this.selectionModifyActive = false;
  return this.afterWrite();
}

export function cancelSelectionModify(this: WorkspaceFeatureContext): void {
  if (this.selectionModifyActive) this.handle?.cancelSelectionModify();
  this.selectionModifyActive = false;
}

export function prepareRefineEdge(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<unknown> {
  if (!this.handle) return this.unavailable();
  return this.handle.prepareRefineEdge(params);
}
