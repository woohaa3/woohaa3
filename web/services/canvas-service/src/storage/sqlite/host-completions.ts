/**
 * SQLite trusted host-completion facts (T11a).
 *
 * Independent schema and transaction; never joins or mutates canvas, Yjs or the
 * world-camera history read model. Rows survive stop/release and process
 * restarts until the exact T08 history write succeeds.
 */
import type { DatabaseSync } from "node:sqlite";
import { decodeWorldCamera } from "@woohaa3/contracts";
import { loadNodeSqlite } from "./sqlite-loader.js";
import { CanvasStorageError } from "../core/errors.js";
import {
  committedWriteKey,
  hostCompletionKey,
  type AssistantHostCompletionFact,
  type AssistantHostCompletionIdentity,
  type AssistantHostCompletionListInput,
  type AssistantHostCompletionRepository,
  type AssistantWorldCommittedWrite,
  type AssistantWorldCommittedWriteIdentity,
  type AssistantWorldCommittedWriteListInput,
  type AssistantWorldWriteIntent
} from "../../world-authoring/host-completions.js";

export const SQLITE_ASSISTANT_HOST_COMPLETION_SCHEMA_VERSION = 5;

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
  camera_json: string | null;
};

type IntentRow = {
  receipt_command_id: string | null;
  command_id: string;
  canvas_id: string;
  request_id: string;
  run_id: string;
  epoch: number;
  execution_id: string;
  context_id: string;
  completion_id: string;
  camera_id: string;
  expected_settings_version: string;
  node_id: string;
  settings_version: string;
  camera_json: string;
  payload_hash: string;
};

type CommittedRow = {
  canvas_id: string;
  request_id: string;
  run_id: string;
  epoch: number;
  execution_id: string;
  context_id: string;
  completion_id: string;
  camera_id: string;
  settings_version: string;
  camera_json: string | null;
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
          camera_json TEXT,
          created_at TEXT NOT NULL
        )
      `);
      // Migrate v1 databases in place: the frozen camera settings are required to
      // finish a completion after the current camera changed. Existing rows stay
      // valid with a NULL snapshot and keep the fail-closed current-camera path.
      const columns = this.db.prepare("PRAGMA table_info(assistant_host_completions)").all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === "camera_json")) {
        this.db.exec("ALTER TABLE assistant_host_completions ADD COLUMN camera_json TEXT");
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_ahc_run ON assistant_host_completions(canvas_id, run_id)"
      );
      // Outbox for authoritative camera commits whose run has not yet reached a
      // trusted successful terminal turn. Kept separate from the completion
      // facts so it can never authorize history by itself.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS assistant_world_committed_writes (
          write_key TEXT PRIMARY KEY,
          canvas_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          epoch INTEGER NOT NULL,
          execution_id TEXT NOT NULL,
          context_id TEXT NOT NULL,
          completion_id TEXT NOT NULL,
          camera_id TEXT NOT NULL,
          settings_version TEXT NOT NULL,
          camera_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_awcw_run ON assistant_world_committed_writes(canvas_id, run_id)"
      );
      // Durable pre-commit write intents. An intent proves what the assistant
      // *tried* to write; it never authorizes history on its own. Recovery must
      // resolve the original Yjs command receipt and match payload_hash first.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS assistant_world_write_intents (
          command_id TEXT PRIMARY KEY,
          canvas_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          epoch INTEGER NOT NULL,
          execution_id TEXT NOT NULL,
          context_id TEXT NOT NULL,
          completion_id TEXT NOT NULL,
          camera_id TEXT NOT NULL,
          expected_settings_version TEXT NOT NULL,
          node_id TEXT NOT NULL,
          settings_version TEXT NOT NULL,
          camera_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      const intentColumns = this.db.prepare("PRAGMA table_info(assistant_world_write_intents)").all() as Array<{ name: string }>;
      if (!intentColumns.some(column => column.name === "receipt_command_id")) this.db.exec("ALTER TABLE assistant_world_write_intents ADD COLUMN receipt_command_id TEXT");
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_awwi_run ON assistant_world_write_intents(canvas_id, run_id)"
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
             (completion_key, canvas_id, request_id, run_id, completion_id, camera_id, settings_version, status, camera_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(completion_key) DO UPDATE SET
             request_id = excluded.request_id,
             settings_version = excluded.settings_version,
             status = excluded.status,
             camera_json = excluded.camera_json`
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
          fact.snapshot ? JSON.stringify(fact.snapshot) : null,
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

  async putCommitted(write: AssistantWorldCommittedWrite): Promise<void> {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO assistant_world_committed_writes
             (write_key, canvas_id, request_id, run_id, epoch, execution_id, context_id,
              completion_id, camera_id, settings_version, camera_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(write_key) DO UPDATE SET
             request_id = excluded.request_id,
             epoch = excluded.epoch,
             execution_id = excluded.execution_id,
             context_id = excluded.context_id,
             settings_version = excluded.settings_version,
             camera_json = excluded.camera_json`
        )
        .run(
          committedWriteKey(write),
          write.canvasId,
          write.requestId,
          write.runId,
          write.epoch,
          write.executionId,
          write.contextId,
          write.completionId,
          write.cameraId,
          write.settingsVersion,
          JSON.stringify(write.snapshot),
          this.now()
        );
    });
  }

  async listCommitted(input: AssistantWorldCommittedWriteListInput = {}): Promise<AssistantWorldCommittedWrite[]> {
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
      .prepare(`SELECT * FROM assistant_world_committed_writes${where} ORDER BY created_at, write_key`)
      .all(...values) as CommittedRow[];
    return rows.flatMap(row => {
      const decoded = decodeSnapshot(row.camera_json);
      if (!decoded) return [];
      return [{
        canvasId: row.canvas_id,
        requestId: row.request_id,
        runId: row.run_id,
        epoch: row.epoch,
        executionId: row.execution_id,
        contextId: row.context_id,
        completionId: row.completion_id,
        cameraId: row.camera_id,
        settingsVersion: row.settings_version,
        snapshot: decoded.snapshot
      }];
    });
  }

  async deleteCommitted(write: AssistantWorldCommittedWriteIdentity): Promise<void> {
    this.db
      .prepare("DELETE FROM assistant_world_committed_writes WHERE write_key = ?")
      .run(committedWriteKey(write));
  }

  async putIntent(intent: AssistantWorldWriteIntent): Promise<void> {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO assistant_world_write_intents
             (command_id, canvas_id, request_id, run_id, epoch, execution_id, context_id,
              completion_id, camera_id, expected_settings_version, node_id, settings_version,
              camera_json, payload_hash, created_at, receipt_command_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(command_id) DO UPDATE SET
             canvas_id = excluded.canvas_id,
             request_id = excluded.request_id,
             run_id = excluded.run_id,
             epoch = excluded.epoch,
             execution_id = excluded.execution_id,
             context_id = excluded.context_id,
             completion_id = excluded.completion_id,
             camera_id = excluded.camera_id,
             expected_settings_version = excluded.expected_settings_version,
             node_id = excluded.node_id,
             settings_version = excluded.settings_version,
             camera_json = excluded.camera_json,
             payload_hash = excluded.payload_hash,
             receipt_command_id = excluded.receipt_command_id`
        )
        .run(
          intent.commandId,
          intent.canvasId,
          intent.requestId,
          intent.runId,
          intent.epoch,
          intent.executionId,
          intent.contextId,
          intent.completionId,
          intent.cameraId,
          intent.expectedSettingsVersion,
          intent.nodeId,
          intent.settingsVersion,
          JSON.stringify(intent.snapshot),
          intent.payloadHash,
          this.now(),
          intent.receiptCommandId ?? null
        );
    });
  }

  async getIntent(commandId: string): Promise<AssistantWorldWriteIntent | null> {
    const row = this.db
      .prepare("SELECT * FROM assistant_world_write_intents WHERE command_id = ?")
      .get(commandId) as IntentRow | undefined;
    return row ? rowToIntent(row) : null;
  }

  async listIntents(input: AssistantWorldCommittedWriteListInput = {}): Promise<AssistantWorldWriteIntent[]> {
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
      .prepare(`SELECT * FROM assistant_world_write_intents${where} ORDER BY created_at, command_id`)
      .all(...values) as IntentRow[];
    return rows.flatMap(row => {
      const intent = rowToIntent(row);
      return intent ? [intent] : [];
    });
  }

  async deleteIntent(commandId: string): Promise<void> {
    this.db
      .prepare("DELETE FROM assistant_world_write_intents WHERE command_id = ?")
      .run(commandId);
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
    status: row.status === "partial" ? "partial" : "succeeded",
    ...(decodeSnapshot(row.camera_json) ?? {})
  };
}

function rowToIntent(row: IntentRow): AssistantWorldWriteIntent | null {
  const decoded = decodeSnapshot(row.camera_json);
  if (!decoded) return null;
  return {
    canvasId: row.canvas_id,
    requestId: row.request_id,
    runId: row.run_id,
    epoch: row.epoch,
    executionId: row.execution_id,
    contextId: row.context_id,
    completionId: row.completion_id,
    cameraId: row.camera_id,
    commandId: row.command_id,
    ...(row.receipt_command_id ? { receiptCommandId: row.receipt_command_id } : {}),
    expectedSettingsVersion: row.expected_settings_version,
    nodeId: row.node_id,
    settingsVersion: row.settings_version,
    snapshot: decoded.snapshot,
    payloadHash: row.payload_hash
  };
}

function decodeSnapshot(value: string | null): { snapshot: NonNullable<AssistantHostCompletionFact["snapshot"]> } | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const decoded = decodeWorldCamera(JSON.parse(value));
    return decoded.ok ? { snapshot: decoded.value } : null;
  } catch {
    return null;
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
