import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GLB_MAX_FILE_BYTES,
  MediaObjectNotFoundError,
  createEmptyWoohaa3ServerCanvas,
  decodeWorldInstanceData,
  normalizeGlbModelReference,
  normalizeModelDefinition,
  type ServerCanvas,
  type StoredAsset,
  type WorldTransform
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom } from "../sync/room.js";
import { SqliteYjsRepository } from "../storage/sqlite/yjs.js";
import { loadNodeSqlite } from "../storage/sqlite/sqlite-loader.js";
import { SqliteSpatialLeaseStore } from "../storage/sqlite/spatial-leases.js";
import { createWorldAuthoringAuthority, instanceFootprint, worldObjectVersion } from "./authority.js";
import { affectedWorldObjects } from "./affected-objects.js";
import { createAssistantWorldService } from "./assistant-service.js";
import { createWorldAuthoringService } from "./scene-area-service.js";
import type { LeaseIntent } from "./spatial-leases.js";

const NOW = "2026-11-04T00:00:00.000Z";
const TYPE = "model/gltf-binary";
const AREA = { kind: "scene-area" as const, areaId: "area-main" };
const TARGET = { kind: "instance" as const, instanceId: "instance-model" };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

/** Real triangle bytes; deliberately misleading accessor min/max are not authority. */
function glb(size = 1, hierarchy = false, unsupported = false): Buffer {
  const vertices = hierarchy ? [0, 0, 0, 2, 0, 0, 0, 1, 2] : [-size / 2, 0, -size / 2, size / 2, 0, -size / 2, 0, 1, size / 2];
  const bin = Buffer.from(new Float32Array(vertices).buffer);
  const document = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: hierarchy
      ? [{ translation: [1, 0, 2], scale: [2, 1, 1], children: [1] }, { translation: [0, 1, 0], mesh: 0 }]
      : [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-100, -100, -100], max: [100, 100, 100] }],
    ...(unsupported ? { extensionsRequired: ["KHR_draco_mesh_compression"], extensionsUsed: ["KHR_draco_mesh_compression"] } : {})
  };
  const json = Buffer.from(JSON.stringify(document));
  const jsonSize = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonSize + bin.length);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonSize, 12); bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(0x20, 20, 20 + jsonSize); json.copy(bytes, 20);
  bytes.writeUInt32LE(bin.length, 20 + jsonSize); bytes.writeUInt32LE(0x004e4942, 24 + jsonSize); bin.copy(bytes, 28 + jsonSize);
  return bytes;
}

function asset(bytes: Buffer): StoredAsset {
  const checksum = createHash("sha256").update(bytes).digest("hex");
  return { id: "shared-model-asset", title: "model.glb", mediaKind: "file", status: "ready", source: "uploaded", createdAt: NOW,
    metadata: { storageKey: `sha256-${checksum}`, checksum, size: bytes.length, contentType: TYPE } };
}

function fixture(bytes = glb(), id = "canvas-glb") {
  const canvas = createEmptyWoohaa3ServerCanvas(id, NOW);
  const modelAsset = asset(bytes);
  const reference = normalizeGlbModelReference({ assetId: modelAsset.id });
  if (!reference.ok) throw new Error(reference.reason);
  canvas.assets.push(modelAsset);
  canvas.document.nodes.push({ id: "area", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "model", type: "model3d", position: { x: 900, y: 900 } });
  canvas.nodeData.area = { sceneArea: { kind: "scene-area", version: "shared-world-v1", areaId: AREA.areaId,
    scopeVersion: "scope-1", bounds: { min: { u: 0, v: 0 }, max: { u: 20, v: 20 } } } };
  canvas.nodeData.model = { modelSourceKind: "glb", modelAssetId: modelAsset.id,
    modelContentVersion: reference.value.contentVersion, modelPlacement: reference.value.placement,
    sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: TARGET.instanceId,
      transform: pose(2, 2) } };
  return canvas;
}

function pose(u: number, v: number) {
  return { version: "shared-world-v1" as const, position: { u, v, h: 0 }, rotation: [0, 0, 0, 1] as [number, number, number, number], scale: 1 } satisfies WorldTransform;
}

function intentFor(canvas: ServerCanvas, version: string): LeaseIntent {
  return { canvasId: canvas.id, requestId: "request-1", runId: "run-1", epoch: 1, executionId: "exec-1",
    scope: { scope: AREA, scopeVersion: "scope-1" }, writable: [{ ...TARGET, version }], readOnly: [] };
}

function readFrom(...buffers: Buffer[]) {
  const byKey = new Map(buffers.map(bytes => [asset(bytes).metadata!.storageKey, bytes]));
  return vi.fn(async (storageKey: string, _canvasId?: string) => {
    const bytes = byKey.get(storageKey);
    if (!bytes) throw new Error("missing media");
    return { bytes, contentType: TYPE };
  });
}

async function persistent(canvas: ServerCanvas, read: ReturnType<typeof readFrom>) {
  const dir = mkdtempSync(join(tmpdir(), "woohaa-glb-authority-"));
  const authority = createWorldAuthoringAuthority({ media: { read } });
  const repository = new SqliteYjsRepository({ path: join(dir, "canvas.sqlite"), spatialAuthority: authority, now: () => NOW });
  const room = new CanvasRoom({ canvasId: canvas.id, repository, bootstrap: async () => canvas, verifyAssets: false, now: () => NOW, broadcast: () => {} });
  cleanup.push(() => { room.dispose(); repository.close(); rmSync(dir, { recursive: true, force: true }); });
  expect(await room.load()).toEqual({ ok: true });
  const resolveRoom = async (id: string) => id === canvas.id ? room : null;
  const worldAuthoring = createWorldAuthoringService({ authority, resolveRoom,
    acquire: async intent => repository.acquireSpatialRun(intent),
    cancel: async (id, requestId) => repository.cancelSpatialRun(id, requestId),
    findLatest: async () => null,
    readOccupancy: async (id, targets) => repository.readSpatialOccupancy(id, targets) });
  cleanup.push(() => worldAuthoring.close());
  const assistant = createAssistantWorldService({ authority, resolveRoom, worldAuthoring,
    cameraSettings: { save: async () => { throw new Error("unused camera save"); }, complete: async () => { throw new Error("unused camera complete"); } },
    cancel: async (id, requestId) => repository.cancelSpatialRun(id, requestId),
    confirmStopped: async input => repository.confirmSpatialStopped(input.canvasId, input.requestId, input.runId, input.epoch, input.executionId, input.evidence),
    pending: async () => repository.pendingSpatialRuns() });
  const published = () => {
    const result = room.exportCanvas();
    if (!result.ok) throw new Error(result.message);
    return result.canvas;
  };
  const issue = () => assistant.issue({ canvasId: canvas.id, requestId: "request-1", runId: "run-1", epoch: 1, executionId: "exec-1", scope: AREA });
  const upsert = (next: StoredAsset, commandId: string) => room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: canvas.id, commandId, actorId: "asset-import", baseRevision: published().revision,
    commands: [{ type: "asset.upsert", asset: next }] });
  return { authority, repository, room, worldAuthoring, assistant, issue, published, upsert };
}

describe("trusted GLB world authority", () => {
  it.each(["local", "http"])("identifies a missing %s GLB outside the area and recovers after its original bytes return", async transport => {
    const bytes = glb(), canvas = fixture(bytes);
    canvas.assets[0].title = "蝠翼拦截机.glb";
    canvas.nodeData.model.sharedWorldInstance = {
      kind: "world-instance", version: "shared-world-v1", instanceId: TARGET.instanceId, transform: pose(-40, -40)
    };
    const original = structuredClone(canvas);
    let missing = true;
    const read = vi.fn(async () => {
      if (missing) {
        if (transport === "local") throw new MediaObjectNotFoundError("private-storage-key");
        throw Object.assign(new Error("private-storage-url"), { status: 404 });
      }
      return { bytes, contentType: TYPE };
    });
    const authority = createWorldAuthoringAuthority({ media: { read } });
    const failed = await authority.prepareCanvas(canvas, AREA);
    expect(failed).toEqual({ ok: false, code: "not-ready",
      message: "无法准备场景模型。模型「蝠翼拦截机.glb」（model）：GLB 文件在当前存储中不存在，请恢复原文件或重新导入模型" });
    expect(authority.cacheFor(canvas.id, { scope: AREA, scopeVersion: "scope-1" })).toBeNull();
    expect(await authority.prepareContent(canvas.nodeData.model, canvas)).toBeNull();
    missing = false;
    const recovered = await authority.prepareCanvas(canvas, AREA);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.snapshot.writable).toEqual([]);
    expect(canvas).toEqual(original);
  });

  it("derives actual hierarchical geometry and applies only the shared-world root transform", async () => {
    const bytes = glb(1, true);
    const canvas = fixture(bytes);
    const reference = normalizeGlbModelReference({ assetId: canvas.assets[0].id,
      placement: { offset: { x: 100, y: 200, z: 300 }, scale: 50, yaw: 1 } });
    if (!reference.ok) throw new Error(reference.reason);
    canvas.nodeData.model.modelContentVersion = reference.value.contentVersion;
    canvas.nodeData.model.modelPlacement = reference.value.placement;
    const transform = { ...pose(3, 4), rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as [number, number, number, number], scale: 2 };
    canvas.nodeData.model.sharedWorldInstance = { kind: "world-instance", version: "shared-world-v1", instanceId: TARGET.instanceId, transform };
    const read = readFrom(bytes);
    const authority = createWorldAuthoringAuthority({ media: { read }, executeScene: () => { throw new Error("must not execute a GLB as script"); } });
    const prepared = await authority.prepareCanvas(canvas, AREA);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.snapshot.writable).toEqual([{ ...TARGET, version: worldObjectVersion(canvas, TARGET) }]);
    const content = await authority.prepareContent(canvas.nodeData.model, canvas);
    expect(content?.localAabb).toEqual({ min: [1, 1, 2], max: [5, 2, 4] });
    expect(content?.localGroundAnchor).toEqual([3, 1, 3]);
    const footprint = instanceFootprint(content!.localAabb, transform);
    expect(footprint.min.u).toBeCloseTo(7); expect(footprint.max.u).toBeCloseTo(11);
    expect(footprint.min.v).toBeCloseTo(6); expect(footprint.max.v).toBeCloseTo(14);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(canvas.assets[0].metadata!.storageKey, canvas.id);
    expect(await authority.prepareContent(canvas.nodeData.model)).toBeNull();
  });

  it("never shares scoped prepared bytes between canvases with the same asset id and metadata", async () => {
    const bytes = glb();
    const a = fixture(bytes, "canvas-a"), b = fixture(bytes, "canvas-b");
    const read = vi.fn(async (_key: string, canvasId?: string) => {
      if (canvasId === b.id) throw new Error("canvas-b media is unavailable");
      return { bytes, contentType: TYPE };
    });
    const authority = createWorldAuthoringAuthority({ media: { read } });
    expect((await authority.prepareCanvas(a, AREA)).ok).toBe(true);
    expect(await authority.prepareCanvas(b, AREA)).toMatchObject({ ok: false, code: "not-ready" });
    expect(read.mock.calls.map(call => call[1])).toEqual(["canvas-a", "canvas-b"]);
    expect(worldObjectVersion(a, TARGET)).not.toBe(worldObjectVersion(b, TARGET));
  });

  it.each(["throw", "checksum", "type", "size"])("does not cache a transient %s failure", async failure => {
    const bytes = glb(), canvas = fixture(bytes);
    let calls = 0;
    const read = vi.fn(async () => {
      if (++calls === 1) {
        if (failure === "throw") throw new Error("transient");
        if (failure === "checksum") return { bytes: Buffer.alloc(bytes.length), contentType: TYPE };
        if (failure === "type") return { bytes, contentType: "image/png" };
        return { bytes: bytes.subarray(0, bytes.length - 1), contentType: TYPE };
      }
      return { bytes, contentType: TYPE };
    });
    const authority = createWorldAuthoringAuthority({ media: { read } });
    expect(await authority.prepareCanvas(canvas, AREA)).toMatchObject({ ok: false, code: "not-ready" });
    expect((await authority.prepareCanvas(canvas, AREA)).ok).toBe(true);
    expect((await authority.prepareCanvas(canvas, AREA)).ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(["status", "kind", "storageKey", "checksum", "budget", "metadata-type"])("rejects canonical %s before reading and recovers after correction", async failure => {
    const bytes = glb(), canvas = fixture(bytes), invalid = structuredClone(canvas);
    if (failure === "status") invalid.assets[0].status = "generating";
    if (failure === "kind") invalid.assets[0].mediaKind = "image";
    if (failure === "storageKey") invalid.assets[0].metadata!.storageKey = "https://example.invalid/model.glb";
    if (failure === "checksum") invalid.assets[0].metadata!.checksum = "a".repeat(64);
    if (failure === "budget") invalid.assets[0].metadata!.size = GLB_MAX_FILE_BYTES + 1;
    if (failure === "metadata-type") invalid.assets[0].metadata!.contentType = "image/png";
    const read = readFrom(bytes), authority = createWorldAuthoringAuthority({ media: { read } });
    expect(await authority.prepareCanvas(invalid, AREA)).toMatchObject({ ok: false, code: "not-ready" });
    expect(read).not.toHaveBeenCalled();
    expect((await authority.prepareCanvas(canvas, AREA)).ok).toBe(true);
  });

  it.each([Buffer.from("invalid glb"), glb(1, false, true)])("retries malformed/unsupported content and recovers when the same asset id receives valid bytes", async bad => {
    const good = glb(), canvas = fixture(bad), read = readFrom(bad, good);
    const authority = createWorldAuthoringAuthority({ media: { read } });
    expect((await authority.prepareCanvas(canvas, AREA)).ok).toBe(false);
    expect((await authority.prepareCanvas(canvas, AREA)).ok).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    canvas.assets[0] = asset(good);
    expect((await authority.prepareCanvas(canvas, AREA)).ok).toBe(true);
  });

  it("expires old content versions after same-id asset replacement and re-preparation", async () => {
    const beforeBytes = glb(), nextBytes = glb(2), before = fixture(beforeBytes);
    const authority = createWorldAuthoringAuthority({ media: { read: readFrom(beforeBytes, nextBytes) } });
    const first = await authority.prepareCanvas(before, AREA);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const oldVersion = worldObjectVersion(before, TARGET)!;
    const oldIntent = intentFor(before, oldVersion);
    const { DatabaseSync } = loadNodeSqlite();
    const db = new DatabaseSync(":memory:");
    cleanup.push(() => db.close());
    const leases = new SqliteSpatialLeaseStore(db, authority);
    leases.acquire(oldIntent);
    const next = structuredClone(before); next.assets[0] = asset(nextBytes); next.revision++;
    expect(next.nodeData).toEqual(before.nodeData);
    expect(worldObjectVersion(next, TARGET)).not.toBe(oldVersion);
    expect((await authority.prepareCanvas(next, AREA)).ok).toBe(true);
    expect(authority.eligible(oldIntent, oldIntent.writable)).toBe(false);
    const after = structuredClone(next);
    after.nodeData.model.sharedWorldInstance = { kind: "world-instance", version: "shared-world-v1", instanceId: TARGET.instanceId, transform: pose(4, 4) };
    const resolved = authority.resolve(oldIntent, next, after, [TARGET]);
    expect(resolved?.previous[0].version).toBe(worldObjectVersion(next, TARGET));
    expect(resolved?.previous[0].version).not.toBe(oldVersion);
    expect(() => leases.validateForCommit(next.id, oldIntent.requestId, oldIntent.runId, oldIntent.epoch,
      oldIntent.executionId, oldIntent.scope, resolved!.previous)).toThrow("version-conflict");
    const shared = structuredClone(before);
    shared.document.nodes.push({ id: "model-copy", type: "model3d", position: { x: 0, y: 0 } });
    shared.nodeData["model-copy"] = structuredClone(shared.nodeData.model);
    shared.nodeData["model-copy"].sharedWorldInstance = {
      kind: "world-instance", version: "shared-world-v1", instanceId: "second-instance", transform: pose(5, 5) };
    const updated = structuredClone(shared); updated.assets[0] = asset(nextBytes);
    expect(affectedWorldObjects(shared, updated)).toEqual([TARGET, { kind: "instance", instanceId: "second-instance" }]);
  });

  it("commits ordinary and GLB assistant moves through the same durable scope and reads back the exact results", async () => {
    const bytes = glb(), canvas = fixture(bytes);
    const definition = normalizeModelDefinition({ modelScript: "scene.box({ id: 'body', size: [1, 1, 1] });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2" });
    if (!definition.ok) throw new Error(definition.reason);
    canvas.document.nodes.push({ id: "script-model", type: "model3d", position: { x: 0, y: 0 } });
    canvas.nodeData["script-model"] = { ...definition.value, modelContentVersion: definition.value.contentVersion,
      modelPlacement: definition.value.placement, sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: "script-instance", transform: pose(6, 6) } };
    delete canvas.nodeData["script-model"].contentVersion; delete canvas.nodeData["script-model"].placement;
    const test = await persistent(canvas, readFrom(bytes));
    const issued = await test.issue(); expect(issued.ok).toBe(true); if (!issued.ok) return;
    for (const [instanceId, u] of [[TARGET.instanceId, 3], ["script-instance", 7]] as const) {
      const target = { kind: "instance" as const, instanceId };
      const wrote = await test.assistant.write({ contextId: issued.context.contextId, operation: {
        kind: "set-model-transform", operationId: `move-${instanceId}`, instanceId,
        expectedVersion: worldObjectVersion(test.published(), target)!, transform: pose(u, u) } });
      expect(wrote).toMatchObject({ ok: true, instanceId });
    }
    const current = test.published();
    expect(current.revision).toBe(2);
    for (const [nodeId, u] of [["model", 3], ["script-model", 7]] as const) {
      const decoded = decodeWorldInstanceData(current.nodeData[nodeId].sharedWorldInstance);
      expect(decoded.ok && decoded.value.transform.position).toEqual({ u, v: u, h: 0 });
    }
    expect((await test.repository.loadYjsState(canvas.id))?.projection?.nodeData).toEqual(current.nodeData);
    const outside = await test.assistant.write({ contextId: issued.context.contextId, operation: {
      kind: "set-model-transform", operationId: "outside", instanceId: TARGET.instanceId,
      expectedVersion: worldObjectVersion(current, TARGET)!, transform: pose(30, 30) } });
    expect(outside).toMatchObject({ ok: false, code: "outside-scope" });
    expect(test.published().revision).toBe(2);
  });

  it("blocks normal asset.upsert while any shared GLB instance is leased", async () => {
    const before = glb(), next = glb(2), canvas = fixture(before);
    canvas.document.nodes.push({ id: "unleased-copy", type: "model3d", position: { x: 0, y: 0 } });
    canvas.nodeData["unleased-copy"] = structuredClone(canvas.nodeData.model);
    canvas.nodeData["unleased-copy"].sharedWorldInstance = {
      kind: "world-instance", version: "shared-world-v1", instanceId: "outside-instance", transform: pose(30, 30) };
    const test = await persistent(canvas, readFrom(before, next));
    const issued = await test.issue(); expect(issued.ok).toBe(true); if (!issued.ok) return;
    expect(issued.context.writableTargets.map(entry => entry.target)).toEqual([
      { ...TARGET, version: worldObjectVersion(test.published(), TARGET) }
    ]);
    const rejected = await test.upsert(asset(next), "replace-while-leased");
    expect(rejected).toMatchObject({ ok: false, code: "lease-conflict" });
    expect(test.published().assets).toEqual(canvas.assets);
    expect(test.published().revision).toBe(0);
  });

  it("maps a normal GLB area move to the same canonical produced object version", async () => {
    const bytes = glb(), canvas = fixture(bytes), test = await persistent(canvas, readFrom(bytes));
    const prepared = await test.authority.prepareCanvas(test.published(), AREA);
    expect(prepared.ok).toBe(true); if (!prepared.ok) return;
    const result = await test.worldAuthoring.execute({ canvasId: canvas.id, request: {
      contractVersion: "scene-area-plan-v1", canvasId: canvas.id, operationId: "move-glb-area", intent: "move",
      area: prepared.snapshot.area, members: prepared.snapshot.members, delta: { u: 1, v: 2 }
    } });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.receipt.produced.targets).toEqual([{ ...TARGET, version: worldObjectVersion(test.published(), TARGET) }]);
    const decoded = decodeWorldInstanceData(test.published().nodeData.model.sharedWorldInstance);
    expect(decoded.ok && decoded.value.transform.position).toEqual({ u: 3, v: 4, h: 0 });
    expect((await test.repository.loadYjsState(canvas.id))?.projection?.revision).toBe(1);
  });

  it("updates unleased assets normally and rejects old expectedVersion after prepare refresh", async () => {
    const before = glb(), next = glb(2), canvas = fixture(before);
    const test = await persistent(canvas, readFrom(before, next));
    const oldVersion = worldObjectVersion(test.published(), TARGET)!;
    expect(await test.upsert(asset(next), "replace-unleased")).toMatchObject({ ok: true });
    expect((await test.authority.prepareCanvas(test.published(), AREA)).ok).toBe(true);
    const issued = await test.issue(); expect(issued.ok).toBe(true); if (!issued.ok) return;
    const result = await test.assistant.write({ contextId: issued.context.contextId, operation: {
      kind: "set-model-transform", operationId: "stale-content-move", instanceId: TARGET.instanceId,
      expectedVersion: oldVersion, transform: pose(3, 3) } });
    expect(result).toMatchObject({ ok: false, code: "version-conflict" });
    expect(test.published().revision).toBe(1);
  });
});
