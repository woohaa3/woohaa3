/**
 * 导演区边缘的鼠标指针反馈。
 *
 * 导演区线框没有 DOM 元素，hover 反馈只能由画布输入层根据地面坐标推导：
 * 指针落在导演区边框容差内时返回一个“拖拽缩放”指针（按投影后的边框方向选择
 * 对角线/水平/垂直 resize）。纯函数，便于测试；不改变手势或规范状态。
 */
import {
  decodeSceneAreaData,
  worldToCanvasPoint,
  worldToRendererPosition,
  type GroundAabb,
  type GroundPoint,
  type ServerCanvas
} from "@woohaa3/contracts";
import { locateSceneAreaEdge, type SceneAreaEdge } from "../world-scopes/gestures.js";

export type SceneAreaCursorTarget = { nodeId: string; bounds: GroundAabb };

/** 画布内所有可参与边缘 hover 的导演区（按文档顺序）。 */
export function sceneAreaCursorTargets(canvas: ServerCanvas): SceneAreaCursorTarget[] {
  return canvas.document.nodes.flatMap(node => {
    const decoded = decodeSceneAreaData(canvas.nodeData[node.id]?.sceneArea);
    return decoded.ok ? [{ nodeId: node.id, bounds: decoded.value.bounds }] : [];
  }).sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
}

/**
 * 投影后的边框方向 → CSS cursor。
 *
 * 等距画布上导演区两条轴边都是斜线，因此优先使用对角线 resize 指针；
 * 只有投影后接近水平/垂直时才使用 `ew-resize` / `ns-resize`。
 */
export function resizeCursorForEdge(bounds: GroundAabb, edge: SceneAreaEdge): string {
  const project = (u: number, v: number) => {
    const renderer = worldToRendererPosition({ u, v, h: 0 });
    return worldToCanvasPoint([renderer[0], renderer[1], renderer[2]]);
  };
  const origin = project(bounds.min.u, bounds.min.v);
  // 指针方向 = 拖这条边时真正移动的轴，而不是边框自身的走向。
  // （u 边拖 u，v 边拖 v；角点两者叠加。）
  const uAxis = project(bounds.min.u + 1, bounds.min.v);
  const vAxis = project(bounds.min.u, bounds.min.v + 1);
  const dx = edge.u * (uAxis.x - origin.x) + edge.v * (vAxis.x - origin.x);
  const dy = edge.u * (uAxis.y - origin.y) + edge.v * (vAxis.y - origin.y);
  if (Math.abs(dx) <= 1e-6) return "ns-resize";
  if (Math.abs(dy) <= 1e-6) return "ew-resize";
  return dx * dy > 0 ? "nwse-resize" : "nesw-resize";
}

/** 指针在导演区边框容差内时返回 resize cursor；否则 `null`。 */
export function sceneAreaEdgeCursor(input: {
  areas: readonly SceneAreaCursorTarget[];
  ground: GroundPoint;
  tolerance: number;
  preferredNodeId?: string | null;
}): string | null {
  const containing = input.areas.filter(area => locateSceneAreaEdge(area.bounds, input.ground, input.tolerance));
  if (containing.length === 0) return null;
  const preferred = input.preferredNodeId
    ? containing.find(area => area.nodeId === input.preferredNodeId)
    : undefined;
  const target = preferred ?? containing[0]!;
  const edge = locateSceneAreaEdge(target.bounds, input.ground, input.tolerance);
  return edge ? resizeCursorForEdge(target.bounds, edge) : null;
}


export type FrameEdge = { x: -1 | 0 | 1; y: -1 | 0 | 1 };
export type FrameBounds = { x: number; y: number; width: number; height: number };

function roundedDistance(bounds: FrameBounds, point: { x: number; y: number }, radius: number): number {
  const dx = Math.abs(point.x - bounds.x - bounds.width / 2) - bounds.width / 2 + radius;
  const dy = Math.abs(point.y - bounds.y - bounds.height / 2) - bounds.height / 2 + radius;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Shared decision for both hover and press: title moves, perimeter resizes. */
export function workflowGroupInteraction(
  groups: ReadonlyMap<string, FrameBounds>,
  hit: import("./hit-test.js").HitTarget | null,
  point: { x: number; y: number },
  zoom: number
): { intent: "move"; cursor: "grab" } | { intent: "resize"; cursor: string; edge: FrameEdge } | null {
  if (!hit || !("nodeId" in hit)) return null;
  const bounds = groups.get(hit.nodeId);
  if (!bounds || (hit.kind !== "node" && hit.kind !== "resize")) return null;
  const { x, y, width, height } = bounds;
  // Same bounded title compensation as Rust scope_label_scale.
  const baseWidth = Math.max(56, Math.min(200, width * 0.72));
  const scale = Math.min(Math.max(1, 18 / (22 * Math.max(0.01, zoom))), Math.max(1, width * 0.72 / baseWidth));
  const title = { x: x + 12, y: y - 11 * scale, width: baseWidth * scale, height: 22 * scale };
  if (hit.kind === "node" && roundedDistance(title, point, 6 * scale) <= 0) return { intent: "move", cursor: "grab" };
  const tolerance = 6 / Math.max(0.01, zoom);
  const radius = Math.min(12, width / 2, height / 2);
  if (hit.kind !== "resize" && Math.abs(roundedDistance(bounds, point, radius)) > tolerance) return null;
  const corner = Math.max(radius, tolerance);
  const nearX = Math.min(Math.abs(point.x - x), Math.abs(point.x - x - width)) <= corner;
  const nearY = Math.min(Math.abs(point.y - y), Math.abs(point.y - y - height)) <= corner;
  const edge: FrameEdge = hit.kind === "resize" ? { x: 1, y: 1 } : {
    x: nearX ? (point.x < x + width / 2 ? -1 : 1) : 0,
    y: nearY ? (point.y < y + height / 2 ? -1 : 1) : 0
  };
  const cursor = edge.x && edge.y ? (edge.x === edge.y ? "nwse-resize" : "nesw-resize")
    : edge.x ? "ew-resize" : "ns-resize";
  return { intent: "resize", cursor, edge };
}

export function workflowGroupCursor(
  groups: ReadonlyMap<string, FrameBounds>,
  hit: import("./hit-test.js").HitTarget | null,
  point: { x: number; y: number },
  zoom: number
): string | null {
  return workflowGroupInteraction(groups, hit, point, zoom)?.cursor ?? null;
}
