/**
 * Group 操作：几何与坐标
 * （自 `group-ops.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R17）。
 *
 * 节点宽高读取、绝对坐标、包围盒与 group 框契约。纯函数、无副作用。
 *
 * 宽高读取统一走 `effectiveCanvasNodeSize`：group 包围盒/框必须按**可见**尺寸计算，
 * 否则紧凑的旧 model3d 卡片（存 196×64、渲染 248×232）会算在渲染矩形之外
 * （change: 统一画布尺寸语义）。
 */
import { effectiveCanvasNodeSize } from "../../node-dimensions.js";
import { DEFAULT_NODE_DIMS } from "./node-factory";
import type { Woohaa3CanvasNode } from "./canvas-runtime";

/**
 * 组成员到组框的内边距（change: canvas-grouping-redesign）。
 *
 * 参考稿里组框紧贴成员、只留一圈窄边，组名浮在框外上方，因此不再需要旧版那个
 * 40/80 的大留白（80 的 footer 原本是留给组徽章的，徽章已随 redesign 移除）。
 */
export const groupPadding = 12;
/** 底部内边距：与左右一致，组框不再额外留出 footer。 */
export const groupBottomPadding = 12;
/** Shallow badge lip in canvas units, outside member/resize bounds. */
export const groupBadgeOutset = 6;

type LayoutNode = Pick<Woohaa3CanvasNode, "id" | "type" | "parentId" | "position" | "width" | "height">;
type LayoutSize = { width: number; height: number };

function requiredSize(children: LayoutNode[], sizeOf: (node: LayoutNode) => LayoutSize) {
  if (!children.length) return { minWidth: DEFAULT_NODE_DIMS.width, minHeight: DEFAULT_NODE_DIMS.height };
  const minLeft = Math.min(...children.map(child => child.position.x));
  const minTop = Math.min(...children.map(child => child.position.y));
  const right = Math.max(...children.map(child => child.position.x + sizeOf(child).width));
  const bottom = Math.max(...children.map(child => child.position.y + sizeOf(child).height));
  return {
    minWidth: Math.max(DEFAULT_NODE_DIMS.width, right + groupPadding, right - minLeft + groupPadding * 2),
    minHeight: Math.max(DEFAULT_NODE_DIMS.height, bottom + groupBottomPadding, bottom - minTop + groupPadding + groupBottomPadding)
  };
}

/**
 * 成员**完全在框内**的硬下限：左右/上不预留装饰留白，只保留底部页脚（徽标间隔）。
 *
 * 渲染投影用它而非 {@link requiredSize}：用户拖框边缩小气泡时成员保持画布绝对位置，
 * 框可以一直收到贴住成员；手工缩小后的尺寸不会被「成员 + 左右留白」重新撑回去。
 * 新建/自动适配仍用 `requiredSize` 留出留白（见 {@link getGroupRequiredMinSize}）。
 */
function contentSize(children: LayoutNode[], sizeOf: (node: LayoutNode) => LayoutSize) {
  if (!children.length) return { minWidth: DEFAULT_NODE_DIMS.width, minHeight: DEFAULT_NODE_DIMS.height };
  const right = Math.max(...children.map(child => child.position.x + sizeOf(child).width));
  const bottom = Math.max(...children.map(child => child.position.y + sizeOf(child).height));
  return {
    minWidth: Math.max(DEFAULT_NODE_DIMS.width, right),
    // 底部页脚（徽标与成员之间的间隔）仍保留；左右/上不再预留装饰留白。
    minHeight: Math.max(DEFAULT_NODE_DIMS.height, bottom + groupBottomPadding)
  };
}

/** Current group display sizes, including existing documents and nested/resizing members.
 * Pure projection: reserve the footer without moving members or silently rewriting stored nodes.
 */
export function getGroupLayoutSizes(nodes: readonly LayoutNode[], overrides?: ReadonlyMap<string, LayoutSize>): Map<string, LayoutSize> {
  const children = new Map<string, LayoutNode[]>();
  for (const node of nodes) if (node.parentId) {
    const list = children.get(node.parentId) ?? [];
    list.push(node); children.set(node.parentId, list);
  }
  const sizes = new Map<string, LayoutSize>();
  const visiting = new Set<string>();
  const sizeOf = (node: LayoutNode): LayoutSize => {
    const cached = sizes.get(node.id); if (cached) return cached;
    const size = effectiveCanvasNodeSize(node, overrides?.get(node.id));
    if (node.type !== "group" || visiting.has(node.id)) return size;
    // 交互缩放预览的尺寸由手势自行 clamp（`resizeTarget` 按拖动方向贴住成员），
    // 投影不得再用成员尺寸把它顶回去，否则拖小后的组框会闪回。
    if (overrides?.has(node.id)) { sizes.set(node.id, size); return size; }
    visiting.add(node.id);
    const members = children.get(node.id) ?? [];
    // 手工缩小后的组框没有留白，成员仍完全在框内，必须按存储尺寸渲染，否则会被「成员 + 留白」
    // 重新撑回去。只有存储尺寸装不下成员（历史数据/成员外溢）时才按带留白的最小尺寸修复。
    const content = members.length ? contentSize(members, sizeOf) : { minWidth: size.width, minHeight: size.height };
    const contained = size.width >= content.minWidth && size.height >= content.minHeight;
    const min = contained || !members.length
      ? content
      : requiredSize(members, sizeOf);
    const result = { width: Math.max(size.width, min.minWidth), height: Math.max(size.height, min.minHeight) };
    visiting.delete(node.id); sizes.set(node.id, result); return result;
  };
  for (const node of nodes) if (node.type === "group") sizeOf(node);
  return sizes;
}

export function applyNodeDimensions(node: Woohaa3CanvasNode, width: number, height: number): Woohaa3CanvasNode {
  return {
    ...node,
    width,
    height
  };
}

export function readNodeWidth(node: Woohaa3CanvasNode): number {
  return effectiveCanvasNodeSize(node).width;
}

export function readNodeHeight(node: Woohaa3CanvasNode): number {
  return effectiveCanvasNodeSize(node).height;
}

export function getNodeBounds(nodes: Woohaa3CanvasNode[]) {
  const left = Math.min(...nodes.map((node) => node.position.x));
  const top = Math.min(...nodes.map((node) => node.position.y));
  const right = Math.max(...nodes.map((node) => node.position.x + readNodeWidth(node)));
  const bottom = Math.max(...nodes.map((node) => node.position.y + readNodeHeight(node)));
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

/** 计算节点绝对画布坐标（含 group parentId 偏移），供工具条包围盒定位使用 */
export function getWoohaa3CanvasNodeAbsolutePosition<T extends Pick<Woohaa3CanvasNode, "position" | "parentId">>(
  node: T,
  nodeById: ReadonlyMap<string, Pick<Woohaa3CanvasNode, "position" | "parentId">>
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const guard = new Set<string>();
  while (parentId && !guard.has(parentId)) {
    guard.add(parentId);
    const parent = nodeById.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

export function getWoohaa3CanvasNodeRect(node: Woohaa3CanvasNode, nodeById: Map<string, Woohaa3CanvasNode>, groupSizes?: ReadonlyMap<string, LayoutSize>): { x: number; y: number; width: number; height: number } {
  const position = getWoohaa3CanvasNodeAbsolutePosition(node, nodeById);
  const size = node.type === "group"
    ? (groupSizes ?? getGroupLayoutSizes([...nodeById.values()])).get(node.id)
    : undefined;
  return { ...position, ...(size ?? effectiveCanvasNodeSize(node)) };
}

/** Minimum resize bounds required to keep every direct child inside a group. */
export function getGroupRequiredMinSize(nodes: Woohaa3CanvasNode[], groupId: string): { minWidth: number; minHeight: number } {
  const sizes = getGroupLayoutSizes(nodes);
  return requiredSize(nodes.filter(node => node.parentId === groupId), node => sizes.get(node.id) ?? effectiveCanvasNodeSize(node));
}

export function captureWoohaa3CanvasGroupRects(nodes: Woohaa3CanvasNode[]): Map<string, { x: number; y: number; width: number; height: number }> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const result = new Map<string, { x: number; y: number; width: number; height: number }>();
  const sizes = getGroupLayoutSizes(nodes);
  for (const node of nodes) {
    if (node.type !== "group") continue;
    result.set(node.id, getWoohaa3CanvasNodeRect(node, nodeById, sizes));
  }
  return result;
}

/** 选中节点包围盒（绝对坐标），供框选工具条定位 */
export function getWoohaa3CanvasSelectionBounds(
  selectedNodes: Woohaa3CanvasNode[],
  allNodes: Woohaa3CanvasNode[]
): { x: number; y: number; width: number; height: number } | null {
  if (selectedNodes.length === 0) return null;
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const sizes = getGroupLayoutSizes(allNodes);
  const absolutes = selectedNodes.map(node => getWoohaa3CanvasNodeRect(node, nodeById, sizes));
  const left = Math.min(...absolutes.map((n) => n.x));
  const top = Math.min(...absolutes.map((n) => n.y));
  const right = Math.max(...absolutes.map((n) => n.x + n.width));
  const bottom = Math.max(...absolutes.map((n) => n.y + n.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
