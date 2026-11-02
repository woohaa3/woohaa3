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
  type SceneAreaPlanMemberSet,
  type ServerCanvas
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom } from "../services/canvas-service/src/sync/room.js";
import { SqliteYjsRepository } from "../services/canvas-service/src/storage/sqlite/yjs.js";
import { createCanvasService } from "../services/canvas-service/src/composition.js";
import { InMemoryCanvasRepository } from "../services/canvas-service/src/storage/core/in-memory-repository.js";
import { createInMemoryWriterLock } from "../services/canvas-service/src/sync/index.js";
import { createWorldAuthoringAuthority, worldObjectVersion } from "../services/canvas-service/src/world-authoring/authority.js";

const NOW = "2026-01-01T00:00:00Z";

type Harness = Awaited<ReturnType<typeof openHarness>>;
const nodeDataOf = (canvas: ServerCanvas, nodeId: string) => canvas.nodeData[nodeId] as unknown as Record<string, any>;

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

function canvasFixture(id = "canvas-world"): ServerCanvas {
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

async function openHarness(options: { canvas?: ServerCanvas; file?: string; dir?: string; initialize?: boolean } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "world-authoring-"));
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
    }
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

function moveRequest(
  prepared: { ok: true; snapshot: { canvasId: string; area: SceneAreaPlanRequest["area"]; members: SceneAreaPlanMemberSet } },
  operationId: string,
  delta = { u: 2, v: 1 }
): SceneAreaPlanRequest {
  return {
    contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
    canvasId: prepared.snapshot.canvasId,
    operationId,
    intent: "move",
    area: prepared.snapshot.area,
    members: prepared.snapshot.members,
    delta
  };
}

function memberFor(canvas: ServerCanvas, nodeId: string): SceneAreaPlanMemberSet["instances"][number] {
  const data = canvas.nodeData[nodeId] as unknown as { sharedWorldInstance: { instanceId: string; transform: SceneAreaPlanMemberSet["instances"][number]["transform"] } };
  return {
    identity: { kind: "instance", instanceId: data.sharedWorldInstance.instanceId },
    version: worldObjectVersion(canvas, { kind: "instance", instanceId: data.sharedWorldInstance.instanceId })!,
    transform: data.sharedWorldInstance.transform
  };
}

function batch(canvasId: string, commandId: string, commands: unknown[]) {
  return { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId, commandId, actorId: "manual", baseRevision: 0, commands } as never;
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

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function stopContext(harness: Harness, requestId: string, outcome: { run: { runId: string; epoch: number; executionId: string } }): Promise<void> {
  await harness.service.spatialWrites!.confirmStopped(harness.canvas.id, requestId, outcome.run.runId, outcome.run.epoch, outcome.run.executionId, true);
}

describe("scene-area authority integration", () => {
  it("prepares complete/partial/outside eligibility and rejects forged scope, targets and contexts", async () => {
    const harness = await openHarness();
    try {
      const prepared = await harness.service.worldAuthoring!.prepare({ canvasId: harness.canvas.id, areaId: "area-main" });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.snapshot.writable.map(target => target.kind === "instance" ? target.instanceId : target.cameraId).sort())
        .toEqual(["camera-in", "complete-a"]);
      expect(prepared.snapshot.readOnly.map(target => target.kind === "instance" ? target.instanceId : target.cameraId)).toEqual(["partial-b"]);

      const issued = await harness.service.worldAuthoring!.issueContext({
        canvasId: harness.canvas.id,
        requestId: "request-partial",
        runId: "run-partial",
        epoch: 1,
        executionId: "exec-partial",
        scope: { kind: "scene-area", areaId: "area-main" }
      });
      expect(issued.ok).toBe(true);
      if (!issued.ok) return;
      expect(issued.context.writableTargets).toHaveLength(2);
      expect(issued.context.readOnlyReferences.map(target => target.kind === "instance" ? target.instanceId : target.cameraId)).toEqual(["partial-b"]);

      const canvas = await canonical(harness);
      const partial = memberFor(canvas, "partial");
      const partialRequest: SceneAreaPlanRequest = {
        ...moveRequest({ ok: true, snapshot: prepared.snapshot }, "op-partial"),
        members: { instances: [partial], cameras: [] }
      };
      expect(await harness.service.worldAuthoring!.execute({ canvasId: harness.canvas.id, request: partialRequest, contextId: issued.context.contextId }))
        .toMatchObject({ ok: false, code: "outside-scope" });

      const outside = memberFor(canvas, "outside");
      const outsideRequest: SceneAreaPlanRequest = {
        ...moveRequest({ ok: true, snapshot: prepared.snapshot }, "op-outside"),
        members: { instances: [outside], cameras: [] }
      };
      expect(await harness.service.worldAuthoring!.execute({ canvasId: harness.canvas.id, request: outsideRequest, contextId: issued.context.contextId }))
        .toMatchObject({ ok: false, code: "outside-scope" });

      const forgedScope: SceneAreaPlanRequest = {
        ...moveRequest({ ok: true, snapshot: prepared.snapshot }, "op-scope"),
        area: { ...prepared.snapshot.area, scopeVersion: "forged-scope" }
      };
      expect(await harness.service.worldAuthoring!.execute({ canvasId: harness.canvas.id, request: forgedScope, contextId: issued.context.contextId }))
        .toMatchObject({ ok: false, code: "version-conflict" });

      expect(await harness.service.worldAuthoring!.execute({
        canvasId: harness.canvas.id,
        request: moveRequest({ ok: true, snapshot: prepared.snapshot }, "op-context"),
        contextId: "forged-context"
      })).toMatchObject({ ok: false, code: "stale-epoch" });

      const forgedCapability = await harness.service.spatialWrites!.submit(
        harness.canvas.id,
        {},
        batch(harness.canvas.id, "forged-capability", [{ type: "nodeData.patch", nodeId: "complete", value: { title: "x" } }])
      );
      expect(forgedCapability).toMatchObject({ ok: false, code: "spatial-rejected" });

      expect((await canonical(harness)).revision).toBe(0);
      await stopContext(harness, "request-partial", issued);
    } finally {
      await closeHarness(harness);
    }
  });

  it("moves a fixed set atomically, undoes/redoes the same set, and rejects source or occupancy conflicts", async () => {
    const harness = await openHarness();
    try {
      const prepared = await harness.service.worldAuthoring!.prepare({ canvasId: harness.canvas.id, areaId: "area-main" });
      if (!prepared.ok) throw new Error(prepared.message);
      const issued = await harness.service.worldAuthoring!.issueContext({
        canvasId: harness.canvas.id,
        requestId: "request-move",
        runId: "run-move",
        epoch: 1,
        executionId: "exec-move",
        scope: { kind: "scene-area", areaId: "area-main" }
      });
      if (!issued.ok) throw new Error(issued.message);

      const executed = await harness.service.worldAuthoring!.execute({
        canvasId: harness.canvas.id,
        request: moveRequest(prepared, "op-move"),
        contextId: issued.context.contextId
      });
      expect(executed).toMatchObject({ ok: true, operationId: "op-move", duplicate: false });
      if (!executed.ok) return;
      const moved = await canonical(harness);
      expect(nodeDataOf(moved, "complete").sharedWorldInstance.transform.position).toMatchObject({ u: 3, v: 2, h: 0 });
      expect(nodeDataOf(moved, "camera-card").worldCamera.position).toMatchObject({ u: 7, v: 6, h: 1.5 });
      expect(nodeDataOf(moved, "area").sceneArea.bounds.min).toEqual({ u: 2, v: 1 });
      expect(nodeDataOf(moved, "partial").sharedWorldInstance.transform.position).toMatchObject({ u: 9.5, v: 1 });
      expect(nodeDataOf(moved, "outside").sharedWorldInstance.transform.position).toMatchObject({ u: 20, v: 20 });

      // A retried operation returns the same durable receipt, not a second edit.
      const retried = await harness.service.worldAuthoring!.execute({
        canvasId: harness.canvas.id,
        request: moveRequest(prepared, "op-move"),
        contextId: issued.context.contextId
      });
      expect(retried).toMatchObject({ ok: true, duplicate: true, revision: executed.revision });
      expect(await harness.service.worldAuthoring!.execute({
        canvasId: harness.canvas.id,
        request: moveRequest(prepared, "op-move", { u: 9, v: 9 }),
        contextId: issued.context.contextId
      })).toMatchObject({ ok: false, code: "operation-conflict" });

      await harness.service.worldAuthoring!.revokeContext({ canvasId: harness.canvas.id, contextId: issued.context.contextId });
      const revisionBeforeCancelled = (await canonical(harness)).revision;
      expect(await harness.service.worldAuthoring!.execute({
        canvasId: harness.canvas.id,
        request: moveRequest(prepared, "op-after-cancel", { u: 0, v: 0 }),
        contextId: issued.context.contextId
      })).toMatchObject({ ok: false, code: "stale-epoch" });
      expect((await canonical(harness)).revision).toBe(revisionBeforeCancelled);
      await stopContext(harness, "request-move", issued);

      const undone = await harness.service.worldAuthoring!.undo({ canvasId: harness.canvas.id, operationId: "op-move" });
      expect(undone).toMatchObject({ ok: true, direction: "undo" });
      const restored = await canonical(harness);
      expect(nodeDataOf(restored, "complete").sharedWorldInstance.transform.position).toMatchObject({ u: 1, v: 1 });
      expect(nodeDataOf(restored, "camera-card").worldCamera.position).toMatchObject({ u: 5, v: 5 });
      expect(nodeDataOf(restored, "area").sceneArea.bounds.min).toEqual({ u: 0, v: 0 });

      // A new object inserted after undo must not be absorbed by redo.
      const room = await harness.service.sync!.registry.resolve(harness.canvas.id);
      expect(await room.submit(batch(harness.canvas.id, "insert-new", [{
        type: "node.add",
        node: { id: "new-after", type: "model3d", position: { x: 0, y: 0 } },
        nodeData: instanceData("new-after", 4, 4)
      }] as never))).toMatchObject({ ok: true });
      const redone = await harness.service.worldAuthoring!.redo({ canvasId: harness.canvas.id, operationId: "op-move" });
      expect(redone).toMatchObject({ ok: true, direction: "redo" });
      const afterRedo = await canonical(harness);
      expect(nodeDataOf(afterRedo, "complete").sharedWorldInstance.transform.position).toMatchObject({ u: 3, v: 2 });
      expect(nodeDataOf(afterRedo, "new-after").sharedWorldInstance.transform.position).toMatchObject({ u: 4, v: 4 });

      // Source version conflict rejects the whole batch and leaves no half update.
      const currentPrepared = await harness.service.worldAuthoring!.prepare({ canvasId: harness.canvas.id, areaId: "area-main" });
      if (!currentPrepared.ok) throw new Error(currentPrepared.message);
      const conflictRequest = moveRequest(currentPrepared, "op-conflict", { u: -1, v: 0 });
      const beforeManual = await canonical(harness);
      const manualData = nodeDataOf(beforeManual, "complete");
      await room.submit(batch(harness.canvas.id, "manual-change", [{
        type: "nodeData.patch",
        nodeId: "complete",
        value: {
          ...manualData,
          sharedWorldInstance: {
            ...manualData.sharedWorldInstance,
            transform: { ...manualData.sharedWorldInstance.transform, position: { u: 8, v: 8, h: 0 } }
          }
        }
      }] as never));
      const beforeConflict = await canonical(harness);
      expect(await harness.service.worldAuthoring!.execute({ canvasId: harness.canvas.id, request: conflictRequest }))
        .toMatchObject({ ok: false, code: "version-conflict" });
      expect(await canonical(harness)).toEqual(beforeConflict);

      // Occupancy from another run blocks a manual whole-batch write.
      const occupancyPrepared = await harness.service.worldAuthoring!.prepare({ canvasId: harness.canvas.id, areaId: "area-main" });
      if (!occupancyPrepared.ok) throw new Error(occupancyPrepared.message);
      const occupied = await harness.service.worldAuthoring!.issueContext({
        canvasId: harness.canvas.id,
        requestId: "request-occupied",
        runId: "run-occupied",
        epoch: 2,
        executionId: "exec-occupied",
        scope: { kind: "scene-area", areaId: "area-main" }
      });
      if (!occupied.ok) throw new Error(occupied.message);
      const beforeOccupied = await canonical(harness);
      const occupiedTarget = { kind: "camera", cameraId: "camera-in" } as const;
      const occupiedVersion = worldObjectVersion(beforeOccupied, occupiedTarget);
      const secondContext = await harness.service.worldAuthoring!.issueContext({
        canvasId: harness.canvas.id,
        requestId: "request-occupied-second",
        runId: "run-occupied-second",
        epoch: 1,
        executionId: "exec-occupied-second",
        scope: { kind: "scene-area", areaId: "area-main" }
      });
      expect(secondContext).toMatchObject({
        ok: false,
        code: "lease-conflict",
        conflicts: [{
          target: occupiedTarget,
          version: occupiedVersion,
          runId: "run-occupied",
          epoch: 2
        }]
      });
      const executeConflict = await harness.service.worldAuthoring!.execute({
        canvasId: harness.canvas.id,
        request: moveRequest(occupancyPrepared, "op-occupied")
      });
      expect(executeConflict).toMatchObject({
        ok: false,
        code: "lease-conflict",
        conflicts: [{
          target: occupiedTarget,
          version: occupiedVersion,
          runId: "run-occupied",
          epoch: 2
        }]
      });
      expect(await canonical(harness)).toEqual(beforeOccupied);
      await harness.service.worldAuthoring!.revokeContext({ canvasId: harness.canvas.id, contextId: occupied.context.contextId });
      await stopContext(harness, "request-occupied", occupied);
    } finally {
      await closeHarness(harness);
    }
  });

  it("changes only range on resize, keeps contents on default delete, and preserves generated media on explicit delete", async () => {
    const harness = await openHarness();
    try {
      const prepared = await harness.service.worldAuthoring!.prepare({ canvasId: harness.canvas.id, areaId: "area-main" });
      if (!prepared.ok) throw new Error(prepared.message);
      const before = await canonical(harness);
      const resize = await harness.service.worldAuthoring!.execute({
        canvasId: harness.canvas.id,
        request: {
          contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
          canvasId: harness.canvas.id,
          operationId: "op-resize",
          intent: "resize",
          area: prepared.snapshot.area,
          members: prepared.snapshot.members,
          bounds: { min: { u: -2, v: -2 }, max: { u: 9, v: 9 } }
        }
      });
      expect(resize).toMatchObject({ ok: true });
      const resized = await canonical(harness);
      expect(nodeDataOf(resized, "area").sceneArea.bounds).toEqual({ min: { u: -2, v: -2 }, max: { u: 9, v: 9 } });
      expect(resized.nodeData.complete).toEqual(before.nodeData.complete);
      expect(resized.nodeData["camera-card"]).toEqual(before.nodeData["camera-card"]);

      const resizedPrepared = await harness.service.worldAuthoring!.prepare({ canvasId: harness.canvas.id, areaId: "area-main" });
      if (!resizedPrepared.ok) throw new Error(resizedPrepared.message);
      const deletedArea = await harness.service.worldAuthoring!.execute({
        canvasId: harness.canvas.id,
        request: {
          contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
          canvasId: harness.canvas.id,
          operationId: "op-delete-area",
          intent: "delete-area",
          area: resizedPrepared.snapshot.area,
          members: resizedPrepared.snapshot.members
        }
      });
      expect(deletedArea).toMatchObject({ ok: true });
      const areaOnly = await canonical(harness);
      expect(areaOnly.document.nodes.some(node => node.id === "area")).toBe(false);
      expect(areaOnly.document.nodes.some(node => node.id === "complete")).toBe(true);
      expect(areaOnly.document.nodes.some(node => node.id === "camera-card")).toBe(true);
      expect(areaOnly.assets.map(asset => asset.id)).toContain("asset-generated");
      expect(areaOnly.jobs.map(job => job.id)).toContain("job-1");

      expect(await harness.service.worldAuthoring!.undo({ canvasId: harness.canvas.id, operationId: "op-delete-area" }))
        .toMatchObject({ ok: true });
      expect((await canonical(harness)).document.nodes.some(node => node.id === "area")).toBe(true);

      // World objects may carry connections. Add them through the real queue so the
      // delete plan is prepared against the canonical post-reconciliation state.
      const room = await harness.service.sync!.registry.resolve(harness.canvas.id);
      expect(await room.submit(batch(harness.canvas.id, "add-world-edges", [
        { type: "edge.add", edge: { id: "edge-complete-partial", source: "complete", target: "partial", data: { kind: "dependency" } } },
        { type: "edge.add", edge: { id: "edge-complete-camera", source: "complete", target: "camera-card", data: { kind: "dependency" } } }
      ] as never))).toMatchObject({ ok: true });
      expect((await canonical(harness)).document.edges.map(edge => edge.id).sort())
        .toEqual(["edge-complete-camera", "edge-complete-partial"]);

      const prepareAgain = await harness.service.worldAuthoring!.prepare({ canvasId: harness.canvas.id, areaId: "area-main" });
      if (!prepareAgain.ok) throw new Error(prepareAgain.message);
      const deleteContents = await harness.service.worldAuthoring!.execute({
        canvasId: harness.canvas.id,
        request: {
          contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
          canvasId: harness.canvas.id,
          operationId: "op-delete-contents",
          intent: "delete-area-with-contents",
          area: prepareAgain.snapshot.area,
          members: prepareAgain.snapshot.members
        }
      });
      expect(deleteContents).toMatchObject({ ok: true });
      const withContents = await canonical(harness);
      expect(withContents.document.nodes.some(node => node.id === "area")).toBe(false);
      expect(withContents.document.nodes.some(node => node.id === "complete")).toBe(false);
      expect(withContents.document.nodes.some(node => node.id === "camera-card")).toBe(false);
      expect(withContents.document.nodes.some(node => node.id === "partial")).toBe(true);
      expect(withContents.document.nodes.some(node => node.id === "outside")).toBe(true);
      expect(withContents.assets.map(asset => asset.id)).toContain("asset-generated");
      expect(withContents.jobs.map(job => job.id)).toContain("job-1");
      // `node.remove` also drops incident edges; the frozen source snapshot keeps them.
      expect(withContents.document.edges).toEqual([]);

      expect(await harness.service.worldAuthoring!.undo({ canvasId: harness.canvas.id, operationId: "op-delete-contents" }))
        .toMatchObject({ ok: true });
      const restored = await canonical(harness);
      expect(restored.document.nodes.some(node => node.id === "complete")).toBe(true);
      expect(restored.document.nodes.some(node => node.id === "camera-card")).toBe(true);
      expect(restored.assets.map(asset => asset.id)).toContain("asset-generated");
      expect(restored.document.edges.map(edge => edge.id).sort())
        .toEqual(["edge-complete-camera", "edge-complete-partial"]);
      expect(restored.document.edges.find(edge => edge.id === "edge-complete-partial")?.data)
        .toEqual({ kind: "dependency" });

      expect(await harness.service.worldAuthoring!.redo({ canvasId: harness.canvas.id, operationId: "op-delete-contents" }))
        .toMatchObject({ ok: true, direction: "redo" });
      const redoneDelete = await canonical(harness);
      expect(redoneDelete.document.nodes.some(node => node.id === "complete")).toBe(false);
      expect(redoneDelete.document.edges).toEqual([]);
    } finally {
      await closeHarness(harness);
    }
  });

  it("keeps 2D group membership organizational, ignores camera cards, and invalidates a context when the range moves", async () => {
    const harness = await openHarness();
    try {
      const groupContext = await harness.service.worldAuthoring!.issueContext({
        canvasId: harness.canvas.id,
        requestId: "request-group",
        runId: "run-group",
        epoch: 1,
        executionId: "exec-group",
        scope: { kind: "workflow-group-2d", groupId: "group-1" }
      });
      expect(groupContext.ok).toBe(true);
      if (!groupContext.ok) return;
      expect(groupContext.context.writableTargets).toEqual([]);
      expect(groupContext.context.readOnlyReferences.map(target => target.kind === "instance" ? target.instanceId : target.cameraId).sort())
        .toEqual(["camera-in", "complete-a"]);

      const prepared = await harness.service.worldAuthoring!.prepare({ canvasId: harness.canvas.id, areaId: "area-main" });
      if (!prepared.ok) throw new Error(prepared.message);
      expect(await harness.service.worldAuthoring!.execute({
        canvasId: harness.canvas.id,
        request: moveRequest(prepared, "op-group", { u: 0, v: 0 }),
        contextId: groupContext.context.contextId
      })).toMatchObject({ ok: false, code: "outside-scope" });

      // 2D membership changes stay organizational: adding a world object does not
      // grant it a 3D write lease.
      const groupRoom = await harness.service.sync!.registry.resolve(harness.canvas.id);
      const currentGroup = nodeDataOf(await canonical(harness), "group").workflowGroup2d;
      expect(await groupRoom.submit(batch(harness.canvas.id, "group-member-add", [{
        type: "nodeData.patch",
        nodeId: "group",
        value: {
          workflowGroup2d: {
            ...currentGroup,
            memberNodeIds: [...currentGroup.memberNodeIds, "outside"],
            scopeVersion: "group-scope-2"
          }
        }
      }] as never))).toMatchObject({ ok: true });
      const groupAgain = await harness.service.worldAuthoring!.issueContext({
        canvasId: harness.canvas.id,
        requestId: "request-group-2",
        runId: "run-group-2",
        epoch: 1,
        executionId: "exec-group-2",
        scope: { kind: "workflow-group-2d", groupId: "group-1" }
      });
      expect(groupAgain).toMatchObject({ ok: true, context: { writableTargets: [] } });
      if (groupAgain.ok) {
        expect(groupAgain.context.readOnlyReferences.map(target => target.kind === "instance" ? target.instanceId : target.cameraId).sort())
          .toEqual(["camera-in", "complete-a", "outside-c"]);
        await harness.service.worldAuthoring!.revokeContext({ canvasId: harness.canvas.id, contextId: groupAgain.context.contextId });
        await stopContext(harness, "request-group-2", groupAgain);
      }

      // Camera card move is layout only and does not change the spatial context.
      const cameraContext = await harness.service.worldAuthoring!.issueContext({
        canvasId: harness.canvas.id,
        requestId: "request-camera",
        runId: "run-camera",
        epoch: 1,
        executionId: "exec-camera",
        scope: { kind: "scene-area", areaId: "area-main" }
      });
      if (!cameraContext.ok) throw new Error(cameraContext.message);
      const room = await harness.service.sync!.registry.resolve(harness.canvas.id);
      expect(await room.submit(batch(harness.canvas.id, "card-move", [{
        type: "node.update", nodeId: "camera-card", position: { x: 10, y: 10 }
      }] as never))).toMatchObject({ ok: true });
      const cameraPrepared = await harness.service.worldAuthoring!.prepare({ canvasId: harness.canvas.id, areaId: "area-main" });
      if (!cameraPrepared.ok) throw new Error(cameraPrepared.message);
      expect(await harness.service.worldAuthoring!.execute({
        canvasId: harness.canvas.id,
        request: moveRequest(cameraPrepared, "op-card-inside", { u: 0.5, v: 0 }),
        contextId: cameraContext.context.contextId
      })).toMatchObject({ ok: true });

      // Another entry changes only the range (areas are not lockable objects); the
      // old context can no longer write once the camera anchor is outside.
      const current = await canonical(harness);
      const currentArea = nodeDataOf(current, "area");
      expect(await room.submit(batch(harness.canvas.id, "shrink-area", [{
        type: "nodeData.patch",
        nodeId: "area",
        value: {
          ...currentArea,
          sceneArea: { ...currentArea.sceneArea, scopeVersion: "area-scope-shrunk", bounds: { min: { u: 0, v: 0 }, max: { u: 1, v: 1 } } }
        }
      }] as never))).toMatchObject({ ok: true });
      const stale = await harness.service.worldAuthoring!.prepare({ canvasId: harness.canvas.id, areaId: "area-main" });
      expect(stale.ok).toBe(true);

      const staleRequest = moveRequest(cameraPrepared, "op-stale", { u: 0.1, v: 0 });
      const beforeStale = await canonical(harness);
      expect(await harness.service.worldAuthoring!.execute({
        canvasId: harness.canvas.id,
        request: staleRequest,
        contextId: cameraContext.context.contextId
      })).toMatchObject({ ok: false });
      expect(await canonical(harness)).toEqual(beforeStale);

      await harness.service.worldAuthoring!.revokeContext({ canvasId: harness.canvas.id, contextId: cameraContext.context.contextId });
      await stopContext(harness, "request-camera", cameraContext);
      await harness.service.worldAuthoring!.revokeContext({ canvasId: harness.canvas.id, contextId: groupContext.context.contextId });
      await stopContext(harness, "request-group", groupContext);
    } finally {
      await closeHarness(harness);
    }
  });

  it("serves prepare, commit, context and undo through the real HTTP semantic entry", async () => {
    const harness = await openHarness();
    const server = await startServer(harness);
    try {
      const prepare = await post(server.base, `/api/canvases/${harness.canvas.id}/scene-area-prepare`, { areaId: "area-main" });
      expect(prepare.status).toBe(200);
      expect(prepare.body).toMatchObject({ ok: true, snapshot: { canvasId: harness.canvas.id } });
      const snapshot = prepare.body.snapshot;

      const context = await post(server.base, `/api/canvases/${harness.canvas.id}/world-tool-context`, {
        requestId: "http-request",
        runId: "http-run",
        epoch: 1,
        executionId: "http-exec",
        scope: { kind: "scene-area", areaId: "area-main" }
      });
      expect(context.status).toBe(200);
      expect(context.body).toMatchObject({ ok: true, context: { canvasId: harness.canvas.id } });
      expect(JSON.stringify(context.body)).not.toContain("capability");

      const commit = await post(server.base, `/api/canvases/${harness.canvas.id}/scene-area-commit`, {
        contextId: context.body.context.contextId,
        request: {
          contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
          canvasId: harness.canvas.id,
          operationId: "http-move",
          intent: "move",
          area: snapshot.area,
          members: snapshot.members,
          delta: { u: 1, v: 0 }
        }
      });
      expect(commit.status).toBe(200);
      expect(commit.body).toMatchObject({ ok: true, operationId: "http-move" });

      await post(server.base, `/api/canvases/${harness.canvas.id}/world-tool-context-revoke`, { contextId: context.body.context.contextId });
      await stopContext(harness, "http-request", { run: context.body.run });

      const undo = await post(server.base, `/api/canvases/${harness.canvas.id}/scene-area-undo`, { operationId: "http-move" });
      expect(undo.status).toBe(200);
      expect(undo.body).toMatchObject({ ok: true, direction: "undo" });
      expect(nodeDataOf(await canonical(harness), "complete").sharedWorldInstance.transform.position).toMatchObject({ u: 1, v: 1 });
    } finally {
      await server.close();
      await closeHarness(harness);
    }
  });

  it("rejects unknown bounds and reloads receipts from real storage for undo", async () => {
    const unknownCanvas = canvasFixture("canvas-unknown");
    unknownCanvas.document.nodes.push({ id: "broken", type: "model3d", position: { x: 0, y: 0 } });
    unknownCanvas.nodeData.broken = instanceData("broken", 2, 2, "");
    const unknown = await openHarness({ canvas: unknownCanvas });
    try {
      expect(await unknown.service.worldAuthoring!.prepare({ canvasId: unknownCanvas.id, areaId: "area-main" }))
        .toMatchObject({ ok: false, code: "not-ready" });
      expect(await unknown.service.worldAuthoring!.issueContext({
        canvasId: unknownCanvas.id,
        requestId: "request-unknown",
        runId: "run-unknown",
        epoch: 1,
        executionId: "exec-unknown",
        scope: { kind: "scene-area", areaId: "area-main" }
      })).toMatchObject({ ok: false, code: "not-ready" });
      expect(unknown.repository.debugQuery("SELECT COUNT(*) AS count FROM spatial_lease_runs")).toEqual([{ count: 0 }]);
    } finally {
      await closeHarness(unknown);
    }

    const dir = mkdtempSync(join(tmpdir(), "world-authoring-reload-"));
    const file = join(dir, "canvas.sqlite");
    const first = await openHarness({ dir });
    let removed = false;
    try {
      const firstRoom = await first.service.sync!.registry.resolve(first.canvas.id);
      expect(await firstRoom.submit(batch(first.canvas.id, "reload-edge", [{
        type: "edge.add",
        edge: { id: "edge-reload", source: "complete", target: "partial", data: { kind: "dependency" } }
      }] as never))).toMatchObject({ ok: true });
      const prepared = await first.service.worldAuthoring!.prepare({ canvasId: first.canvas.id, areaId: "area-main" });
      if (!prepared.ok) throw new Error(prepared.message);
      expect(await first.service.worldAuthoring!.execute({
        canvasId: first.canvas.id,
        request: {
          contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
          canvasId: first.canvas.id,
          operationId: "op-reloaded",
          intent: "delete-area-with-contents",
          area: prepared.snapshot.area,
          members: prepared.snapshot.members
        }
      })).toMatchObject({ ok: true });
      expect((await canonical(first)).document.nodes.some(node => node.id === "area")).toBe(false);
      await first.service.close();
      first.repository.close();

      const reopened = await openHarness({ dir, file, initialize: false });
      try {
        const undone = await reopened.service.worldAuthoring!.undo({ canvasId: first.canvas.id, operationId: "op-reloaded" });
        expect(undone).toMatchObject({ ok: true, direction: "undo" });
        const reloaded = await canonical(reopened);
        expect(reloaded.document.nodes.some(node => node.id === "area")).toBe(true);
        expect(reloaded.document.nodes.some(node => node.id === "complete")).toBe(true);
        // The edge frozen in the durable receipt survives JSON storage and reopen.
        expect(reloaded.document.edges.map(edge => edge.id)).toContain("edge-reload");
        // A second undo of the same operation is refused without a write.
        expect(await reopened.service.worldAuthoring!.undo({ canvasId: first.canvas.id, operationId: "op-reloaded" }))
          .toMatchObject({ ok: false, code: "operation-conflict" });
      } finally {
        await closeHarness(reopened, false);
      }
      removed = true;
    } finally {
      if (!removed) {
        try { await first.service.close(); } catch { /* already closed */ }
        try { first.repository.close(); } catch { /* already closed */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
