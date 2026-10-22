/**
 * Offline input boundary for the one-time composite-asset migration.
 * Used only before startup or by offline tools, never by rooms or browsers. It deliberately
 * reads old Yjs bytes without asking the new production codec to accept them.
 * It performs no conversion, normalization, schema migration or database write.
 */
import { createHash } from "node:crypto";
import * as Y from "yjs";
const FORMATS = new Set(["woohaa3-ycanvas-v1", "woohaa3-ycanvas-v2"]);
const MAPS = ["meta", "nodes", "edges", "nodeData", "assets", "jobs"];
const META_KEYS = ["formatVersion", "id", "title", "documentSchemaVersion", "revision", "createdAt", "updatedAt"];

export class OfflineCanvasSourceError extends Error {
  constructor(code, canvasId, details = {}) {
    // Diagnostics identify records and fields, never user source or secrets.
    super(`Offline canvas source ${code}: ${canvasId ?? "unknown"}`);
    this.name = "OfflineCanvasSourceError";
    this.code = code;
    this.canvasId = canvasId;
    this.details = details;
  }
}

function fail(code, id, details) {
  throw new OfflineCanvasSourceError(code, id, details);
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function string(value) {
  return typeof value === "string" && value.length > 0;
}
function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function stable(value) {
  return JSON.stringify(value, (_key, entry) => object(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
}
function same(left, right) {
  return stable(left) === stable(right);
}
function byId(values) {
  return [...values].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function assertJson(value, id, path, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!object(value) && !Array.isArray(value)) fail("non-json-value", id, { path });
  if (value instanceof Y.AbstractType || seen.has(value)) fail("non-atomic-value", id, { path });
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    fail("non-json-value", id, { path });
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value)) assertJson(child, id, `${path}.${key}`, seen);
  seen.delete(value);
}

function mapJson(doc, name, id) {
  // Yjs does not encode an empty map. Only metadata must be present; an absent
  // entity map represents the empty collection, without mutating the document.
  if (!doc.share.has(name)) {
    if (name === "meta") fail("missing-shared-map", id, { map: name });
    return {};
  }
  let map;
  try { map = doc.getMap(name); } catch { fail("invalid-shared-type", id, { map: name }); }
  const entries = [...map.entries()];
  for (const [key, value] of entries) assertJson(value, id, `${name}.${key}`);
  return Object.fromEntries(entries);
}

function entities(records, name, id) {
  return Object.entries(records).map(([key, value]) => {
    if (!object(value) || !string(value.id) || value.id !== key) {
      fail("entity-key-mismatch", id, { map: name, key });
    }
    return value;
  });
}

function assertProjection(raw, projection, id) {
  if (!object(projection) || !object(projection.document)) fail("invalid-projection", id);
  const expectedKeys = ["id", "title", "revision", "document", "nodeData", "assets", "jobs", "updatedAt"];
  if (!same(Object.keys(projection).sort(), expectedKeys.sort())
      || !same(Object.keys(projection.document).sort(), ["schemaVersion", "nodes", "edges", "updatedAt"].sort())) {
    fail("unknown-projection-fields", id);
  }
  for (const [path, left, right] of [
    ["id", projection.id, raw.meta.id],
    ["title", projection.title, raw.meta.title],
    ["revision", projection.revision, raw.meta.revision],
    ["updatedAt", projection.updatedAt, raw.meta.updatedAt],
    ["document.updatedAt", projection.document.updatedAt, raw.meta.updatedAt],
    ["document.schemaVersion", projection.document.schemaVersion, raw.meta.documentSchemaVersion],
    ["nodeData", projection.nodeData, raw.nodeData],
  ]) if (!same(left, right)) fail("projection-mismatch", id, { path });
  for (const name of ["nodes", "assets", "jobs"]) {
    const projected = name === "nodes" ? projection.document.nodes : projection[name];
    if (!Array.isArray(projected) || projected.some(entry => !object(entry) || !string(entry.id))
        || !same(byId(projected), byId(raw[name]))) {
      fail("projection-mismatch", id, { path: name });
    }
  }
  const projected = projection.document.edges;
  if (!Array.isArray(projected) || projected.some(entry => !object(entry) || !string(entry.id))) {
    fail("projection-mismatch", id, { path: "edges" });
  }
  if (same(byId(projected), byId(raw.edges))) return [];
  // The old application omitted edges touching either old pure-model category.
  // Allow precisely that documented difference, retaining every raw edge in the
  // returned input. The apply planner must explicitly remove/report these IDs.
  if (raw.meta.formatVersion !== "woohaa3-ycanvas-v1") {
    fail("projection-mismatch", id, { path: "edges" });
  }
  const endpoints = new Set(raw.nodes.filter(node => node.type === "animation3d" || node.type === "extension3d").map(node => node.id));
  const omitted = raw.edges.filter(edge => endpoints.has(edge.source) || endpoints.has(edge.target));
  const kept = raw.edges.filter(edge => !endpoints.has(edge.source) && !endpoints.has(edge.target));
  if (!omitted.length || !same(byId(projected), byId(kept))) {
    fail("projection-mismatch", id, { path: "edges" });
  }
  return omitted.map(edge => edge.id).sort();
}

function observeHistoricalNodeIdentities(doc, seq, canvasId, history, active) {
  const nodes = doc.share.has("nodes") ? doc.getMap("nodes") : null;
  const data = doc.share.has("nodeData") ? doc.getMap("nodeData") : null;
  const meta = doc.share.has("meta") ? doc.getMap("meta") : null;
  const revision = meta?.get("revision");
  const present = new Set();
  for (const [nodeId, node] of nodes?.entries() ?? []) {
    if (node instanceof Y.AbstractType) fail("non-atomic-value", canvasId, { path: `nodes.${nodeId}`, seq });
    if (!object(node) || node instanceof Y.AbstractType || node.id !== nodeId || !string(node.type)) {
      fail("entity-key-mismatch", canvasId, { map: "nodes", key: nodeId, seq });
    }
    const fields = data?.get(nodeId);
    if (fields instanceof Y.AbstractType) fail("non-atomic-value", canvasId, { path: `nodeData.${nodeId}`, seq });
    if (fields !== undefined && (!object(fields) || fields instanceof Y.AbstractType)) {
      fail("invalid-historical-node-data", canvasId, { seq, nodeId });
    }
    const extensionId = fields?.extensionId ?? null;
    if (extensionId !== null && !string(extensionId)) {
      fail("invalid-historical-business-identity", canvasId, { seq, nodeId });
    }
    if (!integer(revision)) fail("invalid-historical-revision", canvasId, { seq });
    present.add(nodeId);
    const prior = active.get(nodeId);
    if (prior && prior.type === node.type && prior.extensionId === extensionId) {
      prior.lastSeenSeq = seq;
      prior.lastSeenRevision = revision;
    } else {
      const entry = { nodeId, type: node.type, extensionId, firstSeenSeq: seq, lastSeenSeq: seq,
        firstSeenRevision: revision, lastSeenRevision: revision };
      history.push(entry);
      active.set(nodeId, entry);
    }
  }
  // A deletion followed by recreation is a new interval even if both type and
  // discriminator are unchanged. Never infer historical ownership from IDs.
  for (const nodeId of active.keys()) if (!present.has(nodeId)) active.delete(nodeId);
}

/** Restore and validate one stored document plus ALL of its ordered update rows. */
export function readOfflineYjsCanvasSource({ document: row, updates }) {
  const id = row?.canvas_id;
  if (!object(row) || !string(id) || !FORMATS.has(row.format_version)) fail("unsupported-format", id);
  if (!(row.snapshot instanceof Uint8Array) || !integer(row.snapshot_seq)
      || !integer(row.revision) || !string(row.room_epoch)
      || !string(row.created_at) || !string(row.updated_at) || !Array.isArray(updates)) {
    fail("invalid-storage-metadata", id);
  }
  let sequence = row.snapshot_seq;
  for (const update of updates) {
    if (update.canvas_id !== id || !integer(update.seq) || update.seq !== sequence + 1) {
      fail("update-sequence", id, { previousSeq: sequence, seq: update.seq });
    }
    if (!(update.update_bytes instanceof Uint8Array) || !/^[a-f0-9]{64}$/.test(update.sha256)
        || hash(update.update_bytes) !== update.sha256) {
      fail("update-checksum", id, { seq: update.seq });
    }
    sequence = update.seq;
  }
  const doc = new Y.Doc();
  try {
    const historicalNodeIdentities = [];
    const activeIdentities = new Map();
    try {
      if (row.snapshot.byteLength) Y.applyUpdate(doc, row.snapshot);
      observeHistoricalNodeIdentities(doc, row.snapshot_seq, id, historicalNodeIdentities, activeIdentities);
      for (const update of updates) {
        if (update.update_bytes.byteLength) Y.applyUpdate(doc, update.update_bytes);
        observeHistoricalNodeIdentities(doc, update.seq, id, historicalNodeIdentities, activeIdentities);
      }
    } catch (error) {
      if (error instanceof OfflineCanvasSourceError) throw error;
      fail("corrupt-yjs-bytes", id);
    }
    if (doc.store.pendingStructs || doc.store.pendingDs) fail("unresolved-yjs-dependencies", id);
    const unknown = [...doc.share.keys()].filter(key => !MAPS.includes(key));
    if (unknown.length) fail("unknown-shared-types", id, { maps: unknown.sort() });
    const maps = Object.fromEntries(MAPS.map(name => [name, mapJson(doc, name, id)]));
    const meta = maps.meta;
    if (!same(Object.keys(meta).sort(), [...META_KEYS].sort()) || meta.id !== id
        || meta.formatVersion !== row.format_version || meta.documentSchemaVersion !== "asset-canvas-v1"
        || typeof meta.title !== "string" || !string(meta.createdAt) || !string(meta.updatedAt)
        || meta.revision !== row.revision) {
      fail("document-metadata-mismatch", id);
    }
    const raw = {
      meta, nodes: entities(maps.nodes, "nodes", id), edges: entities(maps.edges, "edges", id),
      nodeData: maps.nodeData, assets: entities(maps.assets, "assets", id), jobs: entities(maps.jobs, "jobs", id),
    };
    const nodeIds = new Set(raw.nodes.map(node => node.id));
    for (const node of raw.nodes) {
      if (!string(node.type) || !object(node.position) || !finite(node.position.x) || !finite(node.position.y)
          || ["width", "height"].some(key => node[key] !== undefined && (!finite(node[key]) || node[key] <= 0))
          || (node.zIndex !== undefined && !finite(node.zIndex))
          || (node.parentId !== undefined && (!string(node.parentId) || !nodeIds.has(node.parentId) || node.parentId === node.id))) {
        fail("invalid-node", id, { nodeId: node.id });
      }
    }
    for (const [nodeId, data] of Object.entries(raw.nodeData)) {
      if (!nodeIds.has(nodeId) || !object(data)) fail("invalid-node-data", id, { nodeId });
    }
    for (const edge of raw.edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || !object(edge.data)) {
        fail("invalid-edge-reference", id, { edgeId: edge.id });
      }
    }
    for (const job of raw.jobs) {
      // Historical jobs intentionally survive deletion of their source node.
      // Activity/draining is a separate migration gate; never drop these rows.
      if (!string(job.nodeId) || !string(job.taskId) || !string(job.status) || !string(job.updatedAt)) {
        fail("invalid-job", id, { jobId: job.id });
      }
    }
    let projection;
    try { projection = JSON.parse(row.projection_json); } catch { fail("invalid-projection", id); }
    assertJson(projection, id, "projection");
    const omittedEdgeIds = assertProjection(raw, projection, id);
    const canvas = {
      id, title: meta.title, revision: meta.revision,
      document: { schemaVersion: meta.documentSchemaVersion, nodes: byId(raw.nodes), edges: byId(raw.edges), updatedAt: meta.updatedAt },
      nodeData: raw.nodeData, assets: byId(raw.assets), jobs: byId(raw.jobs), updatedAt: meta.updatedAt,
    };
    return {
      raw, canvas, projection,
      report: {
        canvasId: id, formatVersion: row.format_version, roomEpoch: row.room_epoch,
        revision: meta.revision, checkpointSeq: row.snapshot_seq, storageSeq: sequence,
        restoredUpdates: updates.length, checkpointSha256: hash(row.snapshot),
        updatesSha256: hash(stable(updates.map(update => [update.seq, update.sha256]))),
        rawSha256: hash(stable(raw)), projectionSha256: hash(row.projection_json),
        nodeCount: raw.nodes.length, edgeCount: raw.edges.length, assetCount: raw.assets.length, jobCount: raw.jobs.length,
        requiresExplicitEdgeRemoval: omittedEdgeIds,
        detachedJobIds: raw.jobs.filter(job => !nodeIds.has(job.nodeId)).map(job => job.id).sort(),
        historicalNodeIdentities: historicalNodeIdentities.sort((left, right) =>
          left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : left.firstSeenSeq - right.firstSeenSeq),
      },
    };
  } finally { doc.destroy(); }
}

/**
 * Read all documents from one consistent SQLite read transaction. The caller
 * opens the connection read-only; no table creation, PRAGMA mutation or writer
 * lock acquisition is performed here. Errors never produce a partial plan.
 */
export function loadOfflineYjsCanvasSources(db, { transaction = true } = {}) {
  if (transaction) db.exec("BEGIN");
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok") {
      fail("sqlite-integrity", undefined);
    }
    const rows = db.prepare("SELECT * FROM canvas_yjs_documents ORDER BY canvas_id").all();
    const orphan = db.prepare("SELECT canvas_id FROM canvas_yjs_updates WHERE canvas_id NOT IN (SELECT canvas_id FROM canvas_yjs_documents) LIMIT 1").get();
    if (orphan) fail("orphan-update", orphan.canvas_id);
    return rows.map(document => readOfflineYjsCanvasSource({
      document,
      updates: db.prepare("SELECT * FROM canvas_yjs_updates WHERE canvas_id = ? ORDER BY seq").all(document.canvas_id),
    }));
  } finally { if (transaction) db.exec("ROLLBACK"); }
}
