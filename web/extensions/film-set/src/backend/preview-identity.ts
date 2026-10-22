/**
 * 模型 MCP 服务：预览缓存与历史/应用结果上报辅助
 * （自 `service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R03）。
 */
import type { CanvasNodeData } from "@woohaa3/contracts";
import {
  animationSnapshotHash,
  encodeFilmSetPartId,
  filmSetAnimationsOf,
  filmSetClipHash,
  filmSetContentHash,
  decodeFilmSetNodeData,
  resolveFilmSetClip,
  hashModelScript
} from "@woohaa3/contracts";
type AnimationPreviewMetadata = { contentHash: string; clipHash: string; snapshotHash: string; timeSeconds: number; duration: number; loop: boolean; clipId?: string };

/** 编译运动脚本为受控 IR（供渲染器携带；失败返回空轨道）。 */
export function compileMotionTracks(motionScript: string, duration: number): { cameraMotion: unknown[]; modelMotion: unknown[] } {
  return withExecuteMotion(motionScript, duration);
}

// 延迟引用避免顶部循环（executeMotionScript 来自 contracts）。
import { executeMotionScript } from "@woohaa3/contracts";
function withExecuteMotion(motionScript: string, duration: number): { cameraMotion: unknown[]; modelMotion: unknown[] } {
  const execution = executeMotionScript(motionScript, { duration });
  if (!execution.ok) return { cameraMotion: [], modelMotion: [] };
  return { cameraMotion: execution.ir.cameraMotion, modelMotion: execution.ir.modelMotion.map(track => ({ ...track, targetId: encodeFilmSetPartId("", track.targetId) })) };
}

export function previewAnimationMetadata(
  animation: ReturnType<typeof decodeFilmSetNodeData>,
  timeSeconds: number,
  clipId?: string
): { animation?: AnimationPreviewMetadata } {
  if (!animation.ok) return {};
  const collection = filmSetAnimationsOf(animation.value);
  const selectedClip = collection.clips.find(clip => clip.id === (clipId ?? collection.defaultClipId));
  const view = resolveFilmSetClip(animation.value, clipId ?? collection.defaultClipId);
  return {
    animation: {
      contentHash: filmSetContentHash(animation.value.filmSetContent),
      clipHash: selectedClip ? filmSetClipHash(selectedClip) : "",
      snapshotHash: animationSnapshotHash(animation.value),
      timeSeconds,
      duration: view?.timeline.duration ?? animation.value.timeline.duration,
      loop: view?.timeline.loop ?? animation.value.timeline.loop,
      ...(clipId ? { clipId } : {})
    }
  };
}

/** 完整预览身份是否未变（独立根 + 共享内容 + 指定片段的镜头/时间线/binding）。 */
export function previewIdentityMatches(
  before: CanvasNodeData | undefined,
  after: CanvasNodeData | undefined,
  clipId?: string
): boolean {
  const beforeMissing = before === undefined || before === null;
  const afterMissing = after === undefined || after === null;
  if (beforeMissing !== afterMissing) return false;
  const isFilm = (value: CanvasNodeData | undefined): boolean =>
    !beforeMissing && typeof value === "object" && value !== null && (value as Record<string, unknown>).extensionId === "film-set";
  if (isFilm(before) || isFilm(after)) {
    const a = decodeFilmSetNodeData(before);
    const b = decodeFilmSetNodeData(after);
    // 任一侧结构非法（含节点删除/清空）视为身份变化，返回陈旧。
    if (!a.ok || !b.ok) return false;
    const identity = (value: typeof a.value) => {
      const view = resolveFilmSetClip(value, clipId ?? filmSetAnimationsOf(value).defaultClipId);
      const scene = [value.scenePlacement.offset.x, value.scenePlacement.offset.y, value.scenePlacement.offset.z, value.scenePlacement.scale, value.scenePlacement.yaw];
      const camera = value.sceneCamera;
      const sceneCamera = [camera.azimuth, camera.elevation, camera.distance, camera.aspect, camera.focusOffset.x, camera.focusOffset.y, camera.focusOffset.z];
      if (!view) return JSON.stringify({ scene, sceneCamera, content: value.filmSetContent });
      return JSON.stringify({ scene, sceneCamera, content: value.filmSetContent, cameraMotion: view.cameraMotion, camera: view.initialCamera, timeline: view.timeline, bindings: view.clip.bindings });
    };
    return identity(a.value) === identity(b.value);
  }
  const beforeSource = typeof before?.modelScript === "string" ? before.modelScript : "";
  const afterSource = typeof after?.modelScript === "string" ? after.modelScript : "";
  return hashModelScript(beforeSource) === hashModelScript(afterSource) && JSON.stringify([before?.extensionId, before?.modelScriptVersion, before?.modelPlacement, before?.scenePlacement]) === JSON.stringify([after?.extensionId, after?.modelScriptVersion, after?.modelPlacement, after?.scenePlacement]);
}

