/**
 * 节点生成历史 repository 契约
 * （change: add-canvas-node-generation-history，任务 1.2 / design D1、D6）。
 *
 * 后端无关：只描述按 `(canvasId, nodeId, createdAt, entryId)` 索引的历史读写与容量统计，
 * **不**涉及 Y.Doc、画布 revision、媒体 bytes 或 HTTP。历史独立存储，登记历史绝不推进
 * canvas revision、不广播 Yjs update、不写 `ServerCanvas`。
 *
 * 幂等：`insert` 以稳定 `entryId` 为主键；重复登记返回 `duplicate` 与既有条目，绝不追加副本。
 */
import type { NodeGenerationHistoryEntry, NodeHistoryKindCounts, NodeHistorySourceSummary } from "@woohaa3/contracts";

/** 容量统计（画布级）。 */
export type NodeHistoryCanvasStats = {
  count: number;
  bytes: number;
};

/** 清理用的轻量索引行（不含 payload 正文）。 */
export type NodeHistoryIndexRow = {
  entryId: string;
  canvasId: string;
  nodeId: string;
  createdAt: string;
  currentIdentity: string;
  bytes: number;
};

export type NodeHistoryInsertResult = {
  status: "inserted" | "duplicate";
  entry: NodeGenerationHistoryEntry;
};

/**
 * 批量幂等登记结果（change: 2026-10-27-merge-same-type-node-history，任务 3.1）。
 *
 * 单事务写入：要么全部判定并写入，要么整体失败（调用方据此补偿）。`insertedIds` 只含
 * 本次真正新增的条目；`duplicateIds` 是已存在、未追加的条目。
 */
export type NodeHistoryInsertManyResult = {
  insertedIds: string[];
  duplicateIds: string[];
};

export type NodeHistoryListInput = {
  canvasId: string;
  nodeId: string;
  limit: number;
  /** 已经 opaque 解码的游标位置（`createdAt` + `entryId`）。 */
  cursor?: { createdAt: string; entryId: string };
};

export type NodeHistoryListResult = {
  items: NodeGenerationHistoryEntry[];
  nextCursor: { createdAt: string; entryId: string } | null;
  total: number;
};

/**
 * 画布级列表输入（change: add-canvas-generation-history-dialog）。
 * 跨该画布全部节点，按 `(createdAt desc, entryId desc)` 倒序，cursor 为排他位置。
 */
export type NodeHistoryCanvasListInput = {
  summary?: boolean; summaryNodeId?: string;
  currentIdentities?: Readonly<Record<string, string>>;
  canvasId: string;
  limit: number;
  kind?: NodeGenerationHistoryEntry["kind"];
  cursor?: { createdAt: string; entryId: string };
};

export type NodeHistoryRepository = {
  /** 幂等登记一条历史（同 entryId 返回 duplicate）。 */
  insert(entry: NodeGenerationHistoryEntry): Promise<NodeHistoryInsertResult>;

  /**
   * 单事务批量幂等登记（change: 2026-10-27-merge-same-type-node-history，任务 3.1）。
   *
   * 用于合并复制来源历史：调用方按目标节点重算 `entryId` 后一次写入，重复项只报告不追加。
   * 任一条写入失败必须整体回滚（不留下部分复制）。
   */
  insertMany(entries: readonly NodeGenerationHistoryEntry[]): Promise<NodeHistoryInsertManyResult>;

  /** 把条目降级为不可恢复/不可预览（媒体对象缺失或脚本失效）。 */
  markUnrecoverable(canvasId: string, nodeId: string, entryId: string): Promise<void>;

  /** 按归属读取单条；不存在返回 null。 */
  get(canvasId: string, nodeId: string, entryId: string): Promise<NodeGenerationHistoryEntry | null>;

  /** 按 (createdAt, entryId) 倒序分页；cursor 为排他位置。 */
  list(input: NodeHistoryListInput): Promise<NodeHistoryListResult>;

  /**
   * 画布级分页：跨该画布全部节点，可筛选内容种类
   * （change: add-canvas-generation-history-dialog）。
   */
  listCanvas(input: NodeHistoryCanvasListInput): Promise<NodeHistoryListResult>;

  /** 画布按内容种类的条目计数（change: add-canvas-generation-history-dialog）。 */
  canvasKindCounts(canvasId: string): Promise<NodeHistoryKindCounts>;

  /** 某节点全部条目（倒序）；供容量清理与 current 判定。 */
  listForNode(canvasId: string, nodeId: string): Promise<NodeGenerationHistoryEntry[]>;

  /** 画布全部索引行（升序，最旧在前）；供画布级容量清理。 */
  listCanvasIndex(canvasId: string): Promise<NodeHistoryIndexRow[]>;

  /** 画布容量统计。 */
  canvasStats(canvasId: string): Promise<NodeHistoryCanvasStats>;

  /** 删除指定条目（同一画布内）。 */
  delete(canvasId: string, entryIds: readonly string[]): Promise<void>;

  /** 删除某节点全部条目（节点删除生命周期）。 */
  deleteNode(canvasId: string, nodeId: string): Promise<void>;

  /** 删除整个画布历史（画布删除生命周期）。 */
  deleteCanvas(canvasId: string): Promise<void>;

  health(): Promise<NodeHistoryHealth>;
};

export type NodeHistoryHealth = {
  ok: boolean;
  backend: string;
  reason?: string;
};

/** 序列化为稳定 payload（repository 通用）。 */
export function nodeHistoryEntryBytes(entry: NodeGenerationHistoryEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

export type { NodeHistorySourceSummary };
