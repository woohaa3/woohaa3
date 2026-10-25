/**
 * Group 操作：成组/解组/reparent/refit 与 parentId 清洗
 * （自 `group-ops.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R17）。
 */
import type { Woohaa3CanvasNode } from "./canvas-runtime";
import { createWoohaa3CanvasNode } from "./node-factory";
import { DEFAULT_NODE_DIMS } from "./node-factory";
import {
  applyNodeDimensions,
  getNodeBounds,
  getGroupLayoutSizes,
  getWoohaa3CanvasNodeAbsolutePosition,
  groupPadding,
  groupBottomPadding,
  readNodeHeight,
  readNodeWidth
} from "./group-geometry.js";
import { sortNodesParentsFirst } from "./group-selection.js";

/**
 * 清除指向不存在父节点的 parentId，并把相对坐标烘焙为绝对坐标。
 */
export function sanitizeWoohaa3CanvasParentIds(nodes: Woohaa3CanvasNode[]): Woohaa3CanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let changed = false;
  const next = nodes.map((node) => {
    if (!node.parentId || byId.has(node.parentId)) return node;
    changed = true;
    return {
      ...node,
      parentId: undefined,
      position: getWoohaa3CanvasNodeAbsolutePosition(node, byId)
    };
  });
  return changed ? next : nodes;
}

/**
 * 持久化结构节点的 parentId 清洗（change: add-canvas-node-grouping，design D1/D6）。
 */
export function sanitizeSerializedParentIds<T extends {
  id: string;
  parentId?: string;
  position: { x: number; y: number };
}>(nodes: T[]): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const absoluteOf = (node: T): { x: number; y: number } => {
    let x = node.position.x;
    let y = node.position.y;
    let parentId = node.parentId;
    const guard = new Set<string>([node.id]);
    while (parentId && !guard.has(parentId)) {
      guard.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      x += parent.position.x;
      y += parent.position.y;
      parentId = parent.parentId;
    }
    return { x, y };
  };
  let changed = false;
  const next = nodes.map((node) => {
    if (!node.parentId) return node;
    // 悬空 parent、自指或成环（祖先链回到自身）都视为坏结构，清除并烘焙绝对坐标。
    let cyclic = false;
    const guard = new Set<string>([node.id]);
    let cursor: string | undefined = node.parentId;
    while (cursor) {
      if (guard.has(cursor)) {
        cyclic = true;
        break;
      }
      guard.add(cursor);
      cursor = byId.get(cursor)?.parentId;
    }
    if (byId.has(node.parentId) && !cyclic) return node;
    changed = true;
    return { ...node, parentId: undefined, position: absoluteOf(node) };
  });
  return changed ? next : nodes;
}

/** 拖拽结束时用 React Flow 最新坐标覆盖 store，避免 reparent 读到陈旧落点 */
export function mergeDraggedNodePositions(
  storeNodes: Woohaa3CanvasNode[],
  rfNodes: Woohaa3CanvasNode[],
  draggedNodeIds: string[]
): Woohaa3CanvasNode[] {
  const draggedSet = new Set(draggedNodeIds);
  const rfById = new Map(rfNodes.map((node) => [node.id, node]));
  return storeNodes.map((node) => {
    if (!draggedSet.has(node.id)) return node;
    const latest = rfById.get(node.id);
    if (!latest) return node;
    return {
      ...node,
      position: latest.position,
      ...(typeof latest.width === "number" ? { width: latest.width } : {}),
      ...(typeof latest.height === "number" ? { height: latest.height } : {})
    };
  });
}

export function groupWoohaa3CanvasNodes(
  nodes: Woohaa3CanvasNode[],
  selectedNodeIds: string[]
): { nodes: Woohaa3CanvasNode[]; groupId: string } | null {
  const selectedIdSet = new Set(selectedNodeIds);
  const children = nodes.filter((node) => selectedIdSet.has(node.id) && node.type !== "group");
  if (children.length < 2) return null;

  const bounds = getNodeBounds(children);
  const group = createWoohaa3CanvasNode("group", {
    x: bounds.x - groupPadding,
    y: bounds.y - groupPadding
  });
  const groupNode: Woohaa3CanvasNode = applyNodeDimensions(
    group,
    bounds.width + groupPadding * 2,
    bounds.height + groupPadding + groupBottomPadding
  );

  return {
    groupId: groupNode.id,
    // group 必须排在子节点之前，否则 ReactFlow adoptUserNodes 处理子节点时父节点尚未入 lookup，
    // 子节点不会被识别为 nested child（不随 group 拖动、坐标错位）。
    nodes: sortNodesParentsFirst([
      groupNode,
      ...nodes.map((node) =>
        selectedIdSet.has(node.id) && node.type !== "group"
          ? {
              ...node,
              parentId: groupNode.id,
              position: {
                x: node.position.x - groupNode.position.x,
                y: node.position.y - groupNode.position.y
              }
            }
          : node
      )
    ])
  };
}

export function ungroupWoohaa3CanvasNodes(
  nodes: Woohaa3CanvasNode[],
  selectedNodeIds: string[]
): { nodes: Woohaa3CanvasNode[]; ungroupedNodeIds: string[] } | null {
  const selectedIdSet = new Set(selectedNodeIds);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const groupIdsToDissolve = new Set(
    nodes.filter((node) => selectedIdSet.has(node.id) && node.type === "group").map((node) => node.id)
  );
  const memberIdsToLeave = new Set(
    nodes
      .filter((node) =>
        selectedIdSet.has(node.id) && node.type !== "group" && !!node.parentId &&
        !groupIdsToDissolve.has(node.parentId)
      )
      .map((node) => node.id)
  );
  if (groupIdsToDissolve.size === 0 && memberIdsToLeave.size === 0) return null;

  const dissolvedGroups = new Map(
    nodes.filter((node) => groupIdsToDissolve.has(node.id)).map((node) => [node.id, node])
  );
  const ungroupedNodeIds: string[] = [];
  const nextNodes = nodes
    .filter((node) => !dissolvedGroups.has(node.id))
    .map((node) => {
      if (!node.parentId) return node;
      const dissolvingParent = dissolvedGroups.get(node.parentId);
      const leaveGroup = memberIdsToLeave.has(node.id);
      if (!dissolvingParent && !leaveGroup) return node;
      ungroupedNodeIds.push(node.id);
      // 新父级：解散的 group 若有自己的 parent，成员上提到该祖父级；否则成为顶层。
      const nextParentId = dissolvingParent ? dissolvingParent.parentId : undefined;
      const nextParentAbs = nextParentId
        ? getWoohaa3CanvasNodeAbsolutePosition(nodeById.get(nextParentId)!, nodeById)
        : { x: 0, y: 0 };
      const abs = getWoohaa3CanvasNodeAbsolutePosition(node, nodeById);
      return {
        ...node,
        parentId: nextParentId,
        position: { x: abs.x - nextParentAbs.x, y: abs.y - nextParentAbs.y }
      };
    });

  return {
    nodes: nextNodes,
    ungroupedNodeIds
  };
}

/**
 * 拖拽落点 reparent：把拖动的非 group 节点归入/拖出 group。
 */
export function reparentDraggedNodes(
  nodes: Woohaa3CanvasNode[],
  draggedNodeIds: string[],
  targetGroupId?: string | null,
  groupSizes?: ReadonlyMap<string, {width: number; height: number}>,
  eligibleGroupIds?: ReadonlySet<string>
): { nodes: Woohaa3CanvasNode[]; reparented: boolean } {
  const draggedSet = new Set(draggedNodeIds);
  if (draggedSet.size === 0) return { nodes, reparented: false };

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const sizes = groupSizes ?? getGroupLayoutSizes(nodes.filter(node => !draggedSet.has(node.id)));
  const groupBounds = nodes
    .filter((node) => node.type === "group" && (!eligibleGroupIds || eligibleGroupIds.has(node.id)))
    .map((group) => {
      const pos = getWoohaa3CanvasNodeAbsolutePosition(group, nodeById);
      return { id: group.id, x: pos.x, y: pos.y, ...sizes.get(group.id)! };
    });

  const hasExplicitTarget = !!targetGroupId && nodeById.has(targetGroupId) && (!eligibleGroupIds || eligibleGroupIds.has(targetGroupId));

  // nodeId -> 新父级 id（null 表示解除父子关系）
  const newParentFor = new Map<string, string | null>();
  for (const id of draggedNodeIds) {
    const node = nodeById.get(id);
    if (!node || node.type === "group") continue;

    if (hasExplicitTarget) {
      if (node.parentId !== targetGroupId) newParentFor.set(id, targetGroupId!);
      continue;
    }

    const abs = getWoohaa3CanvasNodeAbsolutePosition(node, nodeById);
    const cx = abs.x + readNodeWidth(node) / 2;
    const cy = abs.y + readNodeHeight(node) / 2;
    const hit = groupBounds.find(
      (b) => b.id !== id && cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height
    );
    if (hit) {
      if (hit.id !== node.parentId) newParentFor.set(id, hit.id);
      // 命中当前父级 → 保持不变（在自身组内拖动不脱离）
    } else if (node.parentId) {
      // 未命中任何 group 且原本属于某个 group → 拖出组，解除父子关系。
      newParentFor.set(id, null);
    }
  }
  if (newParentFor.size === 0) return { nodes, reparented: false };

  // 第一遍：应用 parentId / extent 变更，被 reparent 节点的 position 先按绝对坐标写入，
  // target group 收纳后再统一转换为相对坐标。
  const targetGroupIds = new Set<string>();
  const preliminary = nodes.map((node) => {
    const nextParentId = newParentFor.get(node.id);
    if (nextParentId === undefined) return node;
    if (nextParentId === null) {
      const abs = getWoohaa3CanvasNodeAbsolutePosition(node, nodeById);
      return { ...node, parentId: undefined, position: { x: abs.x, y: abs.y } };
    }
    targetGroupIds.add(nextParentId);
    // position 保留原值占位；最终相对坐标在第二遍按原始绝对坐标重算。
    return { ...node, parentId: nextParentId };
  });

  // 第二遍：每个 target group 扩展到容纳全部子节点。
  const groupRefit = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const groupId of targetGroupIds) {
    const children = preliminary.filter((node) => node.parentId === groupId);
    if (children.length === 0) continue;
    const absChildren = children.map((child) => {
      const original = nodeById.get(child.id)!;
      const abs = getWoohaa3CanvasNodeAbsolutePosition(original, nodeById);
      return { x: abs.x, y: abs.y, width: readNodeWidth(original), height: readNodeHeight(original) };
    });
    const originalGroup = nodeById.get(groupId)!;
    const groupPosition = getWoohaa3CanvasNodeAbsolutePosition(originalGroup, nodeById);
    const left = Math.min(...absChildren.map((c) => c.x - groupPadding), groupPosition.x);
    const top = Math.min(...absChildren.map((c) => c.y - groupPadding), groupPosition.y);
    const right = Math.max(
      ...absChildren.map((c) => c.x + c.width + groupPadding),
      groupPosition.x + readNodeWidth(originalGroup)
    );
    const bottom = Math.max(
      ...absChildren.map((c) => c.y + c.height + groupBottomPadding),
      groupPosition.y + readNodeHeight(originalGroup)
    );
    groupRefit.set(groupId, {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    });
  }

  const finalNodes = preliminary.map((node) => {
    // target group：应用新尺寸/位置（group 顶层，position 即画布绝对坐标）
    if (groupRefit.has(node.id)) {
      const fit = groupRefit.get(node.id)!;
      return applyNodeDimensions(
        { ...node, position: { x: fit.x, y: fit.y } },
        fit.width,
        fit.height
      );
    }
    // target group 的子节点：用原始绝对坐标减去新 group 位置得到相对坐标，落点保持不变
    if (node.parentId && groupRefit.has(node.parentId)) {
      const fit = groupRefit.get(node.parentId)!;
      const original = nodeById.get(node.id)!;
      const abs = getWoohaa3CanvasNodeAbsolutePosition(original, nodeById);
      return { ...node, position: { x: abs.x - fit.x, y: abs.y - fit.y } };
    }
    return node;
  });

  return { nodes: sortNodesParentsFirst(finalNodes), reparented: true };
}

/**
 * 让 group 根据子节点绝对位置自适应扩展。
 */
export function refitWoohaa3CanvasGroups(
  nodes: Woohaa3CanvasNode[],
  groupIds: Iterable<string>,
  floors?: Map<string, { x: number; y: number; width: number; height: number }>
): { nodes: Woohaa3CanvasNode[]; changed: boolean } {
  const targetGroupIds = new Set(groupIds);
  if (targetGroupIds.size === 0) return { nodes, changed: false };

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const fits = new Map<string, { x: number; y: number; width: number; height: number }>();

  for (const groupId of targetGroupIds) {
    const group = nodeById.get(groupId);
    if (!group || group.type !== "group") continue;
    const children = nodes.filter((node) => node.parentId === groupId);
    if (children.length === 0) continue;

    const bounds = children.map((child) => {
      const pos = getWoohaa3CanvasNodeAbsolutePosition(child, nodeById);
      return {
        x: pos.x - groupPadding,
        y: pos.y - groupPadding,
        width: readNodeWidth(child) + groupPadding * 2,
        height: readNodeHeight(child) + groupPadding + groupBottomPadding
      };
    });

    const floor = floors?.get(groupId);
    const left = Math.min(...bounds.map((item) => item.x), floor?.x ?? group.position.x);
    const top = Math.min(...bounds.map((item) => item.y), floor?.y ?? group.position.y);
    const right = Math.max(...bounds.map((item) => item.x + item.width), floor ? floor.x + floor.width : group.position.x + readNodeWidth(group));
    const bottom = Math.max(...bounds.map((item) => item.y + item.height), floor ? floor.y + floor.height : group.position.y + readNodeHeight(group));
    const fit = {
      x: left,
      y: top,
      width: Math.max(DEFAULT_NODE_DIMS.width, right - left),
      height: Math.max(DEFAULT_NODE_DIMS.height, bottom - top)
    };

    if (
      fit.x !== group.position.x ||
      fit.y !== group.position.y ||
      fit.width !== readNodeWidth(group) ||
      fit.height !== readNodeHeight(group)
    ) {
      fits.set(groupId, fit);
    }
  }

  if (fits.size === 0) {
    return { nodes, changed: false };
  }

  const nextNodes = nodes.map((node) => {
    const ownFit = fits.get(node.id);
    if (ownFit) {
      return applyNodeDimensions({ ...node, position: { x: ownFit.x, y: ownFit.y } }, ownFit.width, ownFit.height);
    }
    if (node.parentId && fits.has(node.parentId)) {
      const fit = fits.get(node.parentId)!;
      const abs = getWoohaa3CanvasNodeAbsolutePosition(node, nodeById);
      return { ...node, position: { x: abs.x - fit.x, y: abs.y - fit.y } };
    }
    return node;
  });

  return { nodes: sortNodesParentsFirst(nextNodes), changed: true };
}
