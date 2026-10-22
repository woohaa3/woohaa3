/**
 * 画布导入：SQLite schema 迁移与既有目标表断言
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 4.5 / design D6、D11）。
 *
 * 与 `canvas-import.ts` 分开，保持存储类职责聚焦。导入表由本模块迁移；**既有**目标表
 * （`canvases` / `canvas_yjs_documents` / `node_generation_history`）由既有 repository 迁移，
 * 本模块只断言其存在，缺失即失败（不重复定义 DDL、不静默降级）。
 */
import type { DatabaseSync } from "node:sqlite";
import { CanvasStorageError } from "../core/index.js";

export const SQLITE_CANVAS_IMPORT_SCHEMA_VERSION = 1;

/** 导入依赖的既有目标表（必须由既有迁移创建）。 */
export const IMPORT_BASE_TABLES = [
  "canvases",
  "canvas_yjs_documents",
  "node_generation_history"
] as const;

/** 应用导入 schema（幂等）；`inTransaction` 由调用方提供以复用连接事务语义。 */
export function migrateImportSchema(
  db: DatabaseSync,
  now: () => string,
  inTransaction: <T>(run: () => T) => T
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvas_import_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const row = db.prepare("SELECT MAX(version) AS version FROM canvas_import_schema_migrations").get() as
    | { version: number | null }
    | undefined;
  if ((row?.version ?? 0) >= SQLITE_CANVAS_IMPORT_SCHEMA_VERSION) return;
  inTransaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS canvas_import_jobs (
        job_id TEXT PRIMARY KEY,
        target_canvas_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_canvas_id TEXT NOT NULL,
        cutover_generation TEXT NOT NULL,
        extension_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        converter_version TEXT NOT NULL,
        source_version TEXT NOT NULL,
        subject TEXT NOT NULL,
        state TEXT NOT NULL,
        phase TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        fence INTEGER NOT NULL,
        completed_media INTEGER NOT NULL,
        total_media INTEGER NOT NULL,
        error_code TEXT,
        error_retryable INTEGER,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_import_jobs_source ON canvas_import_jobs(source_id, source_canvas_id, state)"
    );
    db.exec(`
      CREATE TABLE IF NOT EXISTS canvas_import_receipts (
        target_canvas_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_canvas_id TEXT NOT NULL,
        cutover_generation TEXT NOT NULL,
        extension_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        converter_version TEXT NOT NULL,
        source_version TEXT NOT NULL,
        owner_subject TEXT NOT NULL,
        sharing_mode TEXT NOT NULL,
        read_subjects_json TEXT NOT NULL,
        write_subjects_json TEXT NOT NULL,
        source_acl_version TEXT NOT NULL,
        ready_media_count INTEGER NOT NULL,
        restored_history_count INTEGER NOT NULL,
        unrecovered_record_count INTEGER NOT NULL,
        -- 'ready' | 'deleted'：删除写持久 deleted tombstone，来源绑定**不**级联删除。
        state TEXT NOT NULL DEFAULT 'ready',
        committed_at TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS canvas_imported_access (
        canvas_id TEXT PRIMARY KEY,
        owner_subject TEXT NOT NULL,
        sharing_mode TEXT NOT NULL,
        read_subjects_json TEXT NOT NULL,
        write_subjects_json TEXT NOT NULL,
        source_acl_version TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS canvas_import_diagnostics (
        canvas_id TEXT PRIMARY KEY,
        entries_json TEXT NOT NULL
      )
    `);
    db
      .prepare("INSERT OR IGNORE INTO canvas_import_schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(SQLITE_CANVAS_IMPORT_SCHEMA_VERSION, now());
  });
}

/** 断言既有 repository 迁移已创建的目标表存在；缺失即拒绝（不重复定义 DDL）。 */
export function assertImportBaseTables(db: DatabaseSync): void {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  const names = new Set(rows.map((row) => row.name));
  const missing = IMPORT_BASE_TABLES.filter((table) => !names.has(table));
  if (missing.length > 0) {
    throw new CanvasStorageError("NOT_READY", `导入存储缺少目标表（应由既有迁移创建）：${missing.join("、")}`);
  }
}
