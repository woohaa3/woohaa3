import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SCENE_AREA_PLAN_CONTRACT_VERSION,
  createEmptyWoohaa3ServerCanvas,
  normalizeModelDefinition,
  parseCanvasAggregate,
  type SceneAreaPlanRequest,
  type ServerCanvas
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom } from "../services/canvas-service/src/sync/room.js";
import { SqliteYjsRepository } from "../services/canvas-service/src/storage/sqlite/yjs.js";
import { createCanvasService } from "../services/canvas-service/src/composition.js";
import { InMemoryCanvasRepository } from "../services/canvas-service/src/storage/core/in-memory-repository.js";
import { createInMemoryWriterLock } from "../services/canvas-service/src/sync/index.js";
import { createWorldAuthoringAuthority } from "../services/canvas-service/src/world-authoring/authority.js";
import type { CanvasServiceOptions } from "../services/canvas-service/src/composition/service-types.js";

const NOW = "2026-01-01T00:00:00Z";

type Harness = Awaited<ReturnType<typeof openHarness>>;
type Server = Awaited<ReturnType<typeof startServer>>;

const nodeDataOf = (canvas: ServerCanvas, nodeId: string) =>
  canvas.nodeData[nodeId] as unknown as Record<string, any>;

function instanceData(id: string, u: number, v: number, script = "scene.box({ id: 'body', size: [2, 2, 2] });") {
  const normalized = normalizeModelDefinition({
    modelScript: script,
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

function cameraData(id: string, u: number, v: number) {
  return {
    kind: "world-camera",
    version: "shared-world-v1",
    cameraId: id,
    settingsVersion: `${id}-v1`,
    position: { u, v, h: 1.5 },
    rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
    captureMode: { kind: "static" },
    aspect: { width: 16, height: 9 },
    boundInstanceId: null
  };
}

function canvasFixture(id = "canvas-scope-http"): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas(id, NOW);
  canvas.document.nodes.push(
    { id: "area", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "complete", type: "model3d", position: { x: 0, y: 0 } },
    { id: "partial", type: "model3d", position: { x: 0, y: 0 } },
    { id: "outside", type: "model3d", position: { x: 0, y: 0 } },
    { id: "camera-card", type: "world-camera", position: { x: 900, y: 900 } },
    { id: "group", type: "workflow-group-2d", position: { x: 0, y: 0 } }
  );
  canvas.nodeData.area = {
    sceneArea: {
      kind: "scene-area",
      version: "shared-world-v1",
      areaId: "area-main",
      scopeVersion: "area-scope-1",
      bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
    }
  };
  canvas.nodeData.complete = instanceData("complete-a", 1, 1);
  canvas.nodeData.partial = instanceData("partial-b", 9.5, 1);
  canvas.nodeData.outside = instanceData("outside-c", 20, 20);
  canvas.nodeData["camera-card"] = { worldCamera: cameraData("camera-in", 5, 5) };
  canvas.nodeData.group = {
    workflowGroup2d: {
      kind: "workflow-group-2d",
      version: "shared-world-v1",
      groupId: "group-1",
      scopeVersion: "group-scope-1",
      memberNodeIds: ["complete", "camera-card"]
    }
  };
  canvas.assets.push({
    id: "asset-generated",
    title: "generated",
    mediaKind: "image",
    source: "generated",
    status: "ready",
    url: "https://example.test/generated.png",
    createdAt: NOW
  });
  canvas.jobs.push({ id: "job-1", nodeId: "complete", taskId: "task-1", status: "success", updatedAt: NOW });
  return canvas;
}

async function openHarness(options: {
  canvas?: ServerCanvas;
  file?: string;
  dir?: string;
  initialize?: boolean;
  serviceOptions?: Partial<CanvasServiceOptions>;
} = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "scope-http-"));
  const file = options.file ?? join(dir, "canvas.sqlite");
  const canvas = options.canvas ?? canvasFixture();
  const initialize = options.initialize !== false;
  if (initialize) expect(parseCanvasAggregate(canvas, { now: NOW }).ok).toBe(true);
  const authority = createWorldAuthoringAuthority({ verifyStopped: () => true });
  const repository = new SqliteYjsRepository({ path: file, spatialAuthority: authority });
  if (initialize) {
    await new CanvasRoom({ canvasId: canvas.id, repository }).initialize({ canvas, roomEpoch: "e", createdAt: NOW });
  }
  const catalog = new InMemoryCanvasRepository();
  if (initialize) await catalog.createCanvas(canvas);
  const service = await createCanvasService({
    repository: catalog,
    yjsRepository: repository,
    storageConfig: { backend: "sqlite", sqlitePath: file, limits: {} },
    writerLock: createInMemoryWriterLock(),
    spatialAuthority: authority,
    mediaClient: {
      async verify() { return { exists: true, matches: true }; }
    },
    ...options.serviceOptions
  });
  return { dir, file, canvas, authority, repository, catalog, service };
}

async function closeHarness(harness: Harness, remove = true): Promise<void> {
  await harness.service.close();
  harness.repository.close();
  if (remove) rmSync(harness.dir, { recursive: true, force: true });
}

async function canonical(harness: Harness, canvasId = harness.canvas.id): Promise<ServerCanvas> {
  const room = await harness.service.sync!.registry.resolve(canvasId);
  const snapshot = await room.inspectPublished(value => value);
  if (!snapshot.ok) throw new Error(snapshot.message);
  return snapshot.canvas;
}

function batch(canvasId: string, commandId: string, commands: unknown[]) {
  return {
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId,
    commandId,
    actorId: "manual",
    baseRevision: 0,
    commands
  } as never;
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
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function get(base: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

function moveRequest(
  snapshot: { canvasId: string; area: SceneAreaPlanRequest["area"]; members: SceneAreaPlanRequest["members"] },
  operationId: string,
  delta = { u: 2, v: 1 }
): SceneAreaPlanRequest {
  return {
    contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
    canvasId: snapshot.canvasId,
    operationId,
    intent: "move",
    area: snapshot.area,
    members: snapshot.members,
    delta
  };
}

async function stopContext(harness: Harness, requestId: string, run: { runId: string; epoch: number; executionId: string }) {
  await harness.service.spatialWrites!.confirmStopped(
    harness.canvas.id,
    requestId,
    run.runId,
    run.epoch,
    run.executionId,
    true
  );
}

async function issueContext(base: string, canvasId: string, requestId: string, runId: string, epoch = 1) {
  return post(base, `/api/canvases/${canvasId}/world-tool-context`, {
    requestId,
    runId,
    epoch,
    executionId: `exec-${requestId}`,
    scope: { kind: "scene-area", areaId: "area-main" }
  });
}

describe("scene-area HTTP seams over real CanvasRoom, SQLite and Yjs", () => {
  it("moves the fixed gesture set, keeps late objects out, and survives cancel/undo/redo over HTTP", async () => {
    const harness = await openHarness();
    const server = await startServer(harness);
    const canvasId = harness.canvas.id;
    try {
      const prepare = await post(server.base, `/api/canvases/${canvasId}/scene-area-prepare`, { areaId: "area-main" });
      expect(prepare.status).toBe(200);
      expect(prepare.body).toMatchObject({ ok: true, snapshot: { canvasId } });
      const snapshot = prepare.body.snapshot;
      expect(snapshot.writable.map((target: any) => target.kind === "instance" ? target.instanceId : target.cameraId).sort())
        .toEqual(["camera-in", "complete-a"]);
      expect(snapshot.readOnly.map((target: any) => target.kind === "instance" ? target.instanceId : target.cameraId))
        .toEqual(["partial-b"]);

      const context = await issueContext(server.base, canvasId, "http-move-request", "http-move-run");
      expect(context.status).toBe(200);
      expect(context.body).toMatchObject({ ok: true, context: { canvasId } });
      expect(JSON.stringify(context.body)).not.toContain("capability");

      // A model that appears after the gesture started must never join the fixed set.
      const room = await harness.service.sync!.registry.resolve(canvasId);
      expect(await room.submit(batch(canvasId, "late-model", [{
        type: "node.add",
        node: { id: "late", type: "model3d", position: { x: 0, y: 0 } },
        nodeData: instanceData("late-d", 4, 4)
      }] as never))).toMatchObject({ ok: true });

      const commit = await post(server.base, `/api/canvases/${canvasId}/scene-area-commit`, {
        contextId: context.body.context.contextId,
        request: moveRequest(snapshot, "http-move")
      });
      expect(commit.status).toBe(200);
      expect(commit.body).toMatchObject({ ok: true, operationId: "http-move", duplicate: false });
      const moved = await canonical(harness);
      expect(nodeDataOf(moved, "complete").sharedWorldInstance.transform.position).toMatchObject({ u: 3, v: 2, h: 0 });
      expect(nodeDataOf(moved, "camera-card").worldCamera.position).toMatchObject({ u: 7, v: 6, h: 1.5 });
      expect(nodeDataOf(moved, "area").sceneArea.bounds.min).toEqual({ u: 2, v: 1 });
      expect(nodeDataOf(moved, "partial").sharedWorldInstance.transform.position).toMatchObject({ u: 9.5, v: 1 });
      expect(nodeDataOf(moved, "outside").sharedWorldInstance.transform.position).toMatchObject({ u: 20, v: 20 });
      expect(nodeDataOf(moved, "late").sharedWorldInstance.transform.position).toMatchObject({ u: 4, v: 4 });

      const retried = await post(server.base, `/api/canvases/${canvasId}/scene-area-commit`, {
        contextId: context.body.context.contextId,
        request: moveRequest(snapshot, "http-move")
      });
      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({ ok: true, duplicate: true, revision: commit.body.revision });

      const changedIntent = await post(server.base, `/api/canvases/${canvasId}/scene-area-commit`, {
        contextId: context.body.context.contextId,
        request: moveRequest(snapshot, "http-move", { u: 9, v: 9 })
      });
      expect(changedIntent.status).toBe(409);
      expect(changedIntent.body).toMatchObject({ ok: false, code: "operation-conflict" });

      const revoke = await post(server.base, `/api/canvases/${canvasId}/world-tool-context-revoke`, {
        contextId: context.body.context.contextId
      });
      expect(revoke.status).toBe(200);
      const beforeCancelledWrite = await canonical(harness);
      const cancelled = await post(server.base, `/api/canvases/${canvasId}/scene-area-commit`, {
        contextId: context.body.context.contextId,
        request: moveRequest(snapshot, "http-after-cancel", { u: 0, v: 0 })
      });
      expect(cancelled.status).toBe(409);
      expect(cancelled.body).toMatchObject({ ok: false, code: "stale-epoch" });
      expect(await canonical(harness)).toEqual(beforeCancelledWrite);
      await stopContext(harness, "http-move-request", context.body.run);

      const undo = await post(server.base, `/api/canvases/${canvasId}/scene-area-undo`, { operationId: "http-move" });
      expect(undo.status).toBe(200);
      expect(undo.body).toMatchObject({ ok: true, direction: "undo" });
      const restored = await canonical(harness);
      expect(nodeDataOf(restored, "complete").sharedWorldInstance.transform.position).toMatchObject({ u: 1, v: 1 });
      expect(nodeDataOf(restored, "camera-card").worldCamera.position).toMatchObject({ u: 5, v: 5 });
      expect(nodeDataOf(restored, "area").sceneArea.bounds.min).toEqual({ u: 0, v: 0 });
      expect(nodeDataOf(restored, "late").sharedWorldInstance.transform.position).toMatchObject({ u: 4, v: 4 });

      // Redo replays only the frozen set and never absorbs an object inserted after undo.
      const roomAfterUndo = await harness.service.sync!.registry.resolve(canvasId);
      expect(await roomAfterUndo.submit(batch(canvasId, "new-after-undo", [{
        type: "node.add",
        node: { id: "new-after", type: "model3d", position: { x: 0, y: 0 } },
        nodeData: instanceData("new-after-e", 4, 4)
      }] as never))).toMatchObject({ ok: true });
      const redo = await post(server.base, `/api/canvases/${canvasId}/scene-area-redo`, { operationId: "http-move" });
      expect(redo.status).toBe(200);
      expect(redo.body).toMatchObject({ ok: true, direction: "redo" });
      const redone = await canonical(harness);
      expect(nodeDataOf(redone, "complete").sharedWorldInstance.transform.position).toMatchObject({ u: 3, v: 2 });
      expect(nodeDataOf(redone, "late").sharedWorldInstance.transform.position).toMatchObject({ u: 4, v: 4 });
      expect(nodeDataOf(redone, "new-after").sharedWorldInstance.transform.position).toMatchObject({ u: 4, v: 4 });
    } finally {
      await server.close();
      await closeHarness(harness);
    }
  });

  it("resizes without moving contents, keeps content on default delete, and restores an explicit delete after reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-http-reopen-"));
    const file = join(dir, "canvas.sqlite");
    let harness: Harness | null = await openHarness({ dir, file });
    let server: Server | null = await startServer(harness);
    let reopened: Harness | null = null;
    let reopenedServer: Server | null = null;
    const canvasId = harness.canvas.id;
    try {
      const prepare = await post(server.base, `/api/canvases/${canvasId}/scene-area-prepare`, { areaId: "area-main" });
      expect(prepare.status).toBe(200);
      const beforeResize = await canonical(harness);
      const resize = await post(server.base, `/api/canvases/${canvasId}/scene-area-commit`, {
        request: {
          contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
          canvasId,
          operationId: "http-resize",
          intent: "resize",
          area: prepare.body.snapshot.area,
          members: prepare.body.snapshot.members,
          bounds: { min: { u: -2, v: -2 }, max: { u: 9.8, v: 9 } }
        }
      });
      expect(resize.status).toBe(200);
      expect(resize.body).toMatchObject({ ok: true, operationId: "http-resize" });
      const resized = await canonical(harness);
      expect(nodeDataOf(resized, "area").sceneArea.bounds).toEqual({ min: { u: -2, v: -2 }, max: { u: 9.8, v: 9 } });
      expect(resized.nodeData.complete).toEqual(beforeResize.nodeData.complete);
      expect(resized.nodeData["camera-card"]).toEqual(beforeResize.nodeData["camera-card"]);

      const preparedDelete = await post(server.base, `/api/canvases/${canvasId}/scene-area-prepare`, { areaId: "area-main" });
      expect(preparedDelete.status).toBe(200);
      const deleteArea = await post(server.base, `/api/canvases/${canvasId}/scene-area-commit`, {
        request: {
          contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
          canvasId,
          operationId: "http-delete-area",
          intent: "delete-area",
          area: preparedDelete.body.snapshot.area,
          members: preparedDelete.body.snapshot.members
        }
      });
      expect(deleteArea.status).toBe(200);
      const areaOnly = await canonical(harness);
      expect(areaOnly.document.nodes.some(node => node.id === "area")).toBe(false);
      expect(areaOnly.document.nodes.some(node => node.id === "complete")).toBe(true);
      expect(areaOnly.document.nodes.some(node => node.id === "camera-card")).toBe(true);
      expect(areaOnly.assets.map(asset => asset.id)).toContain("asset-generated");
      expect(areaOnly.jobs.map(job => job.id)).toContain("job-1");

      const undoAreaDelete = await post(server.base, `/api/canvases/${canvasId}/scene-area-undo`, { operationId: "http-delete-area" });
      expect(undoAreaDelete.status).toBe(200);
      expect(nodeDataOf(await canonical(harness), "area").sceneArea.bounds).toEqual({ min: { u: -2, v: -2 }, max: { u: 9.8, v: 9 } });

      const room = await harness.service.sync!.registry.resolve(canvasId);
      expect(await room.submit(batch(canvasId, "add-scope-edges", [
        { type: "edge.add", edge: { id: "edge-complete-partial", source: "complete", target: "partial", data: { kind: "dependency" } } },
        { type: "edge.add", edge: { id: "edge-complete-camera", source: "complete", target: "camera-card", data: { kind: "dependency" } } }
      ] as never))).toMatchObject({ ok: true });

      const preparedContents = await post(server.base, `/api/canvases/${canvasId}/scene-area-prepare`, { areaId: "area-main" });
      expect(preparedContents.status).toBe(200);
      const deleteContents = await post(server.base, `/api/canvases/${canvasId}/scene-area-commit`, {
        request: {
          contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
          canvasId,
          operationId: "http-delete-contents",
          intent: "delete-area-with-contents",
          area: preparedContents.body.snapshot.area,
          members: preparedContents.body.snapshot.members
        }
      });
      expect(deleteContents.status).toBe(200);
      const withContents = await canonical(harness);
      expect(withContents.document.nodes.some(node => node.id === "area")).toBe(false);
      expect(withContents.document.nodes.some(node => node.id === "complete")).toBe(false);
      expect(withContents.document.nodes.some(node => node.id === "camera-card")).toBe(false);
      expect(withContents.document.nodes.some(node => node.id === "partial")).toBe(true);
      expect(withContents.document.nodes.some(node => node.id === "outside")).toBe(true);
      expect(withContents.assets.map(asset => asset.id)).toContain("asset-generated");
      expect(withContents.jobs.map(job => job.id)).toContain("job-1");
      expect(withContents.document.edges).toEqual([]);

      await server.close();
      server = null;
      await harness.service.close();
      harness.repository.close();
      harness = null;

      reopened = await openHarness({ dir, file, initialize: false });
      reopenedServer = await startServer(reopened);
      const undoContents = await post(reopenedServer.base, `/api/canvases/${canvasId}/scene-area-undo`, {
        operationId: "http-delete-contents"
      });
      expect(undoContents.status).toBe(200);
      expect(undoContents.body).toMatchObject({ ok: true, direction: "undo" });
      const restored = await canonical(reopened);
      expect(restored.document.nodes.some(node => node.id === "area")).toBe(true);
      expect(restored.document.nodes.some(node => node.id === "complete")).toBe(true);
      expect(restored.document.nodes.some(node => node.id === "camera-card")).toBe(true);
      expect(restored.document.nodes.some(node => node.id === "partial")).toBe(true);
      expect(restored.assets.map(asset => asset.id)).toContain("asset-generated");
      expect(restored.document.edges.map(edge => edge.id).sort())
        .toEqual(["edge-complete-camera", "edge-complete-partial"]);

      const secondUndo = await post(reopenedServer.base, `/api/canvases/${canvasId}/scene-area-undo`, {
        operationId: "http-delete-contents"
      });
      expect(secondUndo.status).toBe(409);
      expect(secondUndo.body).toMatchObject({ ok: false, code: "operation-conflict" });

      const redoContents = await post(reopenedServer.base, `/api/canvases/${canvasId}/scene-area-redo`, {
        operationId: "http-delete-contents"
      });
      expect(redoContents.status).toBe(200);
      expect(redoContents.body).toMatchObject({ ok: true, direction: "redo" });
      const redone = await canonical(reopened);
      expect(redone.document.nodes.some(node => node.id === "complete")).toBe(false);
      expect(redone.document.nodes.some(node => node.id === "partial")).toBe(true);
      expect(redone.assets.map(asset => asset.id)).toContain("asset-generated");
    } finally {
      if (server) await server.close();
      if (harness) await closeHarness(harness, false);
      if (reopenedServer) await reopenedServer.close();
      if (reopened) await closeHarness(reopened, false);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects occupancy and stale source versions as whole batches over HTTP", async () => {
    const harness = await openHarness();
    const server = await startServer(harness);
    const canvasId = harness.canvas.id;
    try {
      const prepare = await post(server.base, `/api/canvases/${canvasId}/scene-area-prepare`, { areaId: "area-main" });
      expect(prepare.status).toBe(200);
      const occupied = await issueContext(server.base, canvasId, "http-occupied", "run-occupied", 2);
      expect(occupied.status).toBe(200);
      const secondContext = await issueContext(server.base, canvasId, "http-occupied-second", "run-occupied-second");
      expect(secondContext.status).toBe(409);
      expect(secondContext.body).toMatchObject({
        ok: false,
        code: "lease-conflict",
        conflicts: [{ runId: "run-occupied", epoch: 2 }]
      });

      const beforeOccupied = await canonical(harness);
      const occupiedCommit = await post(server.base, `/api/canvases/${canvasId}/scene-area-commit`, {
        request: moveRequest(prepare.body.snapshot, "http-occupied-move")
      });
      expect(occupiedCommit.status).toBe(409);
      expect(occupiedCommit.body).toMatchObject({
        ok: false,
        code: "lease-conflict",
        conflicts: [{ runId: "run-occupied", epoch: 2 }]
      });
      expect(await canonical(harness)).toEqual(beforeOccupied);
      expect(await harness.repository.getCommandRecord(canvasId, "scene-area:http-occupied-move")).toBeNull();

      await post(server.base, `/api/canvases/${canvasId}/world-tool-context-revoke`, {
        contextId: occupied.body.context.contextId
      });
      await stopContext(harness, "http-occupied", occupied.body.run);

      const stalePrepare = await post(server.base, `/api/canvases/${canvasId}/scene-area-prepare`, { areaId: "area-main" });
      expect(stalePrepare.status).toBe(200);
      const staleRequest = moveRequest(stalePrepare.body.snapshot, "http-stale-source", { u: -1, v: 0 });
      const current = await canonical(harness);
      const completeData = nodeDataOf(current, "complete");
      const room = await harness.service.sync!.registry.resolve(canvasId);
      expect(await room.submit(batch(canvasId, "manual-complete-change", [{
        type: "nodeData.patch",
        nodeId: "complete",
        value: {
          ...completeData,
          sharedWorldInstance: {
            ...completeData.sharedWorldInstance,
            transform: { ...completeData.sharedWorldInstance.transform, position: { u: 8, v: 8, h: 0 } }
          }
        }
      }] as never))).toMatchObject({ ok: true });
      const beforeConflict = await canonical(harness);
      const staleCommit = await post(server.base, `/api/canvases/${canvasId}/scene-area-commit`, { request: staleRequest });
      expect(staleCommit.status).toBe(409);
      expect(staleCommit.body).toMatchObject({ ok: false, code: "version-conflict" });
      expect(await canonical(harness)).toEqual(beforeConflict);
      expect(await harness.repository.getCommandRecord(canvasId, "scene-area:http-stale-source")).toBeNull();
    } finally {
      await server.close();
      await closeHarness(harness);
    }
  });

  it("denies a commit without write permission before the batch can change the canvas", async () => {
    let writeChecks = 0;
    const harness = await openHarness({
      serviceOptions: {
        authenticate: async () => ({ subject: "scope-http-reviewer" }) as never,
        access: {
          async authorize(input) {
            if (input.permission !== "write") return { allowed: true };
            writeChecks += 1;
            return writeChecks <= 1
              ? { allowed: true }
              : { allowed: false, code: "forbidden", message: "写权限已撤销" };
          }
        }
      }
    });
    const server = await startServer(harness);
    const canvasId = harness.canvas.id;
    try {
      const prepare = await post(server.base, `/api/canvases/${canvasId}/scene-area-prepare`, { areaId: "area-main" });
      expect(prepare.status).toBe(200);
      const beforeDenied = await canonical(harness);
      const denied = await post(server.base, `/api/canvases/${canvasId}/scene-area-commit`, {
        request: moveRequest(prepare.body.snapshot, "http-permission-denied")
      });
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ ok: false, code: "write-forbidden" });
      expect(await canonical(harness)).toEqual(beforeDenied);
      expect(await harness.repository.getCommandRecord(canvasId, "scene-area:http-permission-denied")).toBeNull();
    } finally {
      await server.close();
      await closeHarness(harness);
    }
  });

  it("does not authorize unknown bounds or persist a lease when preparation is unavailable", async () => {
    const unknownCanvas = canvasFixture("canvas-scope-unknown");
    unknownCanvas.document.nodes.push({ id: "broken", type: "model3d", position: { x: 0, y: 0 } });
    unknownCanvas.nodeData.broken = instanceData("broken", 2, 2, "");
    const harness = await openHarness({ canvas: unknownCanvas });
    const server = await startServer(harness);
    const canvasId = unknownCanvas.id;
    try {
      const prepare = await post(server.base, `/api/canvases/${canvasId}/scene-area-prepare`, { areaId: "area-main" });
      expect(prepare.status).toBe(409);
      expect(prepare.body).toMatchObject({ ok: false, code: "not-ready" });

      const context = await issueContext(server.base, canvasId, "http-unknown", "run-unknown");
      expect(context.status).toBe(409);
      expect(context.body).toMatchObject({ ok: false, code: "not-ready" });
      expect(harness.repository.debugQuery("SELECT COUNT(*) AS count FROM spatial_lease_runs")).toEqual([{ count: 0 }]);
      expect((await canonical(harness)).revision).toBe(0);
    } finally {
      await server.close();
      await closeHarness(harness);
    }
  });

  it("serves camera save, history and restore through the same real HTTP and SQLite seams", async () => {
    const harness = await openHarness();
    const server = await startServer(harness);
    const canvasId = harness.canvas.id;
    try {
      const prepare = await post(server.base, `/api/canvases/${canvasId}/scene-area-prepare`, { areaId: "area-main" });
      expect(prepare.status).toBe(200);
      const cameraMember = prepare.body.snapshot.members.cameras.find(
        (member: any) => member.identity.cameraId === "camera-in"
      );
      expect(cameraMember).toBeDefined();

      const context = await issueContext(server.base, canvasId, "http-camera", "run-camera");
      expect(context.status).toBe(200);

      const settings = {
        position: { u: 6, v: 4, h: 1.5 },
        rotation: [0, 0, 0, 1],
        projection: cameraMember.camera.projection,
        captureMode: cameraMember.camera.captureMode,
        aspect: cameraMember.camera.aspect,
        boundInstanceId: null
      };
      const save = await post(server.base, `/api/canvases/${canvasId}/world-camera-save`, {
        cameraId: "camera-in",
        expectedSettingsVersion: cameraMember.version,
        contextId: context.body.context.contextId,
        settings
      });
      expect(save.status).toBe(200);
      expect(save.body).toMatchObject({ ok: true, cameraId: "camera-in" });
      expect(save.body.settingsVersion).not.toBe(cameraMember.version);
      const saved = await canonical(harness);
      expect(nodeDataOf(saved, "camera-card").worldCamera.position).toMatchObject({ u: 6, v: 4, h: 1.5 });

      const history = await get(server.base, `/api/canvases/${canvasId}/world-camera-history?cameraId=camera-in`);
      expect(history.status).toBe(200);
      expect(history.body).toMatchObject({ ok: true, cameraId: "camera-in", entries: [] });

      const beforeStale = await canonical(harness);
      const stale = await post(server.base, `/api/canvases/${canvasId}/world-camera-save`, {
        cameraId: "camera-in",
        expectedSettingsVersion: cameraMember.version,
        contextId: context.body.context.contextId,
        settings: { ...settings, position: { u: 1, v: 1, h: 1.5 } }
      });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ ok: false, code: "version-conflict" });
      expect(await canonical(harness)).toEqual(beforeStale);

      const forged = await post(server.base, `/api/canvases/${canvasId}/world-camera-save`, {
        cameraId: "camera-in",
        expectedSettingsVersion: save.body.settingsVersion,
        contextId: "forged-camera-context",
        settings: { ...settings, position: { u: 2, v: 2, h: 1.5 } }
      });
      expect(forged.status).toBe(409);
      expect(forged.body).toMatchObject({ ok: false, code: "stale-epoch" });
      expect(await canonical(harness)).toEqual(beforeStale);

      const restore = await post(server.base, `/api/canvases/${canvasId}/world-camera-restore`, {
        cameraId: "camera-in",
        completionKey: "missing-completion",
        expectedSettingsVersion: save.body.settingsVersion
      });
      expect(restore.status).toBe(404);
      expect(restore.body).toMatchObject({ ok: false, code: "not-found" });

      await post(server.base, `/api/canvases/${canvasId}/world-tool-context-revoke`, {
        contextId: context.body.context.contextId
      });
      await stopContext(harness, "http-camera", context.body.run);
    } finally {
      await server.close();
      await closeHarness(harness);
    }
  });
});
