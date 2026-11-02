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

      const overlap = await assistant.issue({
        canvasId: canvas.id,
        requestId: "run-2",
        runId: "run-2",
        epoch: 0,
        executionId: "exec-2",
        scope: { kind: "scene-area", areaId: "area-1" }
      });
      expect(overlap).toMatchObject({ ok: false, code: "lease-conflict" });
      expect(await repository.getCommandRecord(canvas.id, "assistant-world-create:create-b")).not.toBeNull();
    } finally {
      repository.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
