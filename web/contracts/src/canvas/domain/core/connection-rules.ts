import { createHighEntropyId } from "./node-factory";
import type { Woohaa3CanvasConnection, Woohaa3CanvasEdge, Woohaa3CanvasNode } from "./canvas-runtime";
import { isPureModelNodeType } from "./input-role";
import { isShotPreviewNodeType } from "./shot-preview-node";
import { decideShotReferenceConnection, resolveShotReferenceSource, isShotReferenceEdgeKind, SHOT_REFERENCE_SCHEMA_VERSION } from "./shot-reference";

export type Woohaa3CanvasConnectionNodeDataReader = { get: (nodeId: string) => Record<string, unknown> | undefined };

type Woohaa3CanvasConnectionLike = Woohaa3CanvasConnection;

/** 连接判定的最小节点形状：运行时节点与序列化节点都满足（不要求运行时 `data` 字段）。 */
export type Woohaa3CanvasConnectionNode = { id: string; type: string; data?: Record<string, unknown> };

/** 连接判定的最小边形状：只读端点与 handle。 */
export type Woohaa3CanvasConnectionEdge = {
  source: string | null;
  target: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export type Woohaa3CanvasEdgeKind = "input" | "output" | "dependency" | "reference" | "shot-reference" | "shot-image-reference";

export function isValidWoohaa3CanvasConnection(
  connection: Woohaa3CanvasConnectionLike,
  nodes: readonly Woohaa3CanvasConnectionNode[],
  edges: readonly Woohaa3CanvasConnectionEdge[],
  data?: Woohaa3CanvasConnectionNodeDataReader
): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) {
    return false;
  }

  if (!isValidHandleConnection(connection)) return false;
  const sourceNode = nodes.find((node) => node.id === connection.source);
  const targetNode = nodes.find((node) => node.id === connection.target);
  if (!sourceNode?.type || !targetNode?.type) return false;
  if (isPureNoteNode(sourceNode, data) || isPureNoteNode(targetNode, data)) return false;
  if (targetNode.type === "group") return false;
  // 纯模型节点（片场 animation3d + 通用扩展节点 extension3d）不能作为持久化边端点
  // （change: 2026-10-08-make-film-set-model-only，design D8；
  //  change: 2026-10-10-add-game-furnace-extension 泛化）。
  if (isPureModelNodeType(sourceNode.type, nodeDataOf(sourceNode.id, nodes, data)) || isPureModelNodeType(targetNode.type, nodeDataOf(targetNode.id, nodes, data))) return false;

  const duplicate = edges.some(
    (edge) =>
      edge.source === connection.source &&
      edge.target === connection.target &&
      edge.sourceHandle === (connection.sourceHandle ?? null) &&
      edge.targetHandle === (connection.targetHandle ?? null)
  );

  // 拍摄镜头预览：归属线由派生呈现表达（D5），不进入普通边拓扑；唯一例外是
  // **专用镜头参考**——动态镜头预览可拉线到视频生成节点（D9，change 2026-10-15 任务 8.1）。
  const sourceIsPreview = isShotPreviewNodeType(sourceNode.type);
  const targetIsPreview = isShotPreviewNodeType(targetNode.type);
  if (sourceIsPreview || targetIsPreview) {
    return shotReferenceDecision(connection, nodes, edges, data).ok;
  }

  return !duplicate;
}

/**
 * 镜头参考连接判定（D9 / 任务 8.1）。
 *
 * 由 `isValidWoohaa3CanvasConnection` 的预览分支复用；同时暴露给需要**拒绝原因**的调用方
 * （菜单/交互反馈，任务 8.2）。
 */
export function shotReferenceDecision(
  connection: Woohaa3CanvasConnectionLike,
  nodes: readonly Woohaa3CanvasConnectionNode[],
  edges: readonly Woohaa3CanvasConnectionEdge[],
  data?: Woohaa3CanvasConnectionNodeDataReader
) {
  const sourceNode = nodes.find((node) => node.id === connection.source);
  const targetNode = nodes.find((node) => node.id === connection.target);
  const sourceId = connection.source ?? "";
  const targetId = connection.target ?? "";
  const reader = (nodeId: string) => nodeDataOf(nodeId, nodes, data);
  return decideShotReferenceConnection({
    sourceId,
    targetId,
    sourceIsPreview: isShotPreviewNodeType(sourceNode?.type),
    targetIsPreview: isShotPreviewNodeType(targetNode?.type),
    sourceData: reader(sourceId),
    targetType: targetNode?.type,
    targetData: reader(targetId),
    readNodeData: reader,
    hasExistingEdge: edges.some(
      (edge) =>
        edge.source === connection.source &&
        edge.target === connection.target &&
        edge.sourceHandle === (connection.sourceHandle ?? null) &&
        edge.targetHandle === (connection.targetHandle ?? null)
    )
  });
}

export function createWoohaa3CanvasEdge(
  connection: Woohaa3CanvasConnectionLike,
  nodes: Woohaa3CanvasNode[],
  data?: Woohaa3CanvasConnectionNodeDataReader
): Woohaa3CanvasEdge | null {
  if (!connection.source || !connection.target) return null;
  const sourceNode = nodes.find((node) => node.id === connection.source);
  const targetNode = nodes.find((node) => node.id === connection.target);
  if (!sourceNode || !targetNode) return null;

  const source = isShotPreviewNodeType(sourceNode.type)
    ? resolveShotReferenceSource(sourceNode.id, nodeDataOf(sourceNode.id, nodes, data), id => nodeDataOf(id, nodes, data)) : null;
  const kind = source?.kind === "static" ? "shot-image-reference" : resolveEdgeKind(sourceNode, targetNode);
  return {
    id: createHighEntropyId(`edge-${connection.source}-${connection.target}`),
    source: connection.source,
    target: connection.target,
    sourceHandle: connection.sourceHandle ?? null,
    targetHandle: connection.targetHandle ?? null,
    // 镜头参考边携带结构版本作为能力门禁（任务 8.1）；其他边保持原有 `{ kind }` 形状。
    data: isShotReferenceEdgeKind(kind)
      ? { kind, schemaVersion: SHOT_REFERENCE_SCHEMA_VERSION }
      : { kind }
  };
}

export function explainWoohaa3CanvasConnectionBlock(
  connection: Woohaa3CanvasConnectionLike,
  nodes: readonly Woohaa3CanvasConnectionNode[],
  edges: readonly Woohaa3CanvasConnectionEdge[],
  data?: Woohaa3CanvasConnectionNodeDataReader
): string | null {
  if (isValidWoohaa3CanvasConnection(connection, nodes, edges, data)) return null;
  const sourceNode = nodes.find((node) => node.id === connection.source);
  const targetNode = nodes.find((node) => node.id === connection.target);
  if (sourceNode && targetNode && (isShotPreviewNodeType(sourceNode.type) || isShotPreviewNodeType(targetNode.type))) {
    const decision = shotReferenceDecision(connection, nodes, edges, data);
    return decision.ok ? "重复连线" : decision.reason;
  }
  if (!connection.source || !connection.target) return "连线缺少端点";
  if (connection.source === connection.target) return "不能连接到自己";
  if (!sourceNode || !targetNode) return "连线端点不存在";
  if (targetNode.type === "group") return "分组不能作为连线目标";
  if (isPureModelNodeType(sourceNode.type, nodeDataOf(sourceNode.id, nodes, data)) || isPureModelNodeType(targetNode.type, nodeDataOf(targetNode.id, nodes, data))) return "片场模型不能作为连线端点";
  if (!isValidHandleConnection(connection)) return "连线端口非法";
  return "重复连线或角色不兼容";
}

function resolveEdgeKind(sourceNode: Woohaa3CanvasConnectionNode, targetNode: Woohaa3CanvasConnectionNode): Woohaa3CanvasEdgeKind {
  // 镜头参考边：来源是拍摄镜头预览（D9）。目标必然是视频生成节点（由连接规则保证）。
  if (isShotPreviewNodeType(sourceNode.type)) return "shot-reference";
  if (sourceNode.type !== "group" && targetNode.type !== "group") return "dependency";
  if (sourceNode.type === "group" && targetNode.type !== "group") return "input";
  return "reference";
}

function nodeDataOf(
  nodeId: string,
  nodes: readonly Woohaa3CanvasConnectionNode[],
  data?: Woohaa3CanvasConnectionNodeDataReader
): Record<string, unknown> | undefined {
  const provided = data?.get(nodeId);
  if (provided) return provided;
  const node = nodes.find((node) => node.id === nodeId);
  const nodeData = node?.data;
  return nodeData && typeof nodeData === "object" && !Array.isArray(nodeData)
    ? (nodeData as Record<string, unknown>)
    : undefined;
}

function isValidHandleConnection(connection: Woohaa3CanvasConnectionLike): boolean {
  return (!connection.sourceHandle || connection.sourceHandle === "handleSource")
    && (!connection.targetHandle || connection.targetHandle === "handleTarget");
}

function isPureNoteNode(node: Woohaa3CanvasConnectionNode, data?: Woohaa3CanvasConnectionNodeDataReader): boolean {
  const nodeData = data?.get(node.id) ?? (node.data as Record<string, unknown>);
  return node.type === "text" && nodeData?.isNote === true;
}
