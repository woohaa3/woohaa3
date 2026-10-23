import type { FeatureHandleContext } from "../contracts.js";
import { type EditorResult } from "../../editor-wasm.js";

/**
 * 时间轴与帧交付的内核适配（U77）。
 *
 * 只做字符串/字节转换与 JSON 解析；错误统一交给共享 `FeatureHandleContext.call` 归一化，
 * 因此所有返回值都是 `EditorResult`，界面不需要 try/catch。
 *
 * 帧像素走 `Uint8Array`（不经过 JSON），其余走 JSON 字符串。
 */

export function timelineJson(this: FeatureHandleContext): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.timelineJson()));
}

export function createTimeline(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.createTimeline(JSON.stringify(params))));
}

export function setTimelineProps(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.setTimelineProps(JSON.stringify(params))));
}

export function navigateTimeline(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.navigateTimeline(id, JSON.stringify(params ?? null))));
}

export function videoLayerCommand(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.videoLayerCommand(id, JSON.stringify(params ?? null))));
}

export function importFrames(this: FeatureHandleContext, request: {
  name: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  pixels: Uint8Array;
}): EditorResult<unknown> {
  return this.call((i) =>
    JSON.parse(i.importFrames(request.name, request.width, request.height, request.fps, request.frameCount, request.pixels)),
  );
}

export function deliveryPlan(this: FeatureHandleContext): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.deliveryPlan()));
}

export function renderFrame(this: FeatureHandleContext, frame: number): EditorResult<Uint8Array> {
  return this.call((i) => i.renderFrame(frame));
}

export function renderAnimationGif(this: FeatureHandleContext): EditorResult<Uint8Array> {
  return this.call((i) => i.renderAnimationGif());
}

export function flushVideoFrames(this: FeatureHandleContext): EditorResult<unknown> {
  return this.call((i) => JSON.parse(i.flushVideoFrames()));
}

export function createHandle(context: () => FeatureHandleContext) {
  return {
    timelineJson: () => timelineJson.apply(context()),
    createTimeline: (...args: Parameters<OmitThisParameter<typeof createTimeline>>) => createTimeline.apply(context(), args),
    setTimelineProps: (...args: Parameters<OmitThisParameter<typeof setTimelineProps>>) => setTimelineProps.apply(context(), args),
    navigateTimeline: (...args: Parameters<OmitThisParameter<typeof navigateTimeline>>) => navigateTimeline.apply(context(), args),
    videoLayerCommand: (...args: Parameters<OmitThisParameter<typeof videoLayerCommand>>) => videoLayerCommand.apply(context(), args),
    importFrames: (...args: Parameters<OmitThisParameter<typeof importFrames>>) => importFrames.apply(context(), args),
    deliveryPlan: () => deliveryPlan.apply(context()),
    renderFrame: (...args: Parameters<OmitThisParameter<typeof renderFrame>>) => renderFrame.apply(context(), args),
    renderAnimationGif: () => renderAnimationGif.apply(context()),
    flushVideoFrames: () => flushVideoFrames.apply(context())
  };
}
