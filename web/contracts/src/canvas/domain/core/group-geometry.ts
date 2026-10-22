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

export const groupPadding = 40;

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
export function getWoohaa3CanvasNodeAbsolutePosition(
  node: Woohaa3CanvasNode,
  nodeById: Map<string, Woohaa3CanvasNode>
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

export function getWoohaa3CanvasNodeRect(node: Woohaa3CanvasNode, nodeById: Map<string, Woohaa3CanvasNode>): { x: number; y: number; width: number; height: number } {
  const position = getWoohaa3CanvasNodeAbsolutePosition(node, nodeById);
  return { ...position, width: readNodeWidth(node), height: readNodeHeight(node) };
}

/** Minimum resize bounds required to keep every direct child inside a group. */
export function getGroupRequiredMinSize(nodes: Woohaa3CanvasNode[], groupId: string): { minWidth: number; minHeight: number } {
  const children = nodes.filter((node) => node.parentId === groupId);
  if (children.length === 0) return { minWidth: DEFAULT_NODE_DIMS.width, minHeight: DEFAULT_NODE_DIMS.height };
  const minLeft = Math.min(...children.map((child) => child.position.x));
  const minTop = Math.min(...children.map((child) => child.position.y));
  const maxRight = Math.max(...children.map((child) => child.position.x + readNodeWidth(child)));
  const maxBottom = Math.max(...children.map((child) => child.position.y + readNodeHeight(child)));
  return {
    minWidth: Math.max(DEFAULT_NODE_DIMS.width, maxRight + groupPadding, maxRight - minLeft + groupPadding * 2),
    minHeight: Math.max(DEFAULT_NODE_DIMS.height, maxBottom + groupPadding, maxBottom - minTop + groupPadding * 2)
  };
}

export function captureWoohaa3CanvasGroupRects(nodes: Woohaa3CanvasNode[]): Map<string, { x: number; y: number; width: number; height: number }> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const result = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const node of nodes) {
    if (node.type !== "group") continue;
    result.set(node.id, getWoohaa3CanvasNodeRect(node, nodeById));
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
  const absolutes = selectedNodes.map((node) => {
    const pos = getWoohaa3CanvasNodeAbsolutePosition(node, nodeById);
    return { x: pos.x, y: pos.y, width: readNodeWidth(node), height: readNodeHeight(node) };
  });
  const left = Math.min(...absolutes.map((n) => n.x));
  const top = Math.min(...absolutes.map((n) => n.y));
  const right = Math.max(...absolutes.map((n) => n.x + n.width));
  const bottom = Math.max(...absolutes.map((n) => n.y + n.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
