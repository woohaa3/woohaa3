/** One-time offline profile cutover. No production compatibility reader is installed. */
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
const args = process.argv.slice(2), mode = args.shift();
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const repeated = name => args.flatMap((arg, index) => arg === name ? [args[index + 1]] : []);
const flag = name => args.includes(name);
const hashFile = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); fs.chmodSync(file, 0o600); };
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const filenames = ["canvas-dev.sqlite", "task-dev.sqlite", "application-dev.sqlite"];
function openedByOthers(profile) {
  const files = new Set(filenames.flatMap(name => [path.join(profile, name), path.join(profile, name) + "-wal", path.join(profile, name) + "-shm"]));
  if (process.platform === "darwin") {
    const result = spawnSync("lsof", ["-t", "--", ...files], { encoding: "utf8" });
    if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error("Cannot verify profile writers: lsof failed");
    return [...new Set(result.stdout.trim().split(/\s+/).filter(value => /^\d+$/.test(value)).map(Number))].filter(pid => pid !== process.pid);
  }
  if (process.platform !== "linux") throw new Error("Offline profile migration writer detection supports macOS and Linux; use one of those platforms to apply or restore");
  const pids = [];
  for (const pid of fs.readdirSync("/proc").filter(pid => /^\d+$/.test(pid) && Number(pid) !== process.pid)) {
    try { if (fs.readdirSync(`/proc/${pid}/fd`).some(fd => { try { return files.has(fs.readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { return false; } })) pids.push(Number(pid)); } catch { /* process exited */ }
  }
  return pids;
}
function requireQuiesced(profile) {
  if (!flag("--quiesced")) throw new Error("apply/restore require --quiesced after stopping profile writers");
  const pids = openedByOthers(profile);
  if (pids.length) throw new Error(`Profile database handles remain open in processes: ${pids.join(",")}`);
}
function tables(db) { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name); }
function typedReferences(value, context, path = "$", writes = []) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((child, index) => typedReferences(child, context, `${path}[${index}]`, writes));
  const out = { ...value };
  for (const [key, child] of Object.entries(value)) {
    if (child === "animation3d" || child === "extension3d") {
      if (["nodeType", "sourceNodeType", "targetNodeType"].includes(key) || (key === "type" && value.position && value.id)) {
        if (child === "extension3d") throw new Error(`Unknown old extension owner at ${context}:${path}.${key}`);
        out[key] = "composite-asset";
        if (key === "nodeType" && child === "animation3d") out.extensionId = "film-set";
        if (key === "type" && value.nodeData) throw new Error(`Embedded old full node snapshot requires an explicit payload adapter at ${context}:${path}`);
        writes.push(`${path}.${key}`);
      } else if (key === "mode" || key === "authoringMode") {
        if (child !== "animation3d") throw new Error(`Unknown old authoring mode at ${context}:${path}.${key}`);
        out[key] = "film-set"; writes.push(`${path}.${key}`);
      } else if (["kind", "targetType", "nodeKind"].includes(key)) throw new Error(`Unsupported typed old identity at ${context}:${path}.${key}`);
      // IDs, source, prompt and other free text are never globally replaced.
    } else out[key] = typedReferences(child, context, `${path}.${key}`, writes);
  }
  return out;
}
function planRelatedDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const updates = [];
  try {
    const knownTables = new Set(tables(db));
    const gates = [
      ["task_records", "status", ["completed", "failed", "cancelled"]],
      ["task_execution_records", "state", ["succeeded", "failed", "cancelled"]],
      ["extension_work_references", "state", ["succeeded", "failed", "cancelled"]],
      ["extension_task_intents", "state", ["settled", "failed"]]
    ];
    for (const [table, column, terminal] of gates) if (knownTables.has(table)) {
      const count = db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)} WHERE ${quote(column)} NOT IN (${terminal.map(() => "?").join(",")})`).get(...terminal).count;
      if (count > 0) throw new Error(`Active work requires draining: ${table} (${count} records)`);
    }
    for (const table of knownTables) {
      const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all();
      const primary = columns.filter(column => column.pk).sort((a,b) => a.pk-b.pk).map(column => column.name);
      const jsonColumns = columns.filter(column => /(?:_json|payload|definition|snapshot)$/.test(column.name)).map(column => column.name);
      if (!jsonColumns.length) continue;
      for (const row of db.prepare(`SELECT * FROM ${quote(table)}`).all()) {
        for (const column of jsonColumns) {
          if (typeof row[column] !== "string" || !/^[\s]*[\[{]/.test(row[column])) continue;
          let input; try { input = JSON.parse(row[column]); } catch { throw new Error(`Invalid JSON at ${path.basename(file)}:${table}.${column}`); }
          const locations = [], output = typedReferences(input, `${path.basename(file)}:${table}.${column}`, "$", locations);
          if (!locations.length) continue;
          if (!primary.length) throw new Error(`Cannot safely address typed row without primary key: ${table}`);
          const activeStatuses = new Set(["queued", "submitting", "pending", "processing", "running"]);
          const active = value => value && typeof value === "object" && (Object.entries(value).some(([key, child]) => ["status", "taskStatus", "state"].includes(key) && activeStatuses.has(child)) || Object.values(value).some(child => active(child)));
          if (active(input) || ["status", "task_status", "state"].some(key => activeStatuses.has(row[key]))) throw new Error(`Active typed work requires draining: ${table}`);
          updates.push({ table, column, primary, identity: primary.map(key => row[key]), before: row[column], after: JSON.stringify(output), locations });
        }
      }
    }
  } finally { db.close(); }
  return updates;
}
function inventoryResources(saved) {
  const argumentsByKey = new Map(repeated("--resource-file").map(argument => {
    const at = argument.indexOf("=");
    if (at < 1) throw new Error("--resource-file requires storageKey=/absolute/path");
    return [argument.slice(0, at), argument.slice(at + 1)];
  }));
  for (const entry of saved?.resources ?? []) if (!argumentsByKey.has(entry.storageKey)) argumentsByKey.set(entry.storageKey, entry.file);
  return [...argumentsByKey].map(([storageKey, source]) => {
    const file = fs.realpathSync(source), sha256 = hashFile(file), bytes = fs.readFileSync(file);
    if (storageKey !== `sha256-${sha256}`) throw new Error("Immutable resource storage key/checksum mismatch");
    let document; try { document = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Project resource must be valid JSON"); }
    const locations = []; typedReferences(document, "immutable-project-resource", "$", locations);
    if (locations.length) throw new Error("Immutable project resource needs a dedicated typed payload adapter before migration");
    return { storageKey, file, sha256, bytes: bytes.length };
  }).sort((left, right) => left.storageKey.localeCompare(right.storageKey));
}
async function loadConverter() {
  const { build } = require("esbuild");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "composite-asset-migration-"));
  const outfile = path.join(temporary, "converter.mjs");
  await build({ entryPoints: [path.join(root, "scripts/lib/model-native-migration.ts")], outfile, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent", nodePaths: [path.join(root, "web/node_modules"), path.join(root, "web/contracts/node_modules")], alias: { "@woohaa3/contracts/canvas-yjs": path.join(root, "web/contracts/src/canvas/yjs/index.ts"), "@woohaa3/contracts": path.join(root, "web/contracts/src/index.ts") }, banner: { js: "import { createRequire as __migrationCreateRequire } from 'node:module'; const require = __migrationCreateRequire(import.meta.url);" } });
  try { return await import(pathToFileURL(outfile).href); } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
async function restore(profile, manifestFile) {
  requireQuiesced(profile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.profile !== profile || manifest.version !== "composite-asset-profile-cutover-v1") throw new Error("Backup manifest profile/version mismatch");
  if (!Array.isArray(manifest.backups) || manifest.backups.length !== filenames.length || new Set(manifest.backups.map(file => file.name)).size !== filenames.length || manifest.backups.some(file => !filenames.includes(file.name))) throw new Error("Restore requires exactly all three profile database backups");
  // Verify ALL backups before touching ANY target.
  for (const file of manifest.backups) if (hashFile(file.backup) !== file.sha256) throw new Error(`Backup checksum mismatch: ${file.name}`);
  const staged = manifest.backups.map(file => { const temp = path.join(profile, `.${file.name}.restore-${process.pid}`); fs.copyFileSync(file.backup, temp); fs.chmodSync(temp, 0o600); return { ...file, temp }; });
  write(manifestFile, { ...manifest, restoreState: "prepared", restoreTargets: staged.map(file => file.name), restoreCompleted: [] });
  const restored = [];
  for (const file of staged) {
    const target = path.join(profile, file.name);
    fs.rmSync(target + "-wal", { force: true }); fs.rmSync(target + "-shm", { force: true });
    fs.renameSync(file.temp, target);
    restored.push(file.name);
    write(manifestFile, { ...manifest, restoreState: "prepared", restoreTargets: staged.map(file => file.name), restoreCompleted: restored });
  }
  write(manifestFile, { ...manifest, restoreState: "complete", restoredAt: new Date().toISOString() });
  console.log(JSON.stringify({ restored: true, databaseCount: staged.length }));
}
async function main() {
  if (!["dry-run", "apply", "verify", "restore"].includes(mode) || !option("--profile")) throw new Error("Usage: node scripts/migrate-model-native-nodes.mjs dry-run|apply|verify|restore --profile <.local> --manifest <private-json> [--quiesced] [--remove-edge <id>]");
  const profile = fs.realpathSync(option("--profile"));
  const manifestFile = path.resolve(option("--manifest") ?? path.join(profile, "model-native-migration/manifest.json"));
  if (mode === "restore") return restore(profile, manifestFile);
  for (const name of filenames) if (!fs.existsSync(path.join(profile, name))) throw new Error(`Profile database missing: ${name}`);
  const converter = await loadConverter();
  const saved = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : null;
  if (saved?.restoreState === "prepared") throw new Error("Interrupted restore must be resumed with restore before any migration command");
  if (saved && saved.profile !== profile) throw new Error("Migration manifest belongs to another profile");
  if (mode === "apply") requireQuiesced(profile);
  const db = new DatabaseSync(path.join(profile, filenames[0]), { readOnly: mode !== "apply" });
  let plan;
  try { plan = converter.planMigration(db, { previousMappings: saved?.mappings, removeEdgeIds: repeated("--remove-edge") }); }
  catch (error) { db.close(); throw error; }
  const resources = inventoryResources(saved);
  const related = filenames.slice(1).map(name => ({ name, updates: planRelatedDatabase(path.join(profile, name)) }));
  const planHash = hash({ report: plan.report, resources, related: related.map(({ name, updates }) => ({ name, updates: updates.map(update => ({ table: update.table, column: update.column, identity: update.identity, before: hash(update.before), after: hash(update.after) })) })) });
  const publicReport = { ...plan.report, relatedDatabaseChanges: related.map(({ name, updates }) => ({ name, changedRows: updates.length })), planHash };
  if (mode === "dry-run") {
    db.close();
    write(manifestFile, { version: "composite-asset-profile-cutover-v1", profile, state: "planned", mappings: plan.mappings, resources, planHash, report: publicReport, plannedAt: new Date().toISOString() });
    console.log(JSON.stringify({ mode, manifest: manifestFile, changed: plan.changed || related.some(item => item.updates.length), canvasCount: plan.documents.length, historyCount: plan.historyWrites.length })); return;
  }
  if (mode === "verify") {
    db.close();
    if (plan.changed || related.some(item => item.updates.length)) throw new Error("Verification found records still requiring migration");
    write(manifestFile + ".verify.json", { verifiedAt: new Date().toISOString(), report: publicReport });
    console.log(JSON.stringify({ mode, verified: true, canvasCount: plan.documents.length, historyCount: plan.historyWrites.length })); return;
  }
  if (saved?.state === "applied" && !plan.changed && !related.some(item => item.updates.length)) {
    db.close();
    console.log(JSON.stringify({ mode, applied: true, changed: false, manifest: manifestFile })); return;
  }
  if (!saved || saved.state !== "planned" || saved.planHash !== planHash) { db.close(); throw new Error("apply requires a matching final dry-run manifest; source state changed or no plan exists"); }
  const backupDir = path.join(path.dirname(manifestFile), `backup-${Date.now()}`);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backups = [];
  for (const name of filenames) {
    const source = name === filenames[0] ? db : new DatabaseSync(path.join(profile, name), { readOnly: true });
    const target = path.join(backupDir, name);
    try { await backup(source, target); } finally { if (source !== db) source.close(); }
    fs.chmodSync(target, 0o600); backups.push({ name, backup: target, sha256: hashFile(target) });
  }
  const manifest = { ...saved, backups, state: "backed-up", backedUpAt: new Date().toISOString() };
  write(manifestFile, manifest);
  // Offline rollback-journal mode gives SQLite one atomic transaction across attached files.
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
  for (const { name } of related) {
    const alias = name.startsWith("task") ? "tasks" : "application";
    db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(path.join(profile, name));
    db.exec(`PRAGMA ${alias}.journal_mode=DELETE; PRAGMA ${alias}.synchronous=FULL`);
  }
  db.exec("BEGIN EXCLUSIVE");
  try {
    const current = db.prepare("SELECT canvas_id, revision,room_epoch,snapshot,projection_json FROM canvas_yjs_documents ORDER BY canvas_id").all();
    for (const document of plan.documents) {
      const row = current.find(row => row.canvas_id === document.canvas.id);
      if (!row || row.revision !== document.canvas.revision || row.room_epoch !== document.sourceReport.roomEpoch) throw new Error("Canvas source changed after backup");
      const sha = bytes => createHash("sha256").update(bytes).digest("hex");
      const updates = db.prepare("SELECT seq,sha256 FROM canvas_yjs_updates WHERE canvas_id=? ORDER BY seq").all(document.canvas.id);
      if (sha(row.snapshot) !== document.sourceReport.checkpointSha256 || sha(row.projection_json) !== document.sourceReport.projectionSha256 || sha(JSON.stringify(updates.map(update => [update.seq, update.sha256]))) !== document.sourceReport.updatesSha256) throw new Error("Canvas checkpoint or update log changed after backup");
    }
    for (const resource of resources) if (hashFile(resource.file) !== resource.sha256) throw new Error("Immutable project resource changed after backup");
    converter.applyMigration(db, plan);
    for (const { name, updates } of related) {
      const alias = name.startsWith("task") ? "tasks" : "application";
      for (const update of updates) {
        const result = db.prepare(`UPDATE ${alias}.${quote(update.table)} SET ${quote(update.column)}=? WHERE ${update.primary.map(key => quote(key) + "=?").join(" AND ")} AND ${quote(update.column)}=?`).run(update.after, ...update.identity, update.before);
        if (result.changes !== 1) throw new Error(`Related row changed: ${name}:${update.table}.${update.column}`);
      }
    }
    // No process owns the profile now; remove its stale deployment lock only at commit.
    if (tables(db).includes("canvas_writer_lock")) db.exec("DELETE FROM canvas_writer_lock");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); write(manifestFile, { ...manifest, state: "rolled-back" }); throw error; }
  finally { db.close(); }
  write(manifestFile, { ...manifest, state: "applied", appliedAt: new Date().toISOString(), report: publicReport });
  console.log(JSON.stringify({ mode, applied: true, manifest: manifestFile, databaseCount: backups.length }));
}
main().catch(error => { console.error(process.env.WOOHAA3_MIGRATION_DEBUG ? error.stack : error.message); process.exitCode = 1; });
