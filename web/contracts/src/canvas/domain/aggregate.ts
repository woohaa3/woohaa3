/**
 * 画布聚合的加载边界。
 *
 * 来源项目把「聚合」拆在 domain 包的 `normalizeCanvas` 与存储适配器里，且没有
 * schema 版本闸门、任务/资产记录校验或可诊断结果。本模块补齐这三件事，并使
 * 不受信任输入在进入规范 Store 之前被统一处理：
 *
 * 1. 文档 schema 版本闸门（可迁移则迁移，不可迁移则拒绝）
 * 2. 聚合各部分的记录级校验（节点、边、资产、任务）
 * 3. 可诊断的 issue 列表
 */
import { decodeInputSnapshot } from "./input-snapshot.js";
import { sanitizeWoohaa3CanvasDocument,
  sanitizeWoohaa3CanvasNodeData,
  toWoohaa3CanvasJsonObject,
  woohaa3CanvasSchemaVersion,
  type Woohaa3CanvasDocument,
  type Woohaa3CanvasNodeDataMap } from "./core";
import { normalizeCanvas, type NormalizeCanvasOptions } from "./normalization";
import { validateWorldIdentities } from "./world-identities.js";
import { decodeWorldCaptureGenerationBinding } from "../world-capture-pipeline-contract.js";
import type { CanvasTaskInput } from "../../task/dto.js";
import { DEFAULT_CANVAS_TITLE,
  type CanvasAssetSource,
  type CanvasAssetStatus,
  type CanvasMediaKind,
  type CanvasNodeData,
  type GenerationStatus,
  type ServerCanvas,
  type StoredAsset,
  type StoredJob } from "./types";

/** 系统当前支持直接读取的画布文档 schema 版本。 */
export const SUPPORTED_CANVAS_SCHEMA_VERSIONS = [woohaa3CanvasSchemaVersion] as const;

export type SupportedCanvasSchemaVersion = (typeof SUPPORTED_CANVAS_SCHEMA_VERSIONS)[number];

export type CanvasAggregateIssue = {
  /** 规范化过程中的定位，例如 `document.nodes[2]`、`nodeData.<id>`。 */
  path: string;
  code: CanvasAggregateIssueCode;
  message: string;
};

export type CanvasAggregateIssueCode =
  | "node.dropped"
  | "node.type-coerced"
  | "edge.dropped"
  | "nodeData.pruned"
  | "asset.dropped"
  | "job.dropped"
  | "revision.corrected"
  | "title.defaulted";

export type CanvasAggregateFailureCode =
  | "not-an-object"
  | "missing-schema-version"
  | "invalid-world-identities"
  | "unsupported-schema-version";

export type CanvasAggregateFailure = {
  code: CanvasAggregateFailureCode;
  message: string;
  /** 输入声明的 schema 版本；缺失或非字符串时为 null。 */
  schemaVersion: string | null;
};

export type CanvasAggregateParseResult =
  | { ok: true; canvas: ServerCanvas; issues: CanvasAggregateIssue[] }
  | { ok: false; failure: CanvasAggregateFailure; issues: CanvasAggregateIssue[] };

export type ParseCanvasAggregateOptions = NormalizeCanvasOptions & {
  /** 缺失时间戳时的确定性回落值；调用方通常传入 `new Date().toISOString()`。 */
  now?: string;
};

/** 解析受信任输入，失败时抛错。用于内部已校验过的路径。 */
export function parseCanvasAggregate(
  input: unknown,
  options?: ParseCanvasAggregateOptions
): CanvasAggregateParseResult {
  const now = options?.now ?? new Date().toISOString();
  const issues: CanvasAggregateIssue[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      issues,
      failure: {
        code: "not-an-object",
        message: "画布聚合必须是对象",
        schemaVersion: null
      }
    };
  }

  const rawDocument = isRecord(input.document) ? input.document : null;
  const declared = readSchemaVersion(rawDocument);
  if (declared === null || rawDocument === null) {
    return {
      ok: false,
      issues,
      failure: {
        code: "missing-schema-version",
        message: "document.schemaVersion 缺失或不是字符串",
        schemaVersion: null
      }
    };
  }

  if (!(SUPPORTED_CANVAS_SCHEMA_VERSIONS as readonly string[]).includes(declared)) {
    // 只接受当前 schema 版本：不做运行时迁移，未知版本以可诊断失败拒绝。
    return {
      ok: false,
      issues,
      failure: {
        code: "unsupported-schema-version",
        message: `不支持的画布文档 schema 版本: ${declared}`,
        schemaVersion: declared
      }
    };
  }

  // rawDocument 已是不受信任输入；`sanitizeWoohaa3CanvasDocument` 做结构规范化。
  const document: Woohaa3CanvasDocument = sanitizeWoohaa3CanvasDocument(rawDocument, now);
  const worldError = validateWorldIdentities(document.nodes, isRecord(input.nodeData) ? input.nodeData : {});
  if (worldError) return { ok: false, issues, failure: { code: "invalid-world-identities", message: worldError, schemaVersion: declared } };
  const nodeData = sanitizeWoohaa3CanvasNodeData(input.nodeData);
  const assets = sanitizeStoredAssets(input.assets, now, issues);
  const jobs = sanitizeStoredJobs(input.jobs, now, issues);
  const revision = readRevision(input.revision, issues);

  const title = typeof input.title === "string" && input.title.trim()
    ? input.title.trim()
    : undefined;
  if (title === undefined) {
    issues.push({
      path: "title",
      code: "title.defaulted",
      message: `标题缺失，回落为「${DEFAULT_CANVAS_TITLE}」`
    });
  }

  const provisional: ServerCanvas = {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : "",
    title,
    revision,
    document,
    nodeData: nodeData as Woohaa3CanvasNodeDataMap<CanvasNodeData>,
    assets,
    jobs,
    updatedAt: readIsoString(input.updatedAt) ?? document.updatedAt
  };

  let canvas: ServerCanvas;
  try {
    canvas = normalizeCanvas(provisional, options);
  } catch (error) {
    return { ok: false, issues, failure: { code: "invalid-world-identities", message: error instanceof Error ? error.message : String(error), schemaVersion: declared } };
  }
  collectStructuralIssues(rawDocument, canvas, nodeData, issues);
  collectNodeDataPruning(document, nodeData, canvas, issues);
  return { ok: true, canvas, issues };
}
/** 创建可持久化的空画布聚合。空画布不含任何节点，也不创建 START 之类规范节点。 */
export function createEmptyWoohaa3ServerCanvas(
  id: string,
  now = new Date().toISOString()
): ServerCanvas {
  return {
    id,
    title: DEFAULT_CANVAS_TITLE,
    revision: 0,
    document: {
      schemaVersion: woohaa3CanvasSchemaVersion,
      nodes: [],
      edges: [],
      updatedAt: now
    },
    nodeData: {},
    assets: [],
    jobs: [],
    updatedAt: now
  };
}

const CANVAS_MEDIA_KINDS: readonly CanvasMediaKind[] = ["image", "video", "audio", "text", "storyboard", "file"];
const GENERATION_STATUSES: readonly GenerationStatus[] = [
  "idle", "queued", "running", "success", "failed", "draft", "ready", "archived"
];
const ASSET_STATUSES = ["ready", "generating", "needs-review", "missing", "failed"] as const;

function sanitizeStoredAssets(
  input: unknown,
  now: string,
  issues: CanvasAggregateIssue[]
): StoredAsset[] {
  if (!Array.isArray(input)) return [];
  const result: StoredAsset[] = [];
  input.forEach((entry, index) => {
    if (!isRecord(entry) || !readNonEmptyString(entry.id)) {
      issues.push({
        path: `assets[${index}]`,
        code: "asset.dropped",
        message: "资产缺少有效 id，已丢弃"
      });
      return;
    }
    const candidate = entry;
    const mediaKind = readMediaKind(candidate.mediaKind);
    if (!mediaKind) {
      issues.push({
        path: `assets[${index}]`,
        code: "asset.dropped",
        message: "资产缺少合法 mediaKind，已丢弃"
      });
      return;
    }
    result.push({
      id: readNonEmptyString(candidate.id) as string,
      // `title` 是资产契约的必填项；缺失时回落为资产 id，而不是丢弃已被节点引用的资产。
      title: readNonEmptyString(candidate.title)
        ?? (readNonEmptyString(candidate.id) as string),
      mediaKind,
      // `source` / `status` 是描述性字段，不承载标识引用；非法或缺失时取中性默认值。
      source: readAssetSource(candidate.source) ?? "uploaded",
      status: readAssetStatus(candidate.status) ?? "ready",
      isFavorite: candidate.isFavorite === true ? true : undefined,
      prompt: readNonEmptyString(candidate.prompt),
      url: readNonEmptyString(candidate.url),
      posterUrl: readNonEmptyString(candidate.posterUrl),
      text: typeof candidate.text === "string" ? candidate.text : undefined,
      durationSeconds: readFiniteNumber(candidate.durationSeconds),
      progress: readFiniteNumber(candidate.progress),
      error: readNonEmptyString(candidate.error),
      provenance: readProvenance(candidate.provenance),
      tags: readStringArray(candidate.tags),
      // 显式白名单式重建：资产上的 Blob / base64 / 任意附加字段不会进入规范聚合。
      metadata: toWoohaa3CanvasJsonObject(candidate.metadata) ?? undefined,
      nodeId: readNonEmptyString(candidate.nodeId),
      historyTitle: readNonEmptyString(candidate.historyTitle),
      providerTaskId: readNonEmptyString(candidate.providerTaskId),
      createdAt: readIsoString(candidate.createdAt) ?? now
    });
  });
  return result;
}

/**
 * 任务记录校验：id / nodeId / taskId 缺一不可；非法或缺失的描述字段取中性默认值。
 */
function sanitizeStoredJobs(
  input: unknown,
  now: string,
  issues: CanvasAggregateIssue[]
): StoredJob[] {
  if (!Array.isArray(input)) return [];
  const result: StoredJob[] = [];
  input.forEach((entry, index) => {
    const id = isRecord(entry) ? readNonEmptyString(entry.id) : undefined;
    const nodeId = isRecord(entry) ? readNonEmptyString(entry.nodeId) : undefined;
    const taskId = isRecord(entry) ? readNonEmptyString(entry.taskId) : undefined;
    if (!id || !nodeId || !taskId) {
      issues.push({
        path: `jobs[${index}]`,
        code: "job.dropped",
        message: "任务记录缺少 id / nodeId / taskId，已丢弃"
      });
      return;
    }
    const status = isRecord(entry) ? readGenerationStatus(entry.status) : undefined;
    const rawWorldCapture = isRecord(entry) ? entry.worldCapture : undefined;
    const worldCapture = rawWorldCapture === undefined ? undefined : decodeWorldCaptureGenerationBinding(rawWorldCapture);
    result.push({
      id,
      nodeId,
      taskId,
      // runId / error 是任务生命周期的一部分（change: add-image-text-node-execution）：
      // 前者用于 latest-run-wins 判定，后者让失败原因在刷新后仍可诊断。二者都必须往返保留。
      runId: isRecord(entry) ? readNonEmptyString(entry.runId) : undefined,
      // modelKey 决定「这次用的是哪个模型」，是产物溯源的一环（change: l0-generation-provenance），
      // 必须和 runId 一样往返保留，否则导出画布就丢。
      modelKey: isRecord(entry) ? readNonEmptyString(entry.modelKey) : undefined,
      ...(worldCapture?.ok ? { worldCapture: worldCapture.value } : {}),
      ...(isRecord(entry) && entry.references !== undefined
        ? { references: sanitizeJobReferences(entry.references) }
        : {}),
      status: status ?? "idle",
      error: isRecord(entry) ? readNonEmptyString(entry.error) : undefined,
      // 提交时的输入快照：「重新编辑 / 重新生成」读回当时的输入，同样必须往返保留；非法则丢弃（不拖垮整条 job）。
      ...(isRecord(entry) && entry.input !== undefined && decodeInputSnapshot(entry.input) ? { input: decodeInputSnapshot(entry.input)! } : {}),
      updatedAt: (isRecord(entry) ? readIsoString(entry.updatedAt) : undefined) ?? now
    });
  });
  return result;
}

/**
 * 参考输入快照：只保留稳定引用与输入槽身份。
 *
 * 批次来自不受信任输入；未知附加字段、浏览器 URL、bytes 一律丢弃，不进入规范聚合。
 */
function sanitizeJobReferences(input: unknown): CanvasTaskInput[] {
  if (!Array.isArray(input)) return [];
  const result: CanvasTaskInput[] = [];
  for (const entry of input) {
    if (!isRecord(entry)) continue;
    const assetId = readNonEmptyString(entry.assetId);
    const role = readNonEmptyString(entry.role);
    const storageKey = readNonEmptyString(entry.storageKey);
    const mediaType = readNonEmptyString(entry.mediaType);
    if (!assetId || !role || !storageKey || !mediaType) continue;
    const mediaKind =
      entry.mediaKind === "image" || entry.mediaKind === "video" || entry.mediaKind === "audio"
        ? entry.mediaKind
        : undefined;
    const slotId = readNonEmptyString(entry.slotId);
    const sourceNodeId = readNonEmptyString(entry.sourceNodeId);
    const order =
      typeof entry.order === "number" && Number.isInteger(entry.order) && entry.order >= 0
        ? entry.order
        : undefined;
    result.push({
      assetId,
      role,
      storageKey,
      mediaType,
      ...(mediaKind ? { mediaKind } : {}),
      ...(slotId ? { slotId } : {}),
      ...(sourceNodeId ? { sourceNodeId } : {}),
      ...(order !== undefined ? { order } : {})
    });
    if (result.length >= 16) break;
  }
  return result;
}

/**
 * 结构性 issue 的比较基准是**规范化之后**的 `canvas`：节点类型收敛发生在
 * `normalizeCanvas` 内部，若拿收敛前的 document 比较，未知类型被改写成 `custom`
 * 时不会产生任何诊断。
 */
function collectStructuralIssues(
  rawDocument: Record<string, unknown> | null,
  canvas: ServerCanvas,
  nodeData: Woohaa3CanvasNodeDataMap,
  issues: CanvasAggregateIssue[]
): void {
  const document = canvas.document;
  const rawNodes = Array.isArray(rawDocument?.nodes) ? rawDocument.nodes : [];
  const rawEdges = Array.isArray(rawDocument?.edges) ? rawDocument.edges : [];
  const keptNodeIds = new Set(document.nodes.map((node) => node.id));
  const rawNodeIds = new Set<string>();

  rawNodes.forEach((entry, index) => {
    const id = isRecord(entry) ? readNonEmptyString(entry.id) : undefined;
    const type = isRecord(entry) ? readNonEmptyString(entry.type) : undefined;
    if (!id || !type) {
      issues.push({
        path: `document.nodes[${index}]`,
        code: "node.dropped",
        message: "节点缺少 id 或 type，已丢弃"
      });
      return;
    }
    rawNodeIds.add(id);
    if (!keptNodeIds.has(id)) return;
    const kept = document.nodes.find((node) => node.id === id);
    if (kept && kept.type !== type) {
      issues.push({
        path: `document.nodes[${index}]`,
        code: "node.type-coerced",
        message: `未知节点类型 ${type} 已收敛为 ${kept.type}`
      });
    }
  });

  rawEdges.forEach((entry, index) => {
    const id = isRecord(entry) ? readNonEmptyString(entry.id) : undefined;
    const hasEndpoints = isRecord(entry)
      && readNonEmptyString(entry.source) !== undefined
      && readNonEmptyString(entry.target) !== undefined;
    const dataOk = isRecord(entry) && isRecord(entry.data);
    if (!id || !hasEndpoints || !dataOk) {
      issues.push({
        path: `document.edges[${index}]`,
        code: "edge.dropped",
        message: "边缺少 id / 端点 / 对象型 data，已丢弃"
      });
    }
  });

  for (const key of Object.keys(nodeData)) {
    if (!rawNodeIds.has(key)) {
      issues.push({
        path: `nodeData.${key}`,
        code: "nodeData.pruned",
        message: "节点业务数据指向不存在的节点，已剪枝"
      });
    }
  }
}

function collectNodeDataPruning(
  document: Woohaa3CanvasDocument,
  nodeData: Woohaa3CanvasNodeDataMap,
  canvas: ServerCanvas,
  issues: CanvasAggregateIssue[]
): void {
  const kept = new Set(Object.keys(canvas.nodeData));
  for (const key of Object.keys(nodeData)) {
    if (kept.has(key)) continue;
    if (issues.some((issue) => issue.path === `nodeData.${key}`)) continue;
    const node = document.nodes.find((entry) => entry.id === key);
    issues.push({
      path: `nodeData.${key}`,
      code: "nodeData.pruned",
      message: node
        ? `节点类型 ${node.type} 不承载业务数据，已剪枝`
        : "节点业务数据未通过校验，已剪枝"
    });
  }
}

function readSchemaVersion(document: Record<string, unknown> | null): string | null {
  if (!document) return null;
  return readNonEmptyString(document.schemaVersion) ?? null;
}

function readRevision(input: unknown, issues: CanvasAggregateIssue[]): number {
  if (input === undefined) return 0;
  if (typeof input === "number" && Number.isInteger(input) && input >= 0) return input;
  issues.push({
    path: "revision",
    code: "revision.corrected",
    message: "revision 不是非负整数，已回落为 0"
  });
  return 0;
}

function readMediaKind(input: unknown): CanvasMediaKind | null {
  return typeof input === "string" && (CANVAS_MEDIA_KINDS as readonly string[]).includes(input)
    ? input as CanvasMediaKind
    : null;
}

function readAssetSource(input: unknown): CanvasAssetSource | null {
  return input === "generated" || input === "uploaded" || input === "external" ? input : null;
}

function readAssetStatus(input: unknown): CanvasAssetStatus | null {
  return typeof input === "string" && (ASSET_STATUSES as readonly string[]).includes(input)
    ? input as CanvasAssetStatus
    : null;
}

function readProvenance(input: unknown): StoredAsset["provenance"] {
  if (!isRecord(input)) return undefined;
  const provenance: NonNullable<StoredAsset["provenance"]> = {};
  const taskNodeId = readNonEmptyString(input.taskNodeId);
  const taskKind = readNonEmptyString(input.taskKind);
  const runId = readNonEmptyString(input.runId);
  const outputIndex = readFiniteNumber(input.outputIndex);
  if (taskNodeId) provenance.taskNodeId = taskNodeId;
  if (taskKind) provenance.taskKind = taskKind;
  if (runId) provenance.runId = runId;
  if (outputIndex !== undefined) provenance.outputIndex = outputIndex;
  return Object.keys(provenance).length > 0 ? provenance : undefined;
}

function readStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const values = input.filter((entry): entry is string => typeof entry === "string");
  return values.length > 0 ? values : undefined;
}

function readGenerationStatus(input: unknown): GenerationStatus | null {
  return typeof input === "string" && (GENERATION_STATUSES as readonly string[]).includes(input)
    ? input as GenerationStatus
    : null;
}

function readIsoString(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const value = input.trim();
  return value.length > 0 ? value : undefined;
}

function readNonEmptyString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0 ? input.trim() : undefined;
}

function readFiniteNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
