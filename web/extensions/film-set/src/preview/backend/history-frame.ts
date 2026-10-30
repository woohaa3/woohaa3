/** Historical rendering uses the saved definition, never the live node's content. */
import { readFilmSetAnimationProjection, type ServerCanvas, type FilmSetGroupHistoryPayload, animationSnapshotHash, composeFilmSetPreviewAtTime, createFilmSetSnapshot, hashModelScript, v2SceneExtent, type FilmSetHistoryAnimationPayload, type StoredAsset } from "@woohaa3/contracts";
import { nativeFilmSetFrame } from "./native-frame.js";
import { prepareFilmSetNativeMedia, type FilmSetMediaReader } from "./media-frame.js";

export async function prepareFilmSetHistoryFrame(input: {
  nodeId: string;
  definition: FilmSetHistoryAnimationPayload | FilmSetGroupHistoryPayload;
  canvas?: ServerCanvas;
  assets: readonly StoredAsset[];
  read?: FilmSetMediaReader;
}) {
  const saved = input.definition;
  const animation = saved.schemaVersion === 4
    ? input.canvas ? readFilmSetAnimationProjection({ ...input.canvas, nodeData: { ...input.canvas.nodeData,
      [input.nodeId]: { ...input.canvas.nodeData[input.nodeId], filmSetGroup: saved.filmSetGroup } } }, input.nodeId) : null
    : { ...createFilmSetSnapshot({ title: "", timeline: { duration: 0, loop: false }, filmSetContent: saved.filmSetContent, scenePlacement: saved.scenePlacement, initialCamera: saved.sceneCamera }), filmSetAnimations: saved.filmSetAnimations };
  if (!animation) throw new Error("历史片场分组的当前资源不可用");
  const projection = composeFilmSetPreviewAtTime({ scenePlacement: animation.scenePlacement, filmSetContent: animation.filmSetContent }, 0);
  if (projection.diagnostics.length) throw new Error(projection.diagnostics.join("; "));
  const frame = nativeFilmSetFrame(animation, {}, projection.ops);
  const hasMedia = animation.filmSetContent.items.some(item => item.kind === "image" || item.kind === "video");
  if (hasMedia && !input.read) throw new Error("历史缩略图未配置稳定媒体读取能力");
  const media = hasMedia ? await prepareFilmSetNativeMedia({ nodeId: input.nodeId, animation, assets: input.assets, timeSeconds: 0, contentExtent: frame.resourceExtent, read: input.read! }) : [];
  const camera = animation.sceneCamera;
  return {
    identity: animationSnapshotHash(animation),
    sceneVersion: "woohaa-model-scene-ir-v2",
    signature: hashModelScript(JSON.stringify({ version: "woohaa-model-scene-ir-v2", ops: projection.ops })),
    extent: v2SceneExtent(projection.ops),
    ops: projection.ops as unknown[],
    compositeAssetFrame: { ...frame, media },
    motion: {
      duration: 0, looped: false, cameraMotion: [], modelMotion: [], managedItemMotion: [], timeSeconds: 0,
      initialCamera: { azimuth: camera.azimuth, elevation: camera.elevation, distance: camera.distance, focusOffset: [camera.focusOffset.x, camera.focusOffset.y, camera.focusOffset.z] as [number, number, number], aspect: camera.aspect }
    }
  };
}
