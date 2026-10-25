/**
 * 画布几何：有效渲染尺寸、节点世界包围盒、定位视口、对齐与等距分布
 * （change: 2026-10-09-improve-canvas-workflow，任务 4.1/4.3 / design D6）。
 *
 * 纯函数：搜索定位、任务定位与「定位当前选区」共用同一份世界几何与有效尺寸计算；
 * 对齐/分布在此计算世界坐标，调用方再转换到同一父级局部坐标。
 *
 * 尺寸语义只有一份：本模块不自带 legacy 尺寸推导，而是**重新导出**
 * `node-dimensions.ts` 的 `effectiveCanvasNodeSize`。渲染场景、canvas-script planner、
 * Agent 投影与 group 几何因此共享同一数值，避免「读到 196×64、渲染成 248×232」
 * 的世界坐标分叉。
 */
import { getWoohaa3CanvasNodeAbsolutePosition, getGroupLayoutSizes } from "./domain/core/group-ops.js";
import type { Woohaa3CanvasSerializedNode } from "./domain/core/document-schema.js";
import { clampWoohaa3CanvasZoom } from "./domain/core/viewport-zoom.js";
import { effectiveCanvasNodeSize as effectiveNodeSize } from "./node-dimensions.js";
export { effectiveNodeSize };

export type Rect = { x: number; y: number; width: number; height: number };
export type Position = { x: number; y: number };

/** 节点世界包围盒（含 group 父级链偏移与有效尺寸）。 */
export function nodeWorldRect(node: Woohaa3CanvasSerializedNode, byId: ReadonlyMap<string, Woohaa3CanvasSerializedNode>): Rect {
  const map = byId instanceof Map ? byId : new Map(byId as Iterable<[string, Woohaa3CanvasSerializedNode]>);
  const abs = getWoohaa3CanvasNodeAbsolutePosition(
    { id: node.id, type: node.type, position: node.position, parentId: node.parentId, data: {} },
    map as Map<string, { id: string; type: string; position: Position; parentId?: string; data: unknown }> as never
  );
  const size = (node.type === "group" ? getGroupLayoutSizes([...byId.values()]).get(node.id) : undefined)
    ?? effectiveNodeSize(node);
  return { x: abs.x, y: abs.y, width: size.width, height: size.height };
}

/** 多个节点世界包围盒的并集；空集合返回 null。 */
export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export type LocateViewportInput = {
  /** 目标世界包围盒。 */
  bounds: Rect;
  /** 当前视口。 */
  viewport: { x: number; y: number; zoom: number };
  /** 可用画布矩形尺寸（宿主像素）；null 时不计算。 */
  hostSize: { width: number; height: number } | null;
  /** 四周留白（像素）。 */
  padding?: number;
  /** 被 DOM 面板遮挡的可用区域（可选）；定位时避免居中到遮挡区。 */
  safeArea?: { left: number; top: number; right: number; bottom: number };
  minZoom?: number;
  maxZoom?: number;
};

/**
 * 计算把目标包围盒居中容纳进可用画布的视口（不写规范 viewport，由调用方本地应用）。
 *
 * - 使用共享缩放上下限；
 * - 目标无效（宽高非正/非有限）时返回 null（不移动到原点）；
 * - 避让 DOM 面板：以安全区中心而非画布中心作为可用中心。
 */
export function computeLocateViewport(input: LocateViewportInput): { x: number; y: number; zoom: number } | null {
  const { bounds, hostSize } = input;
  if (!hostSize || hostSize.width <= 0 || hostSize.height <= 0) return null;
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || bounds.width <= 0 || bounds.height <= 0) return null;

  const padding = input.padding ?? 64;
  const safe = input.safeArea ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const availWidth = Math.max(1, hostSize.width - safe.left - safe.right - padding * 2);
  const availHeight = Math.max(1, hostSize.height - safe.top - safe.bottom - padding * 2);
  const zoom = clampToRange(
    Math.min(availWidth / bounds.width, availHeight / bounds.height),
    input.minZoom ?? 0.1,
    input.maxZoom ?? 12
  );
  // 可用区中心（宿主像素）。
  const centerX = safe.left + (hostSize.width - safe.left - safe.right) / 2;
  const centerY = safe.top + (hostSize.height - safe.top - safe.bottom) / 2;
  const targetWorldCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  // viewport.x/y 是「世界原点在宿主像素上的位置」：center = worldCenter * zoom + offset。
  return {
    x: centerX - targetWorldCenter.x * zoom,
    y: centerY - targetWorldCenter.y * zoom,
    zoom
  };
}

function clampToRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return clampWoohaa3CanvasZoom(1);
  return clampWoohaa3CanvasZoom(Math.min(max, Math.max(min, value)));
}

/**
 * 计算把目标包围盒中心移到可用画布中心、**保持指定缩放**的视口
 * （change: 2026-10-09-improve-canvas-workflow，任务 4.1）。
 *
 * 用于「定位作品」：不改变当前缩放，只把目标平移到视野中心（调用方常配过渡动画）。
 * 目标无效返回 null（不移动到原点）。
 */
export function computeCenteredViewport(input: {
  bounds: Rect;
  hostSize: { width: number; height: number } | null;
  /** 目标缩放；通常传当前视口 zoom 以保持缩放不变。 */
  zoom: number;
  safeArea?: { left: number; top: number; right: number; bottom: number };
}): { x: number; y: number; zoom: number } | null {
  const { bounds, hostSize } = input;
  if (!hostSize || hostSize.width <= 0 || hostSize.height <= 0) return null;
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || bounds.width <= 0 || bounds.height <= 0) return null;
  const safe = input.safeArea ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const centerX = safe.left + (hostSize.width - safe.left - safe.right) / 2;
  const centerY = safe.top + (hostSize.height - safe.top - safe.bottom) / 2;
  const targetWorldCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const zoom = clampWoohaa3CanvasZoom(input.zoom);
  return { x: centerX - targetWorldCenter.x * zoom, y: centerY - targetWorldCenter.y * zoom, zoom };
}

// ---- 对齐与分布（task 4.3 / design D6） ----

export type AlignmentKind = "left" | "right" | "h-center" | "top" | "bottom" | "v-center";
export type DistributionKind = "horizontal" | "vertical";

export type AlignableNode = { id: string; rect: Rect };

export type ArrangeFailure = { ok: false; reason: string };

/**
 * 六种对齐：以选区原世界包围盒为锚点，仅移动对应轴坐标，不缩放、不改尺寸/层级。
 * 至少 2 个对象；返回每个对象新的世界坐标。
 */
export function computeAlignment(
  nodes: readonly AlignableNode[],
  kind: AlignmentKind
): { ok: true; positions: Map<string, Position> } | ArrangeFailure {
  if (nodes.length < 2) return { ok: false, reason: "至少选择两个作品才能对齐" };
  const bounds = unionRects(nodes.map((n) => n.rect))!;
  const positions = new Map<string, Position>();
  for (const node of nodes) {
    const { x, y, width, height } = node.rect;
    let nextX = x;
    let nextY = y;
    switch (kind) {
      case "left": nextX = bounds.x; break;
      case "right": nextX = bounds.x + bounds.width - width; break;
      case "h-center": nextX = bounds.x + (bounds.width - width) / 2; break;
      case "top": nextY = bounds.y; break;
      case "bottom": nextY = bounds.y + bounds.height - height; break;
      case "v-center": nextY = bounds.y + (bounds.height - height) / 2; break;
    }
    positions.set(node.id, { x: nextX, y: nextY });
  }
  return { ok: true, positions };
}

/**
 * 等距分布：按轴上起点、nodeId 稳定排序，固定两端外边界，间距 g 相等非负。
 * 至少 3 个对象；g < 0 时返回失败（不制造重叠或扩大选区）。
 */
export function computeDistribution(
  nodes: readonly AlignableNode[],
  kind: DistributionKind
): { ok: true; positions: Map<string, Position> } | ArrangeFailure {
  if (nodes.length < 3) return { ok: false, reason: "至少选择三个作品才能等距分布" };
  const horizontal = kind === "horizontal";
  const ordered = [...nodes].sort((left, right) => {
    const l = horizontal ? left.rect.x : left.rect.y;
    const r = horizontal ? right.rect.x : right.rect.y;
    if (l !== r) return l - r;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const sizeOf = (n: AlignableNode) => (horizontal ? n.rect.width : n.rect.height);
  const startOf = (n: AlignableNode) => (horizontal ? n.rect.x : n.rect.y);
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const spanStart = startOf(first);
  const spanEnd = startOf(last) + sizeOf(last);
  const totalSize = ordered.reduce((sum, n) => sum + sizeOf(n), 0);
  const gap = (spanEnd - spanStart - totalSize) / (ordered.length - 1);
  if (!Number.isFinite(gap) || gap < 0) {
    return { ok: false, reason: "空间不足，请先拉开两端作品" };
  }
  const positions = new Map<string, Position>();
  let cursor = spanStart;
  for (const node of ordered) {
    if (horizontal) positions.set(node.id, { x: cursor, y: node.rect.y });
    else positions.set(node.id, { x: node.rect.x, y: cursor });
    cursor += sizeOf(node) + gap;
  }
  return { ok: true, positions };
}
