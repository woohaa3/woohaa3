/**
 * SQLite 转片场任务幂等登记仓库
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.2 / design D5）。
 *
 * 独立迁移表 `film_set_conversion_schema_migrations` 与表 `film_set_conversions`；跨重启保留
 * requestId/输入 hash/步骤/候选/首次回执，使重复请求在服务重启后仍返回原结果。所有写操作走
 * `BEGIN IMMEDIATE` 事务。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FilmSetConversionRecord, FilmSetConversionRegistry } from "@woohaa3/contracts";
import { loadNodeSqlite } from "./sqlite-loader.js";
import { CanvasStorageError } from "../core/errors.js";

export const SQLITE_FILM_SET_CONVERSION_SCHEMA_VERSION = 1;

export type SqliteFilmSetConversionRegistryOptions = {
  path: string;
  readOnly?: boolean;
  busyTimeoutMs?: number;
  now?: () => string;
  failWrites?: () => boolean;
};

type Row = {
  canvas_id: string;
  request_id: string;
  record_json: string;
  updated_at: string;
};

export class SqliteFilmSetConversionRegistry implements FilmSetConversionRegistry {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly failWrites: () => boolean;
  private closed = false;

  constructor(options: SqliteFilmSetConversionRegistryOptions) {
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
      throw new CanvasStorageError("NOT_READY", `转换登记初始化失败：${safeMessage(error)}`);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS film_set_conversion_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const row = this.db.prepare("SELECT MAX(version) AS version FROM film_set_conversion_schema_migrations").get() as
      | { version: number | null }
      | undefined;
    if ((row?.version ?? 0) >= SQLITE_FILM_SET_CONVERSION_SCHEMA_VERSION) return;
    this.inImmediateTransaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS film_set_conversions (
          canvas_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          record_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (canvas_id, request_id)
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_film_set_conversion_updated ON film_set_conversions(updated_at ASC)"
      );
      this.db
        .prepare("INSERT OR IGNORE INTO film_set_conversion_schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(SQLITE_FILM_SET_CONVERSION_SCHEMA_VERSION, this.now());
    });
  }

  async get(canvasId: string, requestId: string): Promise<FilmSetConversionRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM film_set_conversions WHERE canvas_id = ? AND request_id = ?")
      .get(canvasId, requestId) as Row | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.record_json) as FilmSetConversionRecord;
    } catch {
      return null;
    }
  }

  async put(record: FilmSetConversionRecord): Promise<void> {
    this.inImmediateTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO film_set_conversions (canvas_id, request_id, record_json, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(canvas_id, request_id) DO UPDATE SET
             record_json = excluded.record_json,
             updated_at = excluded.updated_at`
        )
        .run(record.canvasId, record.requestId, JSON.stringify(record), record.updatedAt);
    });
  }

  async delete(canvasId: string, requestId: string): Promise<void> {
    this.inImmediateTransaction(() => {
      this.db
        .prepare("DELETE FROM film_set_conversions WHERE canvas_id = ? AND request_id = ?")
        .run(canvasId, requestId);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
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

function translateWriteError(error: unknown): unknown {
  if (error instanceof CanvasStorageError) return error;
  const message = safeMessage(error);
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
