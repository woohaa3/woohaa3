/**
 * Task Service 插件任务关联 durable 仓库
 * （change: 2026-10-05-extract-application-plugin-host，任务 4.1/4.4 / design D4）。
 *
 * Task 保存「受信任 extensionId + 不可变 configVersion + 稳定 workerTaskKey」关联，作为恢复与
 * 查询依据；插件只能查询/取消**同一插件**的任务。关联 MUST NOT 包含秘密值、secret reference 或
 * 配置正文。
 *
 * 存储与 Task 的其它表共用同一 store 路径（Task 拥有任务事实源）；Application 不保存第二份
 * 权威任务状态。
 */
import type { DatabaseSync } from "node:sqlite";
import { loadNodeSqlite } from "./sqlite-loader.js";

export type ExtensionTaskAssociationRecord = {
  workerTaskKey: string;
  extensionId: string;
  configVersion: number;
  modelType: string;
  /** 插件任务为非画布任务；保留 null 以显式区分画布任务。 */
  canvasId: string | null;
  createdAt: string;
};

export type ExtensionTaskAssociationStore = {
  upsert: (record: ExtensionTaskAssociationRecord) => void;
  find: (workerTaskKey: string) => ExtensionTaskAssociationRecord | undefined;
  listByExtension: (extensionId: string) => ExtensionTaskAssociationRecord[];
  deleteAll: (extensionId: string) => void;
  close: () => void;
};

type AssociationRow = {
  worker_task_key: string;
  extension_id: string;
  config_version: number;
  model_type: string;
  canvas_id: string | null;
  created_at: string;
};

export class SqliteExtensionTaskAssociationRepository implements ExtensionTaskAssociationStore {
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
      CREATE TABLE IF NOT EXISTS task_extension_associations (
        worker_task_key TEXT PRIMARY KEY,
        extension_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        model_type TEXT NOT NULL,
        canvas_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_plugin_associations_plugin
        ON task_extension_associations(extension_id);
    `);
  }

  upsert(record: ExtensionTaskAssociationRecord): void {
    this.db
      .prepare(
        `INSERT INTO task_extension_associations
           (worker_task_key, extension_id, config_version, model_type, canvas_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(worker_task_key) DO UPDATE SET
           extension_id = excluded.extension_id,
           config_version = excluded.config_version,
           model_type = excluded.model_type,
           canvas_id = excluded.canvas_id`
      )
      .run(record.workerTaskKey, record.extensionId, record.configVersion, record.modelType, record.canvasId, record.createdAt);
  }

  find(workerTaskKey: string): ExtensionTaskAssociationRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM task_extension_associations WHERE worker_task_key = ?")
      .get(workerTaskKey) as AssociationRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  listByExtension(extensionId: string): ExtensionTaskAssociationRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM task_extension_associations WHERE extension_id = ? ORDER BY created_at ASC")
      .all(extensionId) as AssociationRow[];
    return rows.map(toRecord);
  }

  deleteAll(extensionId: string): void {
    this.db.prepare("DELETE FROM task_extension_associations WHERE extension_id = ?").run(extensionId);
  }

  close(): void {
    this.db.close();
  }
}

function toRecord(row: AssociationRow): ExtensionTaskAssociationRecord {
  return {
    workerTaskKey: row.worker_task_key,
    extensionId: row.extension_id,
    configVersion: row.config_version,
    modelType: row.model_type,
    canvasId: row.canvas_id,
    createdAt: row.created_at
  };
}

export function createSqliteExtensionTaskAssociationRepository(options: { path: string }): SqliteExtensionTaskAssociationRepository {
  return new SqliteExtensionTaskAssociationRepository(options);
}
