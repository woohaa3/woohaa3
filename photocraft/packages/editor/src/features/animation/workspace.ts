import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import type { AnimationFrameImport, AnimationNavigation } from "@woohaa3/photocraft-protocol";

/** 帧导入结果：域载荷 + 写入后的视图（界面一次拿到两者，不必再取一次状态）。 */
export type AnimationImportResult = { imported: AnimationFrameImport; view: EditorViewModel };

/**
 * 时间轴、视频图层与帧交付的域会话（U77）。
 *
 * 事务边界与其它域一致：
 * - **写入**（建时间轴、改属性、帧编辑、帧导入、写回帧栈）先过共享草稿门禁，成功一次
 *   `afterWrite()`；失败保留现场（内核在写入前完成预算校验）。
 * - **导航**（定位/步进）不是内容写入：内核不记历史，这里也不走草稿门禁——播放与定位在
 *   草稿未结算时也必须可读（spec：草稿阻塞写入但不阻塞导航读取）。
 * - **交付**（交付计划、渲染帧、GIF 编码）读的是当前显示内容，因此与写入同一套草稿门禁：
 *   预览未结算时交付会把预览烧进结果（spec：非法最后输入不能提交旧候选）。
 * - 其余**只读**（时间轴信息）不推进修订。
 */

function blocked(this: WorkspaceFeatureContext): EditorResult<never> | null {
  const draft = this.blockingDraft();
  return draft ? (draft as EditorResult<never>) : null;
}

export function timelineInfo(this: WorkspaceFeatureContext): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.animation.timelineJson();
}

export function createTimeline(this: WorkspaceFeatureContext, params: Record<string, unknown> = {}): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blockedResult = blocked.call(this);
  if (blockedResult) return blockedResult;
  const result = handle.features.animation.createTimeline(params);
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

export function setTimelineProps(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blockedResult = blocked.call(this);
  if (blockedResult) return blockedResult;
  const result = handle.features.animation.setTimelineProps(params);
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

/**
 * 删除时间轴。
 *
 * 走域会话而不是裸 `controller.dispatch`：与其它时间轴写入共用同一套草稿/冻结门禁与
 * `afterWrite`，界面只拿到一种结果形状，也不必知道命令 id。
 */
export function deleteTimeline(this: WorkspaceFeatureContext): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blockedResult = blocked.call(this);
  if (blockedResult) return blockedResult;
  const result = handle.execute("timeline.delete", null);
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

/**
 * 定位/步进。返回内核的 `{result, historyAdded}`；`historyAdded` 必须为 0。
 *
 * 导航会切换文档的显示内容，因此仍需刷新视图（`afterWrite`），但内容身份不变，故不会让
 * 文档变脏——播放几百帧不会产出几百步历史，也不会把未修改的文档标成未保存。
 */
export function navigateTimeline(this: WorkspaceFeatureContext, id: string, params: Record<string, unknown> = {}): EditorResult<AnimationNavigation & { view: EditorViewModel }> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const result = handle.features.animation.navigateTimeline(id, params);
  if (!result.ok) return this.fail(result);
  const view = this.afterWrite();
  if (!view.ok) return view;
  const navigation = result.value as Partial<AnimationNavigation> | null;
  return { ok: true, value: { result: navigation?.result ?? null, historyAdded: navigation?.historyAdded ?? 0, view: view.value } };
}

export function videoLayerCommand(this: WorkspaceFeatureContext, id: string, params: Record<string, unknown> = {}): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blockedResult = blocked.call(this);
  if (blockedResult) return blockedResult;
  const result = handle.features.animation.videoLayerCommand(id, params);
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

export function importFrames(this: WorkspaceFeatureContext, request: {
  name: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  pixels: Uint8Array;
}): EditorResult<AnimationImportResult> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blockedResult = blocked.call(this);
  if (blockedResult) return blockedResult;
  const result = handle.features.animation.importFrames(request);
  if (!result.ok) return this.fail(result);
  const view = this.afterWrite();
  if (!view.ok) return view;
  return { ok: true, value: { imported: result.value as AnimationFrameImport, view: view.value } };
}

export function deliveryPlan(this: WorkspaceFeatureContext): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  // 交付读的是内核当前显示内容：草稿（滤镜/修饰/笔触预览）未结算时会把预览当成正式帧交付。
  // 因此与写入同一套门禁：先结算或取消草稿，再交付。
  const blockedResult = blocked.call(this);
  if (blockedResult) return blockedResult;
  return handle.features.animation.deliveryPlan();
}

export function renderFrame(this: WorkspaceFeatureContext, frame: number): EditorResult<Uint8Array> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (!Number.isSafeInteger(frame) || frame < 0) {
    return { ok: false, code: "command-failed", message: "帧号必须是非负整数" };
  }
  const blockedResult = blocked.call(this);
  if (blockedResult) return blockedResult;
  return handle.features.animation.renderFrame(frame);
}

export function renderAnimationGif(this: WorkspaceFeatureContext): EditorResult<Uint8Array> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blockedResult = blocked.call(this);
  if (blockedResult) return blockedResult;
  return handle.features.animation.renderAnimationGif();
}

/**
 * 把当前显示内容写回所在帧（保存/交付前）。
 *
 * 不新增历史步骤；有活动草稿时与其它写入一样先过共享草稿门禁，内核另有一层 `draft-active`
 * 报告作为纵深防御。返回值同时给出内核的写回报告（`written`/`reason`）与实际写回后的视图，
 * 界面不必猜。
 */
export function flushVideoFrames(this: WorkspaceFeatureContext): EditorResult<{ flushed: unknown; view?: EditorViewModel }> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blockedResult = blocked.call(this);
  if (blockedResult) return blockedResult;
  const result = handle.features.animation.flushVideoFrames();
  if (!result.ok) return this.fail(result);
  const flushed = result.value as { written?: boolean } | null;
  if (flushed?.written !== true) return { ok: true, value: { flushed: result.value } };
  // 帧栈变了但画面不变；仍刷新一次视图，让修订号与内容状态同步。
  const view = this.afterWrite();
  if (!view.ok) return view;
  return { ok: true, value: { flushed: result.value, view: view.value } };
}

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    timelineInfo: () => timelineInfo.apply(context()),
    createTimeline: (...args: Parameters<OmitThisParameter<typeof createTimeline>>) => createTimeline.apply(context(), args),
    setTimelineProps: (...args: Parameters<OmitThisParameter<typeof setTimelineProps>>) => setTimelineProps.apply(context(), args),
    deleteTimeline: () => deleteTimeline.apply(context()),
    navigateTimeline: (...args: Parameters<OmitThisParameter<typeof navigateTimeline>>) => navigateTimeline.apply(context(), args),
    videoLayerCommand: (...args: Parameters<OmitThisParameter<typeof videoLayerCommand>>) => videoLayerCommand.apply(context(), args),
    importFrames: (...args: Parameters<OmitThisParameter<typeof importFrames>>) => importFrames.apply(context(), args),
    deliveryPlan: () => deliveryPlan.apply(context()),
    renderFrame: (...args: Parameters<OmitThisParameter<typeof renderFrame>>) => renderFrame.apply(context(), args),
    renderAnimationGif: () => renderAnimationGif.apply(context()),
    flushVideoFrames: () => flushVideoFrames.apply(context())
  };
}
