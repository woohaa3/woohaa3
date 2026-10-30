/**
 * Drag release geometry.
 *
 * This module is deliberately a pure leaf: it consumes a working snapshot and
 * returns a complete candidate or a side effect free failure.  It does not
 * resize groups and it never turns the result into canonical state by itself.
 */
import type { Woohaa3CanvasNode } from "./canvas-runtime";
import { groupPresentationRect } from "../../group-presentation.js";
import { groupBadgeBounds, type GroupBadgeProjection } from "../../group-badge.js";
import {
  getGroupLayoutSizes,
  getWoohaa3CanvasNodeAbsolutePosition,
  groupBottomPadding,
  groupPadding,
  readNodeHeight,
  readNodeWidth,
} from "./group-geometry.js";
import { sortNodesParentsFirst } from "./group-selection.js";

export type DropPoint = { x: number; y: number };
export type DropRect = { x: number; y: number; width: number; height: number };
export type DropDirection = "left" | "right" | "top" | "bottom";

export const GROUP_DROP_MAX_CANDIDATES = 128;
export const GROUP_DROP_EPSILON = 1e-7;

export type GroupDropSettlementResult = {
  ok: boolean;
  nodes: Woohaa3CanvasNode[];
  reason?: "invalid-geometry" | "space-exhausted" | "node-too-large" | "protected-node";
  /** Number of bounded candidates evaluated by the group search. */
  candidatesEvaluated: number;
  movedNodeIds: string[];
};

type GroupCandidate = DropRect & { id: string; depth: number; order: number; collapsed?: boolean };

const finite = (value: number): boolean => Number.isFinite(value);
const finiteRect = (rect: DropRect): boolean =>
  [rect.x, rect.y, rect.width, rect.height].every(finite) && rect.width >= 0 && rect.height >= 0;

export function dropRectOverlaps(a: DropRect, b: DropRect): boolean {
  if (!finiteRect(a) || !finiteRect(b)) return false;
  return a.x < b.x + b.width - GROUP_DROP_EPSILON &&
    a.x + a.width > b.x + GROUP_DROP_EPSILON &&
    a.y < b.y + b.height - GROUP_DROP_EPSILON &&
    a.y + a.height > b.y + GROUP_DROP_EPSILON;
}

export function groupInnerRect(group: DropRect): DropRect {
  return {
    x: group.x + groupPadding,
    y: group.y + groupPadding,
    width: Math.max(0, group.width - groupPadding * 2),
    height: Math.max(0, group.height - groupPadding - groupBottomPadding),
  };
}

/** Clamp a node into the frozen group content area. */
export function clampDropPointToGroup(
  ideal: DropPoint,
  size: { width: number; height: number },
  group: DropRect,
): DropPoint | null {
  if (![ideal.x, ideal.y, size.width, size.height].every(finite) || !finiteRect(group)) return null;
  const inner = groupInnerRect(group);
  if (size.width > inner.width + GROUP_DROP_EPSILON || size.height > inner.height + GROUP_DROP_EPSILON) return null;
  return {
    x: Math.min(Math.max(ideal.x, inner.x), inner.x + inner.width - size.width),
    y: Math.min(Math.max(ideal.y, inner.y), inner.y + inner.height - size.height),
  };
}

/**
 * Return the nearest fully external projection.  Equal distances use the
 * documented left/right/top/bottom order and are independent of zoom.
 */
export function projectDropPointOutside(
  ideal: DropPoint,
  size: { width: number; height: number },
  obstacle: DropRect,
): Array<{ point: DropPoint; direction: DropDirection; distance: number }> {
  if (![ideal.x, ideal.y, size.width, size.height].every(finite) || !finiteRect(obstacle)) return [];
  const candidates: Array<{ point: DropPoint; direction: DropDirection; distance: number; order: number }> = [
    { point: { x: obstacle.x - size.width, y: ideal.y }, direction: "left" as const, order: 0 },
    { point: { x: obstacle.x + obstacle.width, y: ideal.y }, direction: "right" as const, order: 1 },
    { point: { x: ideal.x, y: obstacle.y - size.height }, direction: "top" as const, order: 2 },
    { point: { x: ideal.x, y: obstacle.y + obstacle.height }, direction: "bottom" as const, order: 3 },
  ].map((candidate) => ({
    ...candidate,
    distance: (candidate.point.x - ideal.x) ** 2 + (candidate.point.y - ideal.y) ** 2,
  }));
  return candidates.sort((a, b) => a.distance - b.distance || a.order - b.order)
    .map(({ order: _order, ...candidate }) => candidate);
}

function depthOf(node: Woohaa3CanvasNode, byId: ReadonlyMap<string, Woohaa3CanvasNode>): number {
  let depth = 0;
  let parent = node.parentId;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    depth += 1;
    parent = byId.get(parent)?.parentId;
  }
  return depth;
}

function isDescendant(id: string, ancestor: string, byId: ReadonlyMap<string, Woohaa3CanvasNode>): boolean {
  let parent = byId.get(id)?.parentId;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    if (parent === ancestor) return true;
    seen.add(parent);
    parent = byId.get(parent)?.parentId;
  }
  return false;
}

function buildGroups(
  nodes: readonly Woohaa3CanvasNode[],
  byId: ReadonlyMap<string, Woohaa3CanvasNode>,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
  eligible?: ReadonlySet<string>,
  collapsed?: ReadonlySet<string>,
  projections?: ReadonlyMap<string, GroupBadgeProjection>,
): GroupCandidate[] {
  return nodes.flatMap((node, order) => {
    if (node.type !== "group" || (eligible && !eligible.has(node.id))) return [];
    // Center hit testing uses the structural frame. The badge lip belongs to
    // the occupied obstacle range only and must not turn into a drop target.
    const position = nodeAbsolutePosition(node, byId);
    const size = sizes.get(node.id) ?? { width: readNodeWidth(node), height: readNodeHeight(node) };
    const rect = groupFrameRect(node, position, size, collapsed?.has(node.id) === true, projections?.get(node.id));
    return [{ ...rect, id: node.id, depth: depthOf(node, byId), order }];
  });
}

/** Collapsed groups occupy only their model badge; expanded groups keep their frame. */
function groupFrameRect(
  node: Woohaa3CanvasNode,
  position: DropPoint,
  size: { width: number; height: number },
  compact: boolean,
  projection?: GroupBadgeProjection,
): DropRect {
  return groupPresentationRect({ type: node.type }, compact, {
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
  }, projection);
}

function nodeAbsolutePosition(node: Woohaa3CanvasNode, byId: ReadonlyMap<string, Woohaa3CanvasNode>): DropPoint {
  // The contracts helper only reads the map. Reuse the working identity map
  // instead of copying the complete document for each candidate.
  return getWoohaa3CanvasNodeAbsolutePosition(node, byId as Map<string, Woohaa3CanvasNode>);
}

function withAbsolutePosition(
  node: Woohaa3CanvasNode,
  absolute: DropPoint,
  parentId: string | undefined,
  byId: ReadonlyMap<string, Woohaa3CanvasNode>,
): Woohaa3CanvasNode {
  const parent = parentId ? byId.get(parentId) : undefined;
  const parentPosition = parent ? nodeAbsolutePosition(parent, byId) : { x: 0, y: 0 };
  return { ...node, parentId, position: { x: absolute.x - parentPosition.x, y: absolute.y - parentPosition.y } };
}

function chooseTargetGroup(
  center: DropPoint,
  groups: readonly GroupCandidate[],
): GroupCandidate | undefined {
  return groups
    .filter((group) => center.x >= group.x && center.x <= group.x + group.width && center.y >= group.y && center.y <= group.y + group.height)
    .sort((a, b) => b.depth - a.depth || a.order - b.order)[0];
}

/**
 * Return the structural group(s) whose frozen frame contains the final center
 * of each dragged ordinary node.  This is a render-only projection used while
 * dragging; it deliberately shares the same target selection rule as release
 * settlement and never changes parentId or document state.
 */
export function resolveDraggedNodeDropTargets(
  nodes: readonly Woohaa3CanvasNode[],
  draggedNodeIds: readonly string[],
  idealPositions: ReadonlyMap<string, DropPoint>,
  options: {
    groupSizes?: ReadonlyMap<string, { width: number; height: number }>;
    eligibleGroupIds?: ReadonlySet<string>;
  } = {},
): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sizes = options.groupSizes ?? getGroupLayoutSizes(nodes);
  const groups = buildGroups(nodes, byId, sizes, options.eligibleGroupIds);
  const targets = new Set<string>();
  for (const id of draggedNodeIds) {
    const node = byId.get(id);
    const ideal = idealPositions.get(id);
    if (!node || node.type === "group" || !ideal) continue;
    const width = readNodeWidth(node);
    const height = readNodeHeight(node);
    const target = chooseTargetGroup({ x: ideal.x + width / 2, y: ideal.y + height / 2 }, groups);
    if (target) targets.add(target.id);
  }
  return [...targets].sort((left, right) => {
    const a = groups.find((group) => group.id === left);
    const b = groups.find((group) => group.id === right);
    return (a?.order ?? 0) - (b?.order ?? 0);
  });
}

function validateFiniteNodes(nodes: readonly Woohaa3CanvasNode[]): boolean {
  return nodes.every((node) => [node.position.x, node.position.y, readNodeWidth(node), readNodeHeight(node)].every(finite));
}

/**
 * Settle ordinary dragged nodes independently. Group dimensions are frozen by
 * `groupSizes`; no group is refit as a side effect.
 */
export function settleDraggedNodeBoundaries(
  nodes: readonly Woohaa3CanvasNode[],
  draggedNodeIds: readonly string[],
  idealPositions: ReadonlyMap<string, DropPoint>,
  options: {
    groupSizes?: ReadonlyMap<string, { width: number; height: number }>;
    eligibleGroupIds?: ReadonlySet<string>;
    documentOrder?: ReadonlyMap<string, number>;
    collapsedGroupIds?: ReadonlySet<string>;
    groupBadgeProjections?: ReadonlyMap<string, GroupBadgeProjection>;
  } = {},
): GroupDropSettlementResult {
  const source = [...nodes];
  const byId = new Map(source.map((node) => [node.id, node]));
  if (!validateFiniteNodes(source)) return { ok: false, nodes: source, reason: "invalid-geometry", candidatesEvaluated: 0, movedNodeIds: [] };
  const sizes = options.groupSizes ?? getGroupLayoutSizes(source);
  const groups = buildGroups(source, byId, sizes, options.eligibleGroupIds);
  const allGroups = buildGroups(source, byId, sizes, undefined, options.collapsedGroupIds, options.groupBadgeProjections);
  const next = new Map(source.map((node) => [node.id, node]));
  const movedNodeIds: string[] = [];
  let candidatesEvaluated = 0;
  for (const id of draggedNodeIds) {
    const original = byId.get(id);
    const ideal = idealPositions.get(id);
    if (!original || original.type === "group" || !ideal) continue;
    const size = { width: readNodeWidth(original), height: readNodeHeight(original) };
    const center = { x: ideal.x + size.width / 2, y: ideal.y + size.height / 2 };
    const target = chooseTargetGroup(center, groups);
    let resolved = ideal;
    let parentId = original.parentId;
    if (target) {
      const clamped = clampDropPointToGroup(ideal, size, target);
      if (clamped) {
        resolved = clamped;
        parentId = target.id;
      } else {
        // A node that cannot fit is explicitly rejected from the target.  It
        // may still be placed outside the target, subject to all relevant
        // group boundaries.
        const outside = projectDropPointOutside(ideal, size, target).find((candidate) => {
          candidatesEvaluated += 1;
          return !dropRectOverlaps({ ...candidate.point, width: size.width, height: size.height }, target);
        });
        if (!outside) return { ok: false, nodes: source, reason: "node-too-large", candidatesEvaluated, movedNodeIds: [] };
        resolved = outside.point;
        parentId = original.parentId && isDescendant(target.id, original.parentId, byId) ? original.parentId : undefined;
      }
    } else {
      const occupied = allGroups.filter((group) => dropRectOverlaps({ ...ideal, width: size.width, height: size.height }, group));
      if (occupied.length > 0) {
        // Center outside but card crossing a frame: project fully outside all
        // relevant frames. The first group is document-order stable.
        const obstacle = occupied[0]!;
        const outside = projectDropPointOutside(ideal, size, obstacle).find((candidate) => {
          candidatesEvaluated += 1;
          const candidateRect = { ...candidate.point, width: size.width, height: size.height };
          return !occupied.some((group) => dropRectOverlaps(candidateRect, group));
        });
        if (!outside) return { ok: false, nodes: source, reason: "space-exhausted", candidatesEvaluated, movedNodeIds: [] };
        resolved = outside.point;
        parentId = undefined;
      } else if (original.parentId) {
        const ownParent = groups.find((group) => group.id === original.parentId);
        // A collapsed/hidden parent is still the canonical owner. It is not a
        // drop target, but dragging its hidden descendants must not implicitly
        // detach them.
        parentId = ownParent ? undefined : original.parentId;
      }
    }
    const updated = withAbsolutePosition(original, resolved, parentId, byId);
    next.set(id, updated);
    if (updated.parentId !== original.parentId || updated.position.x !== original.position.x || updated.position.y !== original.position.y) movedNodeIds.push(id);
  }
  const result = sortNodesParentsFirst([...next.values()]);
  if (!validateFiniteNodes(result)) return { ok: false, nodes: source, reason: "invalid-geometry", candidatesEvaluated, movedNodeIds: [] };
  return { ok: true, nodes: result, candidatesEvaluated, movedNodeIds };
}

function groupRectAt(group: Woohaa3CanvasNode, absolute: DropPoint, sizes: ReadonlyMap<string, { width: number; height: number }>, collapsed?: ReadonlySet<string>, projections?: ReadonlyMap<string, GroupBadgeProjection>): DropRect {
  const size = sizes.get(group.id) ?? { width: readNodeWidth(group), height: readNodeHeight(group) };
  const frame = { x: absolute.x, y: absolute.y, width: size.width, height: size.height };
  const projection = projections?.get(group.id);
  const rect = groupPresentationRect(group, collapsed?.has(group.id) === true, frame, projection);
  if (collapsed?.has(group.id)) return rect;
  return groupBadgeBounds(frame, projection);
}

/** Settle active group overlap while preserving every ordinary node in place. */
export function settleDraggedGroups(
  nodes: readonly Woohaa3CanvasNode[],
  movingGroupIds: readonly string[],
  idealPositions: ReadonlyMap<string, DropPoint>,
  options: {
    groupSizes?: ReadonlyMap<string, { width: number; height: number }>;
    eligibleGroupIds?: ReadonlySet<string>;
    maxCandidates?: number;
    protectedNodeIds?: ReadonlySet<string>;
    collapsedGroupIds?: ReadonlySet<string>;
    groupBadgeProjections?: ReadonlyMap<string, GroupBadgeProjection>;
  } = {},
): GroupDropSettlementResult {
  const source = [...nodes];
  const byId = new Map(source.map((node) => [node.id, node]));
  if (!validateFiniteNodes(source)) return { ok: false, nodes: source, reason: "invalid-geometry", candidatesEvaluated: 0, movedNodeIds: [] };
  const sizes = options.groupSizes ?? getGroupLayoutSizes(source);
  const groups = buildGroups(source, byId, sizes, options.eligibleGroupIds);
  const allGroups = buildGroups(source, byId, sizes, undefined, options.collapsedGroupIds, options.groupBadgeProjections);
  const moving = new Set(movingGroupIds.filter((id) => byId.get(id)?.type === "group"));
  if (!moving.size) return { ok: true, nodes: source, candidatesEvaluated: 0, movedNodeIds: [] };
  const ideal = new Map<string, DropPoint>();
  for (const id of moving) ideal.set(id, idealPositions.get(id) ?? nodeAbsolutePosition(byId.get(id)!, byId));
  const fixedGroups = allGroups.filter((group) => !moving.has(group.id) && ![...moving].some((id) => isDescendant(group.id, id, byId) || isDescendant(id, group.id, byId)));
  const limit = options.maxCandidates ?? GROUP_DROP_MAX_CANDIDATES;
  let candidatesEvaluated = 0;
  let delta: DropPoint = { x: 0, y: 0 };
  const directions: DropPoint[] = [
    { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 },
  ];
  const collides = (candidateDelta: DropPoint): boolean => {
    for (const id of moving) {
      const group = byId.get(id)!;
      const absolute = { x: ideal.get(id)!.x + candidateDelta.x, y: ideal.get(id)!.y + candidateDelta.y };
      const rect = groupRectAt(group, absolute, sizes, options.collapsedGroupIds, options.groupBadgeProjections);
      if (fixedGroups.some((fixed) => dropRectOverlaps(rect, fixed))) return true;
      if (group.parentId) {
        const parent = groups.find((entry) => entry.id === group.parentId);
        const size = sizes.get(id) ?? { width: readNodeWidth(group), height: readNodeHeight(group) };
        if (parent) {
          // 结构矩形自身的左上角参与父组包含判断；徽标外凸不改变成员的容器语义。
          const point = { x: absolute.x, y: absolute.y };
          const clamped = clampDropPointToGroup(point, size, parent);
          if (!clamped || clamped.x !== point.x || clamped.y !== point.y) return true;
        }
      }
    }
    return false;
  };
  if (collides(delta)) {
    const queue: DropPoint[] = [];
    const seen = new Set<string>();
    for (const fixed of fixedGroups) {
      for (const id of moving) {
        const group = byId.get(id)!;
        const rect = groupRectAt(group, ideal.get(id)!, sizes, options.collapsedGroupIds, options.groupBadgeProjections);
        if (!dropRectOverlaps(rect, fixed)) continue;
        const candidates = projectDropPointOutside(rect, { width: rect.width, height: rect.height }, fixed);
        for (const candidate of candidates) {
          const next = { x: candidate.point.x - rect.x, y: candidate.point.y - rect.y };
          const key = `${next.x}:${next.y}`;
          if (!seen.has(key)) { seen.add(key); queue.push(next); }
        }
      }
    }
    for (let i = 0; i < queue.length && candidatesEvaluated < limit; i += 1) {
      const candidate = queue[i]!;
      candidatesEvaluated += 1;
      if (!collides(candidate)) { delta = candidate; break; }
      // bounded one-step expansion around a rejected candidate
      for (const direction of directions) {
        const expanded = { x: candidate.x + direction.x * 40, y: candidate.y + direction.y * 40 };
        const key = `${expanded.x}:${expanded.y}`;
        if (!seen.has(key)) { seen.add(key); queue.push(expanded); }
      }
    }
    if (collides(delta)) return { ok: false, nodes: source, reason: "space-exhausted", candidatesEvaluated, movedNodeIds: [] };
  }
  const next = new Map(source.map((node) => [node.id, node]));
  const movedNodeIds: string[] = [];
  for (const node of source) {
    if (!moving.has(node.id)) continue;
    const absolute = ideal.get(node.id)!;
    const updated = withAbsolutePosition(node, { x: absolute.x + delta.x, y: absolute.y + delta.y }, node.parentId, byId);
    next.set(node.id, updated);
    if (updated.position.x !== node.position.x || updated.position.y !== node.position.y) movedNodeIds.push(node.id);
  }
  const result = sortNodesParentsFirst([...next.values()]);
  if (!validateFiniteNodes(result)) return { ok: false, nodes: source, reason: "invalid-geometry", candidatesEvaluated, movedNodeIds: [] };
  return { ok: true, nodes: result, candidatesEvaluated, movedNodeIds };
}

