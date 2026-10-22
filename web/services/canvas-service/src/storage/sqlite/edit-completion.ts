/**
 * SQLite 编辑完成回执仓库
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 2.1 / design D6）。
 *
 * 独立迁移表 `edit_completion_schema_migrations` 与表 `canvas_edit_completions`。固定待登记
 * 历史快照（outbox）以 JSON 保存在 `pending_entries_json`，重启后据此补齐历史，**不**读取
 * 当前节点内容冒充当时版本。所有写操作走 `BEGIN IMMEDIATE` 事务。
 */
import type { DatabaseSync } from "node:sqlite";
import type { EditCompletionStatus, NodeGenerationHistoryEntry } from "@woohaa3/contracts";
import { loadNodeSqlite } from "./sqlite-loader.js";
import { CanvasStorageError } from "../core/errors.js";
import type { EditCompletionRecord, EditCompletionRepository } from "../core/edit-completion-contracts.js";

export const SQLITE_EDIT_COMPLETION_SCHEMA_VERSION = 1;

export type SqliteEditCompletionRepositoryOptions = {
  path: string;
  readOnly?: boolean;
  busyTimeoutMs?: number;
  now?: () => string;
  failWrites?: () => boolean;
};

type Row = {
  canvas_id: string;
  node_id: string;
  session_id: string;
  request_id: string;
  kind: string;
  payload_fingerprint: string;
  baseline_content_identity: string;
  status: string;
  content_identity: string;
  entry_id: string | null;
  revision: number;
  content_committed: number;
  pending_entries_json: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export class SqliteEditCompletionRepository implements EditCompletionRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly failWrites: () => boolean;
  private closed = false;

  constructor(options: SqliteEditCompletionRepositoryOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.failWrites = options.failWrites ?? (() => false);
    try {
      const sqlite = loadNodeSqlite();
      this.db = new sqlite.DatabaseSync(options.path, {
        readOnly: options.readOnly ?? false,
        enableForeignKeyConstraints: true
      });
    } catch (error) {
      throw new CanvasStorageError("NOT_READY", `无法打开 SQLite 数据库：${safeMessage(error)}`);
    }
    try {
      if (!options.readOnly) {
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA busy_timeout = " + (options.busyTimeoutMs ?? 5_000));
      }
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migrate();
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
      if (error instanceof CanvasStorageError) throw error;
      throw new CanvasStorageError("NOT_READY", `编辑回执初始化失败：${safeMessage(error)}`);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS edit_completion_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const row = this.db.prepare("SELECT MAX(version) AS version FROM edit_completion_schema_migrations").get() as
      | { version: number | null }
      | undefined;
    if ((row?.version ?? 0) >= SQLITE_EDIT_COMPLETION_SCHEMA_VERSION) return;
    this.inImmediateTransaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS canvas_edit_completions (
          canvas_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_fingerprint TEXT NOT NULL,
          baseline_content_identity TEXT NOT NULL,
          status TEXT NOT NULL,
          content_identity TEXT NOT NULL,
          entry_id TEXT,
          revision INTEGER NOT NULL,
          content_committed INTEGER NOT NULL,
          pending_entries_json TEXT NOT NULL,
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (canvas_id, node_id, request_id)
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_edit_completion_status ON canvas_edit_completions(status, updated_at ASC)"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_edit_completion_canvas ON canvas_edit_completions(canvas_id, node_id)"
      );
      this.db
        .prepare("INSERT OR IGNORE INTO edit_completion_schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(SQLITE_EDIT_COMPLETION_SCHEMA_VERSION, this.now());
    });
  }

  async get(canvasId: string, nodeId: string, requestId: string): Promise<EditCompletionRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM canvas_edit_completions WHERE canvas_id = ? AND node_id = ? AND request_id = ?")
      .get(canvasId, nodeId, requestId) as Row | undefined;
    return row ? rowToRecord(row) : null;
  }

  async put(record: EditCompletionRecord): Promise<void> {
    this.inImmediateTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO canvas_edit_completions
             (canvas_id, node_id, request_id, session_id, kind, payload_fingerprint, baseline_content_identity,
              status, content_identity, entry_id, revision, content_committed, pending_entries_json,
              error_code, error_message, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(canvas_id, node_id, request_id) DO UPDATE SET
             session_id = excluded.session_id,
             kind = excluded.kind,
             payload_fingerprint = excluded.payload_fingerprint,
             baseline_content_identity = excluded.baseline_content_identity,
             status = excluded.status,
             content_identity = excluded.content_identity,
             entry_id = excluded.entry_id,
             revision = excluded.revision,
             content_committed = excluded.content_committed,
             pending_entries_json = excluded.pending_entries_json,
             error_code = excluded.error_code,
             error_message = excluded.error_message,
             updated_at = excluded.updated_at`
        )
        .run(
          record.canvasId,
          record.nodeId,
          record.requestId,
          record.sessionId,
          record.kind,
          record.payloadFingerprint,
          record.baselineContentIdentity,
          record.status,
          record.contentIdentity,
          record.entryId,
          record.revision,
          record.contentCommitted ? 1 : 0,
          JSON.stringify(record.pendingEntries),
          record.errorCode ?? null,
          record.errorMessage ?? null,
          record.createdAt,
          record.updatedAt
        );
    });
  }

  async listByStatus(status: EditCompletionStatus, limit: number): Promise<EditCompletionRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM canvas_edit_completions WHERE status = ? ORDER BY updated_at ASC LIMIT ?"
      )
      .all(status, Math.max(0, limit)) as Row[];
    return rows.map(rowToRecord);
  }

  async listPreparedImages(limit: number): Promise<EditCompletionRecord[]> {
    const rows = this.db.prepare("SELECT * FROM canvas_edit_completions WHERE status = 'prepared' AND kind = 'image' AND pending_entries_json <> '[]' ORDER BY updated_at ASC LIMIT ?")
      .all(Math.max(0, limit)) as Row[];
    return rows.map(rowToRecord);
  }

  async listByNode(canvasId: string, nodeId: string): Promise<EditCompletionRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM canvas_edit_completions WHERE canvas_id = ? AND node_id = ?")
      .all(canvasId, nodeId) as Row[];
    return rows.map(rowToRecord);
  }

  async delete(canvasId: string, nodeId: string, requestId: string): Promise<void> {
    this.inImmediateTransaction(() => {
      this.db
        .prepare("DELETE FROM canvas_edit_completions WHERE canvas_id = ? AND node_id = ? AND request_id = ?")
        .run(canvasId, nodeId, requestId);
    });
  }

  async deleteNode(canvasId: string, nodeId: string): Promise<void> {
    this.inImmediateTransaction(() => {
      this.db.prepare("DELETE FROM canvas_edit_completions WHERE canvas_id = ? AND node_id = ?").run(canvasId, nodeId);
    });
  }

  async deleteCanvas(canvasId: string): Promise<void> {
    this.inImmediateTransaction(() => {
      this.db.prepare("DELETE FROM canvas_edit_completions WHERE canvas_id = ?").run(canvasId);
    });
  }

  async health(): Promise<{ ok: boolean; backend: string; reason?: string }> {
    try {
      this.db.prepare("SELECT COUNT(*) AS total FROM canvas_edit_completions").get();
      return { ok: true, backend: "sqlite" };
    } catch (error) {
      return { ok: false, backend: "sqlite", reason: safeMessage(error) };
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  debugQuery<T = unknown>(sql: string): T[] {
    return this.db.prepare(sql).all() as T[];
  }

  private inImmediateTransaction<T>(run: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw translateWriteError(error);
    }
    try {
      if (this.failWrites()) throw new CanvasStorageError("REPOSITORY_FAILURE", "注入的写失败");
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      safeRollback(this.db);
      throw translateWriteError(error);
    }
  }
}

function rowToRecord(row: Row): EditCompletionRecord {
  return {
    canvasId: row.canvas_id,
    nodeId: row.node_id,
    sessionId: row.session_id,
    requestId: row.request_id,
    kind: row.kind as EditCompletionRecord["kind"],
    payloadFingerprint: row.payload_fingerprint,
    baselineContentIdentity: row.baseline_content_identity,
    status: row.status as EditCompletionStatus,
    contentIdentity: row.content_identity,
    entryId: row.entry_id,
    revision: row.revision,
    contentCommitted: row.content_committed === 1,
    pendingEntries: JSON.parse(row.pending_entries_json) as NodeGenerationHistoryEntry[],
    ...(row.error_code ? { errorCode: row.error_code as EditCompletionRecord["errorCode"] } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function translateWriteError(error: unknown): unknown {
  if (error instanceof CanvasStorageError) return error;
  const message = safeMessage(error);
  if (/UNIQUE constraint failed/i.test(message)) return new CanvasStorageError("REPOSITORY_FAILURE", "唯一性约束冲突");
  if (/readonly|read-only|attempt to write/i.test(message)) return new CanvasStorageError("REPOSITORY_FAILURE", "数据库不可写");
  if (/locked|busy/i.test(message)) return new CanvasStorageError("REPOSITORY_FAILURE", "数据库被锁定");
  if (/no such table|malformed|not a database|corrupt/i.test(message)) {
    return new CanvasStorageError("NOT_READY", "数据库 schema 无效或已损坏");
  }
  return new CanvasStorageError("REPOSITORY_FAILURE", "数据库写入失败");
}

function safeRollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // ignore
  }
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\/[^\s'"]+/g, "<path>").slice(0, 200);
}
