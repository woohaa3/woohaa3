/**
 * Presentation bounds include saved object placement without rebuilding the immutable model resource.
 *
 * `layoutAabb` 是节点矩形的**内容适配基准**（等比 fit 与地面范围的事实源），因此媒体平面
 * （image/video）也必须参与——否则纯媒体片场没有可用 AABB，`fit` 退化为 1，偏移后的媒体
 * 会飞出节点矩形而不能被点选。
 *
 * 但媒体只按**基准尺寸**（`localTransform.scale = 1`）计入：媒体世界尺寸 =
 * 内容高度 × 共同根 `unit`（`unit` 已含 fit）。若按对象当前 `scale` 计入 bounds，放大单个
 * 媒体会同时放大 bounds 与缩小 fit，两者相消，媒体在世界中不再随对象缩放变化
 * （回归证据：`film-set-image-editing` 等比缩放半径不随 1.5 变化）。媒体几何按内容局部量
 * 派生，且被共同 `unit` 统一缩放，不重复应用 `localTransform.scale`。
 */
import { encodeFilmSetPartId, type FilmSetContent } from "./film-set-content.js";
import { v2SceneExtent, v2SceneAabb, type SceneV2Op } from "./scene-ir-v2.js";
import type { Aabb } from "./model-transform.js";

const cache = new WeakMap<readonly SceneV2Op[], { key: string; bounds: Aabb | null }>();
export function filmSetLayoutBounds(ops: readonly SceneV2Op[], content: FilmSetContent, contentExtent = v2SceneExtent(ops), includeMediaScale = false): Aabb | null {
  const items = content.items.filter(item => item.kind === "model" || item.kind === "ground");
  const media = content.items.filter(item => item.kind === "image" || item.kind === "video");
  const key = JSON.stringify([contentExtent, includeMediaScale, items.map(item => [item.id, item.localTransform]), media.map(item => [item.id, item.localTransform, (item as { aspectRatio?: number }).aspectRatio])]);
  const cached = cache.get(ops);
  if (cached?.key === key) return cached.bounds;
  const placements = new Map(items.map(item => [encodeFilmSetPartId(item.id, ""), item.localTransform]));
  const live = ops.map(op => {
    if (op.t !== "group") return op;
    const transform = placements.get(op.id);
    return transform ? { ...op, position: [transform.offset.x, transform.offset.y, transform.offset.z], rotation: [0, transform.yaw * 180 / Math.PI, 0], scale: [transform.scale, transform.scale, transform.scale] } as SceneV2Op : op;
  });
  let bounds = v2SceneAabb(live);
  const root = ops.find(op => op.t === "group" && op.id === "\u0000scene");
  const scene = root?.t === "group" ? root : null;
  const offset = scene?.position ?? [0, 0, 0], scale = scene?.scale ?? [1, 1, 1];
  const yaw = (scene?.rotation?.[1] ?? 0) * Math.PI / 180, cos = Math.cos(yaw), sin = Math.sin(yaw);
  for (const item of media) {
    // 基准高度不含 `localTransform.scale`：对象缩放不参与 fit 基准，保持可见。
    const height = 48 * contentExtent / 192 * (includeMediaScale ? item.localTransform.scale : 1), width = height * ((item as { aspectRatio?: number }).aspectRatio ?? 1);
    const itemCos = Math.cos(item.localTransform.yaw), itemSin = Math.sin(item.localTransform.yaw);
    for (const x of [-width / 2, width / 2]) for (const y of [0, height]) {
      const ix = item.localTransform.offset.x + x * itemCos;
      const iy = item.localTransform.offset.y + y;
      const iz = item.localTransform.offset.z - x * itemSin;
      const point = [offset[0] + ix * scale[0] * cos + iz * scale[2] * sin, offset[1] + iy * scale[1], offset[2] - ix * scale[0] * sin + iz * scale[2] * cos];
      if (!bounds) bounds = { min: [...point] as [number, number, number], max: [...point] as [number, number, number] };
      else for (let axis = 0; axis < 3; axis++) { bounds.min[axis] = Math.min(bounds.min[axis], point[axis]); bounds.max[axis] = Math.max(bounds.max[axis], point[axis]); }
    }
  }
  cache.set(ops, { key, bounds });
  return bounds;
}
