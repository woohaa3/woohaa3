/**
 * 画布导入：SQLite 行解码与错误翻译
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 4.5 / design D6）。
 *
 * 纯函数集中在此，`canvas-import.ts` 只保留连接/事务/作业状态机。所有 JSON 解析必须
 * 有界且容错：损坏行返回空/最小结构，绝不抛出未捕获异常绕过事务回滚。
 */
import { CanvasStorageError } from "../core/index.js";
import type { ImportedCanvasAccess } from "@woohaa3/contracts";
import type {
  CanvasImportJobRecord,
  CanvasImportJobState,
  CanvasImportReceipt
} from "../../import/contracts.js";

/** `commitImport` 写入历史行前需要的最小字段（来自扩展装配的 history JSON）。 */
export type HistoryEntryRow = {
  entryId: string;
  canvasId: string;
  nodeId: string;
  kind: string;
  createdAt: string;
  sourceIdentity: string;
  currentIdentity: string;
  recoverable: boolean;
  previewable: boolean;
  payload: unknown;
  source: unknown;
};

export function parseHistoryEntries(json: string): HistoryEntryRow[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as HistoryEntryRow[]) : [];
  } catch {
    return [];
  }
}

export function rowToReceipt(row: Record<string, unknown>): CanvasImportReceipt {
  return {
    targetCanvasId: String(row.target_canvas_id),
    binding: {
      sourceId: String(row.source_id),
      sourceCanvasId: String(row.source_canvas_id),
      cutoverGeneration: String(row.cutover_generation),
      extensionId: String(row.extension_id),
      configVersion: Number(row.config_version),
      converterVersion: String(row.converter_version),
      sourceVersion: String(row.source_version)
    },
    ownerSubject: String(row.owner_subject),
    sharingMode: row.sharing_mode as ImportedCanvasAccess["sharingMode"],
    diagnostics: {
      readyMediaCount: Number(row.ready_media_count),
      restoredHistoryCount: Number(row.restored_history_count),
      unrecoveredRecordCount: Number(row.unrecovered_record_count)
    },
    committedAt: String(row.committed_at)
  };
}

export function rowToJob(row: Record<string, unknown>): CanvasImportJobRecord {
  return {
    jobId: String(row.job_id),
    targetCanvasId: String(row.target_canvas_id),
    binding: {
      sourceId: String(row.source_id),
      sourceCanvasId: String(row.source_canvas_id),
      cutoverGeneration: String(row.cutover_generation),
      extensionId: String(row.extension_id),
      configVersion: Number(row.config_version),
      converterVersion: String(row.converter_version),
      sourceVersion: String(row.source_version)
    },
    subject: String(row.subject),
    state: String(row.state) as CanvasImportJobState,
    phase: String(row.phase),
    attempt: Number(row.attempt),
    fence: Number(row.fence),
    completedMedia: Number(row.completed_media),
    totalMedia: Number(row.total_media),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    ...(row.error_retryable === null || row.error_retryable === undefined
      ? {}
      : { errorRetryable: Number(row.error_retryable) === 1 }),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function parseArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function translate(error: unknown): CanvasStorageError {
  if (error instanceof CanvasStorageError) return error;
  const message = safe(error);
  if (message.includes("locked") || message.includes("busy")) {
    return new CanvasStorageError("REPOSITORY_FAILURE", "数据库忙，导入事务未提交");
  }
  if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) {
    return new CanvasStorageError("TARGET_CONFLICT", "目标已存在，拒绝覆盖");
  }
  return new CanvasStorageError("REPOSITORY_FAILURE", "导入事务失败");
}

function safe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\/[^\s'"]+/g, "<path>").slice(0, 300);
}
