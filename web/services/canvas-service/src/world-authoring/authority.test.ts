import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  executeModelWithStoredRig,
  HUMANOID_REFERENCE_PARAMETERS,
  type WorldInstanceData,
  type ServerCanvas
} from "@woohaa3/contracts";
import {
  createWorldAuthoringAuthority,
  instanceFootprint,
  nextSceneAreaScopeVersion,
  worldObjectVersion,
  type WorldAuthoringAuthority,
  type WorldAuthoringAuthorityOptions
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

function singleInstanceCanvas(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-single", now);
  canvas.document.nodes.push(
    { id: "area", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "solo", type: "model3d", position: { x: 0, y: 0 } }
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
  canvas.nodeData.solo = instance("solo-a", 1, 1);
  return canvas;
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
  it("grants body overflow when the authoritative ground anchor remains inside", async () => {
    const authority = createWorldAuthoringAuthority({ executeScene });
    const prepared = await authority.prepareCanvas(canvasFixture(), { kind: "scene-area", areaId: "area-main" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const snapshot = prepared.snapshot;
    expect(snapshot.writable.map(target => target.kind === "instance" ? target.instanceId : target.cameraId).sort())
      .toEqual(["camera-in", "complete-a", "partial-b"]);
    expect(snapshot.readOnly.map(target => target.kind === "instance" ? target.instanceId : target.cameraId)).toEqual([]);
    const objects = new Map(snapshot.objects.map(entry => [JSON.stringify(entry.identity), entry.containment]));
    expect(objects.get(JSON.stringify({ kind: "instance", instanceId: "outside-c" }))).toBe("outside");
    expect(objects.get(JSON.stringify({ kind: "camera", cameraId: "camera-out" }))).toBe("outside");
    // The card is far outside the visible area, but the spatial anchor is inside.
    expect(objects.get(JSON.stringify({ kind: "camera", cameraId: "camera-in" }))).toBe("writable");
  });

  it("keeps anchor-out body overlap reference-only and rejects the same commit poststate", async () => {
    const canvas = singleInstanceCanvas();
    const authority = createWorldAuthoringAuthority({ executeScene });
    const prepared = await authority.prepareCanvas(canvas, { kind: "scene-area", areaId: "area-main" });
    if (!prepared.ok) throw new Error("fixture preparation failed");
    const target = { kind: "instance" as const, instanceId: "solo-a" };
    const intent = { requestId: "r", canvasId: canvas.id, runId: "run", epoch: 1, executionId: "exec",
      scope: prepared.snapshot.scope, writable: prepared.snapshot.writable, readOnly: [] };
    const after = structuredClone(canvas);
    const transform = (after.nodeData.solo.sharedWorldInstance as unknown as WorldInstanceData).transform;
    transform.position.u = 10;
    // Anchor on the boundary authorizes even though the body extends beyond it.
    expect(authority.resolve(intent, canvas, after, [target])).not.toBeNull();
    transform.position.u = 10.5;
    expect(authority.resolve(intent, canvas, after, [target])).toBeNull();
    const snapshot = await authority.prepareCanvas(after, { kind: "scene-area", areaId: "area-main" });
    expect(snapshot.ok && snapshot.snapshot.objects[0]?.containment).toBe("read-only");
    transform.position.u = 20;
    const outside = await authority.prepareCanvas(after, { kind: "scene-area", areaId: "area-main" });
    expect(outside.ok && outside.snapshot.objects[0]?.containment).toBe("outside");
  });

  it("transforms the actual bottom anchor with tilted rotation and scale instead of testing the origin", async () => {
    const canvas = singleInstanceCanvas();
    const transform = (canvas.nodeData.solo.sharedWorldInstance as unknown as WorldInstanceData).transform;
    // Bottom is local y=-1. World tilt maps it to u=2 after scale, so
    // an origin outside the left edge still has a valid anchor on the edge.
    transform.position.u = -2;
    transform.rotation = [0, -Math.SQRT1_2, 0, Math.SQRT1_2];
    transform.scale = 2;
    const authority = createWorldAuthoringAuthority({ executeScene });
    const prepared = await authority.prepareCanvas(canvas, { kind: "scene-area", areaId: "area-main" });
    expect(prepared.ok && prepared.snapshot.objects[0]?.containment).toBe("writable");
  });

  it("executes and versions stored rig parameters and uses foot geometry rather than the body center", async () => {
    const canvas = singleInstanceCanvas();
    const rig = { profile: "humanoid", templateId: "humanoid", templateVersion: 1, parameters: HUMANOID_REFERENCE_PARAMETERS } as const;
    canvas.nodeData.solo.modelRig = rig;
    canvas.nodeData.solo.modelScript = 'scene.segment({id:"abdomen",parent:rig.joint("Spine"),from:[0,-0.5,0],to:[0,0,0],width:0.32,depth:0.24,shape:"box"});scene.box({id:"body",parent:rig.joint("Spine"),position:[20,0,0],size:[10,2,2]});scene.box({id:"foot",parent:rig.joint("LeftFoot"),position:[0,-0.04,0.08],size:[0.24,0.14,0.38]});';
    let received: unknown;
    const authority = createWorldAuthoringAuthority({ executeScene: async (source, version, options) => {
      received = options?.rig;
      const execution = executeModelWithStoredRig(source, version, rig);
      if (!execution.ok) return execution as never;
      return { ok: true, version: "woohaa-model-js-v2", sceneVersion: "scene-ir-v2", ops: execution.scene.ops, json: "", sourceHash: "fixture" };
    } });
    const prepared = await authority.prepareCanvas(canvas, { kind: "scene-area", areaId: "area-main" });
    expect(received).toEqual(rig.parameters);
    expect(prepared.ok && prepared.snapshot.objects[0]?.containment).toBe("writable");
    const oldVersion = worldObjectVersion(canvas, { kind: "instance", instanceId: "solo-a" });
    canvas.nodeData.solo.modelRig = { ...rig, parameters: { ...rig.parameters, height: 4 } };
    expect(worldObjectVersion(canvas, { kind: "instance", instanceId: "solo-a" })).not.toBe(oldVersion);
  });

  it("fails closed when authoritative instance bounds are unknown", async () => {
    const canvas = canvasFixture();
    canvas.nodeData.broken = instance("broken", 2, 2, { modelScript: "" });
    canvas.document.nodes.push({ id: "broken", type: "model3d", position: { x: 0, y: 0 } });
    const authority = createWorldAuthoringAuthority({ executeScene });
    const prepared = await authority.prepareCanvas(canvas, { kind: "scene-area", areaId: "area-main" });
    expect(prepared).toMatchObject({ ok: false, code: "not-ready",
      message: "无法准备场景模型。模型「broken」：模型脚本为空，请修复模型内容" });
  });

  it("recovers after a transient bounds preparation failure without authorizing unknown", async () => {
    let calls = 0;
    const flaky: NonNullable<WorldAuthoringAuthorityOptions["executeScene"]> = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient bounds preparation failure");
      return executeScene();
    };
    const authority = createWorldAuthoringAuthority({ executeScene: flaky });
    const canvas = canvasFixture();
    const first = await authority.prepareCanvas(canvas, { kind: "scene-area", areaId: "area-main" });
    expect(first).toMatchObject({ ok: false, code: "not-ready" });
    const second = await authority.prepareCanvas(canvas, { kind: "scene-area", areaId: "area-main" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.snapshot.writable.map(target => target.kind === "instance" ? target.instanceId : target.cameraId).sort())
      .toEqual(["camera-in", "complete-a", "partial-b"]);
  });

  it("keeps genuinely unknown model bounds unauthorized", async () => {
    const unavailable: NonNullable<WorldAuthoringAuthorityOptions["executeScene"]> = async () => ({
      ok: false,
      code: "execution-failed",
      message: "no bounds"
    } as never);
    const authority = createWorldAuthoringAuthority({ executeScene: unavailable });
    const canvas = canvasFixture();
    const first = await authority.prepareCanvas(canvas, { kind: "scene-area", areaId: "area-main" });
    const second = await authority.prepareCanvas(canvas, { kind: "scene-area", areaId: "area-main" });
    expect(first).toMatchObject({ ok: false, code: "not-ready" });
    expect(second).toMatchObject({ ok: false, code: "not-ready" });
    expect(authority.cacheFor(canvas.id, {
      scope: { kind: "scene-area", areaId: "area-main" },
      scopeVersion: "area-scope-1"
    })).toBeNull();
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

  it("recovers the same canonical content after one transient executor throw", async () => {
    let calls = 0;
    const authority = createWorldAuthoringAuthority({
      executeScene: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("transient model preparation"));
        return executeScene();
      }
    });
    const canvas = singleInstanceCanvas();
    const scopeRef = { kind: "scene-area" as const, areaId: "area-main" };

    const first = await authority.prepareCanvas(canvas, scopeRef);
    expect(first).toMatchObject({ ok: false, code: "not-ready" });

    // A failed preparation leaves no grant: unknown never authorizes, even when
    // the caller supplies a plausible version.
    expect(authority.eligible({
      requestId: "r", canvasId: canvas.id, runId: "run", epoch: 1, executionId: "exec",
      scope: {
        scope: { kind: "scene-area", areaId: "area-main" },
        scopeVersion: "area-scope-1"
      },
      writable: [{ kind: "instance", instanceId: "solo-a", version: "unknown" }],
      readOnly: []
    }, [{ kind: "instance", instanceId: "solo-a", version: "unknown" }])).toBe(false);

    // The original failure also survived `invalidate(canvasId)`; clearing the
    // canvas projections must not require rebuilding the whole authority.
    authority.invalidate(canvas.id);
    const second = await authority.prepareCanvas(canvas, scopeRef);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(calls).toBe(2);
    const writable = second.snapshot.writable.filter(target => target.kind === "instance");
    expect(writable).toHaveLength(1);
    expect(writable[0]).toMatchObject({ instanceId: "solo-a" });
    expect(second.snapshot.objects).toEqual([
      expect.objectContaining({
        identity: { kind: "instance", instanceId: "solo-a" },
        containment: "writable",
        version: writable[0]!.version
      })
    ]);
    expect(authority.eligible({
      requestId: "r", canvasId: canvas.id, runId: "run", epoch: 1, executionId: "exec",
      scope: second.snapshot.scope,
      writable,
      readOnly: []
    }, writable)).toBe(true);
  });

  it("recovers the same canonical content after one structured preparation failure", async () => {
    let calls = 0;
    const authority = createWorldAuthoringAuthority({
      executeScene: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            ok: false as const,
            stage: "execute" as const,
            code: "transient-failure",
            message: "transient executor failure"
          });
        }
        return executeScene();
      }
    });
    const canvas = singleInstanceCanvas();
    const scopeRef = { kind: "scene-area" as const, areaId: "area-main" };

    expect(await authority.prepareCanvas(canvas, scopeRef)).toMatchObject({ ok: false, code: "not-ready" });
    const prepared = await authority.prepareCanvas(canvas, scopeRef);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(calls).toBe(2);
    expect(prepared.snapshot.writable).toEqual([
      expect.objectContaining({ kind: "instance", instanceId: "solo-a" })
    ]);
  });

  it("reuses successful bounds and drops stale eligibility on invalidation", async () => {
    let calls = 0;
    const authority = createWorldAuthoringAuthority({
      executeScene: () => {
        calls += 1;
        return executeScene();
      }
    });
    const canvas = singleInstanceCanvas();
    const scopeRef = { kind: "scene-area" as const, areaId: "area-main" };
    const prepared = await authority.prepareCanvas(canvas, scopeRef);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const target = prepared.snapshot.writable[0]!;

    // Same canonical content reuses the prepared bounds instead of re-executing.
    expect((await authority.prepareCanvas(canvas, scopeRef)).ok).toBe(true);
    expect(calls).toBe(1);
    const intent = {
      requestId: "r", canvasId: canvas.id, runId: "run", epoch: 1, executionId: "exec",
      scope: prepared.snapshot.scope,
      writable: [target],
      readOnly: []
    };
    expect(authority.eligible(intent, [target])).toBe(true);

    authority.invalidate(canvas.id);
    expect(authority.eligible(intent, [target])).toBe(false);

    // A stale version cannot become eligible again through re-preparation.
    const moved = JSON.parse(JSON.stringify(canvas)) as ServerCanvas;
    (moved.nodeData.solo as { sharedWorldInstance: { transform: { position: { u: number } } } })
      .sharedWorldInstance.transform.position.u = 20;
    expect((await authority.prepareCanvas(moved, scopeRef)).ok).toBe(true);
    expect(authority.eligible(intent, [target])).toBe(false);
  });

  it("does not resurrect an expired post-state version after invalidation", async () => {
    const authority = createWorldAuthoringAuthority({ executeScene });
    const canvas = singleInstanceCanvas();
    const scopeRef = { kind: "scene-area" as const, areaId: "area-main" };
    const prepared = await authority.prepareCanvas(canvas, scopeRef);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const target = prepared.snapshot.writable[0]!;

    // Before the atomic resolve the target is absent; the after-state is writable,
    // so the authority records a post-state eligible version for it.
    const before = JSON.parse(JSON.stringify(canvas)) as ServerCanvas;
    before.document.nodes = before.document.nodes.filter(node => node.id !== "solo");
    delete before.nodeData.solo;
    const resolved = authority.resolve({
      requestId: "r", canvasId: canvas.id, runId: "run", epoch: 1, executionId: "exec",
      scope: prepared.snapshot.scope,
      writable: [target],
      readOnly: []
    }, before, canvas, [{ kind: "instance", instanceId: "solo-a" }]);
    expect(resolved?.next).toEqual([target]);
    expect(authority.eligible({
      requestId: "r", canvasId: canvas.id, runId: "run", epoch: 1, executionId: "exec",
      scope: prepared.snapshot.scope,
      writable: [target],
      readOnly: []
    }, [target])).toBe(true);

    authority.invalidate(canvas.id);
    const moved = JSON.parse(JSON.stringify(canvas)) as ServerCanvas;
    (moved.nodeData.solo as { sharedWorldInstance: { transform: { position: { u: number } } } })
      .sharedWorldInstance.transform.position.u = 20;
    expect((await authority.prepareCanvas(moved, scopeRef)).ok).toBe(true);
    expect(authority.eligible({
      requestId: "r", canvasId: canvas.id, runId: "run", epoch: 1, executionId: "exec",
      scope: prepared.snapshot.scope,
      writable: [target],
      readOnly: []
    }, [target])).toBe(false);
  });
});
