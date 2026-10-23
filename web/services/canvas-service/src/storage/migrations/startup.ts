import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { writerLockHolderIsStale } from "../../sync/writer-lock.js";
import { loadNodeSqlite } from "../sqlite/sqlite-loader.js";
import { applyMigration, planMigration } from "./film-set-shooting-shots.js";
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

/** Runs before repositories or rooms open. Only this SQLite file is modified. */
export function migrateSqliteCanvasBeforeStartup(databasePath: string): { changed: boolean; backup?: string } {
  if (databasePath === ":memory:" || !fs.existsSync(databasePath)) return { changed: false };
  const filename = fs.realpathSync(databasePath);
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(filename);
  let manifest: string | undefined;
  let record: Record<string, unknown> = {};
  let inTransaction = false;
  try {
    db.exec("PRAGMA busy_timeout=5000");
    if (!hasTable(db, "canvas_yjs_documents")) return { changed: false };
    const version = () => JSON.stringify(db.prepare("PRAGMA data_version").get());
    const before = version();
    const plan = planMigration(db);
    // 存在无法精确反解坐标单位的片场：明确阻断并保留原件（不猜测单位、不写任何记录）。
    if (plan.conflicts.length > 0) {
      throw new Error(
        `片场坐标迁移存在无法精确反解的记录，已保留原件：${plan.conflicts
          .map((conflict) => `${conflict.canvasId}/${conflict.nodeId}（${conflict.conflict}）`)
          .join("、")}`
      );
    }
    if (!plan.changed) return { changed: false };
    assertNoWriter(db);

    const directory = path.join(path.dirname(filename), "canvas-migrations", `film-set-v3-${Date.now()}-${randomUUID()}`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const backup = path.join(directory, path.basename(filename));
    // SQLite creates a consistent backup, including committed WAL contents.
    // VACUUM INTO runs before the exclusive transaction; data_version below
    // rejects intervening commits so the backup and conversion share a source.
    db.prepare("VACUUM INTO ?").run(backup);
    fs.chmodSync(backup, 0o600);
    manifest = path.join(directory, "manifest.json");
    record = { version: "film-set-shooting-shots-startup-v1", database: filename, backup,
      sha256: createHash("sha256").update(fs.readFileSync(backup)).digest("hex"),
      createdAt: new Date().toISOString(), report: plan.report };
    const writeManifest = (state: string) => fs.writeFileSync(manifest!, JSON.stringify({ ...record, state }, null, 2) + "\n", { mode: 0o600 });
    writeManifest("backed-up");

    db.exec("BEGIN EXCLUSIVE");
    inTransaction = true;
    if (version() !== before) throw new Error("备份期间画布发生变化，已取消迁移，请停止其它写入后重启");
    assertNoWriter(db);
    applyMigration(db, plan);
    if (planMigration(db, { transaction: false }).changed) throw new Error("迁移后仍存在待转换的数据");
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== "ok") throw new Error("迁移后 SQLite 完整性校验失败");
    db.exec("COMMIT");
    inTransaction = false;
    writeManifest("applied");
    return { changed: true, backup };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    if (manifest && inTransaction) {
      fs.writeFileSync(manifest, JSON.stringify({ ...record, state: "rolled-back" }, null, 2) + "\n", { mode: 0o600 });
    }
    throw new Error(`片场数据自动升级失败，画布尚未开放${manifest ? `（备份记录：${manifest}）` : ""}：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally { db.close(); }
}
