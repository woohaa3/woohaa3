import { createEmptyWoohaa3CanvasDocument,
  sanitizeWoohaa3CanvasDocument,
  type Woohaa3CanvasDocument,
  type Woohaa3CanvasDocumentPayload,
  type Woohaa3CanvasEdge as SerializedWoohaa3CanvasEdge,
  type Woohaa3CanvasLightweightDocument,
  type Woohaa3CanvasNodeDataMap,
  type Woohaa3CanvasSerializedNode,
  type Woohaa3CanvasViewport,
  sanitizeWoohaa3CanvasNodeData } from "./document-schema";
import type { Woohaa3CanvasEdge, Woohaa3CanvasNode, Woohaa3CanvasSnapshot } from "./canvas-runtime";
import { WOOHAA3_CANVAS_MAX_ZOOM, WOOHAA3_CANVAS_MIN_ZOOM } from "./viewport-zoom";

/**
 * 图网格像素步长与世界单位换算（change: integrate-origin-master-after-web-split）。
 *
 * 运行时上报的是**世界坐标**，1 世界单位 = 80 图像素（见画布网格常量
 * `CanvasGraphNode.position_offset`）。因此 20 图像素的网格对应 20 / 80 = 0.25 世界单位。
 * 若沿用 20 世界单位的步长，整屏单击会把节点错误吸附到原点（远端修复的真实缺陷）。
 */
const GRAPH_PIXELS_PER_UNIT = 80;
const GRAPH_SNAP_PIXELS = 20;

/** 规范节点坐标（世界单位）吸附：等价于图上的 20 像素网格。 */
export function snapGraphPosition(value: number): number {
  const step = GRAPH_SNAP_PIXELS / GRAPH_PIXELS_PER_UNIT;
  return Math.round(value / step) * step;
}

export function createEmptyWoohaa3CanvasSnapshot(): Woohaa3CanvasSnapshot {
  return fromWoohaa3CanvasDocument(createEmptyWoohaa3CanvasDocument());
}

export function fromWoohaa3CanvasDocument(input?: unknown): Woohaa3CanvasSnapshot {
  const document = sanitizeWoohaa3CanvasDocument(input);
  return {
    nodes: document.nodes.map(toFlowNode),
    edges: document.edges.map(toFlowEdge)
  };
}

export function toWoohaa3CanvasDocument(snapshot: Woohaa3CanvasSnapshot, now = new Date().toISOString()): Woohaa3CanvasDocument {
  return sanitizeWoohaa3CanvasDocument({
    schemaVersion: "asset-canvas-v1",
    nodes: snapshot.nodes.map(toSerializedNode),
    edges: snapshot.edges.map(toSerializedEdge),
    updatedAt: now
  });
}

/**
 * 将结构图与外部业务数据组合为显式持久化 payload。
 * 该边界不参与 Panel 的运行时 hydration。
 */
export function toWoohaa3CanvasDocumentPayload(
  snapshot: Woohaa3CanvasSnapshot,
  nodeData?: Woohaa3CanvasNodeDataMap,
  now = new Date().toISOString()
): Woohaa3CanvasDocumentPayload {
  return {
    document: toWoohaa3CanvasDocument(snapshot, now),
    nodeData: sanitizeWoohaa3CanvasNodeData(nodeData)
  };
}

export function toLightweightWoohaa3CanvasDocument(snapshot: Woohaa3CanvasSnapshot): Woohaa3CanvasLightweightDocument {
  const document = toWoohaa3CanvasDocument(snapshot);
  return {
    schemaVersion: document.schemaVersion,
    nodes: document.nodes,
    edges: document.edges
  };
}

function toFlowNode(node: Woohaa3CanvasSerializedNode): Woohaa3CanvasNode {
  const flowNode: Woohaa3CanvasNode = {
    id: node.id,
    type: node.type,
    ...(node.position ? { position: node.position } : {}),
    width: node.width,
    height: node.height,
    parentId: node.parentId,
    data: {}
  };
  if (typeof node.zIndex === "number" && Number.isFinite(node.zIndex)) flowNode.zIndex = node.zIndex;
  return flowNode;
}

function toFlowEdge(edge: SerializedWoohaa3CanvasEdge): Woohaa3CanvasEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    data: edge.data
  };
}

function toSerializedNode(node: Woohaa3CanvasNode): Woohaa3CanvasSerializedNode {
  const serialized: Woohaa3CanvasSerializedNode = {
    id: node.id,
    type: node.type ?? "unknown",
    ...(node.position
      ? {
          position: {
            x: snapGraphPosition(node.position.x),
            y: snapGraphPosition(node.position.y)
          }
        }
      : {}),
    width: readPositiveNumber(node.width),
    height: readPositiveNumber(node.height),
    parentId: node.parentId
  };
  if (typeof node.zIndex === "number" && Number.isFinite(node.zIndex)) serialized.zIndex = node.zIndex;
  return serialized;
}

function toSerializedEdge(edge: Woohaa3CanvasEdge): SerializedWoohaa3CanvasEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
    data: edge.data ?? {}
  };
}

function readPositiveNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) && input > 0 ? input : undefined;
}

export function sanitizeWoohaa3CanvasViewport(viewport: Woohaa3CanvasViewport): Woohaa3CanvasViewport {
  return {
    x: Number.isFinite(viewport.x) ? viewport.x : 0,
    y: Number.isFinite(viewport.y) ? viewport.y : 0,
    zoom: Math.min(WOOHAA3_CANVAS_MAX_ZOOM, Math.max(WOOHAA3_CANVAS_MIN_ZOOM, Number.isFinite(viewport.zoom) ? viewport.zoom : 1))
  };
}
