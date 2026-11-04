import { createHighEntropyId } from "./node-factory";
import type { Woohaa3CanvasConnection, Woohaa3CanvasEdge, Woohaa3CanvasNode } from "./canvas-runtime";

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

export type Woohaa3CanvasEdgeKind = "input" | "output" | "dependency" | "reference";

export function isValidWoohaa3CanvasConnection(
  connection: Woohaa3CanvasConnectionLike,
  nodes: readonly Woohaa3CanvasConnectionNode[],
  edges: readonly Woohaa3CanvasConnectionEdge[],
  _data?: Woohaa3CanvasConnectionNodeDataReader
): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) {
    return false;
  }

  if (!isValidHandleConnection(connection)) return false;
  const sourceNode = nodes.find((node) => node.id === connection.source);
  const targetNode = nodes.find((node) => node.id === connection.target);
  if (!sourceNode?.type || !targetNode?.type) return false;
  if (isPureNoteNode(sourceNode, _data) || isPureNoteNode(targetNode, _data)) return false;
  return !edges.some(
    (edge) =>
      edge.source === connection.source &&
      edge.target === connection.target &&
      edge.sourceHandle === (connection.sourceHandle ?? null) &&
      edge.targetHandle === (connection.targetHandle ?? null)
  );
}

export function createWoohaa3CanvasEdge(
  connection: Woohaa3CanvasConnectionLike,
  nodes: Woohaa3CanvasNode[],
  _data?: Woohaa3CanvasConnectionNodeDataReader
): Woohaa3CanvasEdge | null {
  if (!connection.source || !connection.target) return null;
  const sourceNode = nodes.find((node) => node.id === connection.source);
  const targetNode = nodes.find((node) => node.id === connection.target);
  if (!sourceNode || !targetNode) return null;

  return {
    id: createHighEntropyId(`edge-${connection.source}-${connection.target}`),
    source: connection.source,
    target: connection.target,
    sourceHandle: connection.sourceHandle ?? null,
    targetHandle: connection.targetHandle ?? null,
    data: { kind: resolveEdgeKind(sourceNode, targetNode) }
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
  if (!connection.source || !connection.target) return "连线缺少端点";
  if (connection.source === connection.target) return "不能连接到自己";
  if (!sourceNode || !targetNode) return "连线端点不存在";
  if (!isValidHandleConnection(connection)) return "连线端口非法";
  return "重复连线或角色不兼容";
}

function resolveEdgeKind(_sourceNode: Woohaa3CanvasConnectionNode, _targetNode: Woohaa3CanvasConnectionNode): Woohaa3CanvasEdgeKind {
  return "dependency";
}

function isValidHandleConnection(connection: Woohaa3CanvasConnectionLike): boolean {
  return (!connection.sourceHandle || connection.sourceHandle === "handleSource")
    && (!connection.targetHandle || connection.targetHandle === "handleTarget");
}

function isPureNoteNode(node: Woohaa3CanvasConnectionNode, data?: Woohaa3CanvasConnectionNodeDataReader): boolean {
  const nodeData = data?.get(node.id) ?? (node.data as Record<string, unknown>);
  return node.type === "text" && nodeData?.isNote === true;
}
