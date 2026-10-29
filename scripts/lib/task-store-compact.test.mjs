/**
 * task_records 存量瘦身：库层行为（不启动宿主）。
 *
 * 钉住四条：
 * 1. 只清终态 + 超过阈值的行，非终态与小行原样；
 * 2. succeeded 必须能对上 history 的 storageKey，否则跳过（字节可能是唯一副本）；
 * 3. 清理后 result 只剩 { media }，state.record.result 不再有 images；
 * 4. apply + vacuum 后文件确实变小。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyCompaction,
  fileSizes,
  mediaRefFromHistory,
  openTaskStore,
  planCompaction,
  summarize,
  vacuum
} from "./task-store-compact.mjs";

const KEY = "run-029817c0-a6d5-469e-b066-4a0a51343563";
const STORAGE_KEY = `generation-outputs/${"a".repeat(64)}.png`;

function tempDb(name = "task.sqlite") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-compact-"));
  return path.join(dir, name);
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE task_records (
      key TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      params_json TEXT,
      context_json TEXT,
      state_json TEXT,
      result_json TEXT,
      owner_id TEXT,
      status TEXT NOT NULL,
      claim_token TEXT,
      lease_until INTEGER,
      next_run_at INTEGER,
      attempt INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE task_execution_records (
      task_key TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL
    );
  `);
}

/** 造一份「provider 字节被 JSON 展开」的 result：{"images":[{"0":137,...}]}。 */
function bytePayload(entries = 4096) {
  const pixels = {};
  for (let index = 0; index < entries; index += 1) pixels[String(index)] = index % 256;
  return { images: [pixels] };
}

function insertTask(db, key, { status, state, result, created = 1000 }) {
  db.prepare(
    `INSERT INTO task_records (key, provider_id, params_json, state_json, result_json, status, created_at, updated_at)
     VALUES (?, 'tokenhub', '{"modelType":"image"}', ?, ?, ?, ?, ?)`
  ).run(key, state === undefined ? null : JSON.stringify(state), result === undefined ? null : JSON.stringify(result), status, created, created);
}

function insertHistory(db, key, { state, result }) {
  db.prepare(
    `INSERT INTO task_execution_records (task_key, state, result_json, created_at, updated_at, duration_ms)
     VALUES (?, ?, ?, '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z', 0)`
  ).run(key, state, result === undefined ? null : JSON.stringify(result));
}

function mediaResult() {
  return { mediaKind: "image", storageKey: STORAGE_KEY, contentType: "image/png", size: 11, checksum: "a".repeat(64) };
}

test("plan：只挑终态、超阈值、能对上 storageKey 的行", () => {
  const file = tempDb();
  const db = new DatabaseSync(file);
  createSchema(db);

  // 1) 可清理：completed + history succeeded + storageKey
  insertTask(db, KEY, {
    status: "completed",
    state: { jobId: "job-1", record: { id: "job-1", result: bytePayload() } },
    result: bytePayload()
  });
  insertHistory(db, KEY, { state: "succeeded", result: mediaResult() });

  // 2) 失败任务：没有产物，字节直接删
  insertTask(db, "run-failed", { status: "failed", state: { jobId: "job-2", record: { result: bytePayload() } }, result: bytePayload() });
  insertHistory(db, "run-failed", { state: "failed" });

  // 3) succeeded 但 history 没有 storageKey：跳过
  insertTask(db, "run-no-key", { status: "completed", result: bytePayload() });
  insertHistory(db, "run-no-key", { state: "succeeded", result: { mediaKind: "image" } });

  // 4) history 还没终结：跳过
  insertTask(db, "run-unsettled", { status: "completed", result: bytePayload() });
  insertHistory(db, "run-unsettled", { state: "running" });

  // 5) completed 但 history 是 failed（转存失败，字节是唯一副本）：跳过
  insertTask(db, "run-import-failed", { status: "completed", result: bytePayload() });
  insertHistory(db, "run-import-failed", { state: "failed", result: { mediaKind: "image" } });

  // 6) 非终态：不碰
  insertTask(db, "run-running", { status: "executing", result: bytePayload() });

  // 7) 小行：不碰
  insertTask(db, "run-small", { status: "completed", result: { images: [new Uint8Array([1, 2, 3])] } });
  insertHistory(db, "run-small", { state: "succeeded", result: mediaResult() });

  const plan = planCompaction(db, { minBytes: 1024 });
  assert.deepEqual(plan.compactable.map((entry) => entry.key).sort(), [KEY, "run-failed"].sort());
  const main = plan.compactable.find((entry) => entry.key === KEY);
  assert.equal(main.media.storageKey, STORAGE_KEY);
  assert.equal(main.media.contentType, "image/png");
  assert.equal(plan.compactable.find((entry) => entry.key === "run-failed").media, null);
  assert.equal(plan.skipped.length, 3);
  assert.ok(
    plan.skipped.some((entry) => entry.key === "run-import-failed" && entry.reason.includes("唯一副本")),
    "completed + history failed 必须跳过"
  );

  const summary = summarize(plan);
  assert.equal(summary.compactableCount, 2);
  assert.ok(summary.reclaimBytes > 0);

  db.close();
});

test("apply：result 只剩 { media }，state 不再有 images，其它行不动", () => {
  const file = tempDb();
  const db = new DatabaseSync(file);
  createSchema(db);
  insertTask(db, KEY, {
    status: "completed",
    state: { jobId: "job-1", record: { id: "job-1", result: bytePayload() } },
    result: { ...bytePayload(), providerMetadata: { tokenhub: { images: [{ mediaType: "image/png" }] } } }
  });
  insertHistory(db, KEY, { state: "succeeded", result: mediaResult() });
  insertTask(db, "run-running", { status: "executing", result: bytePayload() });

  const plan = planCompaction(db, { minBytes: 1024 });
  const result = applyCompaction(db, plan);
  assert.equal(result.changed.length, 1);
  assert.equal(result.failed.length, 0);

  const row = db.prepare("SELECT state_json, result_json, status FROM task_records WHERE key = ?").get(KEY);
  const resultJson = JSON.parse(row.result_json);
  assert.deepEqual(resultJson.media, {
    storageKey: STORAGE_KEY,
    contentType: "image/png",
    size: 11,
    checksum: "a".repeat(64)
  });
  assert.equal(resultJson.images, undefined);
  assert.deepEqual(resultJson.providerMetadata, { tokenhub: { images: [{ mediaType: "image/png" }] } });

  const state = JSON.parse(row.state_json);
  assert.equal(state.record.result.images, undefined);
  assert.equal(state.record.result.media.storageKey, STORAGE_KEY);
  assert.equal(state.jobId, "job-1");

  // 非终态行原样（仍然带字节）。
  const running = db.prepare("SELECT result_json FROM task_records WHERE key = 'run-running'").get();
  assert.ok(JSON.parse(running.result_json).images);

  db.close();
});

test("failed 行：没有 history storageKey 也能清（只删字节）", () => {
  const file = tempDb();
  const db = new DatabaseSync(file);
  createSchema(db);
  insertTask(db, "run-failed", { status: "failed", result: bytePayload(), state: { jobId: "j", record: { result: bytePayload() } } });
  insertHistory(db, "run-failed", { state: "failed" });

  const plan = planCompaction(db, { minBytes: 1024 });
  applyCompaction(db, plan);

  const row = db.prepare("SELECT state_json, result_json FROM task_records WHERE key = 'run-failed'").get();
  assert.deepEqual(JSON.parse(row.result_json), {});
  assert.equal(JSON.parse(row.state_json).record.result.images, undefined);
  db.close();
});

test("vacuum：清理后文件明显变小", () => {
  const file = tempDb();
  const db = new DatabaseSync(file);
  createSchema(db);
  // 2MB 的伪负载：足够让 vacuum 前后的文件大小可见。
  const big = { images: ["x".repeat(2 * 1024 * 1024)] };
  insertTask(db, KEY, { status: "failed", result: big });
  insertHistory(db, KEY, { state: "failed" });
  db.close();

  const before = fs.statSync(file).size;
  const writable = openTaskStore(file);
  const plan = planCompaction(writable, { minBytes: 1024 });
  applyCompaction(writable, plan);
  vacuum(writable);
  const after = fileSizes(fs, file).database;
  writable.close();

  assert.ok(before > 2 * 1024 * 1024, `清理前应有 2MB 以上，实际 ${before}`);
  assert.ok(after < 1024 * 1024, `VACUUM 后应小于 1MB，实际 ${after}`);
});

test("mediaRefFromHistory：只接受带 storageKey 的安全形状", () => {
  assert.equal(mediaRefFromHistory(null), null);
  assert.equal(mediaRefFromHistory("not json"), null);
  assert.equal(mediaRefFromHistory("{}"), null);
  assert.deepEqual(mediaRefFromHistory(JSON.stringify({ storageKey: "k", size: 1 })), { storageKey: "k", size: 1 });
  assert.deepEqual(mediaRefFromHistory("[]"), null);
});
