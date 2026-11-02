import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, deriveModelContentVersion } from "@woohaa3/contracts";
import { CanvasRoom } from "../services/canvas-service/src/sync/room.js";
import { SqliteYjsRepository } from "../services/canvas-service/src/storage/sqlite/yjs.js";
import { createWorldAuthoringAuthority } from "../services/canvas-service/src/world-authoring/authority.js";
import { createWorldAuthoringService } from "../services/canvas-service/src/world-authoring/scene-area-service.js";
import { createAssistantWorldService } from "../services/canvas-service/src/world-authoring/assistant-service.js";
import { createWorldCameraSettingsService } from "../services/canvas-service/src/world-authoring/camera-service.js";
import { InMemoryWorldCameraHistoryRepository } from "../services/canvas-service/src/world-authoring/camera-history.js";

const now = "2026-01-01T00:00:00Z";
const box = {
  t: "box",
  id: "body",
  parent: null,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  material: null,
  color: null,
  size: [2, 2, 2]
};

function executeScene() {
  return Promise.resolve({
    ok: true as const,
    version: "woohaa-model-js-v2" as const,
    sceneVersion: "scene-ir-v2",
    json: "",
    sourceHash: "fixture",
    ops: [box] as never
  });
}

function modelData(instanceId: string, u: number, v: number) {
  const modelScript = "scene.box({ id: 'body', size: [2, 2, 2] });";
  const modelPlacement = { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 };
  return {
    sharedWorldInstance: {
      kind: "world-instance",
      version: "shared-world-v1",
      instanceId,
      transform: {
        version: "shared-world-v1",
        position: { u, v, h: 0 },
        rotation: [0, 0, 0, 1],
        scale: 1
      }
    },
    modelScript,
    modelScriptLanguage: "javascript",
    modelScriptVersion: "woohaa-model-js-v2",
    modelContentVersion: deriveModelContentVersion({
      modelScript,
      modelScriptLanguage: "javascript",
      modelScriptVersion: "woohaa-model-js-v2",
      placement: modelPlacement,
      revision: 1
    }),
    modelPlacement
  };
}

describe("assistant world authoring through the real canvas queue", () => {
  it("moves a fully contained model, creates a new world identity, and rejects stale/overlapping writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assistant-world-"));
    const file = join(dir, "canvas.sqlite");
    const canvas = createEmptyWoohaa3ServerCanvas("canvas-1", now);
    canvas.document.nodes.push(
      { id: "area-node", type: "scene-area", position: { x: 0, y: 0 } },
      { id: "model-a", type: "model3d", position: { x: 0, y: 0 } }
    );
    canvas.nodeData["area-node"] = {
      sceneArea: {
        kind: "scene-area",
        version: "shared-world-v1",
        areaId: "area-1",
        scopeVersion: "area-scope-1",
        bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
      }
    };
    canvas.nodeData["model-a"] = modelData("instance-a", 1, 1);

    const authority = createWorldAuthoringAuthority({ executeScene });
    const repository = new SqliteYjsRepository({ path: file, spatialAuthority: authority });
    const room = new CanvasRoom({ canvasId: canvas.id, repository, now: () => now });
    await room.initialize({ canvas, roomEpoch: "initial", createdAt: now });
    const worldAuthoring = createWorldAuthoringService({
      authority,
      resolveRoom: async () => room,
      acquire: async (intent) => repository.acquireSpatialRun(intent),
      cancel: async (canvasId, requestId) => repository.cancelSpatialRun(canvasId, requestId),
      findLatest: async (canvasId, operationId) => repository.findLatestWorldAuthoringCommand(canvasId, operationId)
    });
    const assistant = createAssistantWorldService({
      authority,
      worldAuthoring,
      cameraSettings: {
        async save() { return { ok: false as const, code: "write-forbidden" as const, message: "camera not used" }; },
        async complete() { return { ok: false as const, code: "write-forbidden" as const, message: "camera not used" }; }
      },
      resolveRoom: async () => room,
      cancel: async (canvasId, requestId) => repository.cancelSpatialRun(canvasId, requestId),
      confirmStopped: async (input) => repository.confirmSpatialStopped(input.canvasId, input.requestId, input.runId, input.epoch, input.executionId, input.evidence),
      pending: async () => repository.pendingSpatialRuns()
    });
    try {
      const issued = await assistant.issue({
        canvasId: canvas.id,
        requestId: "run-1",
        runId: "run-1",
        epoch: 0,
        executionId: "exec-1",
        scope: { kind: "scene-area", areaId: "area-1" }
      });
      if (!issued.ok) throw new Error(issued.message);
      const target = issued.context.writableTargets.find(entry => entry.target.kind === "instance" && entry.target.instanceId === "instance-a");
      expect(target).toBeTruthy();
      const previousVersion = target!.target.version;

      const moved = await assistant.write({
        contextId: issued.context.contextId,
        operation: {
          kind: "set-model-transform",
          operationId: "move-a",
          instanceId: "instance-a",
          expectedVersion: previousVersion,
          transform: {
            version: "shared-world-v1",
            position: { u: 3, v: 3, h: 0.5 },
            rotation: [0, 0, 0, 1],
            scale: 1
          }
        }
      });
      expect(moved).toMatchObject({ ok: true, instanceId: "instance-a" });
      let projection = (await repository.loadYjsState(canvas.id))?.projection ?? null;
      expect((projection?.nodeData["model-a"]?.sharedWorldInstance as { transform: { position: { u: number; h: number } } }).transform.position).toMatchObject({ u: 3, h: 0.5 });

      // The MCP tool keeps one operation id per work/target. A second, genuinely
      // different move in the same run must still apply instead of hitting the
      // first command receipt as a silent no-op.
      const movedAgain = await assistant.write({
        contextId: issued.context.contextId,
        operation: {
          kind: "set-model-transform",
          operationId: "move-a",
          instanceId: "instance-a",
          expectedVersion: moved.version!,
          transform: {
            version: "shared-world-v1",
            position: { u: 5, v: 5, h: 0.5 },
            rotation: [0, 0, 0, 1],
            scale: 1
          }
        }
      });
      expect(movedAgain).toMatchObject({ ok: true, duplicate: false });
      projection = (await repository.loadYjsState(canvas.id))?.projection ?? null;
      expect((projection?.nodeData["model-a"]?.sharedWorldInstance as { transform: { position: { u: number } } }).transform.position).toMatchObject({ u: 5 });

      const stale = await assistant.write({
        contextId: issued.context.contextId,
        operation: {
          kind: "set-model-transform",
          operationId: "move-a-again",
          instanceId: "instance-a",
          expectedVersion: previousVersion,
          transform: {
            version: "shared-world-v1",
            position: { u: 4, v: 4, h: 0 },
            rotation: [0, 0, 0, 1],
            scale: 1
          }
        }
      });
      expect(stale).toMatchObject({ ok: false, code: "version-conflict" });

      const created = await assistant.write({
        contextId: issued.context.contextId,
        operation: {
          kind: "create-model",
          operationId: "create-b",
          nodeId: "model-b",
          content: { modelScript: "scene.box({ id: 'body', size: [2, 2, 2] });" },
          transform: {
            version: "shared-world-v1",
            position: { u: 6, v: 6, h: 0 },
            rotation: [0, 0, 0, 1],
            scale: 1
          }
        }
      });
      expect(created).toMatchObject({ ok: true, nodeId: "model-b" });
      if (!created.ok) return;
      projection = (await repository.loadYjsState(canvas.id))?.projection ?? null;
      const createdData = projection?.nodeData["model-b"] as { sharedWorldInstance?: { instanceId?: string } } | undefined;
      expect(createdData?.sharedWorldInstance?.instanceId).toBe(created.instanceId);
      const replaced = await assistant.write({
        contextId: issued.context.contextId,
        operation: {
          kind: "replace-model-content",
          operationId: "replace-b",
          instanceId: created.instanceId!,
          expectedVersion: created.version!,
          content: { modelScript: "scene.box({ id: 'body', size: [2, 2, 2] });" }
        }
      });
      expect(replaced).toMatchObject({ ok: true, instanceId: created.instanceId });

      const replacedAgain = await assistant.write({
        contextId: issued.context.contextId,
        operation: {
          kind: "replace-model-content",
          operationId: "replace-b",
          instanceId: created.instanceId!,
          expectedVersion: replaced.version!,
          content: { modelScript: "scene.box({ id: 'body', size: [3, 3, 3] });" }
        }
      });
      expect(replacedAgain).toMatchObject({ ok: true, duplicate: false, instanceId: created.instanceId });
      projection = (await repository.loadYjsState(canvas.id))?.projection ?? null;
      expect((projection?.nodeData["model-b"] as { modelScript?: string }).modelScript).toContain("[3, 3, 3]");

      const overlap = await assistant.issue({
        canvasId: canvas.id,
        requestId: "run-2",
        runId: "run-2",
        epoch: 0,
        executionId: "exec-2",
        scope: { kind: "scene-area", areaId: "area-1" }
      });
      expect(overlap).toMatchObject({ ok: false, code: "lease-conflict" });
      expect(await repository.getCommandRecord(canvas.id, created.commandId)).not.toBeNull();
    } finally {
      repository.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("releases a reopened pending run only after the host proves the exact terminal turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assistant-world-restart-"));
    const file = join(dir, "canvas.sqlite");
    const canvas = createEmptyWoohaa3ServerCanvas("canvas-1", now);
    canvas.document.nodes.push(
      { id: "area-node", type: "scene-area", position: { x: 0, y: 0 } },
      { id: "model-a", type: "model3d", position: { x: 0, y: 0 } }
    );
    canvas.nodeData["area-node"] = {
      sceneArea: {
        kind: "scene-area",
        version: "shared-world-v1",
        areaId: "area-1",
        scopeVersion: "area-scope-1",
        bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
      }
    };
    canvas.nodeData["model-a"] = modelData("instance-a", 1, 1);

    const authority = createWorldAuthoringAuthority({
      executeScene,
      // Stand-in for the local host's application turn ledger: only a terminal
      // fact carrying the exact run identity can confirm the stop.
      verifyStopped: (identity, evidence) => {
        const value = evidence as { terminal?: unknown; runId?: unknown } | null;
        return !!value && value.terminal === true && value.runId === identity.runId;
      }
    });
    const repository = new SqliteYjsRepository({ path: file, spatialAuthority: authority });
    const room = new CanvasRoom({ canvasId: canvas.id, repository, now: () => now });
    await room.initialize({ canvas, roomEpoch: "initial", createdAt: now });
    const worldAuthoring = createWorldAuthoringService({
      authority,
      resolveRoom: async () => room,
      acquire: async (intent) => repository.acquireSpatialRun(intent),
      cancel: async (canvasId, requestId) => repository.cancelSpatialRun(canvasId, requestId),
      findLatest: async (canvasId, operationId) => repository.findLatestWorldAuthoringCommand(canvasId, operationId)
    });
    const baseDeps = {
      authority,
      worldAuthoring,
      cameraSettings: {
        async save() { return { ok: false as const, code: "write-forbidden" as const, message: "camera not used" }; },
        async complete() { return { ok: false as const, code: "write-forbidden" as const, message: "camera not used" }; }
      },
      resolveRoom: async () => room,
      cancel: async (canvasId: string, requestId: string) => repository.cancelSpatialRun(canvasId, requestId),
      pending: async () => repository.pendingSpatialRuns()
    };
    try {
      const first = createAssistantWorldService({
        ...baseDeps,
        confirmStopped: async (input) => repository.confirmSpatialStopped(input.canvasId, input.requestId, input.runId, input.epoch, input.executionId, input.evidence)
      });
      const issued = await first.issue({
        canvasId: canvas.id,
        requestId: "run-1",
        runId: "run-1",
        epoch: 0,
        executionId: "exec-1",
        scope: { kind: "scene-area", areaId: "area-1" }
      });
      expect(issued).toMatchObject({ ok: true });
      first.close();

      const confirmed: Array<Record<string, unknown>> = [];
      const second = createAssistantWorldService({
        ...baseDeps,
        confirmStopped: async (input) => {
          repository.confirmSpatialStopped(input.canvasId, input.requestId, input.runId, input.epoch, input.executionId, input.evidence);
          confirmed.push(input);
        }
      });
      const recovered = await second.recover({ canvasId: canvas.id });
      expect(recovered).toMatchObject({ ok: true, capability: null });
      expect(recovered.ok && recovered.runs).toHaveLength(1);
      expect(recovered.ok && recovered.runs[0]).toMatchObject({ requestId: "run-1", runId: "run-1", epoch: 0, executionId: "exec-1" });

      const denied = await second.settleRun({
        canvasId: canvas.id,
        runId: "run-1",
        status: "succeeded",
        evidence: { terminal: false, runId: "run-1" }
      });
      expect(denied).toMatchObject({ ok: false, code: "unverified-stop" });
      expect(await repository.pendingSpatialRuns()).toHaveLength(1);

      const settled = await second.settleRun({
        canvasId: canvas.id,
        runId: "run-1",
        status: "succeeded",
        evidence: { terminal: true, runId: "run-1" }
      });
      expect(settled).toEqual({ ok: true });
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]).toMatchObject({ requestId: "run-1", runId: "run-1", epoch: 0, executionId: "exec-1" });
      expect(await repository.pendingSpatialRuns()).toHaveLength(0);

      const next = await second.issue({
        canvasId: canvas.id,
        requestId: "run-2",
        runId: "run-2",
        epoch: 0,
        executionId: "exec-2",
        scope: { kind: "scene-area", areaId: "area-1" }
      });
      expect(next).toMatchObject({ ok: true });
    } finally {
      repository.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records one camera history entry from the host terminal turn, never from an active run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assistant-world-camera-"));
    const file = join(dir, "canvas.sqlite");
    const canvas = createEmptyWoohaa3ServerCanvas("canvas-1", now);
    canvas.document.nodes.push(
      { id: "area-node", type: "scene-area", position: { x: 0, y: 0 } },
      { id: "camera-card", type: "world-camera", position: { x: 900, y: 900 } }
    );
    canvas.nodeData["area-node"] = {
      sceneArea: {
        kind: "scene-area",
        version: "shared-world-v1",
        areaId: "area-1",
        scopeVersion: "area-scope-1",
        bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
      }
    };
    canvas.nodeData["camera-card"] = {
      worldCamera: {
        kind: "world-camera",
        version: "shared-world-v1",
        cameraId: "camera-1",
        settingsVersion: "camera-1-v1",
        position: { u: 5, v: 5, h: 1.5 },
        rotation: [0, 0, 0, 1],
        projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
        captureMode: { kind: "static" },
        aspect: { width: 16, height: 9 },
        boundInstanceId: null
      }
    };

    const authority = createWorldAuthoringAuthority({
      executeScene,
      verifyStopped: (identity, evidence) => {
        const value = evidence as { terminal?: unknown; runId?: unknown } | null;
        return !!value && value.terminal === true && value.runId === identity.runId;
      }
    });
    const repository = new SqliteYjsRepository({ path: file, spatialAuthority: authority });
    const room = new CanvasRoom({ canvasId: canvas.id, repository, now: () => now });
    await room.initialize({ canvas, roomEpoch: "initial", createdAt: now });
    const worldAuthoring = createWorldAuthoringService({
      authority,
      resolveRoom: async () => room,
      acquire: async (intent) => repository.acquireSpatialRun(intent),
      cancel: async (canvasId, requestId) => repository.cancelSpatialRun(canvasId, requestId),
      findLatest: async (canvasId, operationId) => repository.findLatestWorldAuthoringCommand(canvasId, operationId)
    });
    const history = new InMemoryWorldCameraHistoryRepository();
    let assistant: ReturnType<typeof createAssistantWorldService> | null = null;
    const cameraSettings = createWorldCameraSettingsService({
      resolveRoom: async () => room,
      resolveContext: (canvasId, contextId) => worldAuthoring.resolveCapability(canvasId, contextId),
      history,
      verifyCompletion: (completion, evidence) => assistant ? assistant.verifyCompletion(completion, evidence) : false,
      now: () => now
    });
    assistant = createAssistantWorldService({
      authority,
      worldAuthoring,
      cameraSettings,
      resolveRoom: async () => room,
      cancel: async (canvasId, requestId) => repository.cancelSpatialRun(canvasId, requestId),
      confirmStopped: async (input) => repository.confirmSpatialStopped(input.canvasId, input.requestId, input.runId, input.epoch, input.executionId, input.evidence),
      pending: async () => repository.pendingSpatialRuns()
    });
    try {
      const issued = await assistant.issue({
        canvasId: canvas.id,
        requestId: "run-1",
        runId: "run-1",
        epoch: 0,
        executionId: "exec-1",
        scope: { kind: "scene-area", areaId: "area-1" }
      });
      if (!issued.ok) throw new Error(issued.message);
      const written = await assistant.write({
        contextId: issued.context.contextId,
        operation: {
          kind: "set-world-camera",
          operationId: "camera-1",
          cameraId: "camera-1",
          expectedSettingsVersion: "camera-1-v1",
          settings: {
            position: { u: 5, v: 5, h: 2 },
            rotation: [0, 0, 0, 1],
            projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
            captureMode: { kind: "static" },
            aspect: { width: 16, height: 9 },
            boundInstanceId: null
          }
        }
      });
      expect(written.ok).toBe(true);
      if (!written.ok) return;
      const completion = {
        canvasId: canvas.id,
        runId: "run-1",
        completionId: issued.completionId,
        cameraId: "camera-1",
        settingsVersion: written.settingsVersion!
      };
      const active = await assistant.complete({
        contextId: issued.context.contextId,
        completion,
        evidence: { completed: true, turnStatus: "running" }
      });
      expect(active).toMatchObject({ ok: false, code: "unverified-run" });
      expect(await history.list(canvas.id, "camera-1")).toHaveLength(0);

      const settled = await assistant.settleRun({
        canvasId: canvas.id,
        runId: "run-1",
        status: "succeeded",
        evidence: { terminal: true, runId: "run-1" }
      });
      expect(settled).toEqual({ ok: true });
      const entries = await history.list(canvas.id, "camera-1");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        completionId: issued.completionId,
        settingsVersion: written.settingsVersion,
        runId: "run-1",
        cameraId: "camera-1"
      });

      // A repeated settle/complete retry never adds a second row.
      expect(await assistant.settleRun({
        canvasId: canvas.id,
        runId: "run-1",
        status: "succeeded",
        evidence: { terminal: true, runId: "run-1" }
      })).toEqual({ ok: true });
      expect(await assistant.complete({ contextId: issued.context.contextId, completion })).toMatchObject({ ok: true, duplicate: true });
      expect(await history.list(canvas.id, "camera-1")).toHaveLength(1);
    } finally {
      assistant?.close();
      repository.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
