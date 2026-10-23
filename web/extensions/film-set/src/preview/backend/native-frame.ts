import { filmSetLayoutBounds, encodeFilmSetPartId, prepareModelResource, type FilmSetNodeData, type SceneV2Op } from "@woohaa3/contracts";

/**
 * 原生片场帧的生产输入
 * （change: 2026-10-23-isolate-film-set-camera-space，任务 3.1 / design D4）。
 *
 * 生产取景必须与画布呈现无关：`compositeAssetFrame` 只携带内容 **extent** 与场景单位布局 AABB，
 * **不再**传递节点矩形的 `width/height`。原生 renderer 用 `192/extent` 把内容单位换算成场景
 * 单位并与镜头 distance/focusOffset 同尺度，因此调整节点尺寸或画布 zoom 不会改变成片构图。
 *
 * `FramingBox` 保留尺寸字段只是为了让请求 schema 稳定（旧缓存/旧冻结快照仍可解码），但这些
 * 值**不参与**取景；新产出统一写 1×1。
 */
export const PRODUCTION_FRAMING_BOX = { width: 1, height: 1 } as const;

export function nativeFilmSetFrame(
  animation: FilmSetNodeData,
  _node: { width?: number; height?: number } = {},
  ops: readonly SceneV2Op[]
) {
  const roots = new Set(animation.filmSetContent.items.map(item => encodeFilmSetPartId(item.id, "")));
  const resource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: ops.map(op => op.t === "group" && roots.has(op.id) ? { ...op, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } : op) });
  return {
    ...PRODUCTION_FRAMING_BOX,
    resourceExtent: resource.extent,
    layoutAabb: filmSetLayoutBounds(resource.ops, animation.filmSetContent, resource.extent)
  };
}
