/**
 * 后端无关的画布存储契约（任务 2.1 / design D1、D2、D4）。
 *
 * 这一层只描述「一个结构化画布仓库要做什么」，刻意不出现：
 * - `node:sqlite` / `mongodb` 等具体驱动
 * - COS SDK 或文件系统
 * - HTTP 框架 / Vite / React / Yjs
 * - `BlobRepository` 或任何二进制存储概念
 *
 * 媒体 bytes 的唯一归属是 `@woohaa3/media-storage` 的 COS 适配；本契约只保存
 * `StoredAsset.metadata.storageKey` 这类稳定引用。
 */
import type { ServerCanvas } from "@woohaa3/contracts";

/** 画布列表条目的摘要；不含完整 document，避免分页响应过大。 */
export type CanvasSummary = {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  createdAt: string;
  nodeCount: number;
  assetCount: number;
};

export type CanvasListQuery = {
  /** 从 0 开始的偏移量。 */
  offset?: number;
  /** 页大小；调用方已做过上限钳制。 */
  limit?: number;
  /**
   * 可发现画布 ID 白名单（change: 2026-10-13-...，任务 5.5）：在**分页之前**参与过滤。
   *
   * 省略 = 不过滤；空数组 = 无匹配（`total` 为 0）。由入口从可信主体的可读集合提供，
   * 使 `total`/翻页覆盖全部可读画布，而不是先分页再逐条丢弃。
   */
  ids?: readonly string[];
};

export type CanvasListResult = {
  items: CanvasSummary[];
  total: number;
  offset: number;
  limit: number;
};

/**
 * 命令批次提交结果。
 *
 * `duplicate` 为 true 表示命中已有 operationId，`canvas` / `revision` 是**首次**提交的
 * 结果，命令没有被再次应用（spec「网络重试同一 operation」）。
 */
export type CanvasCommandCommitResult = {
  canvas: ServerCanvas;
  revision: number;
  operationId: string;
  duplicate: boolean;
};

/**
 * 一次命令提交的持久化输入。
 *
 * `canvas` 是应用服务**已在最新加载状态上应用命令并规范化后**的目标聚合，其
 * `revision` 必须等于 `expectedRevision + 1`。仓库只负责 CAS、operation 去重与原子持久化；
 * 领域校验（命令应用、资产引用）由应用服务在事务外完成。这样两个 adapter 共用同一套
 * 命令语义，并发控制则各自用数据库原生能力实现。
 */
export type CommitCanvasInput = {
  canvas: ServerCanvas;
  canvasId: string;
  expectedRevision: number;
  operationId: string;
  actorId: string;
  commands: readonly unknown[];
  now: string;
};

/** 一条已提交的 operation 幂等记录（design D4）。 */
export type CanvasOperationRecord = {
  canvasId: string;
  operationId: string;
  baseRevision: number;
  resultRevision: number;
  actorId: string;
  createdAt: string;
  /**
   * 首次提交结果的画布快照。用于「响应丢失后重试」时**精确**返回首次结果，
   * 即使其后又有别的 operation 提交。刻意只保存幂等重放所需的最小快照，
   * 这不是事件溯源或无限历史（见 design D4）。
   */
  resultCanvas: ServerCanvas;
};

/**
 * 仓库契约。
 *
 * 并发语义由实现负责：`commitCanvas` 必须原子地校验 `expectedRevision`、去重
 * operationId、写入目标聚合并递增一次 revision。任何失败都不得留下部分写入。
 */
export interface CanvasRepository {
  /**
   * 持久化一个新画布。入参是 revision 0 的空聚合；实现存为 revision 1 并返回。
   * 已存在同 ID 时抛 `CANVAS_ALREADY_EXISTS`，绝不覆盖。
   */
  createCanvas(canvas: ServerCanvas, operationId?: string): Promise<ServerCanvas>;

  getCanvas(canvasId: string): Promise<ServerCanvas | null>;

  /** 查询一条已提交的 operation 幂等记录；不存在返回 null。 */
  getOperation(canvasId: string, operationId: string): Promise<CanvasOperationRecord | null>;

  /** 列出某画布的全部 operation 幂等记录（归档导出用）。 */
  listOperations(canvasId: string): Promise<CanvasOperationRecord[]>;

  listCanvases(query?: CanvasListQuery): Promise<CanvasListResult>;

  /** 原子提交一批命令（CAS + 幂等 + 持久化）。 */
  commitCanvas(input: CommitCanvasInput): Promise<CanvasCommandCommitResult>;

  /** 以 expectedRevision 删除画布及其 operation 记录；不触碰任何 COS 对象。 */
  deleteCanvas(canvasId: string, expectedRevision: number, operationId?: string): Promise<void>;

  /**
   * 按原样写回一个画布（保留 `revision` / `updatedAt`），用于**运维恢复**路径：
   * 归档 replace 失败后的自动备份还原、以及恢复演练。
   *
   * 与 `createCanvas` 的区别：不强制 `revision = 1`，因此失败替换后不会静默改写目标
   * 的 revision（否则持有 expectedRevision 的客户端会突然全部冲突）。
   * 是 upsert：存在则整体覆盖。
   */
  restoreCanvas(canvas: ServerCanvas): Promise<void>;

  /**
   * 幂等地补齐一条**结构化目录行**（存在则只刷新标题与更新时间，不改 revision）。
   *
   * 场景是"从上游 seed 一张只在远端存在的画布"：room 建的是 Yjs 文档，而目录行在
   * 另一张表里；只建文档的话，画布既不出现在「我的画布」中，后续命令提交也会因为
   * 找不到画布行失败。
   *
   * 声明成可选是为了兼容只提供 Yjs 的最小实现；但**组合层必须转发它**——room 侧是
   * `ensureCanvasRow?.()` 的可选调用，漏转发不会报错，只会静默丢掉目录行。
   */
  ensureCanvasRow?(canvas: ServerCanvas): Promise<void>;

  health(): Promise<CanvasRepositoryHealth>;
}

export type CanvasRepositoryHealth = {
  ok: boolean;
  /** 稳定的健康维度标识，例如 `sqlite` / `mongo` / `memory`。 */
  backend: string;
  /** 不通过时给出可诊断短原因（不含绝对路径与凭据）。 */
  reason?: string;
};

/** 仓库实现共用的分页默认值与上限。 */
export const DEFAULT_CANVAS_LIST_LIMIT = 20;
export const MAX_CANVAS_LIST_LIMIT = 100;

/** 归一化后的目录查询：`ids` 可选（省略 = 不过滤）。 */
export type NormalizedCanvasListQuery = {
  offset: number;
  limit: number;
  ids?: readonly string[];
};

/** 归一化分页参数：非法/负数回落，超过上限钳制；`ids` 只保留字符串项。 */
export function normalizeCanvasListQuery(
  query: CanvasListQuery | undefined
): NormalizedCanvasListQuery {
  const rawOffset = query?.offset;
  const rawLimit = query?.limit;
  const offset = Number.isInteger(rawOffset) && (rawOffset as number) >= 0 ? (rawOffset as number) : 0;
  const limit = Number.isInteger(rawLimit) && (rawLimit as number) > 0
    ? Math.min(rawLimit as number, MAX_CANVAS_LIST_LIMIT)
    : DEFAULT_CANVAS_LIST_LIMIT;
  const ids = Array.isArray(query?.ids)
    ? [...new Set(query.ids.filter((id): id is string => typeof id === "string" && id !== ""))]
    : undefined;
  return { offset, limit, ...(ids ? { ids } : {}) };
}
