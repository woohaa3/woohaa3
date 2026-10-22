/**
 * Agent Plan 编译器：几何 placement（自动/绝对/锚点相对）与避让
 * （自 `planner.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R28）。
 */
import {
  AGENT_CANVAS_LIMITS,
  agentConnectLabel,
  type AgentCanvasError,
  type AgentCreatePlacement,
  type AgentEntityRef,
  type AgentPlacementMode,
  type Woohaa3CanvasSerializedNode
} from "@woohaa3/contracts";
import type { DeclaredEntity, PlannerSnapshot } from "./planner-types.js";

export type Rect = { x: number; y: number; width: number; height: number };

export function indexSnapshot(snapshot: PlannerSnapshot) {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  return {
    nodeById,
    edges: snapshot.edges,
    nodes: snapshot.nodes
  };
}

export type IndexedSnapshot = ReturnType<typeof indexSnapshot>;

export function rectOf(position: { x: number; y: number }, size: { width: number; height: number }): Rect {
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

export function sizeOf(
  node: { width?: number; height?: number },
  fallback: { width: number; height: number }
): { width: number; height: number } {
  return { width: node.width ?? fallback.width, height: node.height ?? fallback.height };
}

export function resolvePlacement(
  placement: AgentCreatePlacement | undefined,
  context: {
    descriptor: { defaultSize: { width: number; height: number } };
    snapshot: IndexedSnapshot;
    declaredRefs: Map<string, DeclaredEntity>;
    plannedRects: Rect[];
    operationIndex: number;
  }
): { ok: true; position: { x: number; y: number } } | { ok: false; error: AgentCanvasError } {
  const mode: AgentPlacementMode = placement?.mode ?? "auto";
  const size = context.descriptor.defaultSize;
  if (mode === "absolute") {
    if (!placement || placement.mode !== "absolute") {
      return { ok: false, error: { code: "malformed-request", message: "缺少 absolute position", retryable: false, operationIndex: context.operationIndex, field: "placement" } };
    }
    return { ok: true, position: avoidOverlap(placement.position, size, context.snapshot, context.plannedRects, 0) };
  }
  if (mode === "auto") {
    const bounds = graphBounds(context.snapshot.nodes, context.plannedRects);
    return { ok: true, position: avoidOverlap({ x: bounds.maxX + AGENT_CANVAS_LIMITS.layoutGap, y: bounds.minY }, size, context.snapshot, context.plannedRects, 0) };
  }
  if (!placement || placement.mode === "auto" || placement.mode === "absolute") {
    return { ok: false, error: { code: "malformed-request", message: `${mode} placement 需要 anchor`, retryable: false, operationIndex: context.operationIndex, field: "placement" } };
  }
  const anchor = resolveAnchor(placement.anchor, context.declaredRefs, context.snapshot, context.operationIndex);
  if (!anchor.ok) return anchor;
  const node = anchor.node;
  const anchorSize = sizeOf(node, { width: 196, height: 64 });
  const gap = placement.gap ?? AGENT_CANVAS_LIMITS.layoutGap;
  let candidate: { x: number; y: number };
  if (placement.mode === "after") candidate = { x: node.position.x + anchorSize.width + gap, y: node.position.y };
  else if (placement.mode === "before") candidate = { x: node.position.x - size.width - gap, y: node.position.y };
  else candidate = { x: node.position.x, y: node.position.y + anchorSize.height + gap };
  return { ok: true, position: avoidOverlap(candidate, size, context.snapshot, context.plannedRects, gap) };
}

export function resolveAnchor(
  ref: AgentEntityRef,
  declaredRefs: Map<string, DeclaredEntity>,
  snapshot: IndexedSnapshot,
  operationIndex: number
): { ok: true; node: Pick<Woohaa3CanvasSerializedNode, "id" | "type" | "position" | "width" | "height"> } | { ok: false; error: AgentCanvasError } {
  if ("ref" in ref) {
    const declared = declaredRefs.get(ref.ref);
    if (!declared || declared.kind !== "node") {
      return { ok: false, error: { code: "unknown-ref", message: `placement 引用了未知 ref ${ref.ref}`, retryable: false, operationIndex, field: "placement.anchor" } };
    }
    const node = snapshot.nodeById.get(declared.nodeId);
    // 同计划新建节点不在 snapshot 中：用声明时的占位位置（已由 plannedRects 处理避让）。
    if (node) return { ok: true, node };
    return { ok: false, error: { code: "unsupported-placement", message: `暂不支持相对同计划新建节点 ${ref.ref} 布局`, retryable: false, operationIndex, field: "placement.anchor" } };
  }
  const node = snapshot.nodeById.get(ref.nodeId);
  if (!node) {
    return { ok: false, error: { code: "unknown-node", message: `锚点节点 ${ref.nodeId} 不存在`, retryable: false, operationIndex, field: "placement.anchor" } };
  }
  return { ok: true, node };
}

function graphBounds(
  nodes: IndexedSnapshot["nodes"],
  planned: readonly Rect[]
): { minY: number; maxX: number } {
  let minY = 0;
  let maxX = 0;
  for (const node of nodes) {
    const size = sizeOf(node, { width: 196, height: 64 });
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + size.width);
  }
  for (const rect of planned) {
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
  }
  return { minY, maxX };
}

/** 确定性避让：与当前/计划矩形重叠时按固定步长下移，直到无重叠。 */
function avoidOverlap(
  candidate: { x: number; y: number },
  size: { width: number; height: number },
  snapshot: IndexedSnapshot,
  planned: readonly Rect[],
  gap: number
): { x: number; y: number } {
  const occupied: Rect[] = [
    ...snapshot.nodes.map((node) => rectOf(node.position, sizeOf(node, { width: 196, height: 64 }))),
    ...planned
  ];
  const step = size.height + Math.max(gap, 20);
  let position = { x: candidate.x, y: candidate.y };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!occupied.some((rect) => overlaps(rectOf(position, size), rect, gap))) return position;
    position = { x: position.x, y: position.y + step };
  }
  return position;
}

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

export function hasEdge(snapshot: IndexedSnapshot, source: string, target: string): boolean {
  return snapshot.edges.some((edge) => edge.source === source && edge.target === target);
}

export function defaultConnectLabel(sourceType: string, targetType: string): string {
  return agentConnectLabel(sourceType, targetType);
}
