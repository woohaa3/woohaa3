import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorResult } from "../../editor-wasm.js";
import { isRecord } from "../shared/panels.js";

export function histogram(this: WorkspaceFeatureContext, params: { source?: "layer" | "composite"; channel?: "rgb" | "luminance" } = {}): EditorResult<unknown> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const result = handle.histogram(params);
    if (!result.ok) return result;
    // 代际核对：调用方拿到的结果必须属于当前文档修订。
    const generation = this.view.document?.revision ?? 0;
    const value = result.value;
    if (isRecord(value) && typeof value.generation === "number" && generation !== 0 && value.generation !== generation) {
      return { ok: false, code: "stale", message: "直方图结果属于旧修订，已丢弃" };
    }
    return result;
  }

/**
 * 本域可开始的调整入口（唯一命令门的真实结果）。
 *
 * 界面只渲染这里列出的条目；未开放的类型/命令即使在本域已实现也不显示，避免出现点了才失败的
 * 菜单占位。
 */
export function directAdjustmentTargets(this: WorkspaceFeatureContext): EditorResult<unknown> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    return handle.features.adjustments.directAdjustmentTargets();
  }

/**
 * 图像 ▸ 调整：直接在像素层上开始草稿。
 *
 * 与调整层共用同一草稿槽；`layer` 省略时用活动层，是否可写（像素层、未锁定、非文字/智能对象）
 * 由内核判定，界面不复制这套规则。
 */
export function beginDirectAdjustment(this: WorkspaceFeatureContext, target: string, params: unknown, layer?: number): EditorResult<unknown> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const blocked = this.blockingDraft();
    if (blocked) return this.fail(blocked);
    return handle.features.adjustments.beginDirectAdjustment(target, params, layer);
  }

/** 更新直接调整草稿；失败的更新会让草稿不可确认（内核语义）。 */
export function previewDirectAdjustment(this: WorkspaceFeatureContext, params: unknown): EditorResult<unknown> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    return handle.features.adjustments.previewAdjustment(params);
  }

/** 确认直接调整：内核只增加一步历史，不新增图层；提交后发布新视图。 */
export function commitDirectAdjustment(this: WorkspaceFeatureContext, ): EditorResult<unknown> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const result = handle.features.adjustments.commitAdjustment();
    if (!result.ok) return this.fail(result);
    const published = this.afterWrite();
    return published.ok ? { ok: true, value: result.value } : this.fail(published);
  }

export function cancelDirectAdjustment(this: WorkspaceFeatureContext, ): void {
    this.handle?.features.adjustments.cancelAdjustment();
  }

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    histogram: (...args: Parameters<OmitThisParameter<typeof histogram>>) => histogram.apply(context(), args),
    directAdjustmentTargets: (...args: Parameters<OmitThisParameter<typeof directAdjustmentTargets>>) => directAdjustmentTargets.apply(context(), args),
    beginDirectAdjustment: (...args: Parameters<OmitThisParameter<typeof beginDirectAdjustment>>) => beginDirectAdjustment.apply(context(), args),
    previewDirectAdjustment: (...args: Parameters<OmitThisParameter<typeof previewDirectAdjustment>>) => previewDirectAdjustment.apply(context(), args),
    commitDirectAdjustment: (...args: Parameters<OmitThisParameter<typeof commitDirectAdjustment>>) => commitDirectAdjustment.apply(context(), args),
    cancelDirectAdjustment: (...args: Parameters<OmitThisParameter<typeof cancelDirectAdjustment>>) => cancelDirectAdjustment.apply(context(), args),
  };
}
