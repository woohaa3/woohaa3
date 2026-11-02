import { compareByZIndexThenId, YJS_CANVAS_FORMAT_VERSION, serverCanvasToYDoc, yDocToServerCanvas } from "@woohaa3/contracts/canvas-yjs";
/** Offline-only conversion. This entry is bundled by the CLI and never imported by a service. */
import * as Y from "yjs";
import { canonicalFilmSetFields, type ServerCanvas } from "@woohaa3/contracts";
import { planFilmSetSceneSpaceNode } from "../../web/services/canvas-service/src/animation/film-set-scene-space-migration.js";
import { readLegacyFilmSetNodeData } from "./legacy-film-set/legacy-film-set-reader.js";
import { legacyFilmSetHistoryInput, convertLegacyFilmSetHistoryEntry } from "./legacy-film-set/legacy-film-set-history.js";
import { legacyFilmSetIdentityKey, planLegacyFilmSetItemIdentities } from "./legacy-film-set/legacy-film-set-identities.js";
import { loadOfflineYjsCanvasSources } from "./model-native-migration-source.mjs";
import { randomUUID, createHash } from "node:crypto";

const stable = (value: unknown): string => JSON.stringify(value, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const keyOf = legacyFilmSetIdentityKey;
const fail = (message: string): never => { throw new Error(message); };
const isFilm = (type: string, data: any) => type === "animation3d" || (type === "composite-asset" && data?.extensionId === "film-set");

export type MigrationOptions = { previousMappings?: any[]; removeEdgeIds?: string[] };

/** Preserve every original row/receipt unless a known typed payload needs conversion. */
export function planMigration(db: any, options: MigrationOptions = {}) {
  const sources = loadOfflineYjsCanvasSources(db);
  if (process.env.WOOHAA3_MIGRATION_DEBUG) console.error("migration: sources loaded");
  const owners = new Map<string, { title: string; types: Set<string> }>();
  for (const mapping of options.previousMappings ?? []) owners.set(keyOf(mapping.canvasId, mapping.nodeId), { title: "片场", types: new Set(["film-set"]) });
  const records: any[] = [];
  const histories: any[] = [];
  const completions: any[] = [];
  const identityMap = new Map<string, string>();
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row: any) => row.name));
  for (const source of sources) {
    for (const identity of source.report.historicalNodeIdentities) {
      const key = keyOf(source.canvas.id, identity.nodeId);
      const owner = owners.get(key) ?? { title: source.canvas.nodeData[identity.nodeId]?.title || "片场", types: new Set<string>() };
      owner.types.add(isFilm(identity.type, { extensionId: identity.extensionId }) ? "film-set" : identity.extensionId ?? identity.type);
      owners.set(key, owner);
    }
    // Reserve IDs from ALL historical versions, including deleted nodes and unarchived edits.
    const row = db.prepare("SELECT * FROM canvas_yjs_documents WHERE canvas_id=?").get(source.canvas.id);
    const doc = new Y.Doc();
    try {
      const collect = () => {
        for (const [id, node] of doc.getMap<any>("nodes")) {
          const data = doc.getMap<any>("nodeData").get(id);
          if (isFilm(node.type, data)) records.push({ canvasId: source.canvas.id, nodeId: id, nodeData: structuredClone(data) });
        }
      };
      if (row.snapshot.byteLength) Y.applyUpdate(doc, row.snapshot); collect();
      for (const update of db.prepare("SELECT update_bytes FROM canvas_yjs_updates WHERE canvas_id=? ORDER BY seq").all(source.canvas.id)) { if (update.update_bytes.byteLength) Y.applyUpdate(doc, update.update_bytes); collect(); }
    } finally { doc.destroy(); }
  }
  const filmOwner = (canvasId: string, nodeId: string) => {
    const owner = owners.get(keyOf(canvasId, nodeId));
    if (!owner?.types.has("film-set")) return null;
    if (owner.types.size !== 1) fail(`Ambiguous historical business ownership: ${canvasId}/${nodeId}`);
    return owner;
  };
  const prepareEntry = (entry: any) => {
    const owner = filmOwner(entry.canvasId, entry.nodeId);
    if (!owner) return;
    const input = legacyFilmSetHistoryInput(entry.payload, owner.title);
    if (!input.ok) fail(`History input ${entry.entryId}: ${input.reason}`);
    records.push({ canvasId: entry.canvasId, nodeId: entry.nodeId, nodeData: input.nodeData });
  };
  if (tables.has("node_generation_history")) {
    for (const row of db.prepare("SELECT * FROM node_generation_history ORDER BY canvas_id,node_id,created_at,entry_id").all()) {
      if (!filmOwner(row.canvas_id, row.node_id)) continue;
      const entry = { version: "woohaa-node-generation-history-v1", entryId: row.entry_id, canvasId: row.canvas_id, nodeId: row.node_id, kind: row.kind, createdAt: row.created_at,
        sourceIdentity: row.source_identity, currentIdentity: row.current_identity, recoverable: row.recoverable === 1, previewable: row.previewable === 1, source: JSON.parse(row.source_json), payload: JSON.parse(row.payload_json) };
      prepareEntry(entry); histories.push({ row, entry });
    }
  }
  if (tables.has("canvas_edit_completions")) {
    for (const row of db.prepare("SELECT * FROM canvas_edit_completions ORDER BY canvas_id,node_id,request_id").all()) {
      const entries = JSON.parse(row.pending_entries_json);
      if (!Array.isArray(entries)) fail(`Invalid completion outbox: ${row.request_id}`);
      for (const entry of entries) prepareEntry(entry);
      completions.push({ row, entries });
    }
  }
  const allocation = planLegacyFilmSetItemIdentities(records, options.previousMappings ?? []);
  if (!allocation.ok) fail(allocation.reason);
  const mappings = allocation.mappings;
  const mapping = new Map(mappings.map(record => [keyOf(record.canvasId, record.nodeId), record.topModelItemId]));
  const convertEntry = (entry: any) => {
    const owner = filmOwner(entry.canvasId, entry.nodeId);
    if (!owner) return entry;
    const converted = convertLegacyFilmSetHistoryEntry(entry, { title: owner.title, topModelItemId: mapping.get(keyOf(entry.canvasId, entry.nodeId))! });
    if (!converted.ok) fail(`History conversion ${entry.entryId}: ${converted.reason}`);
    identityMap.set(`${keyOf(entry.canvasId, entry.nodeId)}:${entry.currentIdentity}`, converted.entry.currentIdentity);
    return converted.entry;
  };
  if (process.env.WOOHAA3_MIGRATION_DEBUG) console.error("migration: histories collected");
  const historyWrites = histories.map(({ row, entry }) => {
    const converted = convertEntry(entry);
    return { row, entry: converted, changed: stable(converted) !== stable(entry), bytes: Buffer.byteLength(JSON.stringify(converted)) };
  });
  if (process.env.WOOHAA3_MIGRATION_DEBUG) console.error("migration: histories converted");
  const documents = sources.map((source: any) => {
    const canvas: ServerCanvas = structuredClone(source.canvas);
    const removedEdges: string[] = [];
    for (const node of canvas.document.nodes) {
      if ((node.type === "animation3d" || node.type === "extension3d") && node.width === 196 && node.height === 64) { node.width = 260; node.height = 195; }
      const data = canvas.nodeData[node.id];
      if (isFilm(node.type, data)) {
        const result = readLegacyFilmSetNodeData(data, { topModelItemId: mapping.get(keyOf(canvas.id, node.id)) });
        if (!result.ok) fail(`Canonical conversion ${canvas.id}/${node.id}: ${result.reason}`);
        // 坐标契约升级（场景单位）紧随 items-only 转换：用该节点当时的显示映射反解镜头，
        // 缺少可证实尺寸时明确阻断，不猜测单位
        // （change: 2026-10-23-isolate-film-set-camera-space，任务 4.1–4.3 / design D5）。
        const sceneSpace = planFilmSetSceneSpaceNode(canonicalFilmSetFields(result.value), {
          nodeSize: { width: node.width, height: node.height }
        });
        if (!sceneSpace.ok) fail(`Scene-space conversion ${canvas.id}/${node.id} (${sceneSpace.conflict}): ${sceneSpace.reason}`);
        const preserved = { ...data };
        if (preserved.kind === "animation3d" || preserved.kind === "composite-asset") delete preserved.kind;
        for (const field of ["modelScript", "modelScriptLanguage", "modelScriptVersion", "modelContentVersion", "modelPlacement", "motionScript", "motionScriptLanguage", "motionScriptVersion", "motionRevision", "motionSourceHash", "motionBasedOnModelVersion", "initialCamera", "timeline", "animationSnapshotHash"]) delete preserved[field];
        canvas.nodeData[node.id] = { ...preserved, ...canonicalFilmSetFields(sceneSpace.value) } as any;
        node.type = "composite-asset";
      } else if (node.type === "extension3d") {
        fail(`Unknown old extension owner: ${canvas.id}/${node.id}`);
      }
    }
    const approvedRemoval = new Set(options.removeEdgeIds ?? []);
    for (const edgeId of source.report.requiresExplicitEdgeRemoval) {
      if (!approvedRemoval.has(edgeId)) fail(`Legacy illegal edge requires explicit --remove-edge ${edgeId}`);
      canvas.document.edges = canvas.document.edges.filter(edge => edge.id !== edgeId); removedEdges.push(edgeId);
    }
    for (const [id, data] of Object.entries(canvas.nodeData)) if (data.taskStatus === "pending" || data.taskStatus === "processing") fail(`Active generation requires draining: ${canvas.id}/${id}`);
    for (const job of canvas.jobs) if (job.status === "queued" || job.status === "running") fail(`Active job requires draining: ${canvas.id}/${job.id}`);
    const changed = source.report.formatVersion !== YJS_CANVAS_FORMAT_VERSION || stable(canvas) !== stable(source.canvas);
    if (process.env.WOOHAA3_MIGRATION_DEBUG) console.error("migration: canonical converted");
    const doc = serverCanvasToYDoc(canvas);
    try {
      // Preserve original creation time instead of deriving it from updatedAt.
      doc.getMap("meta").set("createdAt", source.raw.meta.createdAt);
      const decoded = yDocToServerCanvas(doc, { now: canvas.updatedAt });
      if (!decoded.ok || stable(decoded.canvas) !== stable({ ...canvas, document: { ...canvas.document, nodes: [...canvas.document.nodes].sort(compareByZIndexThenId) } })) fail(`Target checkpoint loses or normalizes content: ${canvas.id}`);
      return { canvas: decoded.canvas, sourceReport: source.report, changed, snapshot: Y.encodeStateAsUpdate(doc), roomEpoch: changed ? `composite-asset-${randomUUID()}` : source.report.roomEpoch,
        snapshotSeq: source.report.storageSeq, removedEdges, beforeHash: digest(source.canvas), afterHash: digest(canvas) };
    } finally { doc.destroy(); }
  });
  const completionWrites = completions.map(({ row, entries }) => {
    const converted = entries.map(convertEntry);
    const ownerKey = keyOf(row.canvas_id, row.node_id);
    // Opaque historical request fingerprints remain exact, preserving receipt idempotency.
    // An unmatched dormant begin record is not an active edit and must not be canceled.
    const identity = (value: string) => identityMap.get(`${ownerKey}:${value}`) ?? value;
    return { row, pendingEntries: converted, contentIdentity: identity(row.content_identity), baselineIdentity: identity(row.baseline_content_identity),
      changed: stable(entries) !== stable(converted) || identity(row.content_identity) !== row.content_identity || identity(row.baseline_content_identity) !== row.baseline_content_identity };
  });
  return { mappings, documents, historyWrites, completionWrites,
    changed: documents.some((document: any) => document.changed) || historyWrites.some(write => write.changed) || completionWrites.some(write => write.changed),
    report: { version: "composite-asset-migration-v1", mappings,
      canvasCount: documents.length, historyCount: historyWrites.length, completionCount: completionWrites.length,
      preparedBeginCount: completions.filter(({ row }) => row.status === "prepared").length,
      canvases: documents.map(({ canvas, sourceReport, beforeHash, afterHash, changed, removedEdges }: any) => ({ canvasId: canvas.id, revision: canvas.revision, nodeCount: canvas.document.nodes.length, assetCount: canvas.assets.length, jobCount: canvas.jobs.length, restoredUpdates: sourceReport.restoredUpdates, beforeHash, afterHash, changed, removedEdges })) } };
}

/** Call only inside the CLI's exclusive transaction, after complete plan validation. */
export function applyMigration(db: any, plan: ReturnType<typeof planMigration>) {
  for (const document of plan.documents) if (document.changed) {
    db.prepare("UPDATE canvas_yjs_documents SET format_version=?,room_epoch=?,snapshot=?,snapshot_seq=?,projection_json=? WHERE canvas_id=? AND revision=?").run(YJS_CANVAS_FORMAT_VERSION, document.roomEpoch, document.snapshot, document.snapshotSeq, JSON.stringify(document.canvas), document.canvas.id, document.canvas.revision);
    // Keep command receipts. Old bytes cannot re-enter the new epoch on restart.
    db.prepare("DELETE FROM canvas_yjs_updates WHERE canvas_id=?").run(document.canvas.id);
  }
  for (const write of plan.historyWrites) if (write.changed) db.prepare("UPDATE node_generation_history SET payload_json=?,current_identity=?,bytes=? WHERE canvas_id=? AND node_id=? AND entry_id=?").run(JSON.stringify(write.entry.payload), write.entry.currentIdentity, write.bytes, write.row.canvas_id, write.row.node_id, write.row.entry_id);
  for (const write of plan.completionWrites) if (write.changed) db.prepare("UPDATE canvas_edit_completions SET pending_entries_json=?,content_identity=?,baseline_content_identity=? WHERE canvas_id=? AND node_id=? AND request_id=?").run(JSON.stringify(write.pendingEntries), write.contentIdentity, write.baselineIdentity, write.row.canvas_id, write.row.node_id, write.row.request_id);
}
