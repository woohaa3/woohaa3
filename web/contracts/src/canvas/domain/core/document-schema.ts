import { omitRemovedNodeDataFields } from "../removed-node-data.js";

export const woohaa3CanvasSchemaVersion = "asset-canvas-v1" as const;

export type Woohaa3CanvasSchemaVersion = typeof woohaa3CanvasSchemaVersion;
export type Woohaa3CanvasNodeType = string;

export type Woohaa3CanvasJsonPrimitive = string | number | boolean | null;
export type Woohaa3CanvasJsonValue =
  | Woohaa3CanvasJsonPrimitive
  | Woohaa3CanvasJsonValue[]
  | Woohaa3CanvasJsonObject;
export type Woohaa3CanvasJsonObject = { [key: string]: Woohaa3CanvasJsonValue };

export type Woohaa3CanvasPosition = {
  x: number;
  y: number;
};

/**
 * 视口是**各浏览器本地状态**，不属于规范画布（不同步、不持久化）。
 * 这里只保留其形状与缩放钳制，供前端本地视口与命中测试使用。
 */
export type Woohaa3CanvasViewport = Woohaa3CanvasPosition & {
  zoom: number;
};

/**
 * 持久化的结构节点。节点业务数据由宿主单独存储在 Woohaa3CanvasNodeDataMap；
 * core document 不承载、解释或迁移任何 node.data 业务语义。
 */
export type Woohaa3CanvasSerializedNode = {
  id: string;
  type: Woohaa3CanvasNodeType;
  position: Woohaa3CanvasPosition;
  width?: number;
  height?: number;
  parentId?: string;
  zIndex?: number;
};

/** 由宿主保存、节点实现自行解释的业务数据。 */
export type Woohaa3CanvasNodeDataMap<
  TNodeData extends Woohaa3CanvasJsonObject = Woohaa3CanvasJsonObject
> = Record<string, TNodeData>;

/**
 * 宿主持久化边界的显式 payload。nodeData 不属于 Woohaa3CanvasDocument schema。
 */
export type Woohaa3CanvasDocumentPayload = {
  document: Woohaa3CanvasDocument;
  nodeData: Woohaa3CanvasNodeDataMap;
};

export type Woohaa3CanvasEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data: Woohaa3CanvasJsonObject;
};

export type Woohaa3CanvasDocument = {
  schemaVersion: Woohaa3CanvasSchemaVersion;
  nodes: Woohaa3CanvasSerializedNode[];
  edges: Woohaa3CanvasEdge[];
  updatedAt: string;
};

export type Woohaa3CanvasLightweightDocument = {
  schemaVersion: Woohaa3CanvasSchemaVersion;
  nodes: Woohaa3CanvasSerializedNode[];
  edges: Woohaa3CanvasEdge[];
};

export function createEmptyWoohaa3CanvasDocument(now = new Date().toISOString()): Woohaa3CanvasDocument {
  return {
    schemaVersion: woohaa3CanvasSchemaVersion,
    nodes: [],
    edges: [],
    updatedAt: now
  };
}

/**
 * 将不受信任输入规范化为纯结构 document。
 * 任何节点 `data` 字段都会被丢弃；旧版内嵌数据只能由宿主兼容层读取。
 *
 * `viewport` 不再是规范字段：旧文档里的该值在读取时被忽略（视口由各浏览器本地维护）。
 */
export function sanitizeWoohaa3CanvasDocument(input: unknown, now = new Date().toISOString()): Woohaa3CanvasDocument {
  const source = isRecord(input) ? input : {};
  return {
    schemaVersion: woohaa3CanvasSchemaVersion,
    nodes: readNodes(source.nodes),
    edges: readEdges(source.edges),
    updatedAt: readString(source.updatedAt) ?? now
  };
}

/** 宿主 node-data 存储边界：仅保留 nodeId 到 JSON object 的映射。 */
export function sanitizeWoohaa3CanvasNodeData(input: unknown): Woohaa3CanvasNodeDataMap {
  if (!isRecord(input)) return {};
  return Object.fromEntries(
    Object.entries(input).flatMap(([nodeId, data]) => {
      const normalizedNodeId = nodeId.trim();
      const normalizedData = readJsonObject(data);
      // Invalid imported configuration is discarded; strings/numbers never mean true.
      if (normalizedData && normalizedData.retainWhenEmpty !== undefined && typeof normalizedData.retainWhenEmpty !== "boolean") delete normalizedData.retainWhenEmpty;
      if (normalizedData && normalizedData.groupCollapsed !== undefined && typeof normalizedData.groupCollapsed !== "boolean") delete normalizedData.groupCollapsed;
      // 已移除的组徽标展示倍率：读取时静默丢弃，不参与呈现，也不写回或清空权威文档。
      if (normalizedData) omitRemovedNodeDataFields(normalizedData);
      return normalizedNodeId && normalizedData ? [[normalizedNodeId, normalizedData]] : [];
    })
  );
}

/**
 * 将不受信任值收敛为纯 JSON 对象。
 *
 * 用于资产 `metadata` / `provenance` 这类「允许携带任意 JSON，但不得携带 Blob、
 * 函数、`undefined` 或 `NaN`」的字段。非对象输入返回 `null`。
 */
export function toWoohaa3CanvasJsonObject(input: unknown): Woohaa3CanvasJsonObject | null {
  return readJsonObject(input);
}

function readNodes(input: unknown): Woohaa3CanvasSerializedNode[] {
  if (!Array.isArray(input)) return [];
  return input.map(readNode).filter((node): node is Woohaa3CanvasSerializedNode => node !== null);
}

function readNode(input: unknown): Woohaa3CanvasSerializedNode | null {
  if (!isRecord(input)) return null;
  const id = readString(input.id);
  const type = readString(input.type);
  if (!id || !type) return null;
  return {
    id,
    type,
    position: readPosition(input.position),
    width: readPositiveNumber(input.width),
    height: readPositiveNumber(input.height),
    parentId: readString(input.parentId),
    ...(typeof input.zIndex === "number" && Number.isFinite(input.zIndex)
      ? { zIndex: input.zIndex }
      : {})
  };
}

function readEdges(input: unknown): Woohaa3CanvasEdge[] {
  if (!Array.isArray(input)) return [];
  return input.map(readEdge).filter((edge): edge is Woohaa3CanvasEdge => edge !== null);
}

function readEdge(input: unknown): Woohaa3CanvasEdge | null {
  if (!isRecord(input)) return null;
  const id = readString(input.id);
  const source = readString(input.source);
  const target = readString(input.target);
  const data = readJsonObject(input.data);
  if (!id || !source || !target || !data) return null;
  return {
    id,
    source,
    target,
    sourceHandle: readString(input.sourceHandle) ?? null,
    targetHandle: readString(input.targetHandle) ?? null,
    data
  };
}

function readPosition(input: unknown): Woohaa3CanvasPosition {
  if (!isRecord(input)) return { x: 0, y: 0 };
  return {
    x: readFiniteNumber(input.x) ?? 0,
    y: readFiniteNumber(input.y) ?? 0
  };
}

function readString(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const value = input.trim();
  return value.length > 0 ? value : undefined;
}

function readFiniteNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function readPositiveNumber(input: unknown): number | undefined {
  const value = readFiniteNumber(input);
  return value !== undefined && value > 0 ? value : undefined;
}

function readJsonObject(input: unknown): Woohaa3CanvasJsonObject | null {
  if (!isRecord(input)) return null;
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) => {
      const normalized = readJsonValue(value);
      return normalized === undefined ? [] : [[key, normalized]];
    })
  );
}

/** Produces a plain JSON value rather than retaining observable/proxy input objects. */
function readJsonValue(input: unknown): Woohaa3CanvasJsonValue | undefined {
  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return input as null | string | boolean;
  }
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
  if (Array.isArray(input)) {
    const values = input.map(readJsonValue);
    return values.some((value) => value === undefined) ? undefined : values as Woohaa3CanvasJsonValue[];
  }
  return typeof input === "object" ? readJsonObject(input) ?? undefined : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
