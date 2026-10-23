import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorPreview, EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";

/**
 * 通道域会话端口（change: 2026-10-22-add-photocraft-channel-workflows，U25/U26）。
 *
 * 事务规则（design D3）：应用图像/计算只有**隔离预览**（在会话副本上跑一次，正式文档、
 * 修订、指纹与历史都不变）；确认时用**当前**参数重跑同一条命令，因此旧预览不可能被当成新
 * 内容提交，取消就是不提交。结构操作（新建/改名/排序/拆合…）立即生效并由 `afterWrite()`
 * 统一刷新视图、命令表与净变化。
 */

/** 通道读取不写文档，但仍要等编辑器就绪。 */
export function channelSnapshot(this: WorkspaceFeatureContext): EditorResult<unknown> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.channels.channelSnapshot();
}

export function channelThumbnail(this: WorkspaceFeatureContext, reference: unknown, maxSide: number): EditorResult<EditorPreview> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.channels.channelThumbnail(reference, maxSide);
}

/** 当前通道视图（单通道灰度或合成）；只跟随查看态，不改变编辑目标。 */
export function channelViewPreview(this: WorkspaceFeatureContext, maxSide: number): EditorResult<EditorPreview> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.channels.channelViewPreview(maxSide);
}

export function previewChannelCommand(
  this: WorkspaceFeatureContext,
  id: string,
  params: unknown,
  maxSide: number
): EditorResult<{ preview: EditorPreview; summary: unknown }> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  // 预览失败只回给面板（草稿不成立），不把工作区标成 failed。
  const preview = handle.features.channels.channelCalcPreview(id, params, maxSide);
  if (!preview.ok) return preview;
  const summary = handle.features.channels.channelCalcPreviewSummary(id, params, maxSide);
  if (!summary.ok) return summary;
  return { ok: true, value: { preview: preview.value, summary: summary.value } };
}

/** 确认一次：用当前参数重跑命令，只有一步历史。 */
export function channelCommand(this: WorkspaceFeatureContext, id: string, params: unknown): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  // 冻结/保存期间的写入由面板的 `readonly`（工作区 `locked`）挡住；导出竞态另由内核复核命令门。
  const result = handle.features.channels.channelCommand(id, params ?? null);
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    channelSnapshot: (...args: Parameters<OmitThisParameter<typeof channelSnapshot>>) => channelSnapshot.apply(context(), args),
    channelThumbnail: (...args: Parameters<OmitThisParameter<typeof channelThumbnail>>) => channelThumbnail.apply(context(), args),
    channelViewPreview: (...args: Parameters<OmitThisParameter<typeof channelViewPreview>>) => channelViewPreview.apply(context(), args),
    previewChannelCommand: (...args: Parameters<OmitThisParameter<typeof previewChannelCommand>>) => previewChannelCommand.apply(context(), args),
    channelCommand: (...args: Parameters<OmitThisParameter<typeof channelCommand>>) => channelCommand.apply(context(), args)
  };
}
