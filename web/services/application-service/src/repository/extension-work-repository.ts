/**
 * 后端插件工作引用 durable 仓库（change: 2026-10-04-add-backend-plugin-extensions，任务 2.2）。
 *
 * 插件工作在途引用必须持久化：仅内存计数无法在重启后重建引用（design D4）。使用与 task store
 * 相同的 `node:sqlite` 受控加载与幂等 migration 模式。
 */
import type { DatabaseSync } from "node:sqlite";
import { loadNodeSqlite } from "./sqlite-loader.js";
import type { ExtensionWorkReference, ExtensionWorkReferenceStore } from "../extensions/work.js";

type WorkRow = {
  work_id: string;
  extension_id: string;
  config_version: number;
  state: string;
  created_at: string;
  updated_at: string;
};

export class SqliteExtensionWorkRepository implements ExtensionWorkReferenceStore {
  private readonly db: DatabaseSync;

  constructor(options: { path: string }) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extension_work_references (
        work_id TEXT PRIMARY KEY,
        extension_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS extension_work_references_plugin
        ON extension_work_references(extension_id, state);
    `);
  }

  upsert(reference: ExtensionWorkReference): void {
    this.db
      .prepare(
        `INSERT INTO extension_work_references
           (work_id, extension_id, config_version, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(work_id) DO UPDATE SET
           state = excluded.state,
           updated_at = excluded.updated_at`
      )
      .run(
        reference.workId,
        reference.extensionId,
        reference.configVersion,
        reference.state,
        reference.createdAt,
        reference.updatedAt
      );
  }

  settle(workId: string, state: ExtensionWorkReference["state"], now: string): void {
    this.db
      .prepare("UPDATE extension_work_references SET state = ?, updated_at = ? WHERE work_id = ?")
      .run(state, now, workId);
  }

  list(extensionId: string): ExtensionWorkReference[] {
    const rows = this.db
      .prepare(
        `SELECT work_id, extension_id, config_version, state, created_at, updated_at
           FROM extension_work_references WHERE extension_id = ? ORDER BY created_at ASC, work_id ASC`
      )
      .all(extensionId) as WorkRow[];
    return rows.map(toReference);
  }

  find(workId: string): ExtensionWorkReference | undefined {
    const row = this.db
      .prepare(
        `SELECT work_id, extension_id, config_version, state, created_at, updated_at
           FROM extension_work_references WHERE work_id = ?`
      )
      .get(workId) as WorkRow | undefined;
    return row ? toReference(row) : undefined;
  }

  deleteAll(extensionId: string): void {
    this.db.prepare("DELETE FROM extension_work_references WHERE extension_id = ?").run(extensionId);
  }

  close(): void {
    this.db.close();
  }
}

function toReference(row: WorkRow): ExtensionWorkReference {
  return {
    workId: row.work_id,
    extensionId: row.extension_id,
    configVersion: row.config_version,
    state: row.state as ExtensionWorkReference["state"],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createSqliteExtensionWorkRepository(options: { path: string }): SqliteExtensionWorkRepository {
  return new SqliteExtensionWorkRepository(options);
}
