import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  normalizeModelDefinition,
  type ServerCanvas
} from "@woohaa3/contracts";
import { createWorldAuthoringAuthority } from "./authority.js";
import { createWorldAuthoringService, type WorldAuthoringServiceDeps } from "./scene-area-service.js";
import type { SpatialOccupancyReadResult } from "./spatial-leases.js";

const NOW = "2026-01-01T00:00:00Z";
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

function canvasFixture(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-occupancy", NOW);
  canvas.document.nodes.push(
    { id: "area", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "inside", type: "model3d", position: { x: 0, y: 0 } },
    { id: "partial", type: "model3d", position: { x: 0, y: 0 } },
    { id: "outside", type: "model3d", position: { x: 0, y: 0 } },
    { id: "camera", type: "world-camera", position: { x: 900, y: 900 } }
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
  canvas.nodeData.inside = instanceData("inside-a", 1, 1);
  canvas.nodeData.partial = instanceData("partial-b", 9.5, 1);
  canvas.nodeData.outside = instanceData("outside-c", 20, 20);
  canvas.nodeData.camera = {
    worldCamera: {
      kind: "world-camera",
      version: "shared-world-v1",
      cameraId: "cam-in",
      settingsVersion: "cam-in-v1",
      position: { u: 5, v: 5, h: 1.5 },
      rotation: [0, 0, 0, 1],
      projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
      captureMode: { kind: "static" },
      aspect: { width: 16, height: 9 },
      boundInstanceId: null
    }
  };
  return canvas;
}

function serviceWith(readOccupancy: WorldAuthoringServiceDeps["readOccupancy"]) {
  const canvas = canvasFixture();
  const room = {
    inspectPublished: async (project: (value: ServerCanvas) => ServerCanvas) => ({ ok: true as const, canvas: project(canvas) })
  };
  let acquisitions = 0;
  const service = createWorldAuthoringService({
    authority: createWorldAuthoringAuthority({
      executeScene: async () => ({
        ok: true as const,
        version: "woohaa-model-js-v2" as const,
        sceneVersion: "scene-ir-v2",
        json: "",
        sourceHash: "fixture",
        ops: [box] as never
      })
    }),
    resolveRoom: async () => room as never,
    acquire: async () => { acquisitions += 1; throw new Error("prepare must not acquire"); },
    cancel: async () => { throw new Error("prepare must not cancel"); },
    findLatest: async () => null,
    ...(readOccupancy ? { readOccupancy } : {})
  });
  return { service, canvas, acquisitions: () => acquisitions };
}

describe("scene-area prepare occupancy preflight", () => {
  it("reports idle only when the durable store confirms no lock for in-scope objects", async () => {
    const seen: string[][] = [];
    const { service, acquisitions } = serviceWith(async (canvasId, targets): Promise<SpatialOccupancyReadResult> => {
      expect(canvasId).toBe("canvas-occupancy");
      seen.push(targets.map(target => `${target.kind}:${target.kind === "instance" ? target.instanceId : target.cameraId}`).sort());
      return { ok: true, locks: [] };
    });
    const result = await service.prepare({ canvasId: "canvas-occupancy", areaId: "area-main" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.occupancy).toEqual({
      version: "world-scope-occupancy-v1",
      scope: result.snapshot.scope,
      state: "idle",
      locks: []
    });
    // Only writable + read-only objects of the selected scope are queried.
    expect(seen).toEqual([["camera:cam-in", "instance:inside-a", "instance:partial-b"]]);
    expect(acquisitions()).toBe(0);
  });

  it("reports the exact locks and never exposes execution identity", async () => {
    const { service } = serviceWith(async () => ({
      ok: true,
      locks: [
        { target: { kind: "instance", instanceId: "inside-a" }, runId: "run-1", epoch: 4, state: "active" },
        { target: { kind: "camera", cameraId: "cam-in" }, runId: "run-2", epoch: 1, state: "cancelled" }
      ]
    }));
    const result = await service.prepare({ canvasId: "canvas-occupancy", areaId: "area-main" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.occupancy.state).toBe("occupied");
    expect(result.snapshot.occupancy.locks).toEqual([
      { target: { kind: "instance", instanceId: "inside-a" }, runId: "run-1", epoch: 4, state: "active" },
      { target: { kind: "camera", cameraId: "cam-in" }, runId: "run-2", epoch: 1, state: "cancelled" }
    ]);
    expect(JSON.stringify(result.snapshot.occupancy)).not.toContain("exec");
    expect(JSON.stringify(result.snapshot.occupancy)).not.toContain("capability");
  });

  it("reports unknown instead of idle when the lease store is missing, unavailable or throws", async () => {
    const missing = serviceWith(undefined);
    const missingResult = await missing.service.prepare({ canvasId: "canvas-occupancy", areaId: "area-main" });
    expect(missingResult.ok).toBe(true);
    if (missingResult.ok) {
      expect(missingResult.snapshot.occupancy).toMatchObject({ state: "unknown", locks: [], reason: "store-unavailable" });
    }

    const unavailable = serviceWith(async () => ({ ok: false, reason: "store-unavailable" }));
    const unavailableResult = await unavailable.service.prepare({ canvasId: "canvas-occupancy", areaId: "area-main" });
    expect(unavailableResult.ok).toBe(true);
    if (unavailableResult.ok) {
      expect(unavailableResult.snapshot.occupancy).toMatchObject({ state: "unknown", locks: [], reason: "store-unavailable" });
    }

    const thrown = serviceWith(async () => { throw new Error("db closed"); });
    const thrownResult = await thrown.service.prepare({ canvasId: "canvas-occupancy", areaId: "area-main" });
    expect(thrownResult.ok).toBe(true);
    if (thrownResult.ok) {
      expect(thrownResult.snapshot.occupancy).toMatchObject({ state: "unknown", locks: [], reason: "store-unavailable" });
    }
  });
});
