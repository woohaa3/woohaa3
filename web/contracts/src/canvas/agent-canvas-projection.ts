/**
 * Agent 画布图投影（change: add-agent-canvas-authoring-mcp，任务 3.1–3.4 / design D4、D5）。
 *
 * 从**权威 published 画布聚合**派生 Agent 需要的稳定、有界、安全的白名单投影：
 * - 只暴露 identity、语义 kind、位置/尺寸、title/prompt、任务摘要、输入摘要和 affordances；
 * - 裁剪 jobs 全表、Yjs bytes、凭据、storage key 与未授权媒体 URL；
 * - 支持 nodeIds、aroundNodeId/depth、includePrompt、limit/cursor 过滤；
 * - cursor 绑定 revision，翻页期间 revision 变化时调用方返回 `snapshot-stale`；
 * - 提供 before/after 差异计算，供有界 revision delta 使用。
 *
 * 纯函数，无副作用，可被 Canvas Service 与测试直接复用。
 */
import { effectiveCanvasNodeSize } from "./node-dimensions.js";
import { organizationWorldBounds } from "./canvas-script/organization.js";
import { agentDescriptorForCanonicalType } from "./agent-node-descriptors.js";
import {
  AGENT_CANVAS_LIMITS,
  AGENT_CANVAS_PROTOCOL_VERSION,
  type AgentCanvasDelta,
  type AgentCanvasEdgeProjection,
  type AgentCanvasGraph,
  type AgentCanvasNodeProjection,
  type AgentGraphQuery,
  type AgentInputSummary,
  type AgentNodeAffordances
} from "./agent-canvas-protocol.js";
import type { CanvasNodeData } from "./domain/types.js";
import type { Woohaa3CanvasSerializedNode } from "./domain/core/document-schema.js";

type CanvasLike = {
  id: string;
  title?: string;
  revision: number;
  document: {
    nodes: readonly Woohaa3CanvasSerializedNode[];
    edges: readonly { id: string; source: string; target: string; data?: Record<string, unknown> }[];
  };
  nodeData: Record<string, CanvasNodeData | undefined>;
};

/** 语义 kind；未知 canonical 类型返回 null。 */
export function semanticKindFor(canonicalType: string): AgentCanvasNodeProjection["kind"] {
  return agentDescriptorForCanonicalType(canonicalType)?.kind ?? null;
}

/** 节点 affordances；与共享描述符和当前节点状态一致（任务 3.3）。 */
export function projectNodeAffordances(canvasType: string, data: CanvasNodeData | undefined): AgentNodeAffordances {
  const descriptor = agentDescriptorForCanonicalType(canvasType);
  const processing = data?.taskStatus === "processing";
  return {
    canSetPrompt: descriptor?.supportsPrompt === true,
    canRun: descriptor?.executable === true && !processing,
    canConnect: descriptor !== null,
    canDelete: true,
    canMove: true, canGroup: true, canReparent: true, canUngroup: canvasType === "group", canSetTitle: true
  };
}

export function projectAgentNode(
  canvas: CanvasLike,
  node: Woohaa3CanvasSerializedNode,
  options: { includePrompt?: boolean } = {}
): AgentCanvasNodeProjection {
  const data = canvas.nodeData[node.id];
  const descriptor = agentDescriptorForCanonicalType(node.type);
  const task = projectTaskSummary(data);
  const inputs = projectInputSummaries(canvas, node.id, data);
  return {
    nodeId: node.id,
    kind: descriptor?.kind ?? null,
    canonicalType: node.type,
    parentId: node.parentId ?? null,
    worldBounds: organizationWorldBounds(node, new Map(canvas.document.nodes.map(n => [n.id, n]))),
    ...(node.type === "group" ? { directMemberCount: canvas.document.nodes.filter(n => n.parentId === node.id).length } : {}),
    position: { x: node.position.x, y: node.position.y },
    size: effectiveCanvasNodeSize(node),
    ...(typeof data?.title === "string" && data.title !== "" ? { title: data.title } : {}),
    ...(options.includePrompt && typeof data?.prompt === "string" ? { prompt: data.prompt } : {}),
    ...(task ? { task } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    affordances: projectNodeAffordances(node.type, data)
  };
}

function projectTaskSummary(data: CanvasNodeData | undefined): AgentCanvasNodeProjection["task"] {
  if (!data) return undefined;
  const taskKind = typeof data.taskKind === "string" ? data.taskKind : undefined;
  const taskStatus = data.taskStatus;
  if (taskKind === undefined && taskStatus === undefined && data.progress === undefined && data.activeRunId === undefined) {
    return undefined;
  }
  return {
    ...(taskKind ? { taskKind } : {}),
    ...(taskStatus ? { taskStatus } : {}),
    ...(typeof data.progress === "number" ? { progress: data.progress } : {}),
    ...(typeof data.activeRunId === "string" && data.activeRunId !== "" ? { runId: data.activeRunId } : {})
  };
}

/** 只输出稳定引用摘要，不输出资产 URL/storage key。 */
function projectInputSummaries(canvas: CanvasLike, nodeId: string, data: CanvasNodeData | undefined): AgentInputSummary[] {
  const incoming = new Set(canvas.document.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source));
  const declared = (data?.inputMapping ?? []).filter((mapping) => incoming.has(mapping.sourceNodeId));
  const declaredSources = new Set(declared.map((mapping) => mapping.sourceNodeId));
  const summaries: AgentInputSummary[] = declared.map((mapping) => ({
    sourceNodeId: mapping.sourceNodeId,
    role: mapping.role,
    ...(typeof mapping.label === "string" && mapping.label !== "" ? { label: mapping.label } : {})
  }));
  for (const sourceNodeId of incoming) {
    if (declaredSources.has(sourceNodeId)) continue;
    summaries.push({ sourceNodeId, role: "reference_image" });
  }
  return summaries;
}

export function projectAgentEdge(edge: {
  id: string;
  source: string;
  target: string;
  data?: Record<string, unknown>;
}): AgentCanvasEdgeProjection {
  const label = edge.data?.label;
  return {
    edgeId: edge.id,
    source: edge.source,
    target: edge.target,
    ...(typeof label === "string" && label !== "" ? { label } : {})
  };
}

// ---------------------------------------------------------------------------
// 过滤 + 分页
// ---------------------------------------------------------------------------

type CursorPayload = { revision: number; offset: number };

/** cursor 绑定 revision；编码为可读且无歧义的短字符串。 */
export function encodeAgentCursor(revision: number, offset: number): string {
  return `r${revision}:${offset}`;
}

export function decodeAgentCursor(cursor: string): CursorPayload | null {
  const match = /^r(\d+):(\d+)$/.exec(cursor);
  if (!match) return null;
  return { revision: Number(match[1]), offset: Number(match[2]) };
}

export type ProjectGraphResult =
  | { ok: true; graph: AgentCanvasGraph }
  | { ok: false; code: "snapshot-stale" | "unknown-node" | "malformed-request"; message: string; currentRevision: number };

/**
 * 生成有界图投影。cursor 绑定 revision：翻页期间 revision 变化时返回 snapshot-stale，
 * 绝不把不同 revision 的页面伪装成一致快照（design D5）。
 */
export function projectAgentGraph(canvas: CanvasLike, query: AgentGraphQuery = {}): ProjectGraphResult {
  const allNodes = canvas.document.nodes;
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));

  // 选择节点集合：parentId 直系子节点 / nodeIds 选择 + 邻域闭包。
  let selected: Woohaa3CanvasSerializedNode[];
  if (query.parentId !== undefined) {
    if (query.nodeIds !== undefined || query.aroundNodeId !== undefined) {
      return { ok: false, code: "malformed-request", message: "parentId 与 nodeIds/aroundNodeId 互斥", currentRevision: canvas.revision };
    }
    selected = allNodes.filter((node) => (node.parentId ?? null) === query.parentId);
  } else if (query.aroundNodeId !== undefined) {
    if (!nodeById.has(query.aroundNodeId)) {
      return { ok: false, code: "unknown-node", message: `节点 ${query.aroundNodeId} 不存在`, currentRevision: canvas.revision };
    }
    const depth = query.depth ?? AGENT_CANVAS_LIMITS.defaultNeighborhoodDepth;
    selected = neighborhoodClosure(canvas, query.aroundNodeId, depth, nodeById);
  } else if (query.nodeIds && query.nodeIds.length > 0) {
    const missing = query.nodeIds.find((id) => !nodeById.has(id));
    if (missing) return { ok: false, code: "unknown-node", message: `节点 ${missing} 不存在`, currentRevision: canvas.revision };
    selected = query.nodeIds.map((id) => nodeById.get(id)!);
  } else {
    selected = [...allNodes];
  }

  // 稳定排序（按节点 id），保证分页确定性。
  selected.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const cursor = query.cursor ? decodeAgentCursor(query.cursor) : null;
  if (query.cursor && !cursor) {
    return { ok: false, code: "malformed-request", message: "cursor 非法", currentRevision: canvas.revision };
  }
  if (cursor && cursor.revision !== canvas.revision) {
    return { ok: false, code: "snapshot-stale", message: "cursor 绑定的 revision 已变化", currentRevision: canvas.revision };
  }

  const limit = Math.min(query.limit ?? AGENT_CANVAS_LIMITS.maxGraphNodes, AGENT_CANVAS_LIMITS.maxGraphNodes);
  const offset = cursor?.offset ?? 0;
  const pageNodes = selected.slice(offset, offset + limit);
  const pageNodeIds = new Set(pageNodes.map((node) => node.id));

  // 边只保留两端都在本页节点集合内的（邻域/选择裁剪）。
  const edges = canvas.document.edges
    .filter((edge) => pageNodeIds.has(edge.source) && pageNodeIds.has(edge.target))
    .map(projectAgentEdge)
    .sort((left, right) => (left.edgeId < right.edgeId ? -1 : left.edgeId > right.edgeId ? 1 : 0))
    .slice(0, AGENT_CANVAS_LIMITS.maxGraphEdges);

  const end = offset + pageNodes.length;
  const hasMore = end < selected.length;
  const truncated = hasMore || edges.length >= AGENT_CANVAS_LIMITS.maxGraphEdges;

  return {
    ok: true,
    graph: {
      protocolVersion: AGENT_CANVAS_PROTOCOL_VERSION,
      canvasId: canvas.id,
      title: canvas.title ?? "",
      revision: canvas.revision,
      nodes: pageNodes.map((node) => projectAgentNode(canvas, node, { includePrompt: query.includePrompt === true })),
      edges,
      truncated,
      ...(hasMore ? { nextCursor: encodeAgentCursor(canvas.revision, end) } : {})
    }
  };
}

/** aroundNodeId + depth 的无向邻域闭包；边裁剪到闭包内节点之间。 */
function neighborhoodClosure(
  canvas: CanvasLike,
  center: string,
  depth: number,
  nodeById: Map<string, Woohaa3CanvasSerializedNode>
): Woohaa3CanvasSerializedNode[] {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of canvas.document.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }
  const visited = new Set([center]);
  let frontier = [center];
  for (let step = 0; step < depth; step += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.push(neighbor);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return [...visited].map((id) => nodeById.get(id)!).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 增量
// ---------------------------------------------------------------------------

export type AgentDeltaResult =
  | { ok: true; delta: AgentCanvasDelta }
  | { ok: false; code: "reset-required"; message: string; currentRevision: number };

/**
 * 计算两版之间的节点/边变化与 tombstones。
 *
 * 调用方（Canvas room）负责维护有界 revision→delta 日志；无法证明完整时返回 resetRequired。
 */
export function computeAgentDelta(before: CanvasLike, after: CanvasLike): Pick<
  AgentCanvasDelta,
  "nodes" | "edges" | "deletedNodeIds" | "deletedEdgeIds"
> {
  const beforeNodes = new Map(before.document.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.document.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map(before.document.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.document.edges.map((edge) => [edge.id, edge]));

  const deletedNodeIds: string[] = [];
  for (const id of beforeNodes.keys()) if (!afterNodes.has(id)) deletedNodeIds.push(id);
  const deletedEdgeIds: string[] = [];
  for (const id of beforeEdges.keys()) if (!afterEdges.has(id)) deletedEdgeIds.push(id);

  const changedNodes: AgentCanvasNodeProjection[] = [];
  for (const [id, node] of afterNodes) {
    const previous = beforeNodes.get(id);
    if (!previous || !sameProjectedNode(previous, node, before, after, id)) {
      changedNodes.push(projectAgentNode(after, node, { includePrompt: true }));
    }
  }
  const changedEdges: AgentCanvasEdgeProjection[] = [];
  for (const [id, edge] of afterEdges) {
    const previous = beforeEdges.get(id);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(edge)) {
      changedEdges.push(projectAgentEdge(edge));
    }
  }

  return {
    nodes: changedNodes,
    edges: changedEdges,
    deletedNodeIds: deletedNodeIds.sort(),
    deletedEdgeIds: deletedEdgeIds.sort()
  };
}

function sameProjectedNode(
  previous: Woohaa3CanvasSerializedNode,
  next: Woohaa3CanvasSerializedNode,
  before: CanvasLike,
  after: CanvasLike,
  _id: string
): boolean {
  return JSON.stringify(projectAgentNode(before, previous, { includePrompt: true })) === JSON.stringify(projectAgentNode(after, next, { includePrompt: true }));
}

/** 组装规范 delta 响应。 */
export function buildAgentDelta(
  canvas: CanvasLike,
  fromRevision: number,
  delta: Pick<AgentCanvasDelta, "nodes" | "edges" | "deletedNodeIds" | "deletedEdgeIds">
): AgentCanvasDelta {
  return {
    protocolVersion: AGENT_CANVAS_PROTOCOL_VERSION,
    canvasId: canvas.id,
    fromRevision,
    currentRevision: canvas.revision,
    resetRequired: false,
    ...delta
  };
}

export function buildResetDelta(canvas: CanvasLike, fromRevision: number): AgentCanvasDelta {
  return {
    protocolVersion: AGENT_CANVAS_PROTOCOL_VERSION,
    canvasId: canvas.id,
    fromRevision,
    currentRevision: canvas.revision,
    nodes: [],
    edges: [],
    deletedNodeIds: [],
    deletedEdgeIds: [],
    resetRequired: true
  };
}

/** 便于测试：节点语义 kind 的标签。 */
export function agentKindLabel(canonicalType: string): string {
  return agentDescriptorForCanonicalType(canonicalType)?.label ?? canonicalType;
}
