import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  type ServerCanvas
} from "@woohaa3/contracts";
import {
  createWorldAuthoringAuthority,
  instanceFootprint,
  nextSceneAreaScopeVersion,
  worldObjectVersion,
  type WorldAuthoringAuthority
} from "./authority.js";

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

function instance(id: string, u: number, v: number, extra: Record<string, unknown> = {}) {
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
    modelScript: "scene.box({ id: 'body', size: [2, 2, 2] });",
    modelScriptLanguage: "javascript",
    modelScriptVersion: "woohaa-model-js-v2",
    modelContentVersion: { revision: 1, sourceHash: `source-${id}`, contentHash: `content-${id}` },
    ...extra
  };
}

function canvasFixture(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-authority", now);
  const area = {
    kind: "scene-area",
    version: "shared-world-v1",
    areaId: "area-main",
    scopeVersion: "area-scope-1",
    bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
  };
  const camera = (id: string, u: number, v: number) => ({
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
  });
  canvas.document.nodes.push(
    { id: "area", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "complete", type: "model3d", position: { x: 0, y: 0 } },
    { id: "partial", type: "model3d", position: { x: 0, y: 0 } },
    { id: "outside", type: "model3d", position: { x: 0, y: 0 } },
    { id: "camera-card", type: "world-camera", position: { x: 900, y: 900 } },
    { id: "camera-out-card", type: "world-camera", position: { x: 0, y: 0 } },
    { id: "group", type: "workflow-group-2d", position: { x: 0, y: 0 } }
  );
  canvas.nodeData.area = { sceneArea: area };
  canvas.nodeData.complete = instance("complete-a", 1, 1);
  canvas.nodeData.partial = instance("partial-b", 9.5, 1);
  canvas.nodeData.outside = instance("outside-c", 20, 20);
  canvas.nodeData["camera-card"] = { worldCamera: camera("camera-in", 5, 5) };
  canvas.nodeData["camera-out-card"] = { worldCamera: camera("camera-out", 20, 5) };
  canvas.nodeData.group = {
    workflowGroup2d: {
      kind: "workflow-group-2d",
      version: "shared-world-v1",
      groupId: "group-1",
      scopeVersion: "group-scope-1",
      memberNodeIds: ["complete", "camera-card"]
    }
  };
  return canvas;
}

describe("world authoring authority", () => {
  it("classifies complete, partial, outside and camera anchors from authoritative bounds", async () => {
    const authority = createWorldAuthoringAuthority({ executeScene });
    const prepared = await authority.prepareCanvas(canvasFixture(), { kind: "scene-area", areaId: "area-main" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const snapshot = prepared.snapshot;
    expect(snapshot.writable.map(target => target.kind === "instance" ? target.instanceId : target.cameraId).sort())
      .toEqual(["camera-in", "complete-a"]);
    expect(snapshot.readOnly.map(target => target.kind === "instance" ? target.instanceId : target.cameraId)).toEqual(["partial-b"]);
    const objects = new Map(snapshot.objects.map(entry => [JSON.stringify(entry.identity), entry.containment]));
    expect(objects.get(JSON.stringify({ kind: "instance", instanceId: "outside-c" }))).toBe("outside");
    expect(objects.get(JSON.stringify({ kind: "camera", cameraId: "camera-out" }))).toBe("outside");
    // The card is far outside the visible area, but the spatial anchor is inside.
    expect(objects.get(JSON.stringify({ kind: "camera", cameraId: "camera-in" }))).toBe("writable");
  });

  it("fails closed when authoritative instance bounds are unknown", async () => {
    const canvas = canvasFixture();
    canvas.nodeData.broken = instance("broken", 2, 2, { modelScript: "" });
    canvas.document.nodes.push({ id: "broken", type: "model3d", position: { x: 0, y: 0 } });
    const authority = createWorldAuthoringAuthority({ executeScene });
    const prepared = await authority.prepareCanvas(canvas, { kind: "scene-area", areaId: "area-main" });
    expect(prepared).toMatchObject({ ok: false, code: "not-ready" });
  });

  it("grants no world write through 2D group membership", async () => {
    const authority = createWorldAuthoringAuthority({ executeScene });
    const canvas = canvasFixture();
    const group = await authority.prepareGroup(canvas, "group-1");
    expect(group.ok).toBe(true);
    if (!group.ok) return;
    expect(group.snapshot.writable).toEqual([]);
    expect(group.snapshot.readOnly.map(target => target.kind === "instance" ? target.instanceId : target.cameraId).sort())
      .toEqual(["camera-in", "complete-a"]);
    const scope = group.snapshot.scope;
    expect(authority.eligible({
      requestId: "r", canvasId: canvas.id, runId: "run", epoch: 1, executionId: "exec",
      scope, writable: [{ kind: "instance", instanceId: "complete-a", version: "v" }], readOnly: []
    }, [{ kind: "instance", instanceId: "complete-a", version: "v" }])).toBe(false);
    expect(authority.eligible({
      requestId: "r", canvasId: canvas.id, runId: "run", epoch: 1, executionId: "exec",
      scope, writable: [], readOnly: []
    }, [])).toBe(true);
  });

  it("rejects stale target versions and advances scope/version identity deterministically", async () => {
    const authority: WorldAuthoringAuthority = createWorldAuthoringAuthority({ executeScene });
    const canvas = canvasFixture();
    const prepared = await authority.prepareCanvas(canvas, { kind: "scene-area", areaId: "area-main" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const scope = prepared.snapshot.scope;
    const complete = prepared.snapshot.writable.filter(target => target.kind === "instance")[0]!;
    expect(authority.eligible({
      requestId: "r", canvasId: canvas.id, runId: "run", epoch: 1, executionId: "exec",
      scope, writable: [complete], readOnly: []
    }, [complete])).toBe(true);
    expect(authority.eligible({
      requestId: "r", canvasId: canvas.id, runId: "run", epoch: 1, executionId: "exec",
      scope, writable: [{ ...complete, version: "stale" }], readOnly: []
    }, [{ ...complete, version: "stale" }])).toBe(false);

    expect(nextSceneAreaScopeVersion("area", { min: { u: 0, v: 0 }, max: { u: 1, v: 1 } }))
      .not.toBe(nextSceneAreaScopeVersion("area", { min: { u: 0, v: 0 }, max: { u: 2, v: 1 } }));
    const versionBefore = worldObjectVersion(canvas, { kind: "instance", instanceId: "complete-a" });
    const moved = JSON.parse(JSON.stringify(canvas)) as ServerCanvas;
    (moved.nodeData.complete as { sharedWorldInstance: { transform: { position: { u: number } } } }).sharedWorldInstance.transform.position.u = 3;
    expect(worldObjectVersion(moved, { kind: "instance", instanceId: "complete-a" })).not.toBe(versionBefore);
  });

  it("maps a 2x2 asset box through pose and scale to the ground footprint", () => {
    const bounds = instanceFootprint(
      { min: [-1, -1, -1], max: [1, 1, 1] },
      {
        version: "shared-world-v1",
        position: { u: 2, v: 3, h: 5 },
        rotation: [0, 0, 0, 1],
        scale: 2
      }
    );
    expect(bounds.min).toEqual({ u: 0, v: 1 });
    expect(bounds.max).toEqual({ u: 4, v: 5 });
  });
});
