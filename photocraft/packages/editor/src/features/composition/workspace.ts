import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";

export function beginCompose(this: WorkspaceFeatureContext, id: string, params: unknown): EditorResult<unknown> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    if (this.hasActiveDraft()) return { ok: false, code: "gesture-active", message: "请先结算当前草稿" };
    const result = handle.beginCompose(id, params);
    if (result.ok) this.composeActive = true;
    return result;
  }

export function updateCompose(this: WorkspaceFeatureContext, params: unknown): EditorResult<unknown> {
    if (!this.handle || !this.composeActive) return this.unavailable();
    return this.handle.updateCompose(params);
  }

export function commitCompose(this: WorkspaceFeatureContext, ): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle || !this.composeActive) return this.unavailable();
    const result = handle.commitCompose();
    this.composeActive = false;
    if (!result.ok) { handle.cancelCompose(); return this.fail(result); }
    return this.afterWrite();
  }

export function cancelCompose(this: WorkspaceFeatureContext, ): void {
    if (this.composeActive) this.handle?.cancelCompose();
    this.composeActive = false;
  }

export function hasCompose(this: WorkspaceFeatureContext, ): boolean {
    return this.composeActive;
  }

/**
 * 构图工作流清单：只读探测，不改变文档，也不进入草稿门禁。
 *
 * 经 `handle.features.composition` 访问域端口，而不是往共享 `EditorHandle` 上加同名方法：
 * `editor-wasm.ts` 是单一写入的共享核心，域能力只经 handle 注册表暴露。
 */
export function workflowManifest(this: WorkspaceFeatureContext): EditorResult<unknown> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    return handle.features.composition.workflowManifest();
  }

/**
 * 执行一个构图工作流（U50–U56）。
 *
 * 与 `dispatch` 相同的写入约束：草稿/导出期间拒绝，成功后统一刷新视图模型。
 */
export function runWorkflow(this: WorkspaceFeatureContext, id: string, params: unknown): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const blocked = this.blockingDraft();
    if (blocked) return blocked;
    const result = handle.features.composition.runWorkflow(id, params);
    if (!result.ok) return this.fail(result);
    return this.afterWrite();
  }

/**
 * 画板/切片导出计划（U56）：只读，不写修订、不进历史。
 *
 * 与 `runWorkflow` 共用草稿门禁：有未结算草稿时拒绝，避免导出的范围与画布上看到的不一致。
 */
export function compositionExportPlan(this: WorkspaceFeatureContext, kind: "slices" | "artboards"): EditorResult<unknown> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const blocked = this.blockingDraft();
    if (blocked) return blocked;
    return handle.features.composition.compositionExportPlan(kind);
  }

/** 把计划里的一项渲染成 PNG 字节；编码在内核完成，本层不引入第二套编码器。 */
export function compositionExportPng(
    this: WorkspaceFeatureContext,
    rect: { x: number; y: number; width: number; height: number }
  ): EditorResult<Uint8Array> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const blocked = this.blockingDraft();
    if (blocked) return blocked;
    return handle.features.composition.compositionExportPng(rect);
  }

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    beginCompose: (...args: Parameters<OmitThisParameter<typeof beginCompose>>) => beginCompose.apply(context(), args),
    updateCompose: (...args: Parameters<OmitThisParameter<typeof updateCompose>>) => updateCompose.apply(context(), args),
    commitCompose: (...args: Parameters<OmitThisParameter<typeof commitCompose>>) => commitCompose.apply(context(), args),
    cancelCompose: (...args: Parameters<OmitThisParameter<typeof cancelCompose>>) => cancelCompose.apply(context(), args),
    hasCompose: (...args: Parameters<OmitThisParameter<typeof hasCompose>>) => hasCompose.apply(context(), args),
    workflowManifest: (...args: Parameters<OmitThisParameter<typeof workflowManifest>>) => workflowManifest.apply(context(), args),
    runWorkflow: (...args: Parameters<OmitThisParameter<typeof runWorkflow>>) => runWorkflow.apply(context(), args),
    compositionExportPlan: (...args: Parameters<OmitThisParameter<typeof compositionExportPlan>>) => compositionExportPlan.apply(context(), args),
    compositionExportPng: (...args: Parameters<OmitThisParameter<typeof compositionExportPng>>) => compositionExportPng.apply(context(), args),
  };
}
