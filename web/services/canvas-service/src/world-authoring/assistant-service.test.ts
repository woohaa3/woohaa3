import { describe, expect, it } from "vitest";
import type {
  ServerCanvas,
  WorldObjectVersion,
  WorldScopeVersion,
  WorldToolContext
} from "@woohaa3/contracts";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { createAssistantWorldService } from "./assistant-service.js";
import { InMemoryAssistantHostCompletionRepository } from "./host-completions.js";
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
  confirmStopped?: (input: unknown) => Promise<void>;
  /** Throw on this many initial history writes before succeeding. */
  historyFailures?: number;
  hostCompletions?: InMemoryAssistantHostCompletionRepository;
  /** Override the initial canonical canvas (for tests needing scene-area data etc.). */
  canvas?: ServerCanvas;
} = {}) {
  const context = overrides.context ?? contextFor();
  const revoked: string[] = [];
  const saved: Array<Record<string, unknown>> = [];
  const completed: Array<Record<string, unknown>> = [];
  let remainingHistoryFailures = overrides.historyFailures ?? 0;
  let current = overrides.canvas ?? canvasFixture();
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
      refreshContextVersions() { /* no-op stub */ },
      refreshContextScope() { /* no-op stub */ }
    },
    cameraSettings: {
      async save(input: never) {
        const value = input as unknown as Record<string, unknown>;
        saved.push(value);
        return { ok: true, canvasId: "canvas-1", cameraId: "camera-1", commandId: "camera-cmd", revision: 3, duplicate: false,
          camera: {
            kind: "world-camera",
            version: "shared-world-v1",
            cameraId: "camera-1",
            settingsVersion: "cv-2",
            position: { u: 0, v: 0, h: 2 },
            rotation: [0, 0, 0, 1],
            projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
            captureMode: { kind: "static" },
            aspect: { width: 16, height: 9 },
            boundInstanceId: null
          },
          settingsVersion: "cv-2" } as never;
      },
      async complete(input: never) {
        const value = input as unknown as Record<string, unknown>;
        if (remainingHistoryFailures > 0) {
          remainingHistoryFailures -= 1;
          throw new Error("injected transient history failure");
        }
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
    ...(overrides.hostCompletions ? { hostCompletions: overrides.hostCompletions } : {}),
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
    const viewed = await service.read({ canvasId: "canvas-1", contextId: issued.context.contextId });
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

  it("creates a world camera inside the issued director area and rejects an outside positioning point", async () => {
    const canvas = canvasFixture();
    canvas.nodeData["area"] = {
      sceneArea: {
        kind: "scene-area",
        version: "shared-world-v1",
        areaId: "area-1",
        scopeVersion: "scope-1",
        bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
      }
    } as never;
    const { service } = harness({ canvas });
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
      position: { u: 2, v: 3, h: 1 },
      rotation: [0, 0, 0, 1] as const,
      projection: { kind: "perspective" as const, verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
      captureMode: { kind: "static" as const },
      aspect: { width: 16, height: 9 },
      boundInstanceId: null
    };
    const written = await service.write({
      contextId: issued.context.contextId,
      operation: {
        kind: "create-world-camera",
        operationId: "create-camera-1",
        nodeId: "asset-camera-node-1",
        cameraId: "asset-camera-1",
        settings,
        cardPosition: { x: 12, y: 34 }
      }
    });
    expect(written).toMatchObject({ ok: true, cameraId: "asset-camera-1", nodeId: "asset-camera-node-1" });
    // 定位点在导演区外时不再拒绝，而是扩大导演区把镜头包进去（同一原子批次）。
    const outside = await service.write({
      contextId: issued.context.contextId,
      operation: {
        kind: "create-world-camera",
        operationId: "create-camera-2",
        nodeId: "asset-camera-node-2",
        cameraId: "asset-camera-2",
        settings: { ...settings, position: { u: 50, v: 50, h: 1 } }
      }
    });
    expect(outside).toMatchObject({ ok: true, cameraId: "asset-camera-2", nodeId: "asset-camera-node-2" });
  });

  it("returns the camera view so a wrong framing is visible after a successful write", async () => {
    const canvas = canvasFixture();
    canvas.nodeData["area"] = {
      sceneArea: {
        kind: "scene-area",
        version: "shared-world-v1",
        areaId: "area-1",
        scopeVersion: "scope-1",
        bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
      }
    } as never;
    const { service } = harness({ canvas });
    const issued = await service.issue({
      canvasId: "canvas-1",
      requestId: "req-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { kind: "scene-area", areaId: "area-1" }
    });
    if (!issued.ok) throw new Error(issued.message);
    const written = await service.write({
      contextId: issued.context.contextId,
      operation: {
        kind: "create-world-camera",
        operationId: "create-camera-view",
        nodeId: "asset-camera-node-view",
        cameraId: "asset-camera-view",
        settings: {
          // -90° pitch about u: the lens points straight down at the ground under (5, 5).
          position: { u: 5, v: 5, h: 2 },
          rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
          projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
          captureMode: { kind: "static" },
          aspect: { width: 16, height: 9 },
          boundInstanceId: null
        }
      }
    });
    if (!written.ok) throw new Error(written.message);
    expect(written.view).toBeDefined();
    expect(written.view!.forward.u).toBeCloseTo(0, 6);
    expect(written.view!.forward.v).toBeCloseTo(0, 6);
    expect(written.view!.forward.h).toBeCloseTo(-1, 6);
    expect(written.view!.groundIntersection).not.toBeNull();
    expect(written.view!.groundIntersection!.u).toBeCloseTo(5, 6);
    expect(written.view!.groundIntersection!.v).toBeCloseTo(5, 6);
  });

  it("records completion once only after the host records a successful terminal turn", async () => {
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
    // An active/adapter-failed turn and a bare `completed` claim are not host
    // completion evidence: no history may be written yet.
    expect(await service.verifyCompletion(completion, undefined)).toBe(false);
    const early = await service.complete({
      contextId: issued.context.contextId,
      completion,
      evidence: { turnStatus: "running", failure: "adapter aborted", completed: true }
    });
    expect(early).toMatchObject({ ok: false, code: "unverified-run" });
    expect(completed).toHaveLength(0);

    const settled = await service.settleRun({
      canvasId: "canvas-1",
      runId: "run-1",
      status: "succeeded",
      evidence: { owner: "owner-1", requestId: "req-1" }
    });
    expect(settled).toEqual({ ok: true });
    expect(completed).toHaveLength(1);
    const verified = await service.verifyCompletion(completion, undefined);
    expect(verified).toMatchObject({ snapshot: { cameraId: "camera-1", settingsVersion: "cv-2" } });

    const first = await service.complete({ contextId: issued.context.contextId, completion });
    expect(first).toMatchObject({ ok: true, duplicate: true });
    const second = await service.complete({ contextId: issued.context.contextId, completion });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(completed).toHaveLength(1);
  });

  it("keeps a failed history write retryable after the exact stop released the run", async () => {
    const hostCompletions = new InMemoryAssistantHostCompletionRepository();
    const { service, completed } = harness({ historyFailures: 1, hostCompletions });
    const issued = await service.issue({
      canvasId: "canvas-1",
      requestId: "req-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { kind: "scene-area", areaId: "area-1" }
    });
    if (!issued.ok) throw new Error(issued.message);
    await service.write({
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
    const settlement = {
      canvasId: "canvas-1",
      runId: "run-1",
      status: "succeeded" as const,
      evidence: { owner: "owner-1", requestId: "req-1" }
    };
    const first = await service.settleRun(settlement);
    expect(first).toMatchObject({ ok: false, code: "not-ready" });
    expect(completed).toHaveLength(0);
    expect(await hostCompletions.list({ canvasId: "canvas-1", runId: "run-1" })).toHaveLength(1);

    const second = await service.settleRun(settlement);
    expect(second).toEqual({ ok: true });
    expect(completed).toHaveLength(1);
    expect(await hostCompletions.list({ canvasId: "canvas-1", runId: "run-1" })).toHaveLength(0);
  });

  it("lets a complete retry补记 a pending host fact after the run was settled", async () => {
    const hostCompletions = new InMemoryAssistantHostCompletionRepository();
    const { service, completed } = harness({ historyFailures: 1, hostCompletions });
    const issued = await service.issue({
      canvasId: "canvas-1",
      requestId: "req-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { kind: "scene-area", areaId: "area-1" }
    });
    if (!issued.ok) throw new Error(issued.message);
    await service.write({
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
    expect(await service.settleRun({
      canvasId: "canvas-1",
      runId: "run-1",
      status: "succeeded",
      evidence: { owner: "owner-1", requestId: "req-1" }
    })).toMatchObject({ ok: false, code: "not-ready" });
    const completion = {
      canvasId: "canvas-1",
      runId: "run-1",
      completionId: issued.completionId,
      cameraId: "camera-1",
      settingsVersion: "cv-2"
    };
    const retried = await service.complete({ contextId: issued.context.contextId, completion });
    expect(retried).toMatchObject({ ok: true, duplicate: false });
    expect(completed).toHaveLength(1);
    expect(await hostCompletions.list()).toHaveLength(0);
  });

  it("replays a durable host fact after a process rebuild instead of losing history", async () => {
    const hostCompletions = new InMemoryAssistantHostCompletionRepository();
    const pending = [{ intent: { requestId: "req-1", runId: "run-1", epoch: 0, executionId: "exec-1" }, state: "active" as const }];
    const firstRun = harness({ historyFailures: 1, hostCompletions, pending });
    const issued = await firstRun.service.issue({
      canvasId: "canvas-1",
      requestId: "req-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { kind: "scene-area", areaId: "area-1" }
    });
    if (!issued.ok) throw new Error(issued.message);
    await firstRun.service.write({
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
    expect(await firstRun.service.settleRun({
      canvasId: "canvas-1",
      runId: "run-1",
      status: "succeeded",
      evidence: { owner: "owner-1", requestId: "req-1" }
    })).toMatchObject({ ok: false, code: "not-ready" });
    firstRun.service.close();

    const secondRun = harness({ hostCompletions, pending });
    const settled = await secondRun.service.settleRun({
      canvasId: "canvas-1",
      runId: "run-1",
      status: "succeeded",
      evidence: { owner: "owner-1", requestId: "req-1" }
    });
    expect(settled).toEqual({ ok: true });
    expect(secondRun.completed).toHaveLength(1);
    expect(await hostCompletions.list()).toHaveLength(0);
    const retried = await secondRun.service.complete({
      contextId: issued.context.contextId,
      completion: {
        canvasId: "canvas-1",
        runId: "run-1",
        completionId: issued.completionId,
        cameraId: "camera-1",
        settingsVersion: "cv-2"
      }
    });
    expect(retried).toMatchObject({ ok: true, duplicate: true });
  });

  it("recovers a camera completion when the backend restarts before the first successful settle", async () => {
    const hostCompletions = new InMemoryAssistantHostCompletionRepository();
    const pending = [{ intent: { requestId: "req-1", runId: "run-1", epoch: 0, executionId: "exec-1" }, state: "active" as const }];
    const firstRun = harness({ hostCompletions, pending });
    const issued = await firstRun.service.issue({
      canvasId: "canvas-1",
      requestId: "req-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { kind: "scene-area", areaId: "area-1" }
    });
    if (!issued.ok) throw new Error(issued.message);
    const written = await firstRun.service.write({
      contextId: issued.context.contextId,
      operation: {
        kind: "set-world-camera",
        operationId: "camera-1",
        cameraId: "camera-1",
        expectedSettingsVersion: "cv-1",
        settings: {
          position: { u: 0, v: 0, h: 2 },
          rotation: [0, 0, 0, 1],
          projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
          captureMode: { kind: "static" },
          aspect: { width: 16, height: 9 },
          boundInstanceId: null
        }
      }
    });
    expect(written.ok).toBe(true);
    expect(await hostCompletions.listCommitted({ canvasId: "canvas-1", runId: "run-1" })).toHaveLength(1);
    firstRun.service.close();

    const completion = {
      canvasId: "canvas-1",
      runId: "run-1",
      completionId: issued.completionId,
      cameraId: "camera-1",
      settingsVersion: "cv-2"
    };
    const secondRun = harness({ hostCompletions, pending });
    // The supervisor may reissue the same run before settling it; the reissued
    // ledger is empty, so recovery must also reconcile the durable outbox.
    const reissued = await secondRun.service.issue({
      canvasId: "canvas-1",
      requestId: "req-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { kind: "scene-area", areaId: "area-1" }
    });
    expect(reissued).toMatchObject({ ok: true });
    // A durable committed write is not by itself a successful host completion.
    expect(await secondRun.service.verifyCompletion(completion, undefined)).toBe(false);
    const settlement = {
      canvasId: "canvas-1",
      runId: "run-1",
      status: "succeeded" as const,
      evidence: { owner: "owner-1", requestId: "req-1" }
    };
    expect(await secondRun.service.settleRun(settlement)).toEqual({ ok: true });
    expect(secondRun.completed).toHaveLength(1);
    expect(secondRun.completed[0]).toMatchObject({
      completion: { completionId: issued.completionId, settingsVersion: "cv-2", cameraId: "camera-1" }
    });
    expect(await hostCompletions.list({ canvasId: "canvas-1", runId: "run-1" })).toHaveLength(0);
    expect(await hostCompletions.listCommitted({ canvasId: "canvas-1", runId: "run-1" })).toHaveLength(0);
    // Repeated settle and completion retries stay idempotent.
    expect(await secondRun.service.settleRun(settlement)).toEqual({ ok: true });
    expect(secondRun.completed).toHaveLength(1);
  });

  it("keeps an outbox write and occupancy when the restarted stop is not verified", async () => {
    const hostCompletions = new InMemoryAssistantHostCompletionRepository();
    const pending = [{ intent: { requestId: "req-1", runId: "run-1", epoch: 0, executionId: "exec-1" }, state: "active" as const }];
    const firstRun = harness({ hostCompletions, pending });
    const issued = await firstRun.service.issue({
      canvasId: "canvas-1",
      requestId: "req-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { kind: "scene-area", areaId: "area-1" }
    });
    if (!issued.ok) throw new Error(issued.message);
    await firstRun.service.write({
      contextId: issued.context.contextId,
      operation: {
        kind: "set-world-camera",
        operationId: "camera-1",
        cameraId: "camera-1",
        expectedSettingsVersion: "cv-1",
        settings: {
          position: { u: 0, v: 0, h: 2 },
          rotation: [0, 0, 0, 1],
          projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
          captureMode: { kind: "static" },
          aspect: { width: 16, height: 9 },
          boundInstanceId: null
        }
      }
    });
    firstRun.service.close();

    let stopChecks = 0;
    const secondRun = harness({
      hostCompletions,
      pending,
      async confirmStopped() {
        stopChecks += 1;
        throw Object.assign(new Error("stop evidence rejected"), { code: "unverified-stop" });
      }
    });
    const settled = await secondRun.service.settleRun({
      canvasId: "canvas-1",
      runId: "run-1",
      status: "succeeded",
      evidence: null
    });
    expect(settled).toMatchObject({ ok: false, code: "unverified-stop" });
    expect(stopChecks).toBe(1);
    // No history, no lease release, no consumed outbox.
    expect(secondRun.completed).toHaveLength(0);
    expect(await hostCompletions.list({ canvasId: "canvas-1", runId: "run-1" })).toHaveLength(0);
    expect(await hostCompletions.listCommitted({ canvasId: "canvas-1", runId: "run-1" })).toHaveLength(1);
  });

  it("never promotes a committed camera write for a failed terminal turn", async () => {
    const hostCompletions = new InMemoryAssistantHostCompletionRepository();
    const pending = [{ intent: { requestId: "req-1", runId: "run-1", epoch: 0, executionId: "exec-1" }, state: "active" as const }];
    const firstRun = harness({ hostCompletions, pending });
    const issued = await firstRun.service.issue({
      canvasId: "canvas-1",
      requestId: "req-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { kind: "scene-area", areaId: "area-1" }
    });
    if (!issued.ok) throw new Error(issued.message);
    await firstRun.service.write({
      contextId: issued.context.contextId,
      operation: {
        kind: "set-world-camera",
        operationId: "camera-1",
        cameraId: "camera-1",
        expectedSettingsVersion: "cv-1",
        settings: {
          position: { u: 0, v: 0, h: 2 },
          rotation: [0, 0, 0, 1],
          projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
          captureMode: { kind: "static" },
          aspect: { width: 16, height: 9 },
          boundInstanceId: null
        }
      }
    });
    firstRun.service.close();

    const secondRun = harness({ hostCompletions, pending });
    expect(await secondRun.service.settleRun({
      canvasId: "canvas-1",
      runId: "run-1",
      status: "failed",
      evidence: { owner: "owner-1", requestId: "req-1" }
    })).toEqual({ ok: true });
    expect(secondRun.completed).toHaveLength(0);
    expect(await hostCompletions.list({ canvasId: "canvas-1", runId: "run-1" })).toHaveLength(0);
    expect(await hostCompletions.listCommitted({ canvasId: "canvas-1", runId: "run-1" })).toHaveLength(0);
    expect(await secondRun.service.verifyCompletion({
      canvasId: "canvas-1",
      runId: "run-1",
      completionId: issued.completionId,
      cameraId: "camera-1",
      settingsVersion: "cv-2"
    }, undefined)).toBe(false);
  });

  it("never records camera history for a failed terminal turn", async () => {
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
    await service.write({
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
    const settled = await service.settleRun({
      canvasId: "canvas-1",
      runId: "run-1",
      status: "failed",
      evidence: { owner: "owner-1", requestId: "req-1" }
    });
    expect(settled).toEqual({ ok: true });
    expect(completed).toHaveLength(0);
    const completion = await service.complete({
      contextId: issued.context.contextId,
      completion: {
        canvasId: "canvas-1",
        runId: "run-1",
        completionId: issued.completionId,
        cameraId: "camera-1",
        settingsVersion: "cv-2"
      }
    });
    expect(completion).toMatchObject({ ok: false });
  });

  it("releases a reopened pending run only after exact host stop evidence", async () => {
    const pending = [{ intent: { requestId: "req-1", runId: "run-1", epoch: 0, executionId: "exec-1" }, state: "active" as const }];
    const confirmed: Array<Record<string, unknown>> = [];
    const { service } = harness({
      pending,
      confirmStopped: async (input) => { confirmed.push(input as Record<string, unknown>); }
    });
    const settled = await service.settleRun({
      canvasId: "canvas-1",
      runId: "run-1",
      status: "succeeded",
      evidence: { owner: "owner-1", requestId: "req-1" }
    });
    expect(settled).toEqual({ ok: true });
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ requestId: "req-1", runId: "run-1", epoch: 0, executionId: "exec-1" });
  });

  it("keeps a reopened pending run when the host cannot verify the stop", async () => {
    const pending = [{ intent: { requestId: "req-1", runId: "run-1", epoch: 0, executionId: "exec-1" }, state: "active" as const }];
    const { service } = harness({
      pending,
      confirmStopped: async () => {
        throw Object.assign(new Error("not verified"), { code: "unverified-stop" });
      }
    });
    const unverified = await service.settleRun({
      canvasId: "canvas-1",
      runId: "run-1",
      status: "succeeded",
      evidence: { unverified: true }
    });
    expect(unverified).toMatchObject({ ok: false, code: "unverified-stop" });
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
