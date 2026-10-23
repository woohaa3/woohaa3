/** 本域的 wasm 绑定面（与 Rust `features/animation/wasm.rs` 逐一对齐）。 */
export type FeatureEditorInstance = {
  timelineJson(): string;
  createTimeline(paramsJson: string): string;
  setTimelineProps(paramsJson: string): string;
  navigateTimeline(id: string, paramsJson: string): string;
  videoLayerCommand(id: string, paramsJson: string): string;
  /** `pixels` 是 `frameCount` 帧首尾相接的 RGBA8 字节。 */
  importFrames(name: string, width: number, height: number, fps: number, frameCount: number, pixels: Uint8Array): string;
  deliveryPlan(): string;
  renderFrame(frame: number): Uint8Array;
  renderAnimationGif(): Uint8Array;
  flushVideoFrames(): string;
};
