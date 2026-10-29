/**
 * 画布小地图投影（2026-10-26）。
 *
 * 只把 working 画布投影成小地图可直接绘制的世界矩形与连线；不读 DOM、不建第二套
 * 相机、不触发布局读取。屏幕映射与视口换算也在这里保持纯函数，宿主组件只负责绘制和
 * 指针转发。
 *
 * 可见性与画布一致：
 * - 收起分组的后代按 `hiddenByCollapsedGroups` 跳过，分组自身用紧凑展示矩形；
 * - 复合资产（片场、炉体等）内部的受管节点不是概览卡片，按祖先类型排除。
 */
import {
  bevyKindForNodeType,
  groupPresentationRect,
  hiddenByCollapsedGroups,
  isCompositeAssetNodeType,
  isModelNodeType,
  nodeWorldRect,
  resolveNodeDisplayName,
  unionRects,
  type BevyNodeKind,
  type Rect,
  type ServerCanvas,
  type Woohaa3CanvasSerializedNode
} from "@woohaa3/contracts";

export type MinimapNode = {
  id: string;
  type: string;
  /** 视觉种类；决定小地图上的填色。 */
  kind: BevyNodeKind;
  /** 3D 内容节点：以小方块（积木）缩略图呈现。 */
  model: boolean;
  group: boolean;
  title: string;
  /** 世界坐标矩形（含父级链偏移与有效渲染尺寸）。 */
  rect: Rect;
};

export type MinimapEdge = {
  id: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
};

export type MinimapProjection = {
  nodes: readonly MinimapNode[];
  edges: readonly MinimapEdge[];
  /** 所有可见节点的世界包围盒；空画布为 null。 */
  bounds: Rect | null;
};

export type MinimapViewport = { x: number; y: number; zoom: number };
export type MinimapSurface = { width: number; height: number };

export type MinimapTransform = {
  /** 世界单位 → 小地图内部坐标的缩放。 */
  scale: number;
  /** 世界原点在小地图内部坐标中的偏移。 */
  offsetX: number;
  offsetY: number;
};

const EMPTY_PROJECTION: MinimapProjection = { nodes: [], edges: [], bounds: null };

/** 把 working 画布投影成小地图内容。纯函数，按画布对象身份可安全 memo。 */
export function projectMinimap(canvas: ServerCanvas | null): MinimapProjection {
  if (!canvas) return EMPTY_PROJECTION;
  const document = canvas.document;
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const hidden = hiddenByCollapsedGroups(canvas);
  const nodes: MinimapNode[] = [];
  for (const node of document.nodes) {
    const visible = !hidden.has(node.id) && !insideCompositeAsset(node, byId);
    if (!visible) continue;
    const data = canvas.nodeData[node.id] ?? {};
    const title = resolveNodeDisplayName({
      type: node.type,
      explicitName: data.title,
      prompt: data.prompt
    }).displayName;
    const collapsed = node.type === "group" && data.groupCollapsed === true;
    const rect = groupPresentationRect(node, collapsed, nodeWorldRect(node, byId), data.groupBadgeScale);
    const kind = bevyKindForNodeType(node.type);
    nodes.push({
      id: node.id,
      type: node.type,
      kind,
      model: isModelNodeType(node.type),
      group: node.type === "group",
      title,
      rect
    });
  }
  const byVisibleId = new Map(nodes.map((node) => [node.id, node]));
  const edges: MinimapEdge[] = [];
  for (const edge of document.edges) {
    const source = byVisibleId.get(edge.source);
    const target = byVisibleId.get(edge.target);
    if (!source || !target) continue;
    edges.push({
      id: edge.id,
      from: rectCenter(source.rect),
      to: rectCenter(target.rect)
    });
  }
  return {
    nodes,
    edges,
    bounds: unionRects(nodes.map((node) => node.rect))
  };
}

function insideCompositeAsset(
  node: Woohaa3CanvasSerializedNode,
  byId: ReadonlyMap<string, Woohaa3CanvasSerializedNode>
): boolean {
  const visited = new Set<string>();
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return false;
    if (isCompositeAssetNodeType(parent.type)) return true;
    parentId = parent.parentId;
  }
  return false;
}

export function rectCenter(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * 把内容包围盒等比放进小地图内部坐标，居中留白。
 *
 * 内容为空时用当前视口的 1.4 倍范围兜底，空画布也能看到视口指示框而不是一张纯色底。
 */
export function fitMinimapTransform(
  bounds: Rect | null,
  fallback: Rect | null,
  width: number,
  height: number,
  padding: number
): MinimapTransform {
  const content = usableBounds(bounds) ?? expandRect(fallback, 1.4) ?? {
    x: -width / 2,
    y: -height / 2,
    width,
    height
  };
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const scale = Math.min(availableWidth / content.width, availableHeight / content.height);
  return {
    scale,
    offsetX: padding + (availableWidth - content.width * scale) / 2 - content.x * scale,
    offsetY: padding + (availableHeight - content.height * scale) / 2 - content.y * scale
  };
}

function usableBounds(rect: Rect | null): Rect | null {
  if (!rect) return null;
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return null;
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

function expandRect(rect: Rect | null, factor: number): Rect | null {
  const usable = usableBounds(rect);
  if (!usable) return null;
  const width = usable.width * factor;
  const height = usable.height * factor;
  return {
    x: usable.x + (usable.width - width) / 2,
    y: usable.y + (usable.height - height) / 2,
    width,
    height
  };
}

/** 世界矩形 → 小地图内部坐标。 */
export function minimapRect(rect: Rect, transform: MinimapTransform): Rect {
  return {
    x: rect.x * transform.scale + transform.offsetX,
    y: rect.y * transform.scale + transform.offsetY,
    width: rect.width * transform.scale,
    height: rect.height * transform.scale
  };
}

/** 世界坐标 → 小地图内部坐标。 */
export function minimapPoint(
  point: { x: number; y: number },
  transform: MinimapTransform
): { x: number; y: number } {
  return {
    x: point.x * transform.scale + transform.offsetX,
    y: point.y * transform.scale + transform.offsetY
  };
}

/** 小地图内部坐标 → 世界坐标。 */
export function minimapPointToWorld(
  point: { x: number; y: number },
  transform: MinimapTransform
): { x: number; y: number } {
  return {
    x: (point.x - transform.offsetX) / transform.scale,
    y: (point.y - transform.offsetY) / transform.scale
  };
}

/** 当前视口覆盖的世界矩形。`viewport.x/y` 是世界原点在画布左上角像素上的位置。 */
export function viewportWorldRect(
  viewport: MinimapViewport | null,
  surface: MinimapSurface | null
): Rect | null {
  if (!viewport || !surface) return null;
  if (!(viewport.zoom > 0) || !(surface.width > 0) || !(surface.height > 0)) return null;
  return {
    x: -viewport.x / viewport.zoom,
    y: -viewport.y / viewport.zoom,
    width: surface.width / viewport.zoom,
    height: surface.height / viewport.zoom
  };
}

/**
 * 让指定世界点落在画布中心、保持缩放。
 *
 * 返回的是控制器的本地视口格式；调用方自行决定瞬时或带动画地提交。
 */
export function viewportCenteredOn(
  world: { x: number; y: number },
  viewport: MinimapViewport,
  surface: MinimapSurface
): MinimapViewport {
  return {
    x: surface.width / 2 - world.x * viewport.zoom,
    y: surface.height / 2 - world.y * viewport.zoom,
    zoom: viewport.zoom
  };
}
