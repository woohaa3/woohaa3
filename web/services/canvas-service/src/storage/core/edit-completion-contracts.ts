/**
 * 编辑完成回执与待登记快照 repository 契约
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 2.1 / design D6）。
 *
 * 后端无关：持久保存稳定请求身份、目标归属、基线/最终内容身份、权威提交结果与**固定**的
 * 待登记历史快照。与节点历史 repository 一样是 Canvas Service 元数据，不含媒体 bytes。
 *
 * 关键约束：
 * - 同一 `(canvasId, nodeId, requestId)` 为主键，重试返回既有结果；
 * - `prepared` 在内容提交**之前**持久化；内容提交成功后把固定 snapshot 与回执一起写为
 *   `history-pending`；历史登记成功后改为 `completed`；
 * - `history-pending` 记录可被启动补偿扫描，使用持久 snapshot，绝不读取当前节点内容。
 */
import type { NodeGenerationHistoryEntry } from "@woohaa3/contracts";
import type { EditCompletionStatus, EditSessionKind, EditSessionErrorCode } from "@woohaa3/contracts";

/** 一条完成回执（含固定待登记 snapshot）。 */
export type EditCompletionRecord = {
  canvasId: string;
  nodeId: string;
  sessionId: string;
  requestId: string;
  kind: EditSessionKind;
  /** 请求 payload 指纹；同 requestId 不同指纹 → 冲突。 */
  payloadFingerprint: string;
  baselineContentIdentity: string;
  status: EditCompletionStatus;
  contentIdentity: string;
  entryId: string | null;
  revision: number;
  contentCommitted: boolean;
  /**
   * 固定待登记历史快照（outbox）。图片提交前写入，补偿任务据此登记历史，
   * **不**读取当前节点内容冒充当时版本。历史登记成功后清空。
   */
  pendingEntries: NodeGenerationHistoryEntry[];
  errorCode?: EditSessionErrorCode;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type EditCompletionRepository = {
  /** 按 `(canvasId, nodeId, requestId)` 读取；不存在返回 null。 */
  get(canvasId: string, nodeId: string, requestId: string): Promise<EditCompletionRecord | null>;

  /** 幂等 upsert（主键为 `(canvasId, nodeId, requestId)`）。 */
  put(record: EditCompletionRecord): Promise<void>;

  /** 列出处于给定状态的记录（补偿扫描 `history-pending`）。 */
  listByStatus(status: EditCompletionStatus, limit: number): Promise<EditCompletionRecord[]>;

  /** 只扫描带固定快照的 prepared 图片完成请求，begin 会话不占补偿批次。 */
  listPreparedImages(limit: number): Promise<EditCompletionRecord[]>;

  /** 列出某节点全部完成回执（供会话存在性判定）。 */
  listByNode(canvasId: string, nodeId: string): Promise<EditCompletionRecord[]>;

  /** 删除记录（放弃/清理）。 */
  delete(canvasId: string, nodeId: string, requestId: string): Promise<void>;

  /** 删除某节点/画布全部记录（节点/画布删除生命周期）。 */
  deleteNode(canvasId: string, nodeId: string): Promise<void>;
  deleteCanvas(canvasId: string): Promise<void>;

  health(): Promise<{ ok: boolean; backend: string; reason?: string }>;
};

/** 记录字节（容量/诊断）。 */
export function editCompletionRecordBytes(record: EditCompletionRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}
