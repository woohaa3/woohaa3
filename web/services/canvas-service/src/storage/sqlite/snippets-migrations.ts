/**
 * SQLite 提示词片段仓库：迁移、行类型与错误归一
 * （自 `snippets.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R26）。
 *
 * 独立迁移表 `snippet_schema_migrations` 与 `prompt_snippets` / `prompt_snippet_tags` /
 * `prompt_snippet_operations`；**绝不**触碰画布表或 Y.Doc。
 */
import type { DatabaseSync } from "node:sqlite";
import { CanvasStorageError } from "../core/errors.js";

export const SQLITE_SNIPPET_SCHEMA_VERSION = 1;

export type SqliteSnippetRepositoryOptions = {
  path: string;
  readOnly?: boolean;
  busyTimeoutMs?: number;
  now?: () => string;
  failWrites?: () => boolean;
};

export type SnippetRow = {
  id: string;
  name: string;
  name_key: string;
  body: string;
  materials_json: string;
  tag_ids_json: string;
  built_in: number;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type TagRow = {
  id: string;
  name: string;
  name_key: string;
  built_in: number;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type OperationRow = {
  operation_id: string;
  kind: string;
  payload_hash: string;
  result_id: string;
  created_at: string;
};

/**
 * 按版本顺序执行片段目录迁移所需的原语。调用方（repository owner）负责版本检查与
 * `BEGIN IMMEDIATE` 事务边界，保持与原实现一致。
 */
export function ensureMigrationTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snippet_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

export function readMigrationVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM snippet_schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}

/** v1：建表与索引。 */
export function migrationV1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_snippets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      body TEXT NOT NULL,
      materials_json TEXT NOT NULL,
      tag_ids_json TEXT NOT NULL,
      built_in INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_snippets_name_key ON prompt_snippets(name_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_prompt_snippets_updated ON prompt_snippets(built_in DESC, updated_at DESC, id ASC)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_snippet_tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      built_in INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_snippet_tags_name_key ON prompt_snippet_tags(name_key)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_snippet_operations (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
}

export function recordMigrationVersion(db: DatabaseSync, now: () => string): void {
  db
    .prepare("INSERT OR IGNORE INTO snippet_schema_migrations (version, applied_at) VALUES (?, ?)")
    .run(SQLITE_SNIPPET_SCHEMA_VERSION, now());
}

export function translateWriteError(error: unknown): unknown {
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

export function safeRollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // ignore
  }
}

export function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\/[^\s'"]+/g, "<path>").slice(0, 200);
}
