/**
 * Task 历史 repository：schema 迁移
 * （自 `history-repository.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R04）。
 *
 * 保留版本顺序：先建表/索引，再幂等补列（老库不被 CREATE TABLE IF NOT EXISTS 更新）。
 */
import type { DatabaseSync } from "node:sqlite";

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_execution_records (
      task_key TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_name TEXT,
      model_type TEXT,
      model_key TEXT,
      model_title TEXT,
      canvas_id TEXT,
      canvas_title TEXT,
      node_id TEXT,
      node_title TEXT,
      run_id TEXT,
      job_id TEXT,
      upstream_task_id TEXT,
      progress REAL,
      attempt INTEGER,
      result_json TEXT,
      error_json TEXT,
      request_json TEXT,
      request_truncated INTEGER,
      full_text TEXT,
      source TEXT,
      extension_id TEXT,
      catalog_revision INTEGER,
      schema_revision INTEGER,
      config_version INTEGER,
      extension_config_version INTEGER,
      created_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER NOT NULL,
      terminal_identity TEXT,
      cursor INTEGER NOT NULL DEFAULT 0,
      last_event_sequence INTEGER
    );
    CREATE INDEX IF NOT EXISTS task_execution_records_order
      ON task_execution_records(created_at DESC, task_key DESC);
    CREATE INDEX IF NOT EXISTS task_execution_records_state ON task_execution_records(state);
    CREATE INDEX IF NOT EXISTS task_execution_records_provider ON task_execution_records(provider_id);
    CREATE INDEX IF NOT EXISTS task_execution_records_model_type ON task_execution_records(model_type);
    CREATE INDEX IF NOT EXISTS task_execution_records_canvas ON task_execution_records(canvas_id);
    CREATE INDEX IF NOT EXISTS task_execution_records_node ON task_execution_records(node_id);
    CREATE INDEX IF NOT EXISTS task_execution_records_model ON task_execution_records(model_key);
    CREATE TABLE IF NOT EXISTS task_execution_events (
      task_key TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      stage TEXT NOT NULL,
      detail_json TEXT,
      occurred_at TEXT NOT NULL,
      PRIMARY KEY (task_key, sequence)
    );
    CREATE TABLE IF NOT EXISTS task_history_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sequence INTEGER NOT NULL DEFAULT 0,
      pruned_floor INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO task_history_cursor (id, sequence) VALUES (1, 0);
    -- 一次性数据迁移的标记：避免每次启动都重扫大字段（见 backfill 上方注释）。
    CREATE TABLE IF NOT EXISTS task_history_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  // 增量列：老库（已存在表）不会被 CREATE TABLE IF NOT EXISTS 更新，显式补列。
  addColumnIfMissing(db, "task_execution_records", "request_json", "TEXT");
  addColumnIfMissing(db, "task_execution_records", "full_text", "TEXT");
  addColumnIfMissing(db, "task_execution_records", "model_key", "TEXT");
  addColumnIfMissing(db, "task_execution_records", "provider_name", "TEXT");
  addColumnIfMissing(db, "task_execution_records", "model_title", "TEXT");
  addColumnIfMissing(db, "task_execution_records", "canvas_title", "TEXT");
  addColumnIfMissing(db, "task_execution_records", "node_title", "TEXT");
  addColumnIfMissing(db, "task_execution_records", "request_truncated", "INTEGER");
  addColumnIfMissing(db, "task_execution_records", "upstream_task_id", "TEXT");
  addColumnIfMissing(db, "task_execution_records", "last_event_sequence", "INTEGER");
  addColumnIfMissing(db, "task_execution_records", "source", "TEXT");
  addColumnIfMissing(db, "task_execution_records", "extension_id", "TEXT");
  addColumnIfMissing(db, "task_execution_records", "catalog_revision", "INTEGER");
  addColumnIfMissing(db, "task_execution_records", "schema_revision", "INTEGER");
  addColumnIfMissing(db, "task_execution_records", "config_version", "INTEGER");
  addColumnIfMissing(db, "task_execution_records", "extension_config_version", "INTEGER");
  addColumnIfMissing(db, "task_history_cursor", "pruned_floor", "INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS task_execution_records_source ON task_execution_records(source);");
  db.exec("CREATE INDEX IF NOT EXISTS task_execution_records_plugin ON task_execution_records(extension_id);");
  // 回填是一次性数据迁移：每次启动都跑会把整张 task_records 的 state_json（dev/生产里可能是 GB 级）
  // 重新读一遍，实测启动被拖慢 8s；同步 Provider 的行永远补不出值，却每轮都被 json_valid/json_extract 扫到。
  // 用标记表保证每个库只跑一次；历史表还没数据的新库不落标记，等真有老记录时再补。
  if (!migrationApplied(db, UPSTREAM_BACKFILL_KEY) && hasHistoryRows(db)) {
    backfillUpstreamTaskIds(db);
    markMigration(db, UPSTREAM_BACKFILL_KEY);
  }
}

/**
 * 回填上游任务号（change: l0-generation-provenance）。
 *
 * `upstream_task_id` 是新列：此前完成的任务在终态投影时它还不存在，老记录会一直为空。
 * 真实的上游任务号仍留在 worker 调度库的 `state_json.record.operation.taskId`（异步 Provider 才有；
 * 同步 Provider 本来就没有上游任务号），这里做一次幂等回填，让历史任务也能对上账。
 *
 * 只填空值、只认 JSON 有效的行；与 worker store 同库时才有效，表不存在时静默跳过。
 */
function backfillUpstreamTaskIds(db: DatabaseSync): void {
  if (!tableExists(db, "task_records")) return;
  try {
    db.exec(`
      UPDATE task_execution_records
         SET upstream_task_id = COALESCE(
               json_extract((SELECT state_json FROM task_records t WHERE t.key = task_execution_records.task_key), '$.record.operation.taskId'),
               json_extract((SELECT state_json FROM task_records t WHERE t.key = task_execution_records.task_key), '$.operation.taskId'),
               json_extract((SELECT state_json FROM task_records t WHERE t.key = task_execution_records.task_key), '$.record.taskId')
             )
       WHERE upstream_task_id IS NULL
         AND EXISTS (
               SELECT 1 FROM task_records t
                WHERE t.key = task_execution_records.task_key
                  AND t.state_json IS NOT NULL
                  AND json_valid(t.state_json)
             )
    `);
  } catch {
    // JSON1 不可用或表结构变化：回填不是关键路径，跳过而不是让服务起不来。
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

/** 一次性数据迁移的标记（同一库只跑一次）。 */
const UPSTREAM_BACKFILL_KEY = "upstream-task-id-backfill-v1";

function migrationApplied(db: DatabaseSync, id: string): boolean {
  return db.prepare("SELECT 1 FROM task_history_migrations WHERE id = ?").get(id) !== undefined;
}

function markMigration(db: DatabaseSync, id: string): void {
  db.prepare("INSERT OR REPLACE INTO task_history_migrations (id, applied_at) VALUES (?, ?)").run(id, new Date().toISOString());
}

function hasHistoryRows(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM task_execution_records LIMIT 1").get() !== undefined;
}

/** 幂等补列：已存在时忽略「duplicate column」错误。 */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch {
    // 列已存在（或表结构由 CREATE TABLE 新建时已包含）。
  }
}
