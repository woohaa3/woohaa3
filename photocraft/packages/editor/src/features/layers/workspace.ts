import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import { isRecord } from "../shared/panels.js";
import {
  LAYER_FILL_KINDS,
  blendingParamError,
  layerCompParamError,
  layerFillParamError,
  layerFilterParamError,
  layerStylePresetParamError,
  mattingParamError,
  type LayerFillKind,
} from "@woohaa3/photocraft-protocol";

/**
 * 填充层（U57）。
 *
 * 三步语义，与其它域的草稿一致：
 * 1. `createFillLayer` 直接建层（一步历史）；
 * 2. `previewFillLayer` 只让内核在隔离会话上算候选像素，正式修订/指纹/历史不变；
 * 3. `applyFillLayer` 重新校验**最新**输入后一步提交，无变化不增历史。
 *
 * 草稿不保存在内核里：预览结果只属于调用方，晚到的预览由宿主代际门禁丢弃，
 * 因此不存在「确认了上一份失败预览」的路径。
 */
export function createFillLayer(this: WorkspaceFeatureContext, kind: LayerFillKind, params: Record<string, unknown>): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  if (!(LAYER_FILL_KINDS as readonly string[]).includes(kind)) return this.fail({ ok: false, code: "bad-params", message: `未知填充层种类：${String(kind)}` });
  const reason = layerFillParamError(kind, params);
  if (reason) return this.fail({ ok: false, code: "bad-params", message: reason });
  const command = kind === "solid" ? "layer.newFillLayer.solidColor" : kind === "gradient" ? "layer.newFillLayer.gradient" : "layer.newFillLayer.pattern";
  const result = handle.features.layers.newFillLayer(command, params);
  if (!result.ok) return this.fail(result);
  this.afterWrite();
  return result;
}

/** 填充层规范参数（只读）：面板重开后仍能改填充参数。 */
export function fillLayerInfo(this: WorkspaceFeatureContext, layer: number): EditorResult<unknown> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.layers.fillLayerInfo(layer);
}

/** 填充参数预览：只返回候选像素与规范参数，不推进正式内容。 */
export function previewFillLayer(this: WorkspaceFeatureContext, layer: number, kind: LayerFillKind, params: Record<string, unknown>): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (this.hasActiveDraft()) return { ok: false, code: "gesture-active", message: "请先结算当前草稿" };
  const reason = layerFillParamError(kind, params);
  if (reason) return this.fail({ ok: false, code: "bad-params", message: reason });
  return handle.features.layers.previewFillLayer(layer, { ...params, fillKind: kind });
}

/** 确认填充参数：重新校验最新输入后一步提交。 */
export function applyFillLayer(this: WorkspaceFeatureContext, layer: number, kind: LayerFillKind, params: Record<string, unknown>): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const reason = layerFillParamError(kind, params);
  if (reason) return this.fail({ ok: false, code: "bad-params", message: reason });
  const result = handle.features.layers.applyFillLayer(layer, { ...params, fillKind: kind });
  if (!result.ok) return this.fail(result);
  // 刷新视图与基线，但把内核的确认结果（含 `changed`）返回给面板。
  this.afterWrite();
  return result;
}

/**
 * 高级混合（U60）：分离端点拖动时逐次预览真实合成过渡，松手才提交。
 *
 * 预览不写文档；提交前用**当前**参数重新计算，因此拖动中失败的中间值不会变成提交值。
 */
export function previewBlending(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (this.hasActiveDraft()) return { ok: false, code: "gesture-active", message: "请先结算当前草稿" };
  const reason = blendingParamError(params);
  if (reason) return this.fail({ ok: false, code: "bad-params", message: reason });
  return handle.features.layers.layerWorkflow("layer.layerStyle.blendingOptions", params, true);
}

export function applyBlending(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const reason = blendingParamError(params);
  if (reason) return this.fail({ ok: false, code: "bad-params", message: reason });
  const result = handle.features.layers.layerWorkflow("layer.layerStyle.blendingOptions", params, false);
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

/**
 * 去边与颜色净化（U62）。
 *
 * `preview` 为真时内核只返回候选像素；确认时一步提交，一次撤销恢复原像素。
 */
export function matting(this: WorkspaceFeatureContext, id: string, params: Record<string, unknown>, preview: boolean): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (preview && this.hasActiveDraft()) return { ok: false, code: "gesture-active", message: "请先结算当前草稿" };
  if (!preview) {
    const blocked = this.blockingDraft();
    if (blocked) return blocked;
  }
  const reason = mattingParamError(id, params);
  if (reason) return this.fail({ ok: false, code: "bad-params", message: reason });
  const result = handle.features.layers.layerWorkflow(id, params, preview);
  if (!result.ok) return this.fail(result);
  if (!preview) return this.afterWrite();
  return result;
}

/** 样式命令（U61）与结构命令（U58/U59）：只有确认路径，均一步提交。 */
export function layerCommand(this: WorkspaceFeatureContext, id: string, params: unknown = null): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const result = handle.features.layers.layerWorkflow(id, params, false);
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

/** 只改会话状态（如样式剪贴板）的命令：文档不变，因此不刷新内容身份。 */
export function copyLayerStyle(this: WorkspaceFeatureContext, layer?: number): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  return handle.features.layers.layerWorkflow("layer.layerStyle.copyLayerStyle", layer === undefined ? null : { layer }, false);
}

/** 图层复合（U64）：命令 + 最新复合列表一起返回，面板无需二次读取。 */
export function layerComp(this: WorkspaceFeatureContext, id: string, params: Record<string, unknown>): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (!id.startsWith("layerComp.")) return this.fail({ ok: false, code: "bad-params", message: `不是图层复合命令：${id}` });
  const reason = layerCompParamError(id, params);
  if (reason) return this.fail({ ok: false, code: "bad-params", message: reason });
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  const result = handle.features.layers.layerWorkflow(id, params, false);
  if (!result.ok) return this.fail(result);
  this.afterWrite();
  const comps = handle.features.layers.layerComps();
  if (!comps.ok) return this.fail(comps);
  // 内核把上游命令自身的报告放在 `result` 里（如缺失层 `warnings`）；面板按报告判断，不能只看到 `changed`。
  const kernel = isRecord(result.value) ? result.value : {};
  const report = isRecord(kernel.result) ? { ...kernel.result, changed: kernel.changed === true } : kernel;
  return { ok: true, value: { result: report, comps: comps.value } };
}

/** 图层复合列表（只读）。 */
export function layerComps(this: WorkspaceFeatureContext, ): EditorResult<unknown> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.layers.layerComps();
}

/** 粘贴入/外的选区与剪贴板前提（只读），面板据此禁用与说明。 */
export function pasteRegion(this: WorkspaceFeatureContext, ): EditorResult<unknown> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.layers.pasteRegion();
}

/**
 * 样式预设管理（U61）：列出、保存、整理、恢复默认。
 *
 * 预设是**会话偏好**而非文档内容，因此这里不调用 `afterWrite()`：不刷新内容身份、不当作
 * 文档改动。面板用返回的 `presetsRevision` 重绘预设列表。
 */
export function stylePresets(this: WorkspaceFeatureContext, id: string, params: unknown = {}): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const reason = layerStylePresetParamError(id, params);
  if (reason) return this.fail({ ok: false, code: "bad-params", message: reason });
  // 预设库是偏好，不阻塞正在进行的文档草稿；但 `new` 读当前层，仍需一个稳定文档。
  return handle.features.layers.stylePresets(id, params);
}

/**
 * 图层过滤（U63）：只读取列表，不改内容/选择/合成。
 *
 * 过滤参数非法时返回明确原因，不静默退回「显示全部」——否则用户会以为过滤生效了。
 */
export function filterLayers(this: WorkspaceFeatureContext, params: { name?: string; kinds?: string[]; by?: "kind" | "name" | "mode"; mode?: string; onlySelected?: boolean }): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    const reason = layerFilterParamError(params);
    if (reason) return this.fail({ ok: false, code: "bad-params", message: reason });
    return this.handle.filterLayers(params);
  }
export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    filterLayers: (...args: Parameters<OmitThisParameter<typeof filterLayers>>) => filterLayers.apply(context(), args),
    createFillLayer: (...args: Parameters<OmitThisParameter<typeof createFillLayer>>) => createFillLayer.apply(context(), args),
    fillLayerInfo: (...args: Parameters<OmitThisParameter<typeof fillLayerInfo>>) => fillLayerInfo.apply(context(), args),
    previewFillLayer: (...args: Parameters<OmitThisParameter<typeof previewFillLayer>>) => previewFillLayer.apply(context(), args),
    applyFillLayer: (...args: Parameters<OmitThisParameter<typeof applyFillLayer>>) => applyFillLayer.apply(context(), args),
    previewBlending: (...args: Parameters<OmitThisParameter<typeof previewBlending>>) => previewBlending.apply(context(), args),
    applyBlending: (...args: Parameters<OmitThisParameter<typeof applyBlending>>) => applyBlending.apply(context(), args),
    matting: (...args: Parameters<OmitThisParameter<typeof matting>>) => matting.apply(context(), args),
    layerCommand: (...args: Parameters<OmitThisParameter<typeof layerCommand>>) => layerCommand.apply(context(), args),
    copyLayerStyle: (...args: Parameters<OmitThisParameter<typeof copyLayerStyle>>) => copyLayerStyle.apply(context(), args),
    layerComp: (...args: Parameters<OmitThisParameter<typeof layerComp>>) => layerComp.apply(context(), args),
    layerComps: (...args: Parameters<OmitThisParameter<typeof layerComps>>) => layerComps.apply(context(), args),
    pasteRegion: (...args: Parameters<OmitThisParameter<typeof pasteRegion>>) => pasteRegion.apply(context(), args),
    stylePresets: (...args: Parameters<OmitThisParameter<typeof stylePresets>>) => stylePresets.apply(context(), args),
  };
}
