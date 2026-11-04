/**
 * SQLite Yjs 仓储：schema 迁移
 * （自 `yjs.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R22）。
 *
 * 保留版本顺序（v1→v6）；迁移在 `BEGIN IMMEDIATE` 内并记录版本。
 */
import type { DatabaseSync } from "node:sqlite";
import { CanvasStorageError } from "../core/index.js";

export const SQLITE_YJS_SCHEMA_VERSION = 7;

/** 迁移：建表/删表按版本顺序，记录 applied_at。 */
export function migrateYjsSchema(db: DatabaseSync, now: () => string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvas_yjs_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const row = db
    .prepare("SELECT MAX(version) AS version FROM canvas_yjs_schema_migrations")
    .get() as { version: number | null } | undefined;
  const current = row?.version ?? 0;

  if (current > SQLITE_YJS_SCHEMA_VERSION) {
    throw new CanvasStorageError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `Yjs schema 版本 ${current} 高于应用支持的 ${SQLITE_YJS_SCHEMA_VERSION}`
    );
  }

  const steps: Array<{ version: number; run: (db: DatabaseSync) => void }> = [
    { version: 1, run: migrationV1 },
    { version: 2, run: migrationV2 },
    { version: 3, run: migrationV3 },
    { version: 4, run: migrationV4 },
    { version: 5, run: migrationV5 },
    { version: 6, run: migrationV6 },
    { version: 7, run: migrationV7 }
  ];
  for (const step of steps) {
    if (current >= step.version) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      step.run(db);
      db.prepare("INSERT INTO canvas_yjs_schema_migrations (version, applied_at) VALUES (?, ?)").run(step.version, now());
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw new CanvasStorageError("NOT_READY", `Yjs 迁移 v${step.version} 失败：${safe(error)}`);
    }
  }
}

/** v3：部署级 writer lock 表（任务 3.7 / spec「首版 room 服务采用单应用实例」）。 */
function migrationV3(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvas_writer_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      holder TEXT NOT NULL,
      since TEXT NOT NULL
    )
  `);
}

/** v2：历史上新增 `canvas_sync_modes`；保留空实现以维持迁移链的单调编号，v4 删除。 */
function migrationV2(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvas_sync_modes (
      canvas_id TEXT PRIMARY KEY,
      sync_mode TEXT NOT NULL,
      room_epoch TEXT,
      migrated_revision INTEGER,
      updated_at TEXT NOT NULL
    )
  `);
}

/** v4：删除 `canvas_sync_modes`（remote-cas 模式元数据）。 */
function migrationV4(db: DatabaseSync): void {
  db.exec("DROP TABLE IF EXISTS canvas_sync_modes");
}

/**
 * v5：命令记录增加**源码无关**的 Canvas script 首次提交元数据
 * （change: 2026-10-13-add-canvas-script-authoring，任务 3.2/3.7）。
 *
 * 只增一列可空 JSON；旧记录保持 NULL，读取时 `script` 省略。绝不存源码。
 */
function migrationV5(db: DatabaseSync): void {
  db.exec("ALTER TABLE canvas_yjs_commands ADD COLUMN script_meta_json TEXT");
}

function migrationV1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvas_yjs_documents (
      canvas_id TEXT PRIMARY KEY,
      format_version TEXT NOT NULL,
      room_epoch TEXT,
      snapshot BLOB NOT NULL,
      snapshot_seq INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      projection_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvas_yjs_updates (
      canvas_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      update_bytes BLOB NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (canvas_id, seq),
      FOREIGN KEY (canvas_id) REFERENCES canvas_yjs_documents(canvas_id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvas_yjs_commands (
      canvas_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      revision INTEGER NOT NULL,
      changed INTEGER NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (canvas_id, command_id),
      FOREIGN KEY (canvas_id) REFERENCES canvas_yjs_documents(canvas_id) ON DELETE CASCADE
    )
  `);
}

export function safe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\/[^\s'"]+/g, "<path>").slice(0, 200);
}

export function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // 事务可能未开始或已自动回滚。
  }
}

/** Frozen model authoring summaries share the command transaction. */
function migrationV6(db: DatabaseSync): void {
  db.exec("ALTER TABLE canvas_yjs_commands ADD COLUMN model_batch_json TEXT");
}

/** T06 scene-area authority receipts share the command transaction. */
function migrationV7(db: DatabaseSync): void {
  db.exec("ALTER TABLE canvas_yjs_commands ADD COLUMN world_authoring_json TEXT");
}
