import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import type { SmartSourceExport } from "./wasm-handle.js";

/**
 * 智能对象的父层入口（U65/U66）。
 *
 * 「导出源 / 替换源 / 转回图层」只看选中图层自己的源与门禁，**不要求**已打开子文档：
 * `smartChildState().active` 只描述当前子会话，不能控制这些入口。
 */

/** 选中层的源导出：只读，不产生历史、不改会话。 */
export function exportSmartSource(this: WorkspaceFeatureContext, layer: number): EditorResult<SmartSourceExport> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.smart.exportSmartSource(layer);
}

/**
 * 读出选中层的可用性投影（可用入口 + 不可用原因）。
 *
 * 只读：可以在每次渲染时调用，不推进修订/历史。
 */
export function smartLayerState(this: WorkspaceFeatureContext, layer: number): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.smart.smartLayerState(layer);
}

/**
 * 转回图层：解包嵌入源为可编辑层/组（一步历史，只改当前实例）。
 *
 * 与栅格化不同，结果保留源内部层/组；有活动草稿时先拒绝，不自动结算别人的笔迹。
 */
export function convertSmartToLayers(this: WorkspaceFeatureContext, layer: number): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const result = handle.features.smart.convertSmartToLayers(layer);
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    smartLayerState: (...args: Parameters<OmitThisParameter<typeof smartLayerState>>) => smartLayerState.apply(context(), args),
    exportSmartSource: (...args: Parameters<OmitThisParameter<typeof exportSmartSource>>) => exportSmartSource.apply(context(), args),
    convertSmartToLayers: (...args: Parameters<OmitThisParameter<typeof convertSmartToLayers>>) => convertSmartToLayers.apply(context(), args),
  };
}
