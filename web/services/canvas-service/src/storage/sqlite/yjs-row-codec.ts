/**
 * SQLite Yjs 仓储：行类型与二进制 codec
 * （自 `yjs.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R22）。
 */
import type { DatabaseSync } from "node:sqlite";
import { CanvasStorageError } from "../core/index.js";
import { SpatialLeaseError } from "../../world-authoring/spatial-leases.js";

export type DocumentRow = {
  canvas_id: string;
  format_version: string;
  room_epoch: string | null;
  snapshot: Uint8Array;
  snapshot_seq: number;
  revision: number;
  projection_json: string | null;
  created_at: string;
  updated_at: string;
};

export type UpdateRow = {
  canvas_id: string;
  seq: number;
  update_bytes: Uint8Array;
  sha256: string;
  created_at: string;
};

export type CommandRow = {
  canvas_id: string;
  command_id: string;
  payload_hash: string;
  revision: number;
  changed: number;
  actor_id: string;
  created_at: string;
  /** Canvas script 首次提交元数据（源码无关 JSON）；旧记录为 null。 */
  script_meta_json?: string | null;
  model_batch_json?: string | null;
};

/** `node:sqlite` 的 BLOB 列以 Uint8Array 返回；统一成新数组避免外部持有内部视图。 */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array(0);
}

/** 写入 BLOB：`node:sqlite` 接受 Uint8Array。 */
export function toBlob(value: Uint8Array): Uint8Array {
  return value;
}

export function translate(error: unknown): unknown {
  if (error instanceof CanvasStorageError || error instanceof SpatialLeaseError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/locked|busy/i.test(message)) return new CanvasStorageError("REPOSITORY_FAILURE", "数据库被锁定");
  if (/readonly|read-only|attempt to write/i.test(message)) {
    return new CanvasStorageError("REPOSITORY_FAILURE", "数据库不可写");
  }
  if (/no such table|malformed|not a database|corrupt/i.test(message)) {
    return new CanvasStorageError("NOT_READY", "数据库 schema 无效或已损坏");
  }
  return new CanvasStorageError("REPOSITORY_FAILURE", "数据库写入失败");
}

/** 单行 `BEGIN IMMEDIATE` 事务包装（返回值形式支持「事务内决定不写」）。 */
export function inImmediateTransaction<T>(db: DatabaseSync, run: () => T): T {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    throw translate(error);
  }
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 事务可能未开始或已自动回滚。
    }
    throw translate(error);
  }
}

/**
 * 命令行 → 领域记录。
 *
 * `script_meta_json` 是**源码无关**的 Canvas script 首次提交元数据；旧记录为 NULL，
 * 解析失败时忽略（不能让历史行让整个恢复失败）。
 */
export function decodeCommandRow(row: CommandRow): {
  commandId: string;
  payloadHash: string;
  revision: number;
  changed: boolean;
  actorId: string;
  createdAt: string;
  script?: import("@woohaa3/contracts").CanvasScriptSubmissionMeta;
  modelBatch?: import("@woohaa3/contracts").ModelScriptBatchMeta;
} {
  const record = {
    commandId: row.command_id,
    payloadHash: row.payload_hash,
    revision: row.revision,
    changed: row.changed === 1,
    actorId: row.actor_id,
    createdAt: row.created_at
  };
  const script = parseScriptMeta(row.script_meta_json);
  let modelBatch: import("@woohaa3/contracts").ModelScriptBatchMeta | undefined;
  if (row.model_batch_json) modelBatch = JSON.parse(row.model_batch_json);
  return { ...record, ...(script ? { script } : {}), ...(modelBatch ? { modelBatch } : {}) };
}

function parseScriptMeta(value: unknown): import("@woohaa3/contracts").CanvasScriptSubmissionMeta | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object") return undefined;
    return parsed as import("@woohaa3/contracts").CanvasScriptSubmissionMeta;
  } catch {
    return undefined;
  }
}
