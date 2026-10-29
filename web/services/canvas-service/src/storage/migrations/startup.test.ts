import { readFilmSetAnimationProjection } from "@woohaa3/contracts";
import { filmSetTestMigrations } from "../../../../../test-support/managed-shot-commands.js";
const migrateSqliteCanvasBeforeStartup = (filename: string) => migrateBeforeStartup(filename, { managedMigrations: filmSetTestMigrations });
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { createFilmSetSnapshot, canonicalFilmSetFields, createMotionSnapshot, createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { serverCanvasToYDoc, yDocToServerCanvas } from "@woohaa3/contracts/canvas-yjs";
import { loadNodeSqlite } from "../sqlite/sqlite-loader.js";
import { migrateSqliteCanvasBeforeStartup as migrateBeforeStartup } from "./startup.js";
import { createCanvasService } from "../../composition.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-auto-migration-"));
  directories.push(directory);
  const filename = path.join(directory, "custom-canvas.sqlite");
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE canvas_yjs_documents(canvas_id TEXT PRIMARY KEY,format_version TEXT,room_epoch TEXT,snapshot BLOB,snapshot_seq INTEGER,revision INTEGER,projection_json TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE canvas_yjs_updates(canvas_id TEXT,seq INTEGER,sha256 TEXT,update_bytes BLOB);
    CREATE TABLE canvas_writer_lock(id INTEGER PRIMARY KEY,holder TEXT,since TEXT);`);
  const now = "2026-10-17T00:00:00.000Z";
  const canvas = createEmptyWoohaa3ServerCanvas("test", now);
  canvas.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 100, y: 60 }, width: 320, height: 240 });
  const base = createFilmSetSnapshot({ title: "片场", model: { modelScript: 'scene.box({id:"body"});', modelScriptVersion: "woohaa-model-js-v2" }, timeline: { duration: 0, loop: false } });
  canvas.nodeData.film = canonicalFilmSetFields({ ...base, filmSetAnimations: { schemaVersion: 2, defaultClipId: "clip", clips: [{
    id: "clip", name: "动作", timeline: { duration: 4, loop: false }, initialCamera: base.sceneCamera,
    cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }), bindings: []
  }] } } as unknown as typeof base) as typeof canvas.nodeData[string];
  const doc = serverCanvasToYDoc(canvas);
  const decoded = yDocToServerCanvas(doc, { now });
  if (!decoded.ok) throw new Error(decoded.failure.message);
  db.prepare("INSERT INTO canvas_yjs_documents VALUES(?,?,?,?,?,?,?,?,?)").run("test", "woohaa3-ycanvas-v2", "epoch", Y.encodeStateAsUpdate(doc), 0, canvas.revision, JSON.stringify(decoded.canvas), now, now);
  doc.destroy();
  // A committed no-op in WAL must also survive in the pre-migration backup.
  db.exec("PRAGMA journal_mode=WAL");
  db.prepare("INSERT INTO canvas_yjs_updates VALUES(?,?,?,?)").run("test", 1, createHash("sha256").update(new Uint8Array()).digest("hex"), new Uint8Array());
  return { db, filename, directory };
}

it("backs up committed WAL, converts previews and animation, then skips repeat startup", () => {
  const { db, filename } = fixture();
  try {
    const result = migrateSqliteCanvasBeforeStartup(filename);
    expect(result.changed).toBe(true);
    const row = db.prepare("SELECT * FROM canvas_yjs_documents").get()!;
    const canvas = JSON.parse(String(row.projection_json));
    expect(canvas.nodeData.film.filmSetGroup.schemaVersion).toBe(1);
    expect(readFilmSetAnimationProjection(canvas, "film")!.filmSetAnimations!.clips[0]!.kind).toBe("dynamic");
    expect(canvas.document.nodes.filter((node: { type: string }) => node.type === "video")).toHaveLength(1);
    expect(row.room_epoch).not.toBe("epoch");
    const { DatabaseSync } = loadNodeSqlite();
    const backup = new DatabaseSync(result.backup!, { readOnly: true });
    try {
      const original = JSON.parse(String(backup.prepare("SELECT projection_json FROM canvas_yjs_documents").get()!.projection_json));
      expect(original.nodeData.film.filmSetAnimations.schemaVersion).toBe(2);
      expect(backup.prepare("SELECT * FROM canvas_yjs_updates").all()).toHaveLength(1);
    } finally { backup.close(); }
    expect(fs.statSync(result.backup!).mode & 0o777).toBe(0o600);
    expect(migrateSqliteCanvasBeforeStartup(filename)).toEqual({ changed: false });
    expect(db.prepare("SELECT room_epoch FROM canvas_yjs_documents").get()!.room_epoch).toBe(row.room_epoch);
  } finally { db.close(); }
});

it("refuses a live writer without changing data or making a backup", () => {
  const { db, filename, directory } = fixture();
  try {
    db.prepare("INSERT INTO canvas_writer_lock VALUES(1,?,?)").run(`${os.hostname()}:${process.pid}`, new Date().toISOString());
    expect(() => migrateSqliteCanvasBeforeStartup(filename)).toThrow(/仍被运行中的实例占用/);
    expect(db.prepare("SELECT room_epoch FROM canvas_yjs_documents").get()!.room_epoch).toBe("epoch");
    expect(fs.existsSync(path.join(directory, "canvas-migrations"))).toBe(false);
  } finally { db.close(); }
});

it("rolls back the checkpoint when a later write fails and retains the backup", () => {
  const { db, filename, directory } = fixture();
  try {
    db.exec("CREATE TRIGGER refuse_tail_delete BEFORE DELETE ON canvas_yjs_updates BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    expect(() => migrateSqliteCanvasBeforeStartup(filename)).toThrow(/injected failure/);
    expect(db.prepare("SELECT room_epoch FROM canvas_yjs_documents").get()!.room_epoch).toBe("epoch");
    expect(db.prepare("SELECT * FROM canvas_yjs_updates").all()).toHaveLength(1);
    const backups = path.join(directory, "canvas-migrations");
    const manifest = JSON.parse(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0]!, "manifest.json"), "utf8"));
    expect(manifest.state).toBe("rolled-back");
    expect(fs.existsSync(manifest.backup)).toBe(true);
  } finally { db.close(); }
});

it("skips new and in-memory databases", () => {
  expect(migrateSqliteCanvasBeforeStartup(":memory:")).toEqual({ changed: false });
  expect(migrateSqliteCanvasBeforeStartup("/does-not-exist/canvas.sqlite")).toEqual({ changed: false });
});

it("normal service startup migrates before exposing the canvas service", async () => {
  const { db, filename } = fixture();
  db.close();
  const service = await createCanvasService({
    env: { WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite", WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: filename },
    contentRuntime: { managedMigrations: filmSetTestMigrations },
    enableYjsSync: false,
    enableModelMcp: false,
    enablePromptSnippets: false,
    enableNodeHistory: false
  });
  try {
    const { DatabaseSync } = loadNodeSqlite();
    const reader = new DatabaseSync(filename, { readOnly: true });
    try {
      const canvas = JSON.parse(String(reader.prepare("SELECT projection_json FROM canvas_yjs_documents").get()!.projection_json));
      expect(canvas.nodeData.film.filmSetGroup.schemaVersion).toBe(1);
    } finally { reader.close(); }
  } finally { await service.close(); }
});

it("normal service startup rejects migration failure instead of serving degraded old data", async () => {
  const { db, filename } = fixture();
  db.prepare("INSERT INTO canvas_writer_lock VALUES(1,?,?)").run(`${os.hostname()}:${process.pid}`, new Date().toISOString());
  db.close();
  await expect(createCanvasService({ env: { WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite", WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: filename } })).rejects.toThrow(/片场数据自动升级失败/);
});

it("missing migration extension fails before backup or writes and keeps the original recoverable", () => {
  const { db, filename, directory } = fixture();
  try {
    const original = db.prepare("SELECT * FROM canvas_yjs_documents").get();
    expect(() => migrateBeforeStartup(filename)).toThrow("managed-media-migration-unavailable: test");
    expect(db.prepare("SELECT * FROM canvas_yjs_documents").get()).toEqual(original);
    expect(db.prepare("SELECT * FROM canvas_yjs_updates").all()).toHaveLength(1);
    expect(fs.existsSync(path.join(directory, "canvas-migrations"))).toBe(false);
  } finally { db.close(); }
});
