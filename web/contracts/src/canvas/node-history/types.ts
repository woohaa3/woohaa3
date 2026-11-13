/**
 * 节点生成历史契约：类型与常量
 * （自 `node-history.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R06）。
 *
 * 纯类型/常量叶子；历史是**画布权限域内的独立产品读模型**。完整历史、缩略图与面板状态
 * MUST NOT 进入 Canvas Y.Doc / `ServerCanvas`。
 */
import type { ImageEditDocument, ImageEditProjectObjectRef } from "../image-edit.js";

/** 历史条目契约版本；结构变化必须升版本。 */
export const NODE_GENERATION_HISTORY_VERSION = "woohaa-node-generation-history-v1" as const;
export type NodeGenerationHistoryVersion = typeof NODE_GENERATION_HISTORY_VERSION;

/** 五类可承载生成历史的节点种类。 */
export const NODE_GENERATION_KINDS = ["text", "image", "video", "audio", "model"] as const;
export type NodeGenerationKind = (typeof NODE_GENERATION_KINDS)[number];

export function isNodeGenerationKind(value: unknown): value is NodeGenerationKind {
  return typeof value === "string" && (NODE_GENERATION_KINDS as readonly string[]).includes(value);
}

/**
 * 生成来源 identity：任务 run、模型 source hash，或模型编辑快照。
 *
 * `model-edit` 用于「回退/恢复那一刻」为**即将被替换的当前状态**留档：以 (sourceHash,
 * 摆放, operationId) 派生稳定键，使同一恢复操作重试幂等，同时不改变「当前版本」判定。
 */
export type NodeGenerationSourceIdentity =
  | { kind: "task-run"; runId: string }
  | { kind: "model-source"; sourceHash: string }
  | { kind: "model-edit"; sourceHash: string; snapshotKey: string }
  | { kind: "image-baseline"; baseStorageKey: string }
  | { kind: "image-edit"; baseStorageKey: string; editKey: string }
  /** 编辑工程版本去重键（编辑扩展工作区）。 */
  | { kind: "image-project"; baseStorageKey: string; projectKey: string }
  /** 失败/取消/中断的 task run 归档（change: 2026-10-12-unify-generation-history-strip）。 */
  | { kind: "task-run-failure"; runId: string }
  /** 浏览器本地操作（截图/帧捕获/视频导出）失败或取消归档。 */
  | { kind: "local-operation"; operationId: string };

/**
 * 版本结果语义（change: 2026-10-12-unify-generation-history-strip，design D3）。
 *
 * 成功版本为 `succeeded`；失败/取消/中断为不可恢复归档（`recoverable: false`）。
 */
export const NODE_HISTORY_OUTCOMES = ["succeeded", "failed", "cancelled", "interrupted", "partial"] as const;
export type NodeHistoryOutcome = (typeof NODE_HISTORY_OUTCOMES)[number];

export function isNodeHistoryOutcome(value: unknown): value is NodeHistoryOutcome {
  return typeof value === "string" && (NODE_HISTORY_OUTCOMES as readonly string[]).includes(value);
}

/** 判定 outcome 是否为可恢复的成功版本。 */
export function isRecoverableOutcome(outcome: NodeHistoryOutcome): boolean {
  return outcome === "succeeded";
}

/** 文本版本 payload：保存**完整**正文（可超过全局 Task History 的安全摘要长度）。 */
export type NodeHistoryTextPayload = { kind: "text"; text: string };

/** 图片/视频/音频版本 payload：只保存稳定 Media metadata（bytes 仍归 Media Service）。 */
export type NodeHistoryMediaPayload = {
  kind: "image" | "video" | "audio";
  storageKey: string;
  checksum: string;
  contentType: string;
  size: number;
  durationSeconds?: number;
  /** 视频海报的稳定 metadata。 */
  poster?: { storageKey: string; checksum: string; contentType: string; size: number };
  /** 图片版本的稳定原图 metadata（仅图片编辑版本携带）。 */
  base?: NodeHistoryImageEditBaseMetadata;
  /** 图片版本的严格编辑定义。缺失/零 shape 表示纯媒体或「删除全部标记」。 */
  imageEdit?: ImageEditDocument;
  /**
   * 图片工程版本的工程对象稳定 metadata
   * （编辑扩展工作区，design D6）。
   *
   * 只在 `imageEdit` 为工程分支时存在；缺失时该版本只能预览 PNG、不可继续编辑。
   */
  project?: ImageEditProjectObjectRef;
};

/** 图片编辑版本的原图稳定 metadata（不复制源像素）。 */
export type NodeHistoryImageEditBaseMetadata = {
  baseAssetId: string;
  storageKey: string;
  checksum: string;
  contentType: string;
  size: number;
  sourceWidth: number;
  sourceHeight: number;
};

/** 模型摆放（与 `modelPlacement` 同构）；编辑历史留档用。 */
export type NodeHistoryModelPlacement = {
  offset: { x: number; y: number; z: number };
  scale: number;
  yaw: number;
};

/** 模型版本 payload：保存脚本、语言、版本与 source hash。 */
export type NodeHistoryModelPayload = {
  kind: "model";
  modelScript: string;
  language: string;
  version: string;
  sourceHash: string;
  placement?: NodeHistoryModelPlacement;
};

export type NodeHistoryContentPayload = NodeHistoryTextPayload | NodeHistoryMediaPayload | NodeHistoryModelPayload;

/**
 * 失败/取消/中断版本 payload
 * （change: 2026-10-12-unify-generation-history-strip，design D3）。
 *
 * 保留提交时的基线内容引用（用于“恢复执行前内容”）、安全输入摘要和失败详情。MUST NOT
 * 包含伪造产物、错误对象或媒体 bytes。`baseline.identity` 为提交时节点当前内容 identity；
 * `baseline.entryId`（若有）指向对应的既有可恢复版本，供 UI 提供显式恢复。
 */
export type NodeHistoryFailurePayload = {
  kind: "failure";
  outcome: Exclude<NodeHistoryOutcome, "succeeded">;
  /** 该失败操作本应产生的历史种类。 */
  failureKind: NodeGenerationKind;
  /** 安全错误摘要（不含堆栈/凭据/本机路径）。 */
  message: string;
  /** 稳定错误码（若有）。 */
  code?: string;
  baseline: {
    identity: string;
    nodeType: string;
    entryId?: string;
    outputAssetId?: string;
  } | null;
  /** 安全输入摘要（有界，不含完整 prompt/凭据）。 */
  inputSummary: string;
};

export type NodeHistoryPayload =
  | NodeHistoryTextPayload
  | NodeHistoryMediaPayload
  | NodeHistoryModelPayload
  | NodeHistoryFailurePayload;

export const NODE_HISTORY_LIMITS = {
  defaultPageSize: 20,
  maxPageSize: 100,
  /** 单节点版本上限（超过后确定性淘汰最旧且非当前版本）。 */
  maxVersionsPerNode: 50,
  /** 单画布历史记录总数预算。 */
  maxEntriesPerCanvas: 5_000,
  /** 单画布历史元数据字节预算。 */
  maxBytesPerCanvas: 64 * 1024 * 1024,
  /** 模型缩略图缓存字节预算。 */
  thumbnailCacheBytes: 32 * 1024 * 1024
} as const;

/** 列表项里的安全来源摘要（不含正文/storageKey/完整脚本）。 */
export type NodeHistorySourceSummary = {
  label: string;
  runId?: string;
  /**
   * 这次生成对应的 Task worker key（change: l0-generation-provenance）。
   *
   * providerTaskId 历史上填的是 canvas jobId，语义容易误读；溯源一律以本字段为准。
   */
  taskKey?: string;
  providerTaskId?: string;
  modelId?: string;
  sourceHash?: string;
  durationSeconds?: number;
};

/**
 * 受控预览引用。
 *
 * 图片/视频/音频只给**条目作用域**的受控 href；文本给安全截断摘要；模型给**条目身份**
 * ——模型缩略图由页面内同一 Bevy 运行时按权威脚本一次性离屏渲染
 * （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
 */
export type NodeHistoryPreview =
  | { kind: "text"; excerpt: string }
  | { kind: "image"; href: string }
  | { kind: "video"; href: string; posterHref: string | null; durationSeconds: number | null }
  | { kind: "audio"; href: string; durationSeconds: number | null }
  | { kind: "model"; entry: NodeHistoryPreviewEntry }
  | { kind: "failure"; outcome: Exclude<NodeHistoryOutcome, "succeeded">; message: string };

/** 模型预览的条目身份：渲染器按它读取权威脚本并缓存结果。 */
export type NodeHistoryPreviewEntry = {
  canvasId: string;
  nodeId: string;
  entryId: string;
};

/** 列表项：只含卡片所需的安全 metadata。 */
export type NodeGenerationHistoryListItem = {
  entryId: string;
  kind: NodeGenerationKind;
  createdAt: string;
  /**
   * 版本结果语义（change: 2026-10-12-unify-generation-history-strip，design D3）。
   * 缺省视为 `succeeded`（兼容旧条目与既有 fixture）。
   */
  outcome?: NodeHistoryOutcome;
  /** 是否与节点当前生效输出一致（由权威回流判定，绝不本地猜测）。失败记录恒为 false。 */
  current: boolean;
  /** 引用内容是否仍可解析（媒体缺失 / 脚本失效时为 false）。失败归档恒为 false。 */
  recoverable: boolean;
  /** 预览是否可用（缩略图/媒体缺失时为 false，不影响列表与恢复）。 */
  previewable: boolean;
  source: NodeHistorySourceSummary;
  preview: NodeHistoryPreview;
};

export type NodeGenerationHistoryListPage = {
  items: NodeGenerationHistoryListItem[];
  /** 下一页 opaque cursor；null 表示已到末尾。 */
  nextCursor: string | null;
  total: number;
};

/** 画布级列表项：在节点级安全列表项之上补充 `nodeId` 与安全节点标题。 */
export type CanvasGenerationHistoryListItem = NodeGenerationHistoryListItem & {
  nodeId: string;
  nodeTitle: string;
};

/** 按内容种类的条目计数。 */
export type NodeHistoryKindCounts = Record<NodeGenerationKind, number>;

export type CanvasGenerationHistoryListPage = {
  items: CanvasGenerationHistoryListItem[];
  nextCursor: string | null;
  total: number;
  kindCounts: NodeHistoryKindCounts;
};

/** 画布级历史查询（归一化后）。 */
export type CanvasHistoryQuery = { limit: number; kind?: NodeGenerationKind; cursor?: string };

/** 详情：按 entryId 按需读取的完整内容。 */
export type NodeGenerationHistoryDetail =
  | { entryId: string; kind: "text"; text: string }
  | {
      entryId: string;
      kind: "image" | "video" | "audio";
      storageKey: string;
      checksum: string;
      contentType: string;
      size: number;
      durationSeconds?: number;
      poster?: { storageKey: string; checksum: string; contentType: string; size: number };
      base?: NodeHistoryImageEditBaseMetadata;
      imageEdit?: ImageEditDocument;
      project?: ImageEditProjectObjectRef;
    }
  | {
      entryId: string;
      kind: "model";
      modelScript: string;
      language: string;
      version: string;
      sourceHash: string;
      placement?: NodeHistoryModelPlacement;
            }
  | {
      entryId: string;
      kind: "failure";
      outcome: Exclude<NodeHistoryOutcome, "succeeded">;
      failureKind: NodeGenerationKind;
      message: string;
      code?: string;
      inputSummary: string;
      baseline: NodeHistoryFailurePayload["baseline"];
    };

/** 存储层条目：`(canvasId, nodeId, createdAt, entryId)` 索引的完整记录。 */
export type NodeGenerationHistoryEntry = {
  version: NodeGenerationHistoryVersion;
  entryId: string;
  canvasId: string;
  nodeId: string;
  kind: NodeGenerationKind;
  createdAt: string;
  /**
   * 版本结果语义（change: 2026-10-12-unify-generation-history-strip，design D3）。
   * 缺省（旧条目）视为 `succeeded`。
   */
  outcome?: NodeHistoryOutcome;
  /** 生成来源 identity（去重键）。 */
  sourceIdentity: string;
  /** 代表该版本内容的 identity；用于与节点当前输出比较。 */
  currentIdentity: string;
  recoverable: boolean;
  previewable: boolean;
  source: NodeHistorySourceSummary;
  payload: NodeHistoryPayload;
};

/** 稳定错误码（跨进程按字符串判定）。 */
export const NODE_HISTORY_ERROR_CODES = [
  "NODE_HISTORY_NOT_FOUND",
  "NODE_HISTORY_INVALID",
  "NODE_HISTORY_UNRECOVERABLE",
  "NODE_HISTORY_CONFLICT",
  "NODE_HISTORY_LIMIT_EXCEEDED",
  "NODE_HISTORY_MERGE_FAILED"
] as const;

export type NodeHistoryErrorCode = (typeof NODE_HISTORY_ERROR_CODES)[number];

export function isNodeHistoryErrorCode(value: unknown): value is NodeHistoryErrorCode {
  return typeof value === "string" && (NODE_HISTORY_ERROR_CODES as readonly string[]).includes(value);
}
