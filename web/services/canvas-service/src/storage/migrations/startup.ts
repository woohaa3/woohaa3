import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { writerLockHolderIsStale } from "../../sync/writer-lock.js";
import { loadNodeSqlite } from "../sqlite/sqlite-loader.js";

/**
 * 画布 SQLite 启动前检查（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，
 * 任务 6.1；change: remove-canvas-groups-and-film-set —— 片场坐标迁移删除，只剩占用检查）。
 *
 * 只在启动期打开数据库：确认没有仍被运行中实例持有的写者锁，避免两个进程同时改写同一文件。
 * 无画布表或文件不存在时直接跳过。
 */
export function migrateSqliteCanvasBeforeStartup(
  databasePath: string,
  _options: { managedMigrations?: readonly import("@woohaa3/contracts").ManagedNodeMigrationAdapter[] } = {}
): { changed: boolean; backup?: string } {
  if (databasePath === ":memory:" || !fs.existsSync(databasePath)) return { changed: false };
  const filename = fs.realpathSync(databasePath);
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    assertNoWriter(db);
    return { changed: false };
  } finally {
    db.close();
  }
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function assertNoWriter(db: DatabaseSync): void {
  if (!hasTable(db, "canvas_writer_lock")) return;
  const holder = db.prepare("SELECT holder FROM canvas_writer_lock LIMIT 1").get();
  if (holder && !writerLockHolderIsStale(String(holder.holder))) {
    throw new Error("画布仍被运行中的实例占用，请先停止该实例后重启");
  }
}
