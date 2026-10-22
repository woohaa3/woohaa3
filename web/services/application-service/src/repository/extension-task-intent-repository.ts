/**
 * 跨进程插件任务提交意图 durable 仓库
 * （change: 2026-10-05-extract-application-plugin-host，任务 4.2 / design D5）。
 *
 * 在 Application 配置库的本地事务中记录提交意图与稳定 workerTaskKey，**再**调用 Task。
 * 该事务是「工作已受理」的边界，并与停用写入互斥，因此停用提交后不能创建新意图。
 * 它只记录调用与恢复所需的关联信息，不形成第二套任务队列或权威状态。
 */
import type { DatabaseSync } from "node:sqlite";
import { loadNodeSqlite } from "./sqlite-loader.js";

export type ExtensionTaskIntentState = "pending" | "submitted" | "settled" | "failed";

export type ExtensionTaskIntent = {
  intentId: string;
  extensionId: string;
  configVersion: number;
  workerTaskKey: string;
  /** 稳定 payload 指纹；响应丢失后重试必须与之一致。 */
  payloadHash: string;
  state: ExtensionTaskIntentState;
  createdAt: string;
  updatedAt: string;
};

export type ExtensionTaskIntentStore = {
  create: (intent: ExtensionTaskIntent) => void;
  update: (intentId: string, state: ExtensionTaskIntentState, now: string) => void;
  find: (intentId: string) => ExtensionTaskIntent | undefined;
  findByKey: (workerTaskKey: string) => ExtensionTaskIntent | undefined;
  list: (state?: ExtensionTaskIntentState) => ExtensionTaskIntent[];
  deleteAll: (extensionId: string) => void;
  close: () => void;
};

type IntentRow = {
  intent_id: string;
  extension_id: string;
  config_version: number;
  worker_task_key: string;
  payload_hash: string;
  state: string;
  created_at: string;
  updated_at: string;
};

export class SqliteExtensionTaskIntentRepository implements ExtensionTaskIntentStore {
  private readonly db: DatabaseSync;

  constructor(options: { path: string }) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extension_task_intents (
        intent_id TEXT PRIMARY KEY,
        extension_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        worker_task_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS extension_task_intents_key
        ON extension_task_intents(worker_task_key);
      CREATE INDEX IF NOT EXISTS extension_task_intents_state
        ON extension_task_intents(state);
    `);
  }

  create(intent: ExtensionTaskIntent): void {
    this.db
      .prepare(
        `INSERT INTO extension_task_intents
           (intent_id, extension_id, config_version, worker_task_key, payload_hash, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        intent.intentId,
        intent.extensionId,
        intent.configVersion,
        intent.workerTaskKey,
        intent.payloadHash,
        intent.state,
        intent.createdAt,
        intent.updatedAt
      );
  }

  update(intentId: string, state: ExtensionTaskIntentState, now: string): void {
    this.db
      .prepare("UPDATE extension_task_intents SET state = ?, updated_at = ? WHERE intent_id = ?")
      .run(state, now, intentId);
  }

  find(intentId: string): ExtensionTaskIntent | undefined {
    const row = this.db
      .prepare("SELECT * FROM extension_task_intents WHERE intent_id = ?")
      .get(intentId) as IntentRow | undefined;
    return row ? toIntent(row) : undefined;
  }

  findByKey(workerTaskKey: string): ExtensionTaskIntent | undefined {
    const row = this.db
      .prepare("SELECT * FROM extension_task_intents WHERE worker_task_key = ?")
      .get(workerTaskKey) as IntentRow | undefined;
    return row ? toIntent(row) : undefined;
  }

  list(state?: ExtensionTaskIntentState): ExtensionTaskIntent[] {
    const rows = state
      ? (this.db.prepare("SELECT * FROM extension_task_intents WHERE state = ? ORDER BY created_at ASC").all(state) as IntentRow[])
      : (this.db.prepare("SELECT * FROM extension_task_intents ORDER BY created_at ASC").all() as IntentRow[]);
    return rows.map(toIntent);
  }

  deleteAll(extensionId: string): void {
    this.db.prepare("DELETE FROM extension_task_intents WHERE extension_id = ?").run(extensionId);
  }

  close(): void {
    this.db.close();
  }
}

function toIntent(row: IntentRow): ExtensionTaskIntent {
  return {
    intentId: row.intent_id,
    extensionId: row.extension_id,
    configVersion: row.config_version,
    workerTaskKey: row.worker_task_key,
    payloadHash: row.payload_hash,
    state: row.state as ExtensionTaskIntentState,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createExtensionTaskIntentRepository(options: { path: string }): SqliteExtensionTaskIntentRepository {
  return new SqliteExtensionTaskIntentRepository(options);
}
