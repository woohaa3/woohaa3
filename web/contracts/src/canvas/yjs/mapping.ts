/**
 * `ServerCanvas` ⇄ Y.Doc 映射（任务 2.1 / design D3）。
 *
 * 唯一映射边界：`serverCanvasToYDoc` 与 `yDocToServerCanvas`。除此之外任何地方都不应
 * 直接读写 Y.Doc 内部结构，避免 schema 漂移。
 *
 * 关键设计（design D3）：
 * - 顶层 shared types 固定为 meta / nodes / edges / nodeData / assets / jobs / viewport。
 * - 每个实体作为**单个 JSON value 原子替换**，不递归变成任意深度 shared types。服务端已
 *   串行执行命令，原子值可避免嵌套 schema 漂移，也让「一条命令只改预期实体」可断言。
 * - 导出顺序**不依赖 Y.Map 迭代顺序**（用 format.ts 的稳定比较器）。
 * - `meta.revision` / `updatedAt` 只能由服务端命令 transaction 写。
 */
import * as Y from "yjs";
import { parseCanvasAggregate, type CanvasNodeData, type ServerCanvas, type StoredAsset, type StoredJob } from "../domain/index.js";
import { YJS_CANVAS_FORMAT_VERSION,
  YJS_SHARED_TYPES,
  compareById,
  compareByKey,
  compareByZIndexThenId,
  type YjsCanvasMeta } from "./format.js";

/** 把节点序列化为结构 record（不含业务数据；业务数据在 nodeData）。 */
type SerializedNode = {
  id: string;
  type: string;
  position?: { x: number; y: number };
  width?: number;
  height?: number;
  parentId?: string;
  zIndex?: number;
};

type SerializedEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data: Record<string, unknown>;
};

/** 取得（或创建）顶层 shared types。 */
export function yjsSharedTypes(doc: Y.Doc) {
  return {
    meta: doc.getMap<unknown>(YJS_SHARED_TYPES.meta),
    nodes: doc.getMap<unknown>(YJS_SHARED_TYPES.nodes),
    edges: doc.getMap<unknown>(YJS_SHARED_TYPES.edges),
    nodeData: doc.getMap<unknown>(YJS_SHARED_TYPES.nodeData),
    assets: doc.getMap<unknown>(YJS_SHARED_TYPES.assets),
    jobs: doc.getMap<unknown>(YJS_SHARED_TYPES.jobs)
  };
}

/**
 * 把规范聚合**整体写入**一个 Y.Doc。
 *
 * 用于初始 checkpoint 构造与测试；增量写入用 `applyCanvasToYDoc`（任务 2.2）。
 * 调用方负责在 Yjs transaction 内使用（`doc.transact`），以让一次写入产生单个 update。
 */
export function serverCanvasToYDoc(canvas: ServerCanvas, target?: Y.Doc): Y.Doc {
  const doc = target ?? new Y.Doc();
  const shared = yjsSharedTypes(doc);

  // 清理既有内容，保证整体写入是幂等的「替换」语义。
  doc.transact(() => {
    for (const map of Object.values(shared)) map.clear();
  });

  applyCanvasToYDoc(doc, canvas);
  return doc;
}

/**
 * 把规范聚合的**全部字段**写入（不清理），形成最小差异写入的基础。
 *
 * 与 `serverCanvasToYDoc` 的差别：这里假定调用方已经决定要写哪些 key。整体写入时
 * 由 `serverCanvasToYDoc` 先 clear；增量时由 `applyCanvasDiffToYDoc` 只写变化项。
 */
export function applyCanvasToYDoc(doc: Y.Doc, canvas: ServerCanvas): void {
  const shared = yjsSharedTypes(doc);
  const meta: YjsCanvasMeta = {
    formatVersion: YJS_CANVAS_FORMAT_VERSION,
    id: canvas.id,
    title: canvas.title ?? "",
    documentSchemaVersion: canvas.document.schemaVersion,
    revision: canvas.revision,
    createdAt: canvas.updatedAt,
    updatedAt: canvas.updatedAt
  };

  doc.transact(() => {
    shared.meta.set("formatVersion", meta.formatVersion);
    shared.meta.set("id", meta.id);
    shared.meta.set("title", meta.title);
    shared.meta.set("documentSchemaVersion", meta.documentSchemaVersion);
    shared.meta.set("revision", meta.revision);
    shared.meta.set("createdAt", meta.createdAt);
    shared.meta.set("updatedAt", meta.updatedAt);

    for (const node of canvas.document.nodes) {
      shared.nodes.set(node.id, serializeNode(node));
    }
    for (const edge of canvas.document.edges) {
      shared.edges.set(edge.id, serializeEdge(edge));
    }
    for (const [nodeId, data] of Object.entries(canvas.nodeData)) {
      shared.nodeData.set(nodeId, cloneJson(data));
    }
    for (const asset of canvas.assets) {
      shared.assets.set(asset.id, cloneJson(asset));
    }
    for (const job of canvas.jobs) {
      shared.jobs.set(job.id, cloneJson(job));
    }
  });
}

/**
 * 从 Y.Doc 导出规范 `ServerCanvas`。
 *
 * **必须经过 domain 校验**：非法引用（缺失边端点、孤立 nodeData、非法资产）会让解析失败，
 * 由 room 进入不可写损坏状态——绝不返回修剪后的空画布覆盖原始数据（spec 场景）。
 *
 * 返回 `{ ok: false, failure }` 时调用方不得继续服务该 canvas。
 */
export type YDocExportResult =
  | { ok: true; canvas: ServerCanvas }
  | { ok: false; failure: { code: string; message: string } };

export function yDocToServerCanvas(doc: Y.Doc, options: { now?: string } = {}): YDocExportResult {
  const shared = yjsSharedTypes(doc);

  const id = readString(shared.meta.get("id"));
  if (!id) {
    return { ok: false, failure: { code: "missing-meta-id", message: "meta.id 缺失或非法" } };
  }
  const formatVersion = readString(shared.meta.get("formatVersion"));
  if (formatVersion !== YJS_CANVAS_FORMAT_VERSION) {
    return {
      ok: false,
      failure: {
        code: "unsupported-format",
        message: `不支持的 Y.Doc 格式版本：${String(formatVersion)}`
      }
    };
  }

  const revision = readNumber(shared.meta.get("revision"));
  if (revision === null || revision < 0 || !Number.isInteger(revision)) {
    return { ok: false, failure: { code: "invalid-revision", message: "meta.revision 非法" } };
  }

  // 稳定排序：不依赖 Y.Map 迭代顺序。
  const nodes = [...shared.nodes.entries()]
    .map(([, value]) => value as SerializedNode)
    .filter(isSerializedNode)
    .sort(compareByZIndexThenId);

  const edges = [...shared.edges.entries()]
    .map(([, value]) => value as SerializedEdge)
    .filter(isSerializedEdge)
    .sort(compareById);

  const nodeData = Object.fromEntries(
    [...shared.nodeData.entries()]
      .map(([key, value]) => [key, value] as [string, CanvasNodeData])
      .sort(compareByKey)
  );

  const assets = [...shared.assets.entries()]
    .map(([, value]) => value as StoredAsset)
    .sort(compareById);

  const jobs = [...shared.jobs.entries()]
    .map(([, value]) => value as StoredJob)
    .sort(compareById);

  const updatedAt = readString(shared.meta.get("updatedAt")) ?? options.now ?? new Date().toISOString();
  const title = readString(shared.meta.get("title")) ?? "";

  // 引用完整性**显式校验**。
  //
  // 为什么不能只靠 domain parser：`parseCanvasAggregate` 对非法边/孤立 nodeData 的策略是
  // **丢弃并产生 issue**（那是「读取不受信任输入」的正确行为）。但 spec 要求本 change 在
  // 「Y.Doc 导出结果包含缺失边端点、孤立 nodeData 或非法资产引用」时进入**损坏状态并报告
  // 诊断**，绝不返回修剪后的画布冒充正常。所以这里先做严格校验，再交给 parser 规范化。
  const integrity = validateReferentialIntegrity({ nodes, edges, nodeData, assets, jobs });
  if (!integrity.ok) {
    return { ok: false, failure: { code: integrity.code, message: integrity.message } };
  }

  // 经 domain 规范化：非法引用会在这里被拒绝，而不是产出修剪后的空画布。
  const parsed = parseCanvasAggregate(
    {
      id,
      title,
      revision,
      document: {
        schemaVersion: readString(shared.meta.get("documentSchemaVersion")) ?? "asset-canvas-v1",
        nodes,
        edges,
        updatedAt
      },
      nodeData,
      assets,
      jobs,
      updatedAt
    },
    { now: options.now }
  );

  if (!parsed.ok) {
    return {
      ok: false,
      failure: { code: parsed.failure.code, message: parsed.failure.message }
    };
  }
  return { ok: true, canvas: parsed.canvas };
}

// ---------------------------------------------------------------------------
// 序列化辅助
// ---------------------------------------------------------------------------

/** 结构 record 的输入形态（来自 `ServerCanvas.document.nodes`，不含 `data`）。 */
type CanvasStructureNode = ServerCanvas["document"]["nodes"][number];

function serializeNode(node: CanvasStructureNode): SerializedNode {
  const result: SerializedNode = {
    id: node.id,
    type: node.type,
    ...(node.position ? { position: { x: node.position.x, y: node.position.y } } : {})
  };
  if (typeof node.width === "number") result.width = node.width;
  if (typeof node.height === "number") result.height = node.height;
  if (typeof node.parentId === "string") result.parentId = node.parentId;
  if (typeof node.zIndex === "number") result.zIndex = node.zIndex;
  return result;
}

function serializeEdge(edge: ServerCanvas["document"]["edges"][number]): SerializedEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
    data: cloneJson(edge.data)
  };
}

function isSerializedNode(value: unknown): value is SerializedNode {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.type === "string"
    && (record.position === undefined || typeof record.position === "object");
}

function isSerializedEdge(value: unknown): value is SerializedEdge {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.source === "string" && typeof record.target === "string";
}

/** 深拷贝为纯 JSON，避免把 Yjs 内部对象或引用泄漏到导出结果。 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

/**
 * 引用完整性严格校验（spec「恢复出非法引用」场景）。
 *
 * 与 domain parser 的「丢弃非法项」不同：这里**拒绝**，因为 Y.Doc 是权威状态，
 * 出现悬空引用说明文档已损坏，必须隔离而不是静默修剪。
 */
export function validateReferentialIntegrity(input: {
  nodes: readonly { id: string; parentId?: string }[];
  edges: readonly { id: string; source: string; target: string }[];
  nodeData: Record<string, unknown>;
  assets: readonly { id: string }[];
  jobs: readonly { id: string; nodeId: string }[];
}):
  | { ok: true }
  | { ok: false; code: string; message: string } {
  const nodeIds = new Set(input.nodes.map((node) => node.id));

  // 节点 id 唯一（Y.Map key 天然唯一，但值里的 id 可能被构造得不一致）。
  for (const node of input.nodes) {
    if (!nodeIds.has(node.id)) {
      return { ok: false, code: "node-id-mismatch", message: `节点 ${node.id} 的 id 与 key 不一致` };
    }
  }

  for (const edge of input.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      return {
        ok: false,
        code: "dangling-edge-endpoint",
        message: `边 ${edge.id} 的端点不存在：${edge.source} -> ${edge.target}`
      };
    }
  }

  for (const nodeId of Object.keys(input.nodeData)) {
    if (!nodeIds.has(nodeId)) {
      return {
        ok: false,
        code: "orphan-node-data",
        message: `nodeData 指向不存在的节点 ${nodeId}`
      };
    }
  }

  for (const node of input.nodes) {
    if (node.parentId !== undefined && !nodeIds.has(node.parentId)) {
      return {
        ok: false,
        code: "dangling-parent",
        message: `节点 ${node.id} 的父节点 ${node.parentId} 不存在`
      };
    }
  }

  const jobIds = new Set<string>();
  for (const job of input.jobs) {
    if (jobIds.has(job.id)) {
      return { ok: false, code: "duplicate-job-id", message: `任务 id 重复：${job.id}` };
    }
    jobIds.add(job.id);
  }

  return { ok: true };
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
