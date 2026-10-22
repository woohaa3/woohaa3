import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const cli = fileURLToPath(new URL("./migrate-model-native-nodes.mjs", import.meta.url));
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "composite-cutover-test-"));
  for (const name of ["canvas-dev.sqlite", "task-dev.sqlite", "application-dev.sqlite"]) {
    const db = new DatabaseSync(path.join(profile, name));
    if (name.startsWith("canvas")) db.exec("CREATE TABLE canvas_yjs_documents(canvas_id TEXT PRIMARY KEY,format_version TEXT,room_epoch TEXT,snapshot BLOB,snapshot_seq INTEGER,revision INTEGER,projection_json TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE canvas_yjs_updates(canvas_id TEXT,seq INTEGER,sha256 TEXT,update_bytes BLOB)");
    else if (name.startsWith("task")) {
      db.exec("CREATE TABLE task_records(key TEXT PRIMARY KEY,status TEXT,params_json TEXT)");
      db.prepare("INSERT INTO task_records VALUES(?,?,?)").run("saved-task", "completed", JSON.stringify({ nodeType: "animation3d", prompt: "keep literal animation3d", referenceId: "animation3d" }));
    } else db.exec("CREATE TABLE extension_site_config(extension_id TEXT PRIMARY KEY,values_json TEXT)");
    db.close();
  }
  return { profile, manifest: path.join(profile, "private/manifest.json"), cleanup: () => fs.rmSync(profile, { recursive: true, force: true }) };
}
function run(f, mode, ...extra) {
  return spawnSync(process.execPath, [cli, mode, "--profile", f.profile, "--manifest", f.manifest, ...extra], { encoding: "utf8", timeout: 60_000 });
}
function success(result) { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim()); }
test("profile cutover converts only typed references, backs up all databases, repeats without writes and restores", () => {
  const f = fixture();
  try {
    success(run(f, "dry-run"));
    assert.equal(fs.statSync(f.manifest).mode & 0o777, 0o600);
    const applied = success(run(f, "apply", "--quiesced"));
    assert.equal(applied.databaseCount, 3);
    const db = new DatabaseSync(path.join(f.profile, "task-dev.sqlite"), { readOnly: true });
    const value = JSON.parse(db.prepare("SELECT params_json FROM task_records").get().params_json); db.close();
    assert.equal(value.nodeType, "composite-asset"); assert.equal(value.extensionId, "film-set");
    assert.equal(value.prompt, "keep literal animation3d"); assert.equal(value.referenceId, "animation3d");
    const manifest = JSON.parse(fs.readFileSync(f.manifest, "utf8"));
    const beforeRepeat = ["canvas-dev.sqlite", "task-dev.sqlite", "application-dev.sqlite"].map(name => digest(path.join(f.profile, name)));
    assert.equal(success(run(f, "apply", "--quiesced")).changed, false);
    success(run(f, "verify"));
    assert.deepEqual(["canvas-dev.sqlite", "task-dev.sqlite", "application-dev.sqlite"].map(name => digest(path.join(f.profile, name))), beforeRepeat);
    success(run(f, "restore", "--quiesced"));
    for (const backup of manifest.backups) assert.equal(digest(path.join(f.profile, backup.name)), backup.sha256);
  } finally { f.cleanup(); }
});
test("a bad backup checksum rejects restore before touching any database", () => {
  const f = fixture();
  try {
    success(run(f, "dry-run")); success(run(f, "apply", "--quiesced"));
    const manifest = JSON.parse(fs.readFileSync(f.manifest, "utf8"));
    const before = manifest.backups.map(file => digest(path.join(f.profile, file.name)));
    fs.appendFileSync(manifest.backups[2].backup, Buffer.from([0]));
    const result = run(f, "restore", "--quiesced");
    assert.notEqual(result.status, 0); assert.match(result.stderr, /checksum mismatch/);
    assert.deepEqual(manifest.backups.map(file => digest(path.join(f.profile, file.name))), before);
  } finally { f.cleanup(); }
});
test("active persisted tasks block planning, while completed provenance remains", () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(path.join(f.profile, "task-dev.sqlite")); db.exec("UPDATE task_records SET status='running'"); db.close();
    const result = run(f, "dry-run");
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Active work requires draining/);
    assert.equal(fs.existsSync(f.manifest), false);
  } finally { f.cleanup(); }
});
