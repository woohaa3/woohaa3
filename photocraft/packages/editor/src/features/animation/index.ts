import { sections } from "./sections.js";
import { TimelinePanel } from "./panels.js";

/**
 * 动画域（U77）：时间轴、视频图层/逐帧编辑、帧导入与浏览器动画交付。
 *
 * 本域不新增工具：时间轴是面板工作流，不参与画布手势与笔刷仲裁。
 * 面板经 `FEATURE_PANELS` 暴露，同时由自己的 section 渲染；两处都走同一 `TimelinePanel`。
 */
export const feature = {
  id: "animation",
  tools: [],
  sections,
  panels: { TimelinePanel }
} as const;

export { TimelinePanel } from "./panels.js";
export { TimelinePlayback, nextFrame, type PlaybackRange, type PlaybackStep } from "./playback.js";
export { animationCodecPort, setAnimationCodecPort } from "./codec.js";
export { decodeFrameImages, FRAME_IMAGE_ACCEPT, type DecodedFrames } from "./frame-decoder.js";
export { decodeVideoFrames, videoContainer, type DecodedVideo } from "./video-decoder.js";
export { canvasPngEncoder, encodeFrameSequence, type FrameSequenceRequest, type FrameSequenceResult } from "./frames-export.js";
export { crc32, zipStore, type ZipEntry } from "./zip-store.js";
