import { filmSetLayoutBounds, encodeFilmSetPartId, compositeAssetNodeBoxSize, prepareModelResource, type FilmSetNodeData, type SceneV2Op } from "@woohaa3/contracts";

export function nativeFilmSetFrame(animation: FilmSetNodeData, node: { width?: number; height?: number }, ops: readonly SceneV2Op[]) {
  const roots = new Set(animation.filmSetContent.items.map(item => encodeFilmSetPartId(item.id, "")));
  const resource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: ops.map(op => op.t === "group" && roots.has(op.id) ? { ...op, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } : op) });
  return { ...compositeAssetNodeBoxSize(node), resourceExtent: resource.extent, layoutAabb: filmSetLayoutBounds(resource.ops, animation.filmSetContent, resource.extent) };
}
