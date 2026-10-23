import type { FeatureHandleContext } from "../contracts.js";
import { type EditorFailure, type EditorResult } from "../../editor-wasm.js";

/**
 * 本域 WASM 适配（U17–U24）。
 *
 * 新入口先检查 glue 是否真的导出对应方法：加载到旧运行时（或只装配部分端口的宿主、内核替身）
 * 时返回明确的 `capability-unavailable`，而不是抛 `TypeError`，也不在编译期要求所有宿主都实现
 * 新导出。这也是 spec「加载旧运行时必须拒绝相关写入」的那条路径。
 */

/** 本域导出缺失时的统一失败（不猜测能力，不放行写入）。 */
export function missingExport(name: string): EditorFailure {
  return { ok: false, code: "capability-unavailable", message: `当前运行时缺少“${name}”导出，请更新编辑内核` };
}

/** 确认某个导出存在；缺失时返回统一失败，否则 `null`。 */
function missing(context: FeatureHandleContext, name: string): EditorFailure | null {
  const method = (context.instance as unknown as Record<string, unknown>)[name];
  return typeof method === "function" ? null : missingExport(name);
}

export function beginSelectionModify(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.beginSelectionModify(JSON.stringify(params))));
}

export function updateSelectionModify(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.updateSelectionModify(JSON.stringify(params))));
}

export function commitSelectionModify(this: FeatureHandleContext): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.commitSelectionModify()));
}

export function cancelSelectionModify(this: FeatureHandleContext): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.cancelSelectionModify()));
}

export function prepareRefineEdge(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.prepareRefineEdge(JSON.stringify(params))));
}

// ------------------------------------------------------------------ U17–U24

/** U17 单行/单列：一次命中即一步历史。 */
export function selectLine(this: FeatureHandleContext, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "selectLine");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.selectLine!(JSON.stringify(params))));
}

/** U18 多边形/磁性套索。 */
export function beginMagneticLasso(this: FeatureHandleContext, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "beginMagneticLasso");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.beginMagneticLasso!(JSON.stringify(params))));
}

export function updateMagneticLasso(this: FeatureHandleContext, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "updateMagneticLasso");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.updateMagneticLasso!(JSON.stringify(params))));
}

/** U19 命名选区。 */
export function saveNamedSelection(this: FeatureHandleContext, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "saveNamedSelection");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.saveNamedSelection!(JSON.stringify(params))));
}

export function loadNamedSelection(this: FeatureHandleContext, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "loadNamedSelection");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.loadNamedSelection!(JSON.stringify(params))));
}

/** U19 按颜色扩大（`similar=false`）或选取相似（`similar=true`）。 */
export function beginColorGrow(this: FeatureHandleContext, similar: boolean, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "beginColorGrow");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.beginColorGrow!(similar, JSON.stringify(params))));
}

export function updateColorGrow(this: FeatureHandleContext, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "updateColorGrow");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.updateColorGrow!(JSON.stringify(params))));
}

/** U20 快速蒙版会话。 */
export function beginQuickMask(this: FeatureHandleContext): EditorResult<unknown> {
  const absent = missing(this, "beginQuickMask");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.beginQuickMask!()));
}

export function paintQuickMask(this: FeatureHandleContext, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "paintQuickMask");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.paintQuickMask!(JSON.stringify(params))));
}

export function exitQuickMask(this: FeatureHandleContext, cancel: boolean): EditorResult<unknown> {
  const absent = missing(this, "exitQuickMask");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.exitQuickMask!(cancel)));
}

/** U21 传统分割（object/sky/focusArea/removeBackground）。 */
export function beginSmartSelect(this: FeatureHandleContext, kind: string, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "beginSmartSelect");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.beginSmartSelect!(kind, JSON.stringify(params))));
}

/** U22 色彩范围。 */
export function beginColorRange(this: FeatureHandleContext, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "beginColorRange");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.beginColorRange!(JSON.stringify(params))));
}

export function updateColorRange(this: FeatureHandleContext, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "updateColorRange");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.updateColorRange!(JSON.stringify(params))));
}

/** U23 选择并遮住。 */
export function beginRefineEdge(this: FeatureHandleContext, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "beginRefineEdge");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.beginRefineEdge!(JSON.stringify(params))));
}

export function updateRefineEdge(this: FeatureHandleContext, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "updateRefineEdge");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.updateRefineEdge!(JSON.stringify(params))));
}

/** U24 像素蒙版属性与查看模式。 */
export function editLayerMask(this: FeatureHandleContext, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "editLayerMask");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.editLayerMask!(JSON.stringify(params))));
}

export function layerMaskProperties(this: FeatureHandleContext, layer?: number): EditorResult<unknown> {
  const absent = missing(this, "layerMaskProperties");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.layerMaskProperties!(layer)));
}

export function viewLayerMask(this: FeatureHandleContext, params: Record<string, unknown>): EditorResult<unknown> {
  const absent = missing(this, "viewLayerMask");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.viewLayerMask!(JSON.stringify(params))));
}

/** 通用草稿：视图、边界、确认、取消。 */
export function selectionDraftState(this: FeatureHandleContext): EditorResult<unknown> {
  const absent = missing(this, "selectionDraftStateJson");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.selectionDraftStateJson!()));
}

export function selectionDraftOutline(this: FeatureHandleContext): EditorResult<unknown> {
  const absent = missing(this, "selectionDraftOutlineJson");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.selectionDraftOutlineJson!()));
}

export function commitSelectionDraft(this: FeatureHandleContext): EditorResult<unknown> {
  const absent = missing(this, "commitSelectionDraft");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.commitSelectionDraft!()));
}

export function cancelSelectionDraft(this: FeatureHandleContext): EditorResult<unknown> {
  const absent = missing(this, "cancelSelectionDraft");
  if (absent) return absent;
  return this.call((i) => JSON.parse(i.cancelSelectionDraft!()));
}

export function createHandle(context: () => FeatureHandleContext) {
  return {
    beginSelectionModify: (...args: Parameters<OmitThisParameter<typeof beginSelectionModify>>) => beginSelectionModify.apply(context(), args),
    updateSelectionModify: (...args: Parameters<OmitThisParameter<typeof updateSelectionModify>>) => updateSelectionModify.apply(context(), args),
    commitSelectionModify: (...args: Parameters<OmitThisParameter<typeof commitSelectionModify>>) => commitSelectionModify.apply(context(), args),
    cancelSelectionModify: (...args: Parameters<OmitThisParameter<typeof cancelSelectionModify>>) => cancelSelectionModify.apply(context(), args),
    prepareRefineEdge: (...args: Parameters<OmitThisParameter<typeof prepareRefineEdge>>) => prepareRefineEdge.apply(context(), args),
    selectLine: (...args: Parameters<OmitThisParameter<typeof selectLine>>) => selectLine.apply(context(), args),
    beginMagneticLasso: (...args: Parameters<OmitThisParameter<typeof beginMagneticLasso>>) => beginMagneticLasso.apply(context(), args),
    updateMagneticLasso: (...args: Parameters<OmitThisParameter<typeof updateMagneticLasso>>) => updateMagneticLasso.apply(context(), args),
    saveNamedSelection: (...args: Parameters<OmitThisParameter<typeof saveNamedSelection>>) => saveNamedSelection.apply(context(), args),
    loadNamedSelection: (...args: Parameters<OmitThisParameter<typeof loadNamedSelection>>) => loadNamedSelection.apply(context(), args),
    beginColorGrow: (...args: Parameters<OmitThisParameter<typeof beginColorGrow>>) => beginColorGrow.apply(context(), args),
    updateColorGrow: (...args: Parameters<OmitThisParameter<typeof updateColorGrow>>) => updateColorGrow.apply(context(), args),
    beginQuickMask: (...args: Parameters<OmitThisParameter<typeof beginQuickMask>>) => beginQuickMask.apply(context(), args),
    paintQuickMask: (...args: Parameters<OmitThisParameter<typeof paintQuickMask>>) => paintQuickMask.apply(context(), args),
    exitQuickMask: (...args: Parameters<OmitThisParameter<typeof exitQuickMask>>) => exitQuickMask.apply(context(), args),
    beginSmartSelect: (...args: Parameters<OmitThisParameter<typeof beginSmartSelect>>) => beginSmartSelect.apply(context(), args),
    beginColorRange: (...args: Parameters<OmitThisParameter<typeof beginColorRange>>) => beginColorRange.apply(context(), args),
    updateColorRange: (...args: Parameters<OmitThisParameter<typeof updateColorRange>>) => updateColorRange.apply(context(), args),
    beginRefineEdge: (...args: Parameters<OmitThisParameter<typeof beginRefineEdge>>) => beginRefineEdge.apply(context(), args),
    updateRefineEdge: (...args: Parameters<OmitThisParameter<typeof updateRefineEdge>>) => updateRefineEdge.apply(context(), args),
    editLayerMask: (...args: Parameters<OmitThisParameter<typeof editLayerMask>>) => editLayerMask.apply(context(), args),
    layerMaskProperties: (...args: Parameters<OmitThisParameter<typeof layerMaskProperties>>) => layerMaskProperties.apply(context(), args),
    viewLayerMask: (...args: Parameters<OmitThisParameter<typeof viewLayerMask>>) => viewLayerMask.apply(context(), args),
    selectionDraftState: (...args: Parameters<OmitThisParameter<typeof selectionDraftState>>) => selectionDraftState.apply(context(), args),
    selectionDraftOutline: (...args: Parameters<OmitThisParameter<typeof selectionDraftOutline>>) => selectionDraftOutline.apply(context(), args),
    commitSelectionDraft: (...args: Parameters<OmitThisParameter<typeof commitSelectionDraft>>) => commitSelectionDraft.apply(context(), args),
    cancelSelectionDraft: (...args: Parameters<OmitThisParameter<typeof cancelSelectionDraft>>) => cancelSelectionDraft.apply(context(), args),
  };
}
