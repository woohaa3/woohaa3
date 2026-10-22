/** 创建一次 Canvas attach 的媒体 owner，并把唯一播放头接到片场解码器。 */
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { BevyRuntime } from "./bevy-runtime.js";
import type { CanvasRuntimeOptions } from "./canvas-runtime-options.js";
import type { AnimationPlaybackStore } from "./animation-playback-store.js";
import { createTextureSync } from "./texture-sync.js";
import { createVideoFrameSessions } from "./video-frame-session.js";
import { createCompositeAssetMediaSessions } from "./composite-asset-media-session.js";
import { isDevVideoDisabled, hasMismatchedFlag, withoutVideoMediaSources, withoutVideoNodes } from "./dev-media-switches.js";

export function createAttachedMedia(input: {
  runtime: BevyRuntime;
  options: CanvasRuntimeOptions;
  getPreviewUrls: () => ReadonlyMap<string, string>;
  getFocusTexture: Parameters<typeof createTextureSync>[0]["getFocusTexture"];
  getFocusDetails?:Parameters<typeof createTextureSync>[0]["getFocusDetails"];
  isFocused: () => boolean;
  playback: AnimationPlaybackStore;
  invalidate: (reason: string) => void;
}) {
  const { runtime, options } = input;
  const projectCanvas = (canvas: import("@woohaa3/contracts").ServerCanvas | null) => {
    const projected = options.projectHistoryCanvas?.(canvas) ?? canvas;
    return options.compositeAssets?.projectCanvas(projected) ?? projected;
  };
  const getCanvas = () => projectCanvas(woohaa3CanvasStore.getState().working ?? woohaa3CanvasStore.getState().canvas);
  // 诊断开关（仅 DEV，`?woohaaDevNoVideo=1` 或 storage 键）：见 dev-media-switches.ts，用于「有/无视频」帧率 A/B。
  const videosDisabled = isDevVideoDisabled();
  if (videosDisabled) {
    console.warn("[dev] woohaaDevNoVideo=1：已关闭画布视频会话与复合资产视频源（帧率 A/B 诊断用，不代表产品行为）。");
  } else if (hasMismatchedFlag()) {
    console.warn("[dev] woohaaDevNoVideo 的值不是 1（需要 `?woohaaDevNoVideo=1`），视频诊断开关未开启。");
  }
  const getVideoCanvas = () => {
    const canvas = getCanvas();
    return videosDisabled ? withoutVideoNodes(canvas) : canvas;
  };
  const textureSync = createTextureSync({
    runtime,
    getCanvas: () => projectCanvas(woohaa3CanvasStore.getState().canvas),
    getPreviewUrls: input.getPreviewUrls,
    getFocusTexture: input.getFocusTexture,
    getFocusDetails:input.getFocusDetails,
    onChange: () => input.invalidate("image-resources")
  });
  const videoSessions = options.createVideoSessions?.(runtime) ?? createVideoFrameSessions({
    runtime, getCanvas: getVideoCanvas,
    isReducedMotion: () => options.prefersReducedMotion?.() ?? false,
    isSuspended: input.isFocused,
    getFocusTextureNodeId: () => input.getFocusTexture?.()?.nodeId ?? null,
    onChange: () => input.invalidate("video-frames")
  });
  const compositeAssetMediaSessions = options.createCompositeAssetMediaSessions?.(runtime) ?? createCompositeAssetMediaSessions({
    runtime, getCanvas,
    getSources: () => {
      const sources = options.compositeAssets?.mediaSources(getCanvas(), input.playback.current()) ?? [];
      return videosDisabled ? withoutVideoMediaSources(sources) : sources;
    },
    onChange: () => input.invalidate("film-set-media")
  });
  input.playback.setCompositeAssetMediaSessions(compositeAssetMediaSessions);
  input.playback.setTimeSink((value) => {
    if (value.nodeId !== null) compositeAssetMediaSessions.setMediaTime(value.nodeId, value.time, value.playing);
  });
  return { textureSync, videoSessions, compositeAssetMediaSessions };
}
