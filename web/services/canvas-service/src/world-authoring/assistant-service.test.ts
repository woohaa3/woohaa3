import { describe, expect, it } from "vitest";
import type {
  ServerCanvas,
  WorldObjectVersion,
  WorldScopeVersion,
  WorldToolContext
} from "@woohaa3/contracts";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { createAssistantWorldService } from "./assistant-service.js";
import type { CanvasRoom } from "../sync/room.js";

const now = "2026-01-01T00:00:00Z";
const scope: WorldScopeVersion = {
  scope: { kind: "scene-area", areaId: "area-1" },
  scopeVersion: "scope-1"
};
const instance: WorldObjectVersion = { kind: "instance", instanceId: "instance-1", version: "iv-1" };
const camera: WorldObjectVersion = { kind: "camera", cameraId: "camera-1", version: "cv-1" };

function contextFor(scopeValue: WorldScopeVersion = scope, writable: WorldObjectVersion[] = [instance, camera]): WorldToolContext {
  return {
    contextId: "ctx-1",
    canvasId: "canvas-1",
    runId: "run-1",
    epoch: 0,
    scope: scopeValue,
    writableTargets: writable.map(target => ({
      target,
      lease: {
        canvasId: "canvas-1",
        runId: "run-1",
        epoch: 0,
        target: target.kind === "instance"
          ? { kind: "instance", instanceId: target.instanceId }
          : { kind: "camera", cameraId: target.cameraId }
      }
    })),
    readOnlyReferences: []
  };
}

function canvasFixture(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-1", now);
  canvas.document.nodes.push(
    { id: "area", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "model-node", type: "model3d", position: { x: 0, y: 0 } },
    { id: "camera-node", type: "world-camera", position: { x: 0, y: 0 } }
  );
  canvas.nodeData["model-node"] = {
    sharedWorldInstance: {
      kind: "world-instance",
      version: "shared-world-v1",
      instanceId: "instance-1",
      transform: {
        version: "shared-world-v1",
        position: { u: 1, v: 1, h: 0 },
        rotation: [0, 0, 0, 1],
        scale: 1
      }
    },
    modelScript: "scene.box({});",
    modelScriptLanguage: "javascript",
    modelScriptVersion: "woohaa-model-js-v2",
    modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "c" },
    modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
  };
  return canvas;
}

function harness(overrides: {
  context?: WorldToolContext;
  pending?: Array<{ intent: Record<string, unknown>; state: "active" | "cancelled" | "stopped" }>;
  confirmStopped?: () => Promise<void>;
} = {}) {
  const context = overrides.context ?? contextFor();
  const revoked: string[] = [];
  const saved: Array<Record<string, unknown>> = [];
  const completed: Array<Record<string, unknown>> = [];
  let current = canvasFixture();
  const room = {
    async inspectPublished<T>(select: (canvas: ServerCanvas) => T): Promise<{ ok: true; canvas: ServerCanvas; value: T }> {
      return { ok: true, canvas: current, value: select(current) };
    },
    async submitDerived<T>(input: { derive: (canvas: ServerCanvas) => T | Promise<T> }): Promise<Record<string, unknown>> {
      const derived = await input.derive(current);
      return { ok: true, status: "accepted", commandId: "cmd-1", revision: 2, noop: false, update: null, derived };
    }
  } as unknown as CanvasRoom;
  const service = createAssistantWorldService({
    authority: {
      async prepareCanvas() {
        return { ok: true, snapshot: { version: "world-authoring-v1", canvasId: "canvas-1", revision: 0, scope, areaNodeId: "area", area: {}, bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }, writable: [instance, camera], readOnly: [], members: { instances: [], cameras: [] }, objects: [] } } as never;
      },
      async prepareContent() {
        return { contentVersion: "content-1", localAabb: { min: [0, 0, 0] as const, max: [2, 2, 2] as const } };
      }
    },
    worldAuthoring: {
      async issueContext() {
        return { ok: true, context, run: { canvasId: "canvas-1", requestId: "req-1", runId: "run-1", epoch: 0, executionId: "exec-1", state: "active" }, retry: false };
      },
      async revokeContext(input: { contextId: string }) {
        revoked.push(input.contextId);
      },
      resolveCapability() {
        return { context, capability: {} };
      },
      refreshContextVersions() { /* no-op stub */ }
    },
    cameraSettings: {
      async save(input: never) {
        const value = input as unknown as Record<string, unknown>;
        saved.push(value);
        return { ok: true, canvasId: "canvas-1", cameraId: "camera-1", commandId: "camera-cmd", revision: 3, duplicate: false, camera: {}, settingsVersion: "cv-2" } as never;
      },
      async complete(input: never) {
        const value = input as unknown as Record<string, unknown>;
        completed.push(value);
        return {
          ok: true,
          duplicate: completed.length > 1,
          entry: {
            completionKey: "key",
            canvasId: "canvas-1",
            cameraId: "camera-1",
            runId: "run-1",
            completionId: "completion-1",
            settingsVersion: "cv-2",
            createdAt: now,
            snapshot: {}
          }
        } as never;
      }
    },
    async resolveRoom() { return room; },
    async cancel() { revoked.push("lease-cancelled"); },
    confirmStopped: overrides.confirmStopped ?? (async () => undefined),
    async pending() {
      return (overrides.pending ?? []).map(entry => ({
        intent: {
          requestId: "req-1",
          canvasId: "canvas-1",
          runId: "run-1",
          epoch: 0,
          executionId: "exec-1",
          scope,
          writable: [instance, camera],
          readOnly: [],
          ...entry.intent
        },
        state: entry.state
      })) as never;
    }
  });
  return { service, context, revoked, saved, completed };
}

describe("assistant world authority", () => {
  it("issues a host-owned context and reports the scope without world writes for a 2D group", async () => {
    const groupScope: WorldScopeVersion = { scope: { kind: "workflow-group-2d", groupId: "group-1" }, scopeVersion: "g-1" };
    const group = contextFor(groupScope, []);
    const { service } = harness({ context: group });
    const issued = await service.issue({
      canvasId: "canvas-1",
      requestId: "req-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { kind: "workflow-group-2d", groupId: "group-1" }
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.completionId).toBeTruthy();
    const viewed = service.read({ canvasId: "canvas-1", contextId: issued.context.contextId });
    expect(viewed.ok && viewed.view.worldWritable).toBe(false);
    const wrote = await service.write({
      contextId: issued.context.contextId,
      operation: {
        kind: "set-model-transform",
        operationId: "move-1",
        instanceId: "instance-1",
        expectedVersion: "iv-1",
        transform: {
          version: "shared-world-v1",
          position: { u: 2, v: 2, h: 0 },
          rotation: [0, 0, 0, 1],
          scale: 1
        }
      }
    });
    expect(wrote).toMatchObject({ ok: false, code: "capability-unsupported" });
  });

  it("rejects stale versions and writes the camera only through the issued context", async () => {
    const { service, saved, completed } = harness();
    const issued = await service.issue({
      canvasId: "canvas-1",
      requestId: "req-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { kind: "scene-area", areaId: "area-1" }
    });
    if (!issued.ok) throw new Error(issued.message);
    const stale = await service.write({
      contextId: issued.context.contextId,
      operation: {
        kind: "set-world-camera",
        operationId: "camera-1",
        cameraId: "camera-1",
        expectedSettingsVersion: "old",
        settings: {
          position: { u: 0, v: 0, h: 1 },
          rotation: [0, 0, 0, 1],
          projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
          captureMode: { kind: "static" },
          aspect: { width: 16, height: 9 },
          boundInstanceId: null
        }
      }
    });
    expect(stale).toMatchObject({ ok: false, code: "version-conflict" });
    const written = await service.write({
      contextId: issued.context.contextId,
      operation: {
        kind: "set-world-camera",
        operationId: "camera-1",
        cameraId: "camera-1",
        expectedSettingsVersion: "cv-1",
        settings: {
          position: { u: 0, v: 0, h: 1 },
          rotation: [0, 0, 0, 1],
          projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
          captureMode: { kind: "static" },
          aspect: { width: 16, height: 9 },
          boundInstanceId: null
        }
      }
    });
    expect(written).toMatchObject({ ok: true, settingsVersion: "cv-2" });
    expect(saved[0]).toMatchObject({ contextId: issued.context.contextId, cameraId: "camera-1" });
    expect(completed).toHaveLength(0);
  });

  it("records completion once and refuses a forged completion identity", async () => {
    const { service, completed } = harness();
    const issued = await service.issue({
      canvasId: "canvas-1",
      requestId: "req-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { kind: "scene-area", areaId: "area-1" }
    });
    if (!issued.ok) throw new Error(issued.message);
    const settings = {
      position: { u: 0, v: 0, h: 1 },
      rotation: [0, 0, 0, 1] as const,
      projection: { kind: "perspective" as const, verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
      captureMode: { kind: "static" as const },
      aspect: { width: 16, height: 9 },
      boundInstanceId: null
    };
    await service.write({
      contextId: issued.context.contextId,
      operation: {
        kind: "set-world-camera",
        operationId: "camera-1",
        cameraId: "camera-1",
        expectedSettingsVersion: "cv-1",
        settings
      }
    });
    const forged = await service.complete({
      contextId: issued.context.contextId,
      completion: {
        canvasId: "canvas-1",
        runId: "run-1",
        completionId: "forged",
        cameraId: "camera-1",
        settingsVersion: "cv-2"
      }
    });
    expect(forged).toMatchObject({ ok: false, code: "unverified-run" });
    const completion = {
      canvasId: "canvas-1",
      runId: "run-1",
      completionId: issued.completionId,
      cameraId: "camera-1",
      settingsVersion: "cv-2"
    };
    const first = await service.complete({ contextId: issued.context.contextId, completion });
    expect(first).toMatchObject({ ok: true, duplicate: false });
    const second = await service.complete({ contextId: issued.context.contextId, completion });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(completed).toHaveLength(2);
  });

  it("invalidates the grant on cancel and keeps occupancy until exact stop", async () => {
    const { service, revoked } = harness();
    const issued = await service.issue({
      canvasId: "canvas-1",
      requestId: "req-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { kind: "scene-area", areaId: "area-1" }
    });
    if (!issued.ok) throw new Error(issued.message);
    await service.cancel({ canvasId: "canvas-1", contextId: issued.context.contextId });
    expect(revoked).toContain(issued.context.contextId);
    const afterCancel = await service.write({
      contextId: issued.context.contextId,
      operation: {
        kind: "set-model-transform",
        operationId: "move-1",
        instanceId: "instance-1",
        expectedVersion: "iv-1",
        transform: {
          version: "shared-world-v1",
          position: { u: 2, v: 2, h: 0 },
          rotation: [0, 0, 0, 1],
          scale: 1
        }
      }
    });
    expect(afterCancel).toMatchObject({ ok: false, code: "cancelled" });
  });

  it("fails closed when stop evidence is not verified and never re-issues capability on recovery", async () => {
    const pending = [{ intent: {}, state: "active" as const }];
    const { service } = harness({
      pending,
      confirmStopped: async () => { throw Object.assign(new Error("not verified"), { code: "unverified-stop" }); }
    });
    const issued = await service.issue({
      canvasId: "canvas-1",
      requestId: "req-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { kind: "scene-area", areaId: "area-1" }
    });
    if (!issued.ok) throw new Error(issued.message);
    const stopped = await service.confirmStopped({
      canvasId: "canvas-1",
      contextId: issued.context.contextId,
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      evidence: { unverified: true }
    });
    expect(stopped).toMatchObject({ ok: false, code: "unverified-stop" });
    const recovered = await service.recover({ canvasId: "canvas-1" });
    expect(recovered).toMatchObject({ ok: true, capability: null });
    expect(recovered.ok && recovered.runs).toHaveLength(1);
    expect(recovered.ok && recovered.runs[0]?.runId).toBe("run-1");
  });
});
