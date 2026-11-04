/**
 * 底部执行面板的锚点矩形（导演区/共享世界模型没有卡片）。
 *
 * 面板定位统一读 `runtime.nodeScreenRect`；普通卡片用卡片矩形，而导演区与共享世界
 * 模型没有卡片，必须由真实 3D 位置/地面范围派生，否则会锚到创建时的卡片坐标。
 */
import type { GroundAabb, ScreenRect, WorldPoint } from "@woohaa3/contracts";

export type PanelProject = (u: number, v: number, h?: number) => { x: number; y: number };

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
  const width = Math.max(56 * zoom, Math.min(200 * zoom, length * 0.72));
  const ux = Math.abs(b.x - a.x) / length, uy = Math.abs(b.y - a.y) / length;
  const halfWidth = (ux * width + uy * 22 * zoom) / 2;
  const halfHeight = (uy * width + ux * 22 * zoom) / 2;
  return { left: (a.x + b.x) / 2 - halfWidth, top: (a.y + b.y) / 2 - halfHeight,
    width: halfWidth * 2, height: halfHeight * 2 };
}

/** 共享世界模型：以模型世界原点（脚点）为锚，面板落在模型下方。 */
export function worldInstancePanelRect(position: WorldPoint, project: PanelProject): ScreenRect {
  const anchor = project(position.u, position.v, position.h);
  return { left: anchor.x - 12, top: anchor.y - 12, width: 24, height: 24 };
}
