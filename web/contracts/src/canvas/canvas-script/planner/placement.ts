/**
 * 共享纯计划编译器：几何 placement（自动/绝对/锚点相对）与避让
 * （自 `mcp-service/src/agent-authoring/planner-placement.ts` 提取，
 *  change: 2026-10-13-add-canvas-script-authoring，任务 1.3 / design D2、D5）。
 *
 * 关键补齐：锚点可以是**本次计划内已创建或已移动**的节点，按有序操作解析其最新几何，
 * 而不是只认 published 快照。尚未创建或已删除的锚点拒绝。
 */
import { effectiveCanvasNodeSize } from "../../node-dimensions.js";
import {
  type AgentCanvasError,
  type AgentCreatePlacement,
  type AgentEntityRef,
  type AgentPlacementMode
} from "../../agent-canvas-protocol.js";
import { AGENT_CANVAS_LIMITS } from "../../agent-canvas-protocol.js";
import { agentConnectLabel } from "../../agent-node-descriptors.js";
import type { DeclaredEntity, PlannerSnapshot } from "./types.js";

export type Rect = { x: number; y: number; width: number; height: number };

/** 计划内节点的最新几何（含 position/size），用于相对布局与预测。 */
export type PlannedNode = {
  ref: string;
  canonicalType: string;
  position: { x: number; y: number };
  width: number;
  height: number;
};

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

/** 计划编译过程中维护的几何状态，供锚点解析与避让复用。 */
export type PlacementState = {
  snapshot: IndexedSnapshot;
  declaredRefs: Map<string, DeclaredEntity>;
  /** 计划内仍存活的节点几何；已删除的从 map 移除。 */
  plannedNodes: Map<string, PlannedNode>;
  /** 已删除的 plan-local ref；继续操作它必须拒绝。 */
  deletedRefs: Set<string>;
  plannedRects: Rect[];
  operationIndex: number;
};

export function resolvePlacement(
  placement: AgentCreatePlacement | undefined,
  descriptor: { defaultSize: { width: number; height: number } },
  state: PlacementState
): { ok: true; position: { x: number; y: number } } | { ok: false; error: AgentCanvasError } {
  const mode: AgentPlacementMode = placement?.mode ?? "auto";
  const size = descriptor.defaultSize;
  if (mode === "absolute") {
    if (!placement || placement.mode !== "absolute") {
      return { ok: false, error: { code: "malformed-request", message: "缺少 absolute position", retryable: false, operationIndex: state.operationIndex, field: "placement" } };
    }
    return { ok: true, position: avoidOverlap(placement.position, size, state, 0) };
  }
  if (mode === "auto") {
    const bounds = graphBounds(state.snapshot.nodes, state.plannedRects);
    return { ok: true, position: avoidOverlap({ x: bounds.maxX + AGENT_CANVAS_LIMITS.layoutGap, y: bounds.minY }, size, state, 0) };
  }
  if (!placement || placement.mode === "auto" || placement.mode === "absolute") {
    return { ok: false, error: { code: "malformed-request", message: `${mode} placement 需要 anchor`, retryable: false, operationIndex: state.operationIndex, field: "placement" } };
  }
  const anchor = resolveAnchorGeometry(placement.anchor, state);
  if (!anchor.ok) return anchor;
  const node = anchor.node;
  const gap = placement.gap ?? AGENT_CANVAS_LIMITS.layoutGap;
  let candidate: { x: number; y: number };
  if (placement.mode === "after") candidate = { x: node.position.x + node.width + gap, y: node.position.y };
  else if (placement.mode === "before") candidate = { x: node.position.x - size.width - gap, y: node.position.y };
  else candidate = { x: node.position.x, y: node.position.y + node.height + gap };
  return { ok: true, position: avoidOverlap(candidate, size, state, gap) };
}

/**
 * 解析锚点几何。
 *
 * - `{ ref }`：计划内节点用其最新几何；已删除的 ref 或边 ref 拒绝；
 * - `{ nodeId }`：必须在 published 快照中。
 */
export function resolveAnchorGeometry(
  ref: AgentEntityRef,
  state: PlacementState
): { ok: true; node: { position: { x: number; y: number }; width: number; height: number } } | { ok: false; error: AgentCanvasError } {
  if ("ref" in ref) {
    const declared = state.declaredRefs.get(ref.ref);
    if (!declared || declared.kind !== "node") {
      return { ok: false, error: { code: "unknown-ref", message: `placement 引用了未知 ref ${ref.ref}`, retryable: false, operationIndex: state.operationIndex, field: "placement.anchor" } };
    }
    const planned = state.plannedNodes.get(ref.ref);
    if (planned) return { ok: true, node: planned };
    if (state.deletedRefs.has(ref.ref)) {
      return { ok: false, error: { code: "unknown-ref", message: `placement 引用了已删除节点 ${ref.ref}`, retryable: false, operationIndex: state.operationIndex, field: "placement.anchor" } };
    }
    // 声明过但不在计划几何中：只可能是既有节点 ref（无 planned 记录），回退快照。
    const existing = state.snapshot.nodeById.get(declared.nodeId);
    if (existing?.position) {
      const size = effectiveCanvasNodeSize(existing);
      return { ok: true, node: { position: existing.position, ...size } };
    }
    return { ok: false, error: { code: "unknown-ref", message: `placement 引用的节点 ${ref.ref} 已不存在`, retryable: false, operationIndex: state.operationIndex, field: "placement.anchor" } };
  }
  const node = state.snapshot.nodeById.get(ref.nodeId);
  if (!node) {
    return { ok: false, error: { code: "unknown-node", message: `锚点节点 ${ref.nodeId} 不存在`, retryable: false, operationIndex: state.operationIndex, field: "placement.anchor" } };
  }
  const size = effectiveCanvasNodeSize(node);
  if (!node.position) {
    return { ok: false, error: { code: "unknown-node", message: `锚点节点 ${ref.nodeId} 没有卡片位置`, retryable: false, operationIndex: state.operationIndex, field: "placement.anchor" } };
  }
  return { ok: true, node: { position: node.position, ...size } };
}

function graphBounds(
  nodes: IndexedSnapshot["nodes"],
  planned: readonly Rect[]
): { minY: number; maxX: number } {
  let minY = 0;
  let maxX = 0;
  for (const node of nodes) {
    if (!node.position) continue;
    const size = effectiveCanvasNodeSize(node);
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
  state: PlacementState,
  gap: number
): { x: number; y: number } {
  const occupied: Rect[] = [
    ...state.snapshot.nodes.filter(node => node.position).map((node) => rectOf(node.position!, effectiveCanvasNodeSize(node))),
    ...state.plannedRects
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
