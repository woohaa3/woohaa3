/**
 * Group 操作：拓扑排序、选区闭包与选择规范化
 * （自 `group-ops.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R17）。
 */
import type { Woohaa3CanvasNode } from "./canvas-runtime";
import { getWoohaa3CanvasNodeAbsolutePosition, readNodeWidth, readNodeHeight } from "./group-geometry.js";

/** 为需要父级先挂载的 renderer 生成稳定顺序；领域 Store 本身不依赖此顺序。 */
export function sortNodesParentsFirst(nodes: Woohaa3CanvasNode[]): Woohaa3CanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sorted: Woohaa3CanvasNode[] = [];
  const added = new Set<string>();

  function visit(node: Woohaa3CanvasNode) {
    if (added.has(node.id)) return;
    if (node.parentId) {
      const parent = byId.get(node.parentId);
      if (parent && !added.has(parent.id)) visit(parent);
    }
    added.add(node.id);
    sorted.push(node);
  }

  for (const node of nodes) visit(node);
  return sorted.length === nodes.length ? sorted : nodes;
}

/**
 * Expands a selection containing one or more groups to include every nested
 * descendant. `parentId` is the source of truth for group membership; callers
 * must not rely on the optional group-node metadata for this.
 */
export function expandWoohaa3CanvasSelectionWithGroupDescendants(
  nodes: Woohaa3CanvasNode[],
  selectedNodeIds: Iterable<string>
): Woohaa3CanvasNode[] {
  const selected = new Set(selectedNodeIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!node.parentId || !selected.has(node.parentId) || selected.has(node.id)) continue;
      selected.add(node.id);
      changed = true;
    }
  }
  return sortNodesParentsFirst(nodes.filter((node) => selected.has(node.id)));
}

export function normalizeWoohaa3CanvasGroupSelection(nodes: Woohaa3CanvasNode[], selectedIds: string[]): string[] {
  if (selectedIds.length === 0) return selectedIds;
  const selected = new Set(selectedIds);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const depth = (groupId: string) => {
    let value = 0;
    let parentId = nodeById.get(groupId)?.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      value += 1;
      parentId = nodeById.get(parentId)?.parentId;
    }
    return value;
  };
  const groups = nodes.filter((node) => node.type === "group").sort((a, b) => depth(b.id) - depth(a.id));
  for (const group of groups) {
    const childIds = nodes.filter((node) => node.parentId === group.id).map((node) => node.id);
    if (!childIds.length) continue;
    const selectedChildren = childIds.filter((id) => selected.has(id));
    if (!selectedChildren.length) continue;
    if (selectedChildren.length === childIds.length) {
      childIds.forEach((id) => selected.delete(id));
      selected.add(group.id);
    } else {
      selected.delete(group.id);
    }
  }
  return [...selectedIds.filter((id, index) => selected.has(id) && selectedIds.indexOf(id) === index), ...[...selected].filter((id) => !selectedIds.includes(id))];
}

/**
 * 框选/组批量操作：把顶层选中节点中的 group 递归展开为叶子节点（按 parentId 归属），
 * 非 group 节点原样保留，结果按 allNodes 中的子节点顺序去重。
 */
export function expandSelectionWithGroups(
  topNodes: Woohaa3CanvasNode[],
  allNodes: Woohaa3CanvasNode[]
): Woohaa3CanvasNode[] {
  const result: Woohaa3CanvasNode[] = [];
  const seen = new Set<string>();

  const childrenByParent = new Map<string, Woohaa3CanvasNode[]>();
  for (const node of allNodes) {
    if (!node.parentId) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }
  const visit = (node: Woohaa3CanvasNode) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    if (node.type !== "group") {
      result.push(node);
      return;
    }
    for (const child of childrenByParent.get(node.id) ?? []) visit(child);
  };
  for (const node of topNodes) visit(node);

  return result;
}

/**
 * 拖拽过程中实时判定：节点中心当前落在哪个 group 的虚线框内（含自身当前父级）。
 * 用于「悬停 0.5s 吸附」的候选目标检测；返回 null 表示不在任何 group 内。
 */
export function findGroupContainingCenter(
  nodes: Woohaa3CanvasNode[],
  nodeId: string
): string | null {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const node = nodeById.get(nodeId);
  if (!node || node.type === "group") return null;
  const abs = getWoohaa3CanvasNodeAbsolutePosition(node, nodeById);
  const cx = abs.x + readNodeWidth(node) / 2;
  const cy = abs.y + readNodeHeight(node) / 2;
  for (const candidate of nodes) {
    if (candidate.type !== "group" || candidate.id === nodeId) continue;
    const pos = getWoohaa3CanvasNodeAbsolutePosition(candidate, nodeById);
    if (
      cx >= pos.x &&
      cx <= pos.x + readNodeWidth(candidate) &&
      cy >= pos.y &&
      cy <= pos.y + readNodeHeight(candidate)
    ) {
      return candidate.id;
    }
  }
  return null;
}

