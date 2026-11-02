import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  normalizeModelDefinition,
  parseCanvasAggregate,
  remapWorldCopyReferences,
  rendererToWorldRotation,
  worldCameraCompletionKey,
  type WorldCameraData,
  type WorldCameraHistoryEntry,
  type WorldCompletion,
  type WorldRotation
} from "@woohaa3/contracts";
import { CanvasRoom } from "../services/canvas-service/src/sync/room.js";
import { SqliteYjsRepository } from "../services/canvas-service/src/storage/sqlite/yjs.js";
import { createCanvasService } from "../services/canvas-service/src/composition.js";
import { InMemoryCanvasRepository } from "../services/canvas-service/src/storage/core/in-memory-repository.js";
import { createInMemoryWriterLock } from "../services/canvas-service/src/sync/index.js";
import { createWorldAuthoringAuthority } from "../services/canvas-service/src/world-authoring/authority.js";

const NOW = "2026-01-01T00:00:00Z";
const CANVAS_ID = "canvas-camera";
const CAMERA_ID = "camera-1";
const INSTANCE_ID = "instance-1";

type Vec3 = [number, number, number];

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function quatFromBasis(right: Vec3, up: Vec3, back: Vec3): [number, number, number, number] {
  const m00 = right[0], m01 = up[0], m02 = back[0];
  const m10 = right[1], m11 = up[1], m12 = back[1];
  const m20 = right[2], m21 = up[2], m22 = back[2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

function worldRotationFor(forward: Vec3): WorldRotation {
  const back = normalize([-forward[0], -forward[1], -forward[2]]);
  const right = normalize(cross([0, 1, 0], back));
  const up = cross(back, right);
  return rendererToWorldRotation(quatFromBasis(right, up, back));
}

const ISOMETRIC_ROTATION = worldRotationFor([1, 1, -1]);

function instanceData(id: string, u: number, v: number) {
  const normalized = normalizeModelDefinition({
    modelScript: "scene.box({ id: 'body', size: [2, 2, 2] });",
    modelScriptLanguage: "javascript",
    modelScriptVersion: "woohaa-model-js-v2",
    placement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
  });
  if (!normalized.ok) throw new Error(normalized.reason);
  return {
    sharedWorldInstance: {
      kind: "world-instance",
      version: "shared-world-v1",
      instanceId: id,
      transform: {
        version: "shared-world-v1",
        position: { u, v, h: 0 },
        rotation: [0, 0, 0, 1],
        scale: 1
      }
    },
    modelScript: normalized.value.modelScript,
    modelScriptLanguage: normalized.value.modelScriptLanguage,
    modelScriptVersion: normalized.value.modelScriptVersion,
    modelContentVersion: normalized.value.contentVersion,
    modelPlacement: normalized.value.placement
  };
}

function cameraData(): WorldCameraData {
  return {
    kind: "world-camera",
    version: "shared-world-v1",
    cameraId: CAMERA_ID,
    settingsVersion: "camera-1-v1",
    position: { u: 5, v: 5, h: 1.5 },
    rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
    captureMode: { kind: "static" },
    aspect: { width: 16, height: 9 },
    boundInstanceId: INSTANCE_ID
  };
}

function canvasFixture() {
  const canvas = createEmptyWoohaa3ServerCanvas(CANVAS_ID, NOW);
  canvas.document.nodes.push(
    { id: "area-main", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "area-other", type: "scene-area", position: { x: 800, y: 0 } },
    { id: "model-node", type: "model3d", position: { x: 0, y: 0 } },
    { id: "camera-card", type: "world-camera", position: { x: 900, y: 900 } }
  );
  canvas.nodeData["area-main"] = {
    sceneArea: {
      kind: "scene-area",
      version: "shared-world-v1",
      areaId: "area-main",
      scopeVersion: "area-main-v1",
      bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
    }
  };
  canvas.nodeData["area-other"] = {
    sceneArea: {
      kind: "scene-area",
      version: "shared-world-v1",
      areaId: "area-other",
      scopeVersion: "area-other-v1",
      bounds: { min: { u: 100, v: 0 }, max: { u: 110, v: 10 } }
    }
  };
  canvas.nodeData["model-node"] = instanceData(INSTANCE_ID, 2, 2);
  canvas.nodeData["camera-card"] = { worldCamera: cameraData() } as never;
  return canvas;
}

async function openHarness(options: { dir?: string; file?: string; initialize?: boolean } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "world-camera-history-"));
  const file = options.file ?? join(dir, "canvas.sqlite");
  const canvas = canvasFixture();
  const initialize = options.initialize !== false;
  if (initialize) expect(parseCanvasAggregate(canvas, { now: NOW }).ok).toBe(true);
  const authority = createWorldAuthoringAuthority({ verifyStopped: () => true });
  const repository = new SqliteYjsRepository({ path: file, spatialAuthority: authority });
  if (initialize) {
    await new CanvasRoom({ canvasId: CANVAS_ID, repository }).initialize({ canvas, roomEpoch: "e", createdAt: NOW });
  }
  const catalog = new InMemoryCanvasRepository();
  if (initialize) await catalog.createCanvas(canvas);
  const service = await createCanvasService({
    repository: catalog,
    yjsRepository: repository,
    storageConfig: { backend: "sqlite", sqlitePath: file, limits: {} },
    writerLock: createInMemoryWriterLock(),
    spatialAuthority: authority,
    verifyWorldCameraCompletion: (_completion, evidence) => evidence === "trusted",
    now: () => NOW,
    mediaClient: {
      async verify() { return { exists: true, matches: true }; }
    }
  });
  return { dir, file, canvas, repository, service };
}

type Harness = Awaited<ReturnType<typeof openHarness>>;

async function closeHarness(harness: Harness, remove = false): Promise<void> {
  await harness.service.close();
  try { harness.repository.close(); } catch { /* already closed */ }
  if (remove) rmSync(harness.dir, { recursive: true, force: true });
}

async function canonical(harness: Harness) {
  const room = await harness.service.sync!.registry.resolve(CANVAS_ID);
  const snapshot = await room!.inspectPublished(value => value);
  if (!snapshot.ok) throw new Error(snapshot.message);
  return snapshot.canvas;
}

async function startServer(harness: Harness): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void harness.service.handle(req, res).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}

async function request(
  base: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function cameraOf(canvas: Awaited<ReturnType<typeof canonical>>): WorldCameraData {
  const data = canvas.nodeData["camera-card"] as unknown as { worldCamera: WorldCameraData };
  return data.worldCamera;
}

function completionFor(camera: WorldCameraData, overrides: Partial<WorldCompletion> = {}): WorldCompletion {
  return {
    canvasId: CANVAS_ID,
    runId: "trusted-run-1",
    completionId: "completion-1",
    cameraId: camera.cameraId,
    settingsVersion: camera.settingsVersion,
    ...overrides
  };
}

describe("world camera settings and assistant history", () => {
  it("saves isometric settings, keeps them across Yjs reload and ignores card layout changes", async () => {
    const harness = await openHarness();
    try {
      const service = harness.service.cameraSettings!;
      const saved = await service.save({
        canvasId: CANVAS_ID,
        cameraId: CAMERA_ID,
        expectedSettingsVersion: "camera-1-v1",
        settings: {
          position: { u: 6, v: 6, h: 2 },
          rotation: ISOMETRIC_ROTATION,
          projection: { kind: "isometric", verticalSizeMeters: 12, nearMeters: 0.05, farMeters: 200 },
          captureMode: { kind: "dynamic" },
          aspect: { width: 4, height: 3 },
          boundInstanceId: INSTANCE_ID
        }
      });
      expect(saved).toMatchObject({ ok: true, duplicate: false });
      if (!saved.ok) return;
      expect(saved.camera).toMatchObject({
        projection: { kind: "isometric", verticalSizeMeters: 12 },
        captureMode: { kind: "dynamic" },
        aspect: { width: 4, height: 3 },
        boundInstanceId: INSTANCE_ID
      });
      expect(saved.camera.settingsVersion).not.toBe("camera-1-v1");

      // Moving the 2D camera card must not touch the framing payload.
      const room = await harness.service.sync!.registry.resolve(CANVAS_ID);
      const canvas = await canonical(harness);
      const moved = await room!.submit({
        protocolVersion: 7,
        canvasId: CANVAS_ID,
        commandId: "move-camera-card",
        actorId: "manual",
        baseRevision: canvas.revision,
        commands: [{ type: "node.update", nodeId: "camera-card", position: { x: 120, y: 240 } }]
      } as never);
      expect(moved.ok).toBe(true);
      expect(cameraOf(await canonical(harness))).toEqual(saved.camera);

      await closeHarness(harness);
      const reopened = await openHarness({ dir: harness.dir, file: harness.file, initialize: false });
      try {
        expect(cameraOf(await canonical(reopened))).toEqual(saved.camera);
      } finally {
        await closeHarness(reopened, true);
      }
    } catch (error) {
      await closeHarness(harness, true).catch(() => undefined);
      throw error;
    }
  });

  it("supports an explicit null binding and rejects a new unresolvable binding", async () => {
    const harness = await openHarness();
    try {
      const service = harness.service.cameraSettings!;
      const camera = cameraOf(await canonical(harness));
      const unbound = await service.save({
        canvasId: CANVAS_ID,
        cameraId: CAMERA_ID,
        expectedSettingsVersion: camera.settingsVersion,
        settings: {
          position: camera.position,
          rotation: camera.rotation,
          projection: camera.projection,
          captureMode: camera.captureMode,
          aspect: camera.aspect,
          boundInstanceId: null
        }
      });
      expect(unbound).toMatchObject({ ok: true });
      if (!unbound.ok) return;
      expect(unbound.camera.boundInstanceId).toBeNull();

      const missing = await service.save({
        canvasId: CANVAS_ID,
        cameraId: CAMERA_ID,
        expectedSettingsVersion: unbound.camera.settingsVersion,
        settings: {
          position: camera.position,
          rotation: camera.rotation,
          projection: camera.projection,
          captureMode: camera.captureMode,
          aspect: camera.aspect,
          boundInstanceId: "missing-instance"
        }
      });
      expect(missing).toMatchObject({ ok: false, code: "target-unavailable" });
      expect(cameraOf(await canonical(harness)).boundInstanceId).toBeNull();
    } finally {
      await closeHarness(harness, true);
    }
  });

  it("records exactly one trusted completion across retries and a service restart without capture-driven history", async () => {
    let harness = await openHarness();
    try {
      const camera = cameraOf(await canonical(harness));
      const completion = completionFor(camera);
      const first = await harness.service.cameraSettings!.complete({ completion, evidence: "trusted" });
      expect(first).toMatchObject({ ok: true, duplicate: false });
      if (!first.ok) return;
      expect(first.entry.snapshot.camera).toEqual(camera);

      const retry = await harness.service.cameraSettings!.complete({ completion, evidence: "trusted" });
      expect(retry).toMatchObject({ ok: true, duplicate: true });

      // Framing refresh / later generation must not create settings history.
      const saved = await harness.service.cameraSettings!.save({
        canvasId: CANVAS_ID,
        cameraId: CAMERA_ID,
        expectedSettingsVersion: camera.settingsVersion,
        settings: {
          ...camera,
          position: { u: 4, v: 4, h: 2 },
          projection: { kind: "perspective", verticalFovRadians: 0.7, nearMeters: 0.1, farMeters: 80 }
        }
      });
      expect(saved.ok).toBe(true);
      const list = await harness.service.cameraSettings!.history({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
      expect(list.ok && list.entries).toHaveLength(1);
      expect((list as { entries: WorldCameraHistoryEntry[] }).entries[0]!.completionKey)
        .toBe(worldCameraCompletionKey(completion));

      const untrusted = await harness.service.cameraSettings!.complete({
        completion: completionFor(saved.ok ? saved.camera : camera, { completionId: "completion-untrusted" }),
        evidence: "forged"
      });
      expect(untrusted).toMatchObject({ ok: false, code: "write-forbidden" });

      await closeHarness(harness);
      harness = await openHarness({ dir: harness.dir, file: harness.file, initialize: false });
      const afterRestart = await harness.service.cameraSettings!.complete({ completion, evidence: "trusted" });
      expect(afterRestart).toMatchObject({ ok: true, duplicate: true });
      const listAfter = await harness.service.cameraSettings!.history({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
      expect(listAfter.ok && listAfter.entries).toHaveLength(1);
    } finally {
      await closeHarness(harness, true);
    }
  });

  it("restores settings on the current world, keeps models untouched, and rejects stale or unavailable targets", async () => {
    const harness = await openHarness();
    try {
      const service = harness.service.cameraSettings!;
      const original = cameraOf(await canonical(harness));
      const recorded = await service.complete({ completion: completionFor(original), evidence: "trusted" });
      expect(recorded.ok).toBe(true);

      const second = await service.save({
        canvasId: CANVAS_ID,
        cameraId: CAMERA_ID,
        expectedSettingsVersion: original.settingsVersion,
        settings: {
          position: { u: 3, v: 3, h: 2.5 },
          rotation: [0, 0, 0, 1],
          projection: { kind: "perspective", verticalFovRadians: 0.5, nearMeters: 0.2, farMeters: 60 },
          captureMode: { kind: "static" },
          aspect: { width: 1, height: 1 },
          boundInstanceId: INSTANCE_ID
        }
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      const modelBefore = (await canonical(harness)).nodeData["model-node"];
      const restored = await service.restore({
        canvasId: CANVAS_ID,
        cameraId: CAMERA_ID,
        completionKey: worldCameraCompletionKey(completionFor(original)),
        expectedSettingsVersion: second.camera.settingsVersion
      });
      expect(restored).toMatchObject({ ok: true, duplicate: false });
      if (!restored.ok) return;
      expect(restored.camera.position).toEqual(original.position);
      expect(restored.camera.projection).toEqual(original.projection);
      expect(restored.camera.captureMode).toEqual(original.captureMode);
      expect(restored.camera.aspect).toEqual(original.aspect);
      expect(restored.camera.boundInstanceId).toBe(INSTANCE_ID);
      expect((await canonical(harness)).nodeData["model-node"]).toEqual(modelBefore);
      const afterRestore = await canonical(harness);
      expect(afterRestore.document.nodes.find(node => node.id === "camera-card")!.position).toEqual({ x: 900, y: 900 });
      const roomAfterRestore = await harness.service.sync!.registry.resolve(CANVAS_ID);
      expect(await roomAfterRestore!.lookupCommand(restored.commandId)).not.toBeNull();
      expect(restored.commandId.startsWith("world-camera-restore:")).toBe(true);

      const stale = await service.restore({
        canvasId: CANVAS_ID,
        cameraId: CAMERA_ID,
        completionKey: worldCameraCompletionKey(completionFor(original)),
        expectedSettingsVersion: second.camera.settingsVersion
      });
      expect(stale).toMatchObject({ ok: false, code: "version-conflict" });

      const room = await harness.service.sync!.registry.resolve(CANVAS_ID);
      const current = await canonical(harness);
      const removed = await room!.submit({
        protocolVersion: 7,
        canvasId: CANVAS_ID,
        commandId: "remove-bound-model",
        actorId: "manual",
        baseRevision: current.revision,
        commands: [{ type: "node.remove", nodeIds: ["model-node"] }]
      } as never);
      expect(removed.ok).toBe(true);
      const unavailable = await service.restore({
        canvasId: CANVAS_ID,
        cameraId: CAMERA_ID,
        completionKey: worldCameraCompletionKey(completionFor(original)),
        expectedSettingsVersion: cameraOf(await canonical(harness)).settingsVersion
      });
      expect(unavailable).toMatchObject({ ok: false, code: "target-unavailable" });
      expect(cameraOf(await canonical(harness)).boundInstanceId).toBe(INSTANCE_ID);
    } finally {
      await closeHarness(harness, true);
    }
  });

  it("enforces issued scope, stale contexts and occupancy for camera writes", async () => {
    const harness = await openHarness();
    try {
      const service = harness.service.cameraSettings!;
      const authoring = harness.service.worldAuthoring!;
      const camera = cameraOf(await canonical(harness));
      const initialSettings = {
        position: camera.position,
        rotation: camera.rotation,
        projection: camera.projection,
        captureMode: camera.captureMode,
        aspect: camera.aspect,
        boundInstanceId: camera.boundInstanceId
      };

      const outside = await authoring.issueContext({
        canvasId: CANVAS_ID,
        requestId: "request-outside",
        runId: "run-outside",
        epoch: 1,
        executionId: "exec-outside",
        scope: { kind: "scene-area", areaId: "area-other" }
      });
      expect(outside.ok).toBe(true);
      if (!outside.ok) return;
      expect(await service.save({
        canvasId: CANVAS_ID,
        cameraId: CAMERA_ID,
        expectedSettingsVersion: camera.settingsVersion,
        settings: initialSettings,
        contextId: outside.context.contextId
      })).toMatchObject({ ok: false, code: "outside-scope" });
      await harness.service.spatialWrites!.confirmStopped(CANVAS_ID, "request-outside", outside.run.runId, outside.run.epoch, outside.run.executionId, true);

      const issued = await authoring.issueContext({
        canvasId: CANVAS_ID,
        requestId: "request-main",
        runId: "run-main",
        epoch: 1,
        executionId: "exec-main",
        scope: { kind: "scene-area", areaId: "area-main" }
      });
      expect(issued.ok).toBe(true);
      if (!issued.ok) return;
      const blocked = await service.save({
        canvasId: CANVAS_ID,
        cameraId: CAMERA_ID,
        expectedSettingsVersion: camera.settingsVersion,
        settings: initialSettings
      });
      expect(blocked).toMatchObject({ ok: false, code: "lease-conflict" });

      const inScope = await service.save({
        canvasId: CANVAS_ID,
        cameraId: CAMERA_ID,
        expectedSettingsVersion: camera.settingsVersion,
        settings: initialSettings,
        contextId: issued.context.contextId
      });
      expect(inScope.ok).toBe(true);

      await authoring.revokeContext({ canvasId: CANVAS_ID, contextId: issued.context.contextId });
      await harness.service.spatialWrites!.confirmStopped(CANVAS_ID, "request-main", issued.run.runId, issued.run.epoch, issued.run.executionId, true);
      const stale = await service.save({
        canvasId: CANVAS_ID,
        cameraId: CAMERA_ID,
        expectedSettingsVersion: inScope.ok ? inScope.settingsVersion : camera.settingsVersion,
        settings: initialSettings,
        contextId: issued.context.contextId
      });
      expect(stale).toMatchObject({ ok: false, code: "stale-epoch" });
    } finally {
      await closeHarness(harness, true);
    }
  });

  it("exposes save/restore/history over the canvas HTTP boundary and no raw completion route", async () => {
    const harness = await openHarness();
    const server = await startServer(harness);
    try {
      const original = cameraOf(await canonical(harness));
      const completion = completionFor(original);
      const recorded = await harness.service.cameraSettings!.complete({ completion, evidence: "trusted" });
      expect(recorded.ok).toBe(true);

      const saved = await request(server.base, "POST", `/api/canvases/${CANVAS_ID}/world-camera-save`, {
        cameraId: CAMERA_ID,
        expectedSettingsVersion: original.settingsVersion,
        settings: {
          position: { u: 5, v: 6, h: 2 },
          rotation: [0, 0, 0, 1],
          projection: { kind: "perspective", verticalFovRadians: 0.9, nearMeters: 0.1, farMeters: 90 },
          captureMode: { kind: "dynamic" },
          aspect: { width: 16, height: 9 },
          boundInstanceId: INSTANCE_ID
        }
      });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ ok: true, cameraId: CAMERA_ID });
      const currentVersion = saved.body.settingsVersion as string;

      const restored = await request(server.base, "POST", `/api/canvases/${CANVAS_ID}/world-camera-restore`, {
        cameraId: CAMERA_ID,
        completionKey: worldCameraCompletionKey(completion),
        expectedSettingsVersion: currentVersion
      });
      expect(restored.status).toBe(200);
      expect(restored.body).toMatchObject({ ok: true, cameraId: CAMERA_ID, history: { completionKey: worldCameraCompletionKey(completion) } });

      const list = await request(server.base, "GET", `/api/canvases/${CANVAS_ID}/world-camera-history?cameraId=${CAMERA_ID}`);
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ ok: true, cameraId: CAMERA_ID });
      expect(list.body.entries).toHaveLength(1);

      const rawCompletion = await request(server.base, "POST", `/api/canvases/${CANVAS_ID}/world-camera-complete`, {
        completion,
        evidence: "forged"
      });
      expect(rawCompletion.status).toBe(404);
    } finally {
      await server.close();
      await closeHarness(harness, true);
    }
  });

  it("reuses the OC03 copy remap for camera identity and rejects unresolved external bindings", () => {
    const camera = cameraData();
    const copied = remapWorldCopyReferences({
      nodes: [
        { nodeId: "model-node", nodeData: { sharedWorldInstance: instanceData(INSTANCE_ID, 2, 2).sharedWorldInstance } },
        { nodeId: "camera-card", nodeData: { worldCamera: camera } }
      ],
      ids: {
        nodeIds: new Map([["model-node", "model-copy"], ["camera-card", "camera-copy"]]),
        instanceIds: new Map([[INSTANCE_ID, "instance-copy"]]),
        cameraIds: new Map([[CAMERA_ID, "camera-copy-id"]])
      }
    });
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    const copiedCamera = copied.nodes.find(node => node.nodeId === "camera-copy")!.nodeData
      .worldCamera as WorldCameraData;
    expect(copiedCamera.cameraId).toBe("camera-copy-id");
    expect(copiedCamera.boundInstanceId).toBe("instance-copy");

    const external = remapWorldCopyReferences({
      nodes: [{ nodeId: "camera-card", nodeData: { worldCamera: camera } }],
      ids: {
        nodeIds: new Map([["camera-card", "camera-copy"]]),
        cameraIds: new Map([[CAMERA_ID, "camera-copy-id"]])
      }
    });
    expect(external).toMatchObject({ ok: false, code: "binding-unavailable", field: "boundInstanceId" });
  });
});
