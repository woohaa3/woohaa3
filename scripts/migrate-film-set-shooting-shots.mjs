#!/usr/bin/env node
/**
 * 拍摄镜头 schema2 → schema3 + 预览闭包的**一次性离线迁移**命令
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 3.1/3.2 / design D9）。
 *
 * 复用既有 model-native migration 的备份/dry-run/排他检查/manifest/verify/restore 模式，
 * **不改**原工具既有迁移目标。只处理已是 items-only 内容、动画仍为 schema2 的片场；补齐显式
 * `kind` 与预览节点闭包，原子收敛 checkpoint/projection/update tail/epoch 与历史/回执。
 *
 * 用法：
 *   node scripts/migrate-film-set-shooting-shots.mjs dry-run|apply|verify|restore \
 *     --profile <.local> --manifest <private-json> [--quiesced]
 *
 * 真实用户数据迁移只在正式实施交付步骤执行；本文件不在规划阶段运行。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync, backup } from "node:sqlite";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(root, "web/package.json"));
const args = process.argv.slice(2);
const mode = args.shift();
const option = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const flag = (name) => args.includes(name);
const hashFile = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
};
const filenames = ["canvas-dev.sqlite", "task-dev.sqlite", "application-dev.sqlite"];
const MANIFEST_VERSION = "film-set-shooting-shots-migration-v1";

/** 独占检查：apply/restore 前必须显式声明已停止写入，且没有任何外部进程持有该 profile 的数据库句柄。 */
function openedByOthers(profile) {
  const files = new Set(filenames.flatMap((name) => [path.join(profile, name), path.join(profile, name) + "-wal", path.join(profile, name) + "-shm"]));
  if (process.platform === "darwin") {
    const result = spawnSync("/usr/sbin/lsof", ["-t", "--", ...[...files].filter((file) => fs.existsSync(file))], { encoding: "utf8", timeout: 30_000 });
    if (result.error || ![0, 1].includes(result.status) || (result.status === 1 && result.stderr.trim())) {
      throw new Error(`Cannot inspect profile database handles: ${result.error?.message ?? result.stderr}`);
    }
    return [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean).map(Number))].filter((pid) => pid !== process.pid);
  }
  if (process.platform !== "linux") throw new Error(`Profile handle inspection unsupported on ${process.platform}`);
  const pids = [];
  for (const pid of fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid)) {
    try {
      if (fs.readdirSync(`/proc/${pid}/fd`).some((fd) => { try { return files.has(fs.readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { return false; } })) pids.push(Number(pid));
    } catch { /* process exited */ }
  }
  return pids;
}
function requireQuiesced(profile) {
  if (!flag("--quiesced")) throw new Error("apply/restore require --quiesced after stopping profile writers");
  const pids = openedByOthers(profile);
  if (pids.length) throw new Error(`Profile database handles remain open in processes: ${pids.join(",")}`);
}
function tables(db) { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name); }

/** 离线转换入口：打包 TypeScript 计划模块（唯一 import 点，服务运行时不引用）。 */
async function loadConverter() {
  const { build } = require("esbuild");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "film-set-shooting-shots-"));
  const outfile = path.join(temporary, "converter.mjs");
  await build({
    entryPoints: [path.join(root, "scripts/lib/film-set-shooting-shot-migration.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
    nodePaths: [path.join(root, "web/node_modules"), path.join(root, "web/contracts/node_modules")],
    alias: {
      "@woohaa3/contracts/canvas-yjs": path.join(root, "web/contracts/src/canvas/yjs/index.ts"),
      "@woohaa3/contracts": path.join(root, "web/contracts/src/index.ts")
    },
    banner: { js: "import { createRequire as __migrationCreateRequire } from 'node:module'; const require = __migrationCreateRequire(import.meta.url);" }
  });
  try { return await import(pathToFileURL(outfile).href); } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

async function restore(profile, manifestFile) {
  requireQuiesced(profile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.profile !== profile || manifest.version !== MANIFEST_VERSION) throw new Error("Backup manifest profile/version mismatch");
  if (!Array.isArray(manifest.backups) || manifest.backups.length !== filenames.length || new Set(manifest.backups.map((file) => file.name)).size !== filenames.length || manifest.backups.some((file) => !filenames.includes(file.name))) throw new Error("Restore requires exactly all three profile database backups");
  for (const file of manifest.backups) if (hashFile(file.backup) !== file.sha256) throw new Error(`Backup checksum mismatch: ${file.name}`);
  const staged = manifest.backups.map((file) => {
    const temp = path.join(profile, `.${file.name}.restore-${process.pid}`);
    fs.copyFileSync(file.backup, temp);
    fs.chmodSync(temp, 0o600);
    return { ...file, temp };
  });
  write(manifestFile, { ...manifest, restoreState: "prepared", restoreTargets: staged.map((file) => file.name), restoreCompleted: [] });
  const restored = [];
  for (const file of staged) {
    const target = path.join(profile, file.name);
    fs.rmSync(target + "-wal", { force: true });
    fs.rmSync(target + "-shm", { force: true });
    fs.renameSync(file.temp, target);
    restored.push(file.name);
    write(manifestFile, { ...manifest, restoreState: "prepared", restoreTargets: staged.map((file) => file.name), restoreCompleted: restored });
  }
  write(manifestFile, { ...manifest, restoreState: "complete", restoredAt: new Date().toISOString() });
  console.log(JSON.stringify({ restored: true, databaseCount: staged.length }));
}

async function main() {
  if (!["dry-run", "apply", "verify", "restore"].includes(mode) || !option("--profile")) {
    throw new Error("Usage: node scripts/migrate-film-set-shooting-shots.mjs dry-run|apply|verify|restore --profile <.local> --manifest <private-json> [--quiesced]");
  }
  const profile = fs.realpathSync(option("--profile"));
  const manifestFile = path.resolve(option("--manifest") ?? path.join(profile, "film-set-shooting-shots/manifest.json"));
  if (mode === "restore") return restore(profile, manifestFile);
  for (const name of filenames) if (!fs.existsSync(path.join(profile, name))) throw new Error(`Profile database missing: ${name}`);
  const converter = await loadConverter();
  const saved = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : null;
  if (saved?.restoreState === "prepared") throw new Error("Interrupted restore must be resumed with restore before any migration command");
  if (saved && saved.profile !== profile) throw new Error("Migration manifest belongs to another profile");
  if (mode === "apply") requireQuiesced(profile);
  const db = new DatabaseSync(path.join(profile, filenames[0]), { readOnly: mode !== "apply" });
  let plan;
  try {
    plan = converter.planMigration(db);
  } catch (error) { db.close(); throw error; }
  const planHash = hash({ report: plan.report, documents: plan.documents.map((document) => ({ id: document.canvas.id, beforeHash: document.beforeHash, afterHash: document.afterHash, changed: document.changed })),
    history: plan.historyWrites.map((write) => ({ identity: [write.row.canvas_id, write.row.node_id, write.row.entry_id], changed: write.changed })),
    completions: plan.completionWrites.map((write) => ({ identity: [write.row.canvas_id, write.row.node_id, write.row.request_id], changed: write.changed })) });
  const publicReport = { ...plan.report, planHash };

  if (mode === "dry-run") {
    db.close();
    write(manifestFile, { version: MANIFEST_VERSION, profile, state: "planned", planHash, report: publicReport, plannedAt: new Date().toISOString() });
    console.log(JSON.stringify({ mode, manifest: manifestFile, changed: plan.changed, canvasCount: plan.documents.length, historyCount: plan.historyWrites.length, completionCount: plan.completionWrites.length }));
    return;
  }
  if (mode === "verify") {
    db.close();
    if (plan.changed) throw new Error("Verification found records still requiring migration");
    write(manifestFile + ".verify.json", { verifiedAt: new Date().toISOString(), report: publicReport });
    console.log(JSON.stringify({ mode, verified: true, canvasCount: plan.documents.length, historyCount: plan.historyWrites.length }));
    return;
  }
  if (saved?.state === "applied" && !plan.changed) {
    db.close();
    console.log(JSON.stringify({ mode, applied: true, changed: false, manifest: manifestFile }));
    return;
  }
  if (!saved || saved.state !== "planned" || saved.planHash !== planHash) {
    db.close();
    throw new Error("apply requires a matching final dry-run manifest; source state changed or no plan exists");
  }
  const backupDir = path.join(path.dirname(manifestFile), `backup-${Date.now()}`);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backups = [];
  for (const name of filenames) {
    const source = name === filenames[0] ? db : new DatabaseSync(path.join(profile, name), { readOnly: true });
    const target = path.join(backupDir, name);
    try { await backup(source, target); } finally { if (source !== db) source.close(); }
    fs.chmodSync(target, 0o600);
    backups.push({ name, backup: target, sha256: hashFile(target) });
  }
  const manifest = { ...saved, backups, state: "backed-up", backedUpAt: new Date().toISOString() };
  write(manifestFile, manifest);
  // 离线 rollback journal：SQLite 在 attached 文件上提供单一原子事务。
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
  const aliases = [
    { name: filenames[1], alias: "tasks" },
    { name: filenames[2], alias: "application" }
  ];
  for (const { name, alias } of aliases) {
    db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(path.join(profile, name));
    db.exec(`PRAGMA ${alias}.journal_mode=DELETE; PRAGMA ${alias}.synchronous=FULL`);
  }
  db.exec("BEGIN EXCLUSIVE");
  try {
    // 备份后源必须逐字节一致：否则拒绝并回滚。
    const current = db.prepare("SELECT canvas_id,revision,room_epoch,snapshot,projection_json FROM canvas_yjs_documents ORDER BY canvas_id").all();
    const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
    for (const document of plan.documents) {
      const row = current.find((entry) => entry.canvas_id === document.canvas.id);
      if (!row || row.revision !== document.canvas.revision || row.room_epoch !== document.sourceReport.roomEpoch) throw new Error("Canvas source changed after backup");
      if (sha(row.snapshot) !== document.sourceReport.checkpointSha256 || sha(row.projection_json) !== document.sourceReport.projectionSha256) throw new Error("Canvas checkpoint or projection changed after backup");
      const updates = db.prepare("SELECT seq,sha256 FROM canvas_yjs_updates WHERE canvas_id=? ORDER BY seq").all(document.canvas.id);
      if (sha(JSON.stringify(updates.map((update) => [update.seq, update.sha256]))) !== document.sourceReport.updatesSha256) throw new Error("Canvas update log changed after backup");
    }
    converter.applyMigration(db, plan);
    if (tables(db).includes("canvas_writer_lock")) db.exec("DELETE FROM canvas_writer_lock");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    write(manifestFile, { ...manifest, state: "rolled-back" });
    throw error;
  } finally { db.close(); }
  write(manifestFile, { ...manifest, state: "applied", appliedAt: new Date().toISOString(), report: publicReport });
  console.log(JSON.stringify({ mode, applied: true, manifest: manifestFile, databaseCount: backups.length }));
}

main().catch((error) => { console.error(process.env.WOOHAA3_MIGRATION_DEBUG ? error.stack : error.message); process.exitCode = 1; });
