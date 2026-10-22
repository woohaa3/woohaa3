import type { Woohaa3CanvasDocument,
  Woohaa3CanvasJsonObject,
  Woohaa3CanvasPosition,
  Woohaa3CanvasSerializedNode } from "./document-schema";

/**
 * 渲染器中立的运行时节点。XYFlow 的 selected、dragging、measured、style 等瞬态字段
 * 只允许存在于 renderer adapter 的投影节点中。`data` 仅为渲染器适配保留的空对象：
 * core、图能力和插件不得在此读取或写入业务字段；业务数据必须经宿主 node-data context
 * 按 node id 显式提供。
 */
export type Woohaa3CanvasNodeData = Record<string, never>;

export type Woohaa3CanvasNode = {
  id: string;
  type: string;
  position: Woohaa3CanvasPosition;
  width?: number;
  height?: number;
  parentId?: string;
  /** Explicit stacking order. Missing values retain legacy array-order behavior. */
  zIndex?: number;
  data: Woohaa3CanvasNodeData;
};

export type Woohaa3CanvasEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data: Woohaa3CanvasJsonObject;
};

export type Woohaa3CanvasConnection = {
  source: string | null;
  target: string | null;
  sourceHandle: string | null;
  targetHandle: string | null;
};

export type Woohaa3CanvasSnapshot = {
  nodes: Woohaa3CanvasNode[];
  edges: Woohaa3CanvasEdge[];
};

export type { Woohaa3CanvasDocument, Woohaa3CanvasSerializedNode };
