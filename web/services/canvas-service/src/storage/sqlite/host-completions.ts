/**
 * SQLite trusted host-completion facts (T11a).
 *
 * Independent schema and transaction; never joins or mutates canvas, Yjs or the
 * world-camera history read model. Rows survive stop/release and process
 * restarts until the exact T08 history write succeeds.
 */
import type { DatabaseSync } from "node:sqlite";
import { loadNodeSqlite } from "./sqlite-loader.js";
import { CanvasStorageError } from "../core/errors.js";
import {
  hostCompletionKey,
  type AssistantHostCompletionFact,
  type AssistantHostCompletionIdentity,
  type AssistantHostCompletionListInput,
  type AssistantHostCompletionRepository
} from "../../world-authoring/host-completions.js";

export const SQLITE_ASSISTANT_HOST_COMPLETION_SCHEMA_VERSION = 1;

export type SqliteAssistantHostCompletionRepositoryOptions = {
  path: string;
  readOnly?: boolean;
  busyTimeoutMs?: number;
  now?: () => string;
};

type Row = {
  canvas_id: string;
  request_id: string;
  run_id: string;
  completion_id: string;
  camera_id: string;
  settings_version: string;
  status: string;
};

export class SqliteAssistantHostCompletionRepository implements AssistantHostCompletionRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private closed = false;

  constructor(options: SqliteAssistantHostCompletionRepositoryOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
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
      throw new CanvasStorageError("NOT_READY", `助手完成事实初始化失败：${safeMessage(error)}`);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assistant_host_completion_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const row = this.db.prepare("SELECT MAX(version) AS version FROM assistant_host_completion_schema_migrations").get() as
      | { version: number | null }
      | undefined;
    if ((row?.version ?? 0) >= SQLITE_ASSISTANT_HOST_COMPLETION_SCHEMA_VERSION) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS assistant_host_completions (
          completion_key TEXT PRIMARY KEY,
          canvas_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          completion_id TEXT NOT NULL,
          camera_id TEXT NOT NULL,
          settings_version TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_ahc_run ON assistant_host_completions(canvas_id, run_id)"
      );
      this.db
        .prepare("INSERT OR IGNORE INTO assistant_host_completion_schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(SQLITE_ASSISTANT_HOST_COMPLETION_SCHEMA_VERSION, this.now());
    });
  }

  async put(fact: AssistantHostCompletionFact): Promise<void> {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO assistant_host_completions
             (completion_key, canvas_id, request_id, run_id, completion_id, camera_id, settings_version, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(completion_key) DO UPDATE SET
             request_id = excluded.request_id,
             settings_version = excluded.settings_version,
             status = excluded.status`
        )
        .run(
          hostCompletionKey(fact),
          fact.canvasId,
          fact.requestId,
          fact.runId,
          fact.completionId,
          fact.cameraId,
          fact.settingsVersion,
          fact.status,
          this.now()
        );
    });
  }

  async get(completion: AssistantHostCompletionIdentity): Promise<AssistantHostCompletionFact | null> {
    const row = this.db
      .prepare("SELECT * FROM assistant_host_completions WHERE completion_key = ?")
      .get(hostCompletionKey(completion)) as Row | undefined;
    return row ? rowToFact(row) : null;
  }

  async list(input: AssistantHostCompletionListInput = {}): Promise<AssistantHostCompletionFact[]> {
    const clauses: string[] = [];
    const values: string[] = [];
    if (input.canvasId !== undefined) {
      clauses.push("canvas_id = ?");
      values.push(input.canvasId);
    }
    if (input.runId !== undefined) {
      clauses.push("run_id = ?");
      values.push(input.runId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM assistant_host_completions${where} ORDER BY created_at, completion_key`)
      .all(...values) as Row[];
    return rows.map(rowToFact);
  }

  async delete(completion: AssistantHostCompletionIdentity): Promise<void> {
    this.db
      .prepare("DELETE FROM assistant_host_completions WHERE completion_key = ?")
      .run(hostCompletionKey(completion));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function rowToFact(row: Row): AssistantHostCompletionFact {
  return {
    canvasId: row.canvas_id,
    requestId: row.request_id,
    runId: row.run_id,
    completionId: row.completion_id,
    cameraId: row.camera_id,
    settingsVersion: row.settings_version,
    status: row.status === "partial" ? "partial" : "succeeded"
  };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
