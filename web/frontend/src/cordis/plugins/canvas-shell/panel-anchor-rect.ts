/**
 * 底部执行面板的锚点矩形（导演区/共享世界模型没有卡片）。
 *
 * 面板定位统一读 `runtime.nodeScreenRect`；普通卡片用卡片矩形，而导演区与共享世界
 * 模型没有卡片，必须由真实 3D 位置/地面范围派生，否则会锚到创建时的卡片坐标。
 */
import type { Aabb, GroundAabb, ScreenRect, WorldPoint } from "@woohaa3/contracts";

export type PanelProject = (u: number, v: number, h?: number) => { x: number; y: number };

/** 渲染器世界坐标（Y-up，单位/米）→ 屏幕点。 */
export type PanelRenderProject = (x: number, y: number, z: number) => { x: number; y: number };

/** 导演区：地面范围四角投影后的屏幕包围盒。 */
export function sceneAreaPanelRect(bounds: GroundAabb, project: PanelProject): ScreenRect {
  const corners = [
    project(bounds.min.u, bounds.min.v),
    project(bounds.min.u, bounds.max.v),
    project(bounds.max.u, bounds.min.v),
    project(bounds.max.u, bounds.max.v),
  ];
  const left = Math.min(...corners.map(point => point.x));
  const top = Math.min(...corners.map(point => point.y));
  const right = Math.max(...corners.map(point => point.x));
  const bottom = Math.max(...corners.map(point => point.y));
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Screen bounds of the same lower-left nameplate edge used by the renderer. */
export function sceneAreaTitleRect(bounds: GroundAabb, project: PanelProject, zoom: number): ScreenRect {
  const points = [project(bounds.min.u, bounds.min.v), project(bounds.max.u, bounds.min.v),
    project(bounds.max.u, bounds.max.v), project(bounds.min.u, bounds.max.v)];
  let left = 0, bottom = 0;
  for (let i = 1; i < 4; i++) {
    if (points[i].x < points[left].x) left = i;
    if (points[i].y > points[bottom].y) bottom = i;
  }
  const edge = (left + 1) % 4 === bottom ? left : (bottom + 1) % 4 === left ? bottom
    : points.map((a, i) => ({ i, score: a.y + points[(i + 1) % 4].y - a.x - points[(i + 1) % 4].x }))
      .sort((a, b) => b.score - a.score)[0].i;
  const a = points[edge], b = points[(edge + 1) % 4];
  const length = Math.max(0.001, Math.hypot(b.x - a.x, b.y - a.y));
  const baseWidth = Math.max(56, Math.min(200, length / zoom * 0.72));
  const scale = Math.min(Math.max(1, 18 / (22 * zoom)), Math.max(1, length / zoom * 0.72 / baseWidth));
  const width = baseWidth * scale * zoom;
  const height = 22 * scale * zoom;
  const ux = Math.abs(b.x - a.x) / length, uy = Math.abs(b.y - a.y) / length;
  const halfWidth = (ux * width + uy * height) / 2;
  const halfHeight = (uy * width + ux * height) / 2;
  return { left: (a.x + b.x) / 2 - halfWidth, top: (a.y + b.y) / 2 - halfHeight,
    width: halfWidth * 2, height: halfHeight * 2 };
}

/** 共享世界模型：以模型世界原点（脚点）为锚，面板落在模型下方。 */
export function worldInstancePanelRect(position: WorldPoint, project: PanelProject): ScreenRect {
  const anchor = project(position.u, position.v, position.h);
  return { left: anchor.x - 12, top: anchor.y - 12, width: 24, height: 24 };
}

/**
 * 共享世界模型：以模型世界 AABB 的屏幕包围盒为锚。
 *
 * 世界原点是模型的脚点中心，投影后通常高于模型可见的下沿；只按原点放面板会压住模型下半部分。
 * 把 AABB 八个角投影后取包围盒，`layoutNodePanel` 的 below 策略就会落在模型真实下沿之外。
 */
export function worldAabbPanelRect(aabb: Aabb, project: PanelRenderProject): ScreenRect {
  const xs = [aabb.min[0], aabb.max[0]];
  const ys = [aabb.min[1], aabb.max[1]];
  const zs = [aabb.min[2], aabb.max[2]];
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const x of xs) for (const y of ys) for (const z of zs) {
    const point = project(x, y, z);
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * 世界镜头锚点矩形。
 *
 * 镜头同时有 2D 卡片与 3D 机位，两者可以相距很远（`world-camera-frame.ts`：从卡片操作时
 * 机位可能在 12 m 外、当前视口之外）。只要镜头本体或它的地面投影点在视口内，就用地面投影
 * 点作锚，让面板贴镜头底点下方；只有**镜头本体和地面投影点都不可见、只剩卡片**时才退回
 * 卡片矩形。否则高机位常常是本体/卡片可见、地面投影在视口外，退回卡片会把面板压到镜头上。
 */
export function worldCameraPanelRect(
  position: WorldPoint,
  project: PanelProject,
  area: { left: number; top: number; width: number; height: number },
  card: ScreenRect
): ScreenRect {
  const inside = (point: { x: number; y: number }) =>
    point.x >= area.left &&
    point.x <= area.left + area.width &&
    point.y >= area.top &&
    point.y <= area.top + area.height;
  // `h = 0`：面板贴的是机位在地面的投影点，而不是悬在空中的机位本体。
  const anchor = project(position.u, position.v, 0);
  const body = project(position.u, position.v, position.h);
  if (!inside(anchor) && !inside(body)) return card;
  return { left: anchor.x - 12, top: anchor.y - 12, width: 24, height: 24 };
}
