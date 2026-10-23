import type { FeatureHandleContext } from "../contracts.js";
import { type EditorResult } from "../../editor-wasm.js";

export function beginCompose(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.beginCompose(id, JSON.stringify(params))));
  }

export function updateCompose(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.updateCompose(JSON.stringify(params))));
  }

export function commitCompose(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.commitCompose()));
  }

export function cancelCompose(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.cancelCompose()));
  }

export function beginMove(this: FeatureHandleContext, params: { x: number; y: number; autoSelect: boolean; duplicate: boolean }): EditorResult<boolean> { return this.call((i) => i.beginMove(JSON.stringify(params))); }

export function beginTransform(this: FeatureHandleContext, selectionOnly = false): EditorResult<void> { return this.call((i) => selectionOnly ? i.beginSelectionTransform() : i.beginTransform()); }

export function previewTransform(this: FeatureHandleContext, matrix: readonly number[]): EditorResult<void> { return this.call((i) => i.previewTransform(JSON.stringify(matrix))); }

export function commitTransform(this: FeatureHandleContext, ): EditorResult<unknown> { return this.call((i) => i.commitTransform()); }

export function cancelTransform(this: FeatureHandleContext, ): EditorResult<void> { return this.call((i) => i.cancelTransform()); }

/** 构图工作流清单（U50–U56）；结构由 `parseWorkflowManifest` 校验。 */
export function workflowManifest(this: FeatureHandleContext): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.workflowManifestJson()));
}

/** 执行一个构图工作流；未开放的命令由内核命令门拒绝。 */
export function runWorkflow(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.runWorkflow(id, JSON.stringify(params))));
}

/**
 * 画板/切片导出计划：`{files:[{fileName,name,rect:[x,y,w,h],kind}]}`。
 *
 * 只返回范围与命名，不写盘；渲染由 `renderRegion` 逐项完成，落盘走宿主的文件交付端口。
 */
export function compositionExportPlan(this: FeatureHandleContext, kind: "slices" | "artboards"): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.compositionExportPlanJson(kind)));
}

/** 把计划里的一项导出成 PNG 字节；编码在内核完成，宿主只负责交付。 */
export function compositionExportPng(
  this: FeatureHandleContext,
  rect: { x: number; y: number; width: number; height: number }
): EditorResult<Uint8Array> {
  return this.call((i) => i.compositionExportPng(JSON.stringify(rect))) as EditorResult<Uint8Array>;
}

export function createHandle(context: () => FeatureHandleContext) {
  return {
    beginCompose: (...args: Parameters<OmitThisParameter<typeof beginCompose>>) => beginCompose.apply(context(), args),
    updateCompose: (...args: Parameters<OmitThisParameter<typeof updateCompose>>) => updateCompose.apply(context(), args),
    commitCompose: (...args: Parameters<OmitThisParameter<typeof commitCompose>>) => commitCompose.apply(context(), args),
    cancelCompose: (...args: Parameters<OmitThisParameter<typeof cancelCompose>>) => cancelCompose.apply(context(), args),
    beginMove: (...args: Parameters<OmitThisParameter<typeof beginMove>>) => beginMove.apply(context(), args),
    beginTransform: (...args: Parameters<OmitThisParameter<typeof beginTransform>>) => beginTransform.apply(context(), args),
    previewTransform: (...args: Parameters<OmitThisParameter<typeof previewTransform>>) => previewTransform.apply(context(), args),
    commitTransform: (...args: Parameters<OmitThisParameter<typeof commitTransform>>) => commitTransform.apply(context(), args),
    cancelTransform: (...args: Parameters<OmitThisParameter<typeof cancelTransform>>) => cancelTransform.apply(context(), args),
    workflowManifest: (...args: Parameters<OmitThisParameter<typeof workflowManifest>>) => workflowManifest.apply(context(), args),
    runWorkflow: (...args: Parameters<OmitThisParameter<typeof runWorkflow>>) => runWorkflow.apply(context(), args),
    compositionExportPlan: (...args: Parameters<OmitThisParameter<typeof compositionExportPlan>>) => compositionExportPlan.apply(context(), args),
    compositionExportPng: (...args: Parameters<OmitThisParameter<typeof compositionExportPng>>) => compositionExportPng.apply(context(), args),
  };
}
