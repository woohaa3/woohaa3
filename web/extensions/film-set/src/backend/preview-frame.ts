/** Business preparation for native previews; storage, permissions, cache and renderer belong to the host. */
import { animationSnapshotHash, buildFilmSetObjectMotions, checkAnimationMotion, composeFilmSetPreviewAtTime, executeMotionScript, filmSetAnimationsOf, filmSetClipHash, filmSetContentHash, hashModelScript, hashMotionScript, resolveFilmSetClip, validateSelfContainedModel, v2SceneExtent, type FilmSetNodeData, type StoredAsset } from "@woohaa3/contracts";
import { nativeFilmSetFrame } from "./native-frame.js";
import { prepareFilmSetNativeMedia, type FilmSetMediaReader } from "./media-frame.js";
import { previewAnimationMetadata } from "./preview-identity.js";
const failure = (code: string, message: string) => ({ ok: false as const, code, message });
export async function prepareFilmSetPreviewFrame(input: {
  nodeId: string; node: { width?: number; height?: number }; animation: FilmSetNodeData;
  assets: readonly StoredAsset[]; clipId?: string; timeSeconds: number; read?: FilmSetMediaReader;
}) {
  if (!Number.isFinite(input.timeSeconds) || input.timeSeconds < 0) return failure("malformed-request", "timeSeconds 必须是非负有限数值");
  const animation = input.animation;
  const collection = filmSetAnimationsOf(animation);
  if (collection.clips.length > 1 && !input.clipId) return failure("ambiguous-clip", "多个动画片段，请指定 clipId");
  const clipId = input.clipId ?? collection.defaultClipId ?? undefined;
  const view = clipId ? resolveFilmSetClip(animation, clipId) : null;
  if (clipId && !view) return failure("unknown-clip", "指定片段不存在");
  if (input.timeSeconds > (view?.timeline.duration ?? 0) + 1e-9) return failure("malformed-request", "timeSeconds 超出时间线时长");
  for (const item of animation.filmSetContent.items) {
    if (item.kind !== "model" || !item.model.modelScript.trim()) continue;
    const validity = validateSelfContainedModel(item.model.modelScript, item.model.modelScriptVersion);
    if (!validity.ok) return validity;
  }
  if (view) {
    const motion = checkAnimationMotion(view);
    if (motion.validation !== "valid") return failure(`motion-${motion.validation}`, motion.issues[0]?.message ?? "运动检查未通过");
  }
  const projection = composeFilmSetPreviewAtTime({ scenePlacement: animation.scenePlacement, filmSetContent: animation.filmSetContent, ...(view ? { bindings: view.clip.bindings } : {}) }, 0);
  if (projection.diagnostics.length) return failure("film-set-object-diagnostic", projection.diagnostics[0]!);
  const frame = nativeFilmSetFrame(animation, input.node, projection.ops);
  const hasMedia = animation.filmSetContent.items.some(item => item.kind === "image" || item.kind === "video");
  if (hasMedia && !input.read) return failure("native-media-unavailable", "原生预览未配置稳定媒体读取能力");
  let media: Awaited<ReturnType<typeof prepareFilmSetNativeMedia>> = [];
  if (hasMedia) {
    try { media = await prepareFilmSetNativeMedia({ nodeId: input.nodeId, animation, assets: input.assets, timeSeconds: input.timeSeconds, contentExtent: frame.resourceExtent, read: input.read! }); }
    catch (cause) { return failure("native-media-frame-failed", cause instanceof Error ? cause.message : "媒体帧准备失败"); }
  }
  const camera = view?.initialCamera ?? animation.sceneCamera;
  const cameraTracks = view ? executeMotionScript(view.cameraMotion.motionScript, { duration: view.timeline.duration }) : null;
  if (cameraTracks && !cameraTracks.ok) return failure("camera-motion-invalid", "镜头动作编译失败");
  const sourceHash = hashModelScript(JSON.stringify({ version: "woohaa-model-scene-ir-v2", ops: projection.ops }));
  const animationIdentity = hashMotionScript(JSON.stringify({ content: filmSetContentHash(animation.filmSetContent), scenePlacement: animation.scenePlacement, sceneCamera: animation.sceneCamera, clip: view ? filmSetClipHash(view.clip) : null }));
  return {
    ok: true as const, clipId, sourceHash, animationIdentity,
    snapshotHash: animationSnapshotHash(animation),
    metadata: previewAnimationMetadata({ ok: true, value: animation }, input.timeSeconds, clipId),
    scene: {
      sceneVersion: "woohaa-model-scene-ir-v2", signature: sourceHash,
      extent: v2SceneExtent(projection.ops), ops: projection.ops as unknown[],
      compositeAssetFrame: { ...frame, media },
      motion: {
        duration: view?.timeline.duration ?? 0, looped: view?.timeline.loop ?? false,
        cameraMotion: cameraTracks?.ok ? cameraTracks.ir.cameraMotion : [], modelMotion: [],
        objects: view ? buildFilmSetObjectMotions({ filmSetContent: view.content, bindings: view.clip.bindings }).motions : [],
        initialCamera: { azimuth: camera.azimuth, elevation: camera.elevation, distance: camera.distance, focusOffset: [camera.focusOffset.x, camera.focusOffset.y, camera.focusOffset.z] as [number, number, number], aspect: camera.aspect },
        timeSeconds: input.timeSeconds
      }
    }
  };
}
