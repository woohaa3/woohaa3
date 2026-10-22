import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { loadOfflineYjsCanvasSources, readOfflineYjsCanvasSource } from "./model-native-migration-source.mjs";

const require = createRequire(new URL("../../web/services/canvas-service/package.json", import.meta.url));
const Y = require("yjs");
const timestamp = "2026-10-11T00:00:00.000Z";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

function projection(doc) {
  const meta = doc.getMap("meta").toJSON();
  return {
    id: meta.id, title: meta.title, revision: meta.revision,
    document: {
      schemaVersion: meta.documentSchemaVersion,
      nodes: Object.values(doc.getMap("nodes").toJSON()),
      edges: Object.values(doc.getMap("edges").toJSON()), updatedAt: meta.updatedAt,
    },
    nodeData: doc.getMap("nodeData").toJSON(), assets: Object.values(doc.getMap("assets").toJSON()),
    jobs: Object.values(doc.getMap("jobs").toJSON()), updatedAt: meta.updatedAt,
  };
}

function fixture(options = {}) {
  const doc = new Y.Doc();
  const id = options.id ?? "canvas-a";
  const version = options.version ?? "woohaa3-ycanvas-v1";
  doc.transact(() => {
    const meta = doc.getMap("meta");
    for (const [key, value] of Object.entries({
      formatVersion: version, id, title: "Original animation3d user title", documentSchemaVersion: "asset-canvas-v1",
      revision: 0, createdAt: timestamp, updatedAt: timestamp,
    })) meta.set(key, value);
    doc.getMap("nodes").set("film", { id: "film", type: options.type ?? "animation3d", position: { x: 12, y: 34 }, width: 260, height: 195 });
    doc.getMap("nodes").set("image", { id: "image", type: "image", position: { x: 500, y: 600 } });
    doc.getMap("nodeData").set("film", { title: "用户内容", modelScript: "scene.group({id:'animation3d'});", arbitraryUserText: "extension3d" });
    doc.getMap("nodeData").set("image", { title: "图片", assetId: "asset" });
    doc.getMap("assets").set("asset", { id: "asset", mediaKind: "image", status: "ready", url: "/media/asset", createdAt: timestamp });
    doc.getMap("jobs").set("old-job", { id: "old-job", nodeId: "deleted-node", taskId: "task", status: "success", updatedAt: timestamp });
    if (options.prepare) options.prepare(doc);
  });
  const snapshot = Y.encodeStateAsUpdate(doc);
  const vector = Y.encodeStateVector(doc);
  doc.transact(() => {
    doc.getMap("meta").set("revision", 1);
    doc.getMap("nodes").set("film", { ...doc.getMap("nodes").get("film"), position: { x: 20, y: 40 } });
    if (options.update) options.update(doc);
  });
  const bytes = Y.encodeStateAsUpdate(doc, vector);
  const canvas = projection(doc);
  if (options.project) options.project(canvas);
  const result = {
    document: {
      canvas_id: id, format_version: version, room_epoch: "source-epoch", snapshot,
      snapshot_seq: 4, revision: 1, projection_json: JSON.stringify(canvas), created_at: timestamp, updated_at: timestamp,
    },
    updates: [
      { canvas_id: id, seq: 5, update_bytes: bytes, sha256: sha(bytes), created_at: timestamp },
      // A real no-op command still occupies a sequence row with empty bytes.
      { canvas_id: id, seq: 6, update_bytes: new Uint8Array(), sha256: sha(new Uint8Array()), created_at: timestamp },
    ],
  };
  doc.destroy();
  return result;
}

function rejects(source, code) {
  assert.throws(() => readOfflineYjsCanvasSource(source), error => error.code === code);
}

function appendUpdate(source, run, revision) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, source.document.snapshot);
    for (const update of source.updates) if (update.update_bytes.length) Y.applyUpdate(doc, update.update_bytes);
    const vector = Y.encodeStateVector(doc);
    doc.transact(() => { run(doc); doc.getMap("meta").set("revision", revision); });
    const bytes = Y.encodeStateAsUpdate(doc, vector);
    source.updates.push({ canvas_id: source.document.canvas_id, seq: source.updates.at(-1).seq + 1,
      update_bytes: bytes, sha256: sha(bytes), created_at: timestamp });
    source.document.projection_json = JSON.stringify(projection(doc));
    source.document.revision = revision;
  } finally { doc.destroy(); }
}

test("restores checkpoint plus all updates and no-op sequence without converting user content", () => {
  const source = fixture();
  const saved = structuredClone(source);
  const result = readOfflineYjsCanvasSource(source);
  assert.deepEqual(result.canvas, result.projection);
  assert.deepEqual(result.raw.nodes.find(node => node.id === "film").position, { x: 20, y: 40 });
  assert.equal(result.canvas.document.nodes[0].type, "animation3d");
  assert.equal(result.canvas.nodeData.film.modelScript, "scene.group({id:'animation3d'});");
  assert.equal(result.canvas.nodeData.film.arbitraryUserText, "extension3d");
  assert.deepEqual(result.report.detachedJobIds, ["old-job"]);
  assert.equal(result.report.storageSeq, 6);
  assert.equal(result.report.restoredUpdates, 2);
  assert.deepEqual(source, saved);
  assert.deepEqual(readOfflineYjsCanvasSource(source), result);
});

test("accepts a new-format checkpoint for offline verify without legacy normalization", () => {
  const result = readOfflineYjsCanvasSource(fixture({ version: "woohaa3-ycanvas-v2", type: "composite-asset" }));
  assert.equal(result.report.formatVersion, "woohaa3-ycanvas-v2");
  assert.equal(result.canvas.document.nodes[0].type, "composite-asset");
});

test("records the exact old forbidden edge difference, preserving the raw edge for explicit planning", () => {
  const result = readOfflineYjsCanvasSource(fixture({
    prepare: doc => doc.getMap("edges").set("old-edge", { id: "old-edge", source: "image", target: "film", data: {} }),
    project: canvas => { canvas.document.edges = []; },
  }));
  assert.deepEqual(result.report.requiresExplicitEdgeRemoval, ["old-edge"]);
  assert.equal(result.raw.edges.length, 1);
  assert.equal(result.canvas.document.edges.length, 1);
  assert.equal(result.projection.document.edges.length, 0);
});

test("does not excuse missing ordinary edges as old category normalization", () => {
  rejects(fixture({
    type: "model3d",
    prepare: doc => doc.getMap("edges").set("edge", { id: "edge", source: "image", target: "film", data: {} }),
    project: canvas => { canvas.document.edges = []; },
  }), "projection-mismatch");
});

test("does not apply old edge normalization to new-format documents", () => {
  rejects(fixture({
    version: "woohaa3-ycanvas-v2",
    prepare: doc => doc.getMap("edges").set("edge", { id: "edge", source: "image", target: "film", data: {} }),
    project: canvas => { canvas.document.edges = []; },
  }), "projection-mismatch");
});

test("rejects checksum mismatch, including an empty persisted no-op", () => {
  const source = fixture(); source.updates[1].sha256 = "0".repeat(64);
  rejects(source, "update-checksum");
});

test("rejects missing, duplicate, reversed and checkpoint-covered update sequences", () => {
  for (const transform of [
    updates => { updates.shift(); },
    updates => { updates[1].seq = updates[0].seq; },
    updates => { updates.reverse(); },
    updates => { updates[0].seq = 4; },
    updates => { updates[0].seq = 5.5; },
  ]) {
    const source = fixture(); transform(source.updates); rejects(source, "update-sequence");
  }
});

test("rejects an update belonging to another canvas", () => {
  const source = fixture(); source.updates[0].canvas_id = "other";
  rejects(source, "update-sequence");
});

test("rejects corrupt checkpoint bytes instead of falling back to projection", () => {
  const source = fixture(); source.document.snapshot = Uint8Array.of(255);
  rejects(source, "corrupt-yjs-bytes");
});

test("rejects unresolved Yjs dependencies even with plausible projection metadata", () => {
  const source = fixture(); source.document.snapshot = new Uint8Array();
  rejects(source, "unresolved-yjs-dependencies");
});

test("rejects unsupported physical format, missing epoch and nonbinary checkpoint", () => {
  for (const [key, value, code] of [
    ["format_version", "unknown", "unsupported-format"],
    ["room_epoch", null, "invalid-storage-metadata"],
    ["snapshot", "not binary", "invalid-storage-metadata"],
    ["snapshot_seq", -1, "invalid-storage-metadata"],
  ]) {
    const source = fixture(); source.document[key] = value; rejects(source, code);
  }
});

test("rejects revision mismatch in stored document and projection", () => {
  const source = fixture(); source.document.revision = 2;
  rejects(source, "document-metadata-mismatch");
  rejects(fixture({ project: canvas => { canvas.revision = 2; } }), "projection-mismatch");
});

test("rejects unknown top shared types and metadata instead of discarding them", () => {
  rejects(fixture({ prepare: doc => doc.getMap("future-payload").set("x", 1) }), "unknown-shared-types");
  rejects(fixture({ prepare: doc => doc.getMap("meta").set("future-version", 1) }), "document-metadata-mismatch");
});

test("rejects non-atomic nested Yjs business payloads", () => {
  rejects(fixture({ prepare: doc => {
    const value = new Y.Map(); value.set("text", "value");
    doc.getMap("nodeData").set("film", value);
  } }), "non-atomic-value");
});

test("rejects entity ID/key mismatch rather than silently filtering a row", () => {
  rejects(fixture({ prepare: doc => doc.getMap("nodes").set("wrong-key", { id: "other", type: "text", position: { x: 0, y: 0 } }) }), "entity-key-mismatch");
});

test("rejects dangling nodeData and edge references", () => {
  rejects(fixture({ prepare: doc => doc.getMap("nodeData").set("absent", {}) }), "invalid-node-data");
  rejects(fixture({ prepare: doc => doc.getMap("edges").set("bad", { id: "bad", source: "absent", target: "film", data: {} }) }), "invalid-edge-reference");
});

test("rejects malformed source positions and job payloads", () => {
  rejects(fixture({ prepare: doc => doc.getMap("nodes").set("image", { id: "image", type: "image", position: { x: "0", y: 1 } }) }), "invalid-node");
  rejects(fixture({ prepare: doc => doc.getMap("jobs").set("bad", { id: "bad", status: "success" }) }), "invalid-job");
});

test("rejects content drift, duplicate projection entities and unknown projection fields", () => {
  for (const project of [
    canvas => { canvas.nodeData.film.modelScript = "changed"; },
    canvas => { canvas.document.nodes.push(canvas.document.nodes[0]); },
    canvas => { canvas.future = { executable: true }; },
  ]) rejects(fixture({ project }), project.toString().includes("future") ? "unknown-projection-fields" : "projection-mismatch");
});

test("accepts empty entity maps omitted by Yjs binary encoding", () => {
  const result = readOfflineYjsCanvasSource(fixture({ prepare: doc => {
    for (const name of ["nodes", "nodeData", "assets", "jobs"]) doc.getMap(name).clear();
  }, update: doc => { doc.getMap("nodes").delete("film"); } }));
  assert.equal(result.report.nodeCount, 0);
  assert.deepEqual(result.canvas.nodeData, {});
});

test("historical ownership comes from actual Yjs fields and includes deleted nodes", () => {
  const source = fixture();
  appendUpdate(source, doc => { doc.getMap("nodes").delete("film"); doc.getMap("nodeData").delete("film"); }, 2);
  const result = readOfflineYjsCanvasSource(source);
  assert.equal(result.canvas.document.nodes.some(node => node.id === "film"), false);
  assert.deepEqual(result.report.historicalNodeIdentities.filter(entry => entry.nodeId === "film"), [{
    nodeId: "film", type: "animation3d", extensionId: null,
    firstSeenSeq: 4, lastSeenSeq: 6, firstSeenRevision: 0, lastSeenRevision: 1,
  }]);
});

test("delete/recreate produces separate ownership intervals even for identical identity", () => {
  const source = fixture();
  appendUpdate(source, doc => { doc.getMap("nodes").delete("film"); doc.getMap("nodeData").delete("film"); }, 2);
  appendUpdate(source, doc => {
    doc.getMap("nodes").set("film", { id: "film", type: "animation3d", position: { x: 0, y: 0 } });
    doc.getMap("nodeData").set("film", {});
  }, 3);
  const histories = readOfflineYjsCanvasSource(source).report.historicalNodeIdentities.filter(entry => entry.nodeId === "film");
  assert.equal(histories.length, 2);
  assert.deepEqual(histories.map(entry => [entry.firstSeenSeq, entry.lastSeenSeq]), [[4, 6], [8, 8]]);
});

test("type or business changes produce distinct provenance and do not guess owner", () => {
  const source = fixture();
  appendUpdate(source, doc => {
    doc.getMap("nodes").set("film", { id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
    doc.getMap("nodeData").set("film", { extensionId: "game-furnace" });
  }, 2);
  appendUpdate(source, doc => doc.getMap("nodeData").set("film", { extensionId: "third-business" }), 3);
  const histories = readOfflineYjsCanvasSource(source).report.historicalNodeIdentities.filter(entry => entry.nodeId === "film");
  assert.deepEqual(histories.map(entry => [entry.type, entry.extensionId]), [
    ["animation3d", null], ["composite-asset", "game-furnace"], ["composite-asset", "third-business"],
  ]);
});

test("invalid historical ownership is not hidden by a later valid payload", () => {
  const source = fixture({ update: doc => doc.getMap("nodeData").set("film", { extensionId: 42 }) });
  appendUpdate(source, doc => doc.getMap("nodeData").set("film", { extensionId: "film-set" }), 2);
  rejects(source, "invalid-historical-business-identity");
});

function database(sources) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE canvas_yjs_documents(
    canvas_id TEXT PRIMARY KEY,format_version TEXT,room_epoch TEXT,snapshot BLOB,snapshot_seq INTEGER,
    revision INTEGER,projection_json TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE canvas_yjs_updates(canvas_id TEXT,seq INTEGER,update_bytes BLOB,sha256 TEXT,created_at TEXT);`);
  for (const source of sources) {
    db.prepare("INSERT INTO canvas_yjs_documents VALUES(?,?,?,?,?,?,?,?,?)").run(...Object.values(source.document));
    for (const update of source.updates) db.prepare("INSERT INTO canvas_yjs_updates VALUES(?,?,?,?,?)").run(...Object.values(update));
  }
  return db;
}

test("loads the entire SQLite profile in one read transaction without writes", () => {
  const db = database([fixture({ id: "b" }), fixture({ id: "a" })]);
  try {
    const before = db.prepare("SELECT total_changes() AS total").get();
    const result = loadOfflineYjsCanvasSources(db);
    assert.deepEqual(result.map(entry => entry.report.canvasId), ["a", "b"]);
    assert.deepEqual(db.prepare("SELECT total_changes() AS total").get(), before);
    db.exec("BEGIN"); db.exec("ROLLBACK");
  } finally { db.close(); }
});

test("a corrupt second canvas fails the whole source plan and closes the read transaction", () => {
  const bad = fixture({ id: "b" }); bad.updates[1].sha256 = "0".repeat(64);
  const db = database([fixture({ id: "a" }), bad]);
  try {
    assert.throws(() => loadOfflineYjsCanvasSources(db), error => error.canvasId === "b" && error.code === "update-checksum");
    db.exec("BEGIN"); db.exec("ROLLBACK");
  } finally { db.close(); }
});

test("an orphan update blocks the whole profile rather than being omitted", () => {
  const db = database([fixture()]);
  try {
    db.prepare("INSERT INTO canvas_yjs_updates VALUES(?,?,?,?,?)").run("orphan", 1, new Uint8Array(), sha(new Uint8Array()), timestamp);
    assert.throws(() => loadOfflineYjsCanvasSources(db), error => error.code === "orphan-update");
  } finally { db.close(); }
});
