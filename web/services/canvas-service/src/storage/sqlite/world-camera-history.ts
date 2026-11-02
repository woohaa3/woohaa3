/**
 * SQLite world-camera completion history (T08).
 *
 * Independent schema (`world_camera_history_schema_migrations` and
 * `world_camera_history`). The stable OC05a completion key is the primary key, so
 * retries and host restarts cannot append a second row. The table never joins or
 * updates canvas/Yjs/node-history tables.
 */
import type { DatabaseSync } from "node:sqlite";
import { decodeWorldCameraHistorySnapshot, stableStringify, type WorldCameraHistoryEntry } from "@woohaa3/contracts";
import { loadNodeSqlite } from "./sqlite-loader.js";
import { CanvasStorageError } from "../core/errors.js";
import {
  sameCameraHistory,
  type WorldCameraHistoryInsertResult,
  type WorldCameraHistoryRepository
} from "../../world-authoring/camera-history.js";

export const SQLITE_WORLD_CAMERA_HISTORY_SCHEMA_VERSION = 1;

export type SqliteWorldCameraHistoryRepositoryOptions = {
  path: string;
  readOnly?: boolean;
  busyTimeoutMs?: number;
  now?: () => string;
  failWrites?: () => boolean;
};

type Row = {
  completion_key: string;
  canvas_id: string;
  camera_id: string;
  run_id: string;
  completion_id: string;
  settings_version: string;
  created_at: string;
  snapshot_json: string;
};

export class SqliteWorldCameraHistoryRepository implements WorldCameraHistoryRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly failWrites: () => boolean;
  private closed = false;

  constructor(options: SqliteWorldCameraHistoryRepositoryOptions) {
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
      throw new CanvasStorageError("NOT_READY", `世界镜头历史初始化失败：${safeMessage(error)}`);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS world_camera_history_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const row = this.db.prepare("SELECT MAX(version) AS version FROM world_camera_history_schema_migrations").get() as
      | { version: number | null }
      | undefined;
    if ((row?.version ?? 0) >= SQLITE_WORLD_CAMERA_HISTORY_SCHEMA_VERSION) return;
    this.inImmediateTransaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS world_camera_history (
          completion_key TEXT PRIMARY KEY,
          canvas_id TEXT NOT NULL,
          camera_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          completion_id TEXT NOT NULL,
          settings_version TEXT NOT NULL,
          created_at TEXT NOT NULL,
          snapshot_json TEXT NOT NULL
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_wch_camera_order ON world_camera_history(canvas_id, camera_id, created_at DESC, completion_key DESC)"
      );
      this.db
        .prepare("INSERT OR IGNORE INTO world_camera_history_schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(SQLITE_WORLD_CAMERA_HISTORY_SCHEMA_VERSION, this.now());
    });
  }

  async insert(entry: WorldCameraHistoryEntry): Promise<WorldCameraHistoryInsertResult> {
    return this.inImmediateTransaction(() => {
      const existing = this.findRow(entry.completionKey);
      if (existing) {
        const prior = rowToEntry(existing);
        return { status: sameCameraHistory(prior, entry) ? "duplicate" : "conflict", entry: prior };
      }
      this.db
        .prepare(
          `INSERT INTO world_camera_history
             (completion_key, canvas_id, camera_id, run_id, completion_id, settings_version, created_at, snapshot_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          entry.completionKey,
          entry.canvasId,
          entry.cameraId,
          entry.runId,
          entry.completionId,
          entry.settingsVersion,
          entry.createdAt,
          stableStringify(entry.snapshot)
        );
      return { status: "inserted", entry };
    });
  }

  async get(canvasId: string, completionKey: string): Promise<WorldCameraHistoryEntry | null> {
    const row = this.db
      .prepare("SELECT * FROM world_camera_history WHERE completion_key = ? AND canvas_id = ?")
      .get(completionKey, canvasId) as Row | undefined;
    return row ? rowToEntry(row) : null;
  }

  async list(canvasId: string, cameraId: string, limit = 50): Promise<WorldCameraHistoryEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM world_camera_history
         WHERE canvas_id = ? AND camera_id = ?
         ORDER BY created_at DESC, completion_key DESC
         LIMIT ?`
      )
      .all(canvasId, cameraId, Math.max(0, limit)) as Row[];
    return rows.map(rowToEntry);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  debugQuery<T = unknown>(sql: string): T[] {
    return this.db.prepare(sql).all() as T[];
  }

  private findRow(completionKey: string): Row | undefined {
    return this.db.prepare("SELECT * FROM world_camera_history WHERE completion_key = ?").get(completionKey) as
      | Row
      | undefined;
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

function rowToEntry(row: Row): WorldCameraHistoryEntry {
  const decoded = decodeWorldCameraHistorySnapshot(JSON.parse(row.snapshot_json));
  if (!decoded.ok) {
    throw new CanvasStorageError("NOT_READY", "世界镜头历史记录无效");
  }
  return {
    completionKey: row.completion_key,
    canvasId: row.canvas_id,
    cameraId: row.camera_id,
    runId: row.run_id,
    completionId: row.completion_id,
    settingsVersion: row.settings_version,
    createdAt: row.created_at,
    snapshot: decoded.value
  };
}

function translateWriteError(error: unknown): unknown {
  if (error instanceof CanvasStorageError) return error;
  const message = safeMessage(error);
  if (/UNIQUE constraint failed/i.test(message)) {
    return new CanvasStorageError("REPOSITORY_FAILURE", "唯一性约束冲突");
  }
  if (/readonly|read-only|attempt to write/i.test(message)) {
    return new CanvasStorageError("REPOSITORY_FAILURE", "数据库不可写");
  }
  if (/locked|busy/i.test(message)) {
    return new CanvasStorageError("REPOSITORY_FAILURE", "数据库被锁定");
  }
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
