import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorFailure, EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import type { MeasurementLog, SamplerReadout, ViewAids, ViewSnapshot } from "./decode.js";
import { decodeViewAids } from "./decode.js";
import type { ViewPointerAction } from "./wasm-handle.js";

/**
 * 本域会话（U70–U73）。
 *
 * 归属规则（design D3）：
 * - **会话/偏好**：视图辅助、旋转、多视图、取样点 —— 只刷新只读视图，不推进保存基线；
 * - **文档数据**：参考线、标尺原点、计数、测量比例/标尺、注释 —— 有历史，但内容 hash 不变
 *   （它们不是像素），因此仍刷新视图模型让修订与命令表更新。
 *
 * 写入一律先过共享草稿门禁；冻结/保存期间与其它域一样拒绝写入，而不是让命令落到旧文档上。
 * 新入口都走 `handle.features.views`（本域适配），不扩充共享 facade。
 */

/** 文档类操作：参考线/原点/计数/测量/注释走历史，刷新视图模型但不改内容身份。 */
function documentWrite(this: WorkspaceFeatureContext, result: EditorResult<unknown>): EditorResult<EditorViewModel> {
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

/** 共享草稿门禁：写入前必须没有未结算的笔迹/草稿。 */
function writable(this: WorkspaceFeatureContext): EditorFailure | null {
  return this.blockingDraft() ?? this.frozen();
}

/**
 * 视图辅助状态（会话偏好）。
 *
 * 返回内核原始 JSON：共享 facade `controller.viewAids()` 的既有契约就是 `unknown`，界面用
 * [`decodeViewAids`] 在显示边界做有界解码。这里擅自改成强类型会让同一个方法对宿主暴露两种形状。
 */
export function viewAids(this: WorkspaceFeatureContext): EditorResult<unknown> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.views.viewAids();
}

export function setViewAids(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<unknown> {
  if (!this.handle) return this.unavailable();
  // 视图辅助是会话偏好：不参与草稿门禁；失败原样上报（已接受的字段保持，不回滚）。
  return this.handle.features.views.setViewAids(params);
}

export function snapPoint(this: WorkspaceFeatureContext, point: [number, number], zoom: number, tolerance = 6): EditorResult<unknown> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.views.snapPoint({ point, zoom, tolerance });
}

export function guideCommand(this: WorkspaceFeatureContext, id: string, params: unknown): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = writable.call(this);
  if (blocked) return blocked;
  return documentWrite.call(this, handle.features.views.guideCommand(id, params));
}

/** 参考线布局（U71）：列/行/间距/边距、从形状建线、清空画布参考线。 */
export function guideLayoutCommand(this: WorkspaceFeatureContext, id: string, params: unknown): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = writable.call(this);
  if (blocked) return blocked;
  return documentWrite.call(this, handle.features.views.guideLayoutCommand(id, params));
}

/** 逐项声明的视图/分析命令（取样、测量、计数、注释）。 */
export function viewCommand(this: WorkspaceFeatureContext, id: string, params: unknown): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = writable.call(this);
  if (blocked) return blocked;
  return documentWrite.call(this, handle.features.views.viewCommand(id, params));
}

/**
 * 只读命令：取样点列表、测量日志、注释列表、分析信息。
 *
 * 单独一个入口是为了让界面在只读文档下也能看读数——它们不发历史、不写文档，因此失败也不把
 * 工作区标成 failed。
 */
export function viewRead(this: WorkspaceFeatureContext, id: string, params: unknown = {}): EditorResult<unknown> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.views.viewCommand(id, params);
}

export function viewSnapshot(this: WorkspaceFeatureContext): EditorResult<ViewSnapshot> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.views.viewSnapshot();
}

export function samplerReadout(this: WorkspaceFeatureContext, index: number): EditorResult<SamplerReadout | null> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.views.samplerReadout(index);
}

export function formatLength(this: WorkspaceFeatureContext, px: number, unit: string): EditorResult<{ text: string; unit: string }> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.views.formatLength(px, unit);
}

export function measurementLog(this: WorkspaceFeatureContext): EditorResult<MeasurementLog | null> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.views.measurementLog();
}

/**
 * 画布指针几何（U70/U72）：命中参考线、拖动参考线、拖动标尺原点。
 *
 * 只读：命中与拖动候选都不写文档、不造历史，因此不过草稿门禁——正在落笔时也允许查询命中
 * （取消拖动只丢草稿，参考线仍是上一份有效位置）。
 */
export function viewPointer(
  this: WorkspaceFeatureContext,
  action: ViewPointerAction,
  client: readonly [number, number],
  extra: { vertical?: boolean; tolerance?: number; viewId?: string } = {},
) {
  if (!this.handle) return this.unavailable();
  return this.handle.features.views.viewPointer(action, client, extra);
}

/** 旋转视图（会话）：`degrees` 或 `"reset"`；不影响像素与内容身份。 */export function rotateView(this: WorkspaceFeatureContext, degrees: number | "reset"): EditorResult<unknown> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.views.setViewAids({ rotation: degrees });
}

/** 多视图动作（会话）：`new` / `close` / `activate`。 */
export function viewAction(this: WorkspaceFeatureContext, action: "new" | "close" | "activate", viewId?: string): EditorResult<unknown> {
  if (!this.handle) return this.unavailable();
  return this.handle.features.views.setViewAids(viewId ? { viewAction: action, viewId } : { viewAction: action });
}

/** 有界解码的视图辅助状态（新界面用；失败返回 `null` 由界面报错）。 */
export function viewAidsState(this: WorkspaceFeatureContext): ViewAids | null {
  const handle = this.handle;
  if (!handle) return null;
  const result = handle.features.views.viewAids();
  return result.ok ? decodeViewAids(result.value) : null;
}

/** 取样点列表（`view.colorSamplers.list`），会话数据。 */
export function samplerList(this: WorkspaceFeatureContext): EditorResult<unknown> {
  return viewRead.call(this, "view.colorSamplers.list");
}

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    viewAids: (...args: Parameters<OmitThisParameter<typeof viewAids>>) => viewAids.apply(context(), args),
    setViewAids: (...args: Parameters<OmitThisParameter<typeof setViewAids>>) => setViewAids.apply(context(), args),
    snapPoint: (...args: Parameters<OmitThisParameter<typeof snapPoint>>) => snapPoint.apply(context(), args),
    guideCommand: (...args: Parameters<OmitThisParameter<typeof guideCommand>>) => guideCommand.apply(context(), args),
    guideLayoutCommand: (...args: Parameters<OmitThisParameter<typeof guideLayoutCommand>>) => guideLayoutCommand.apply(context(), args),
    viewCommand: (...args: Parameters<OmitThisParameter<typeof viewCommand>>) => viewCommand.apply(context(), args),
    viewRead: (...args: Parameters<OmitThisParameter<typeof viewRead>>) => viewRead.apply(context(), args),
    viewSnapshot: (...args: Parameters<OmitThisParameter<typeof viewSnapshot>>) => viewSnapshot.apply(context(), args),
    samplerReadout: (...args: Parameters<OmitThisParameter<typeof samplerReadout>>) => samplerReadout.apply(context(), args),
    samplerList: (...args: Parameters<OmitThisParameter<typeof samplerList>>) => samplerList.apply(context(), args),
    formatLength: (...args: Parameters<OmitThisParameter<typeof formatLength>>) => formatLength.apply(context(), args),
    measurementLog: (...args: Parameters<OmitThisParameter<typeof measurementLog>>) => measurementLog.apply(context(), args),
    rotateView: (...args: Parameters<OmitThisParameter<typeof rotateView>>) => rotateView.apply(context(), args),
    viewPointer: (...args: Parameters<OmitThisParameter<typeof viewPointer>>) => viewPointer.apply(context(), args),
    viewAction: (...args: Parameters<OmitThisParameter<typeof viewAction>>) => viewAction.apply(context(), args),
    viewAidsState: (...args: Parameters<OmitThisParameter<typeof viewAidsState>>) => viewAidsState.apply(context(), args),
  };
}
