import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCENE_AREA_PLAN_CONTRACT_VERSION,
  SHARED_WORLD_VERSION,
  createEmptyWoohaa3ServerCanvas,
  type ServerCanvas,
  type WorldAuthoringExecuteOutcome,
  type WorldAuthoringPrepareOutcome,
  type WorldCameraData,
  type WorldPreparedAuthoritySnapshot
} from "@woohaa3/contracts";
import {
  SCENE_AREA_MIN_SIZE_METERS,
  buildSceneAreaRequest,
  createSceneAreaGestures,
  decideSceneAreaDrag,
  groundInsideBounds,
  locateSceneAreaEdge,
  nearestSceneAreaEdge,
  resetSceneAreaGestures,
  resizeSceneAreaBounds,
  sceneAreaGestureStore,
  sceneAreaHistoryStore,
  type SceneAreaGestureDeps,
  type SceneAreaGesturePort
} from "./gestures.js";
import {
  GROUP_DEFAULT_HEIGHT,
  GROUP_DEFAULT_WIDTH,
  GROUP_TIDY_PADDING,
  createGroupActions,
  planGroupFit,
  planGroupMembership,
  planGroupMove,
  planGroupTidy,
  readGroupLayout
} from "./group-actions.js";
import { installInteractionController } from "../canvas-shell/interaction-controller.js";
import { getSession, harness, installSharedSession, runtimeCapturing, submitted } from "../canvas-shell/test-support/controller-harness.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";

installSharedSession();

const AREA_BOUNDS = { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } };

function areaNode(id = "area"): { id: string; type: string; position: { x: number; y: number } } {
  return { id, type: "scene-area", position: { x: 500, y: 500 } };
}

function sceneCanvas(nodes: ServerCanvas["document"]["nodes"], nodeData: ServerCanvas["nodeData"]): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return { ...base, revision: 1, document: { ...base.document, nodes }, nodeData };
}

function modelNode(id: string, instanceId: string) {
  return {
    id,
    type: "model3d",
    position: { x: 0, y: 0 },
    nodeData: {
      sharedWorldInstance: {
        kind: "world-instance" as const,
        version: SHARED_WORLD_VERSION,
        instanceId,
        transform: {
          version: SHARED_WORLD_VERSION,
          position: { u: 2, v: 3, h: 1.5 },
          rotation: [0, 0, 0, 1],
          scale: 1
        }
      }
    }
  };
}

const CAMERA: WorldCameraData = {
  kind: "world-camera",
  version: SHARED_WORLD_VERSION,
  cameraId: "cam",
  settingsVersion: "cam-v1",
  position: { u: 4, v: 4, h: 2 },
  rotation: [0, 0, 0, 1],
  projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
  captureMode: { kind: "static" },
  aspect: { width: 16, height: 9 },
  boundInstanceId: null
};

function preparedSnapshot(overrides: Partial<WorldPreparedAuthoritySnapshot> = {}): WorldPreparedAuthoritySnapshot {
  return {
    version: "world-authoring-v1",
    canvasId: "c1",
    revision: 3,
    scope: { scope: { kind: "scene-area", areaId: "area" }, scopeVersion: "area-v1" },
    areaNodeId: "area",
    area: { areaId: "area", scopeVersion: "area-v1", bounds: AREA_BOUNDS },
    bounds: AREA_BOUNDS,
    writable: [
      { kind: "instance", instanceId: "i1", version: "i1-v1" },
      { kind: "camera", cameraId: "cam", version: "cam-v1" }
    ],
    readOnly: [{ kind: "instance", instanceId: "i2", version: "i2-v1" }],
    members: {
      instances: [{
        identity: { kind: "instance", instanceId: "i1" },
        version: "i1-v1",
        transform: {
          version: SHARED_WORLD_VERSION,
          position: { u: 2, v: 3, h: 1.5 },
          rotation: [0, 0, 0, 1],
          scale: 1
        }
      }],
      cameras: [{ identity: { kind: "camera", cameraId: "cam" }, version: "cam-v1", camera: CAMERA }]
    },
    objects: [
      { identity: { kind: "instance", instanceId: "i1" }, nodeId: "m1", version: "i1-v1", containment: "writable" },
      { identity: { kind: "instance", instanceId: "i2" }, nodeId: "m2", version: "i2-v1", containment: "read-only" },
      { identity: { kind: "camera", cameraId: "cam" }, nodeId: "cam-node", version: "cam-v1", containment: "writable" }
    ],
    occupancy: {
      version: "world-scope-occupancy-v1",
      scope: { scope: { kind: "scene-area", areaId: "area" }, scopeVersion: "area-v1" },
      state: "idle",
      locks: []
    },
    ...overrides
  };
}

function runtimeHarness(overrides: Partial<SceneAreaGestureDeps> = {}) {
  const canvas = sceneCanvas(
    [areaNode(), modelNode("m1", "i1"), modelNode("m2", "i2"), { id: "cam-node", type: "world-camera", position: { x: 0, y: 0 } }],
    {
      area: { sceneArea: { kind: "scene-area", version: SHARED_WORLD_VERSION, areaId: "area", scopeVersion: "area-v1", bounds: AREA_BOUNDS } },
      m1: modelNode("m1", "i1").nodeData as never,
      m2: modelNode("m2", "i2").nodeData as never,
      "cam-node": { worldCamera: CAMERA as never }
    }
  );
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const prepared = preparedSnapshot();
  const prepare = vi.fn(async () => ({ ok: true as const, snapshot: prepared }));
  const execute = vi.fn(async (input: { operationId: string }) => ({
    ok: true as const,
    canvasId: "c1",
    operationId: input.operationId,
    commandId: `scene-area:${input.operationId}`,
    revision: 4,
    duplicate: false,
    plan: {},
    receipt: {}
  }));
  const history = vi.fn(async (direction: "undo" | "redo") => ({
    ok: true as const,
    canvasId: "c1",
    operationId: "scene-area-op",
    commandId: `scene-area-${direction}:scene-area-op`,
    revision: 5,
    duplicate: false,
    direction,
    plan: {},
    receipt: {}
  }));
  const preview = vi.fn();
  const previewArea = vi.fn();
  const deps: SceneAreaGestureDeps = {
    canvasId: () => "c1",
    writable: () => true,
    getCanvas: () => woohaa3CanvasStore.getState().working ?? woohaa3CanvasStore.getState().canvas,
    prepare,
    execute: execute as never,
    history: history as never,
    queryGround: point => ({ u: point.x / 100, v: point.y / 100 }),
    preview,
    previewArea,
    mode: () => "auto",
    tolerance: () => 0.2,
    newOperationId: () => "scene-area-op",
    ...overrides
  };
  return { deps, prepare, execute, history, preview, previewArea, prepared };
}

beforeEach(() => {
  resetSceneAreaGestures();
});

describe("pure scene-area decisions", () => {
  it("keeps interior auto drags available for marquee and detects edges", () => {
    expect(decideSceneAreaDrag({ mode: "auto", card: false, altKey: false, bounds: AREA_BOUNDS, ground: { u: 5, v: 5 }, tolerance: 0.2 })).toBeNull();
    expect(decideSceneAreaDrag({ mode: "auto", card: false, altKey: false, bounds: AREA_BOUNDS, ground: { u: 0.1, v: 5 }, tolerance: 0.2 }))
      .toEqual({ intent: "resize", edge: { u: -1, v: 0 } });
    expect(decideSceneAreaDrag({ mode: "move", card: false, altKey: false, bounds: AREA_BOUNDS, ground: { u: 5, v: 5 }, tolerance: 0.2 }))
      .toEqual({ intent: "move" });
    expect(decideSceneAreaDrag({ mode: "resize", card: false, altKey: false, bounds: AREA_BOUNDS, ground: { u: 5, v: 5 }, tolerance: 0.2 }))
      .toEqual({ intent: "resize", edge: { u: -1, v: -1 } });
    expect(decideSceneAreaDrag({ mode: "auto", card: false, altKey: true, bounds: AREA_BOUNDS, ground: { u: 5, v: 5 }, tolerance: 0.2 }))
      .toEqual({ intent: "resize", edge: { u: -1, v: -1 } });
  });

  it("always moves the title, including Alt and explicit resize mode", () => {
    expect(decideSceneAreaDrag({ mode: "auto", card: true, altKey: false, bounds: AREA_BOUNDS, ground: { u: 5, v: 5 }, tolerance: 0.2 })).toEqual({ intent: "move" });
    expect(decideSceneAreaDrag({ mode: "auto", card: true, altKey: true, bounds: AREA_BOUNDS, ground: { u: 9, v: 9 }, tolerance: 0.2 }))
      .toEqual({ intent: "move" });
  });

  it("keeps edge resize and title move consistent with their cursors in every mode", () => {
    for (const mode of ["auto", "move", "resize"] as const) {
      expect(decideSceneAreaDrag({ mode, card: true, altKey: true, bounds: AREA_BOUNDS, ground: { u: 0, v: 5 }, tolerance: 0.2 }))
        .toEqual({ intent: "move" });
      expect(decideSceneAreaDrag({ mode, card: false, altKey: false, bounds: AREA_BOUNDS, ground: { u: -0.1, v: 5 }, tolerance: 0.2 }))
        .toEqual({ intent: "resize", edge: { u: -1, v: 0 } });
    }
  });

  it("classifies corners and ignores points outside the area", () => {
    expect(locateSceneAreaEdge(AREA_BOUNDS, { u: 0.05, v: 9.95 }, 0.2)).toEqual({ u: -1, v: 1 });
    expect(locateSceneAreaEdge({ min: { u: 0, v: 0 }, max: { u: 2, v: 2 } }, { u: 5, v: 5 }, 0.2)).toBeNull();
    expect(groundInsideBounds(AREA_BOUNDS, { u: 0, v: 10 })).toBe(true);
    expect(nearestSceneAreaEdge(AREA_BOUNDS, { u: 9, v: 1 })).toEqual({ u: 1, v: -1 });
  });

  it("only moves the dragged edge and clamps the minimum size", () => {
    expect(resizeSceneAreaBounds(AREA_BOUNDS, { u: -1, v: 0 }, { u: -2, v: 5 })).toEqual({
      min: { u: -2, v: 0 }, max: { u: 10, v: 10 }
    });
    expect(resizeSceneAreaBounds(AREA_BOUNDS, { u: 1, v: 1 }, { u: -50, v: -50 })).toEqual({
      min: { u: 0, v: 0 },
      max: { u: 0 + SCENE_AREA_MIN_SIZE_METERS, v: 0 + SCENE_AREA_MIN_SIZE_METERS }
    });
  });
});

describe("authoritative request construction", () => {
  it("freezes the prepared writable member set and never adds read-only objects", () => {
    const snapshot = preparedSnapshot();
    const built = buildSceneAreaRequest({ canvasId: "c1", operationId: "op", snapshot, intent: "move", delta: { u: 2, v: -1 } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.contractVersion).toBe(SCENE_AREA_PLAN_CONTRACT_VERSION);
    expect(built.request.intent).toBe("move");
    if (built.request.intent !== "move") return;
    expect(built.request.delta).toEqual({ u: 2, v: -1 });
    expect(built.request.members.instances.map(member => member.identity.instanceId)).toEqual(["i1"]);
    expect(built.request.members.cameras.map(member => member.identity.cameraId)).toEqual(["cam"]);
    expect(JSON.stringify(built.request)).not.toContain("i2-v1");
  });

  it("builds resize and both delete intents without touching media", () => {
    const snapshot = preparedSnapshot();
    const resize = buildSceneAreaRequest({ canvasId: "c1", operationId: "op", snapshot, intent: "resize", bounds: { min: { u: -1, v: -1 }, max: { u: 11, v: 11 } } });
    expect(resize.ok && resize.request.intent).toBe("resize");
    const remove = buildSceneAreaRequest({ canvasId: "c1", operationId: "op", snapshot, intent: "delete-area" });
    expect(remove.ok && remove.request.intent).toBe("delete-area");
    const contents = buildSceneAreaRequest({ canvasId: "c1", operationId: "op", snapshot, intent: "delete-area-with-contents" });
    expect(contents.ok && contents.request.intent).toBe("delete-area-with-contents");
    expect(JSON.stringify(snapshot.members)).not.toContain("media");
  });

  it("rejects inverted or non-finite ranges before calling the authority", () => {
    const snapshot = preparedSnapshot();
    expect(buildSceneAreaRequest({ canvasId: "c1", operationId: "op", snapshot, intent: "resize", bounds: { min: { u: 5, v: 0 }, max: { u: 1, v: 1 } } }).ok).toBe(false);
    expect(buildSceneAreaRequest({ canvasId: "c1", operationId: "op", snapshot, intent: "move", delta: { u: Number.NaN, v: 0 } }).ok).toBe(false);
  });
});

describe("scene-area gesture runtime", () => {
  it("previews only writable instances, commits a move and records scene history", async () => {
    const { deps, execute, preview } = runtimeHarness();
    const port = createSceneAreaGestures(deps);
    expect(port.begin({ point: { x: 500, y: 500 }, areaNodeId: "area", card: true })).toEqual({ areaNodeId: "area", intent: "move" });
    await Promise.resolve();
    await Promise.resolve();
    port.update({ x: 700, y: 800 });
    expect(preview).toHaveBeenCalledWith("m1", { u: 2, v: 3 });
    expect(preview).not.toHaveBeenCalledWith("m2", expect.anything());
    const result = await port.end();
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    const input = execute.mock.calls[0]![0] as unknown as { operationId: string; request: { intent: string; delta: unknown } };
    expect(input.operationId).toBe("scene-area-op");
    expect(input.request.intent).toBe("move");
    expect(input.request.delta).toEqual({ u: 2, v: 3 });
    expect(sceneAreaHistoryStore.getSnapshot()).toMatchObject({ canUndo: true, undoLabel: "搬动场景" });
    expect(preview).toHaveBeenLastCalledWith("m1", null);
  });

  it("prepares with the scene-area identity, not the canvas node id", async () => {
    const nodeId = "asset-scene-area-x";
    const areaId = "area-main";
    const canvas = sceneCanvas(
      [{ id: nodeId, type: "scene-area", position: { x: 500, y: 500 } }, modelNode("m1", "i1")],
      {
        [nodeId]: { sceneArea: { kind: "scene-area", version: SHARED_WORLD_VERSION, areaId, scopeVersion: "area-v1", bounds: AREA_BOUNDS } },
        m1: modelNode("m1", "i1").nodeData as never
      }
    );
    const snapshot = {
      ...preparedSnapshot(),
      areaNodeId: nodeId,
      area: { areaId, scopeVersion: "area-v1", bounds: AREA_BOUNDS },
      scope: { scope: { kind: "scene-area" as const, areaId }, scopeVersion: "area-v1" }
    };
    const prepare = vi.fn(async () => ({ ok: true as const, snapshot }));
    const execute = vi.fn(async (input: { operationId: string }) => ({
      ok: true as const,
      canvasId: "c1",
      operationId: input.operationId,
      commandId: `scene-area:${input.operationId}`,
      revision: 4,
      duplicate: false,
      plan: {},
      receipt: {}
    }));
    const { deps } = runtimeHarness({ getCanvas: () => canvas, prepare, execute: execute as never });
    const port = createSceneAreaGestures(deps);
    expect(port.begin({ point: { x: 500, y: 500 }, areaNodeId: nodeId, card: true })).toEqual({ areaNodeId: nodeId, intent: "move" });
    await Promise.resolve();
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledWith(areaId, expect.any(AbortSignal));
    port.update({ x: 700, y: 800 });
    expect((await port.end()).ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("commits a resize with bounds only and no member preview", async () => {
    const { deps, execute, preview } = runtimeHarness();
    const port = createSceneAreaGestures(deps);
    expect(port.begin({ point: { x: 0, y: 500 }, areaNodeId: "area", card: false })).toEqual({ areaNodeId: "area", intent: "resize", edge: { u: -1, v: 0 } });
    port.update({ x: -200, y: 500 });
    expect(preview).not.toHaveBeenCalled();
    await port.end();
    const input = execute.mock.calls[0]![0] as unknown as { request: { intent: string; bounds: unknown } };
    expect(input.request.intent).toBe("resize");
    expect(input.request.bounds).toEqual({ min: { u: -2, v: 0 }, max: { u: 10, v: 10 } });
  });

  it("previews the live scene-area bounds while dragging and clears them on release", async () => {
    const { deps, previewArea } = runtimeHarness();
    const port = createSceneAreaGestures(deps);
    port.begin({ point: { x: 500, y: 500 }, areaNodeId: "area", card: true });
    port.update({ x: 700, y: 800 });
    expect(previewArea).toHaveBeenCalledWith("area", { min: { u: 2, v: 3 }, max: { u: 12, v: 13 } });
    await port.end();
    expect(previewArea).toHaveBeenLastCalledWith("area", null);
  });

  it("previews resized bounds before the authoritative commit settles", () => {
    const { deps, previewArea, preview } = runtimeHarness();
    const port = createSceneAreaGestures(deps);
    port.begin({ point: { x: 0, y: 500 }, areaNodeId: "area", card: false });
    port.update({ x: -200, y: 500 });
    expect(preview).not.toHaveBeenCalled();
    expect(previewArea).toHaveBeenCalledWith("area", { min: { u: -2, v: 0 }, max: { u: 10, v: 10 } });
    port.cancel();
    expect(previewArea).toHaveBeenLastCalledWith("area", null);
  });

  it("lets an auto interior press fall through so marquee is not swallowed", () => {
    const { deps, prepare } = runtimeHarness();
    const port = createSceneAreaGestures(deps);
    expect(port.begin({ point: { x: 500, y: 500 }, areaNodeId: null, card: false })).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    expect(port.active()).toBe(false);
  });

  it("cancels preparation without executing", async () => {
    let signal: AbortSignal | undefined;
    const { deps, execute } = runtimeHarness({
      prepare: (_areaId, nextSignal) => {
        signal = nextSignal;
        return new Promise(() => undefined) as never;
      }
    });
    const port = createSceneAreaGestures(deps);
    port.begin({ point: { x: 500, y: 500 }, areaNodeId: "area", card: true });
    port.update({ x: 600, y: 600 });
    port.cancel();
    expect(port.active()).toBe(false);
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps a quick release committing while prepare is still pending", async () => {
    let release!: (value: WorldAuthoringPrepareOutcome) => void;
    let signal: AbortSignal | undefined;
    const { deps, execute, prepared } = runtimeHarness({
      prepare: (_areaId, nextSignal) => {
        signal = nextSignal;
        return new Promise<WorldAuthoringPrepareOutcome>(resolve => { release = resolve; });
      }
    });
    const port = createSceneAreaGestures(deps);
    port.begin({ point: { x: 500, y: 500 }, areaNodeId: "area", card: true });
    port.update({ x: 700, y: 800 });
    const ending = port.end();
    // This is what the frame reconciliation used to call on the next tick after release.
    port.cancel();
    expect(signal?.aborted).toBe(false);
    expect(port.ending()).toBe(true);
    release({ ok: true, snapshot: prepared });
    const result = await ending;
    expect(result).toMatchObject({ ok: true, operationId: "scene-area-op" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses a new begin while the previous commit is still in flight", async () => {
    let release!: (value: WorldAuthoringExecuteOutcome) => void;
    const execute = vi.fn(() => new Promise<WorldAuthoringExecuteOutcome>(resolve => { release = resolve; }));
    const { deps } = runtimeHarness({ execute: execute as never });
    const port = createSceneAreaGestures(deps);
    port.begin({ point: { x: 500, y: 500 }, areaNodeId: "area", card: true });
    port.update({ x: 700, y: 800 });
    const ending = port.end();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(port.ending()).toBe(true);
    // The older end() must not be able to clear a newer gesture: no newer one starts.
    expect(port.begin({ point: { x: 500, y: 500 }, areaNodeId: "area", card: true })).toBeNull();
    expect(port.active()).toBe(true);
    release({ ok: true, canvasId: "c1", operationId: "scene-area-op", commandId: "c", revision: 4, duplicate: false, plan: {}, receipt: {} } as unknown as WorldAuthoringExecuteOutcome);
    expect((await ending).ok).toBe(true);
    expect(port.active()).toBe(false);
    // After the old commit settles the runtime accepts the next gesture normally.
    expect(port.begin({ point: { x: 500, y: 500 }, areaNodeId: "area", card: true })).toEqual({ areaNodeId: "area", intent: "move" });
    expect(port.update({ x: 600, y: 600 })).toBe(true);
    const secondEnding = port.end();
    await new Promise(resolve => setTimeout(resolve, 10));
    release({ ok: true, canvasId: "c1", operationId: "scene-area-op", commandId: "c", revision: 4, duplicate: false, plan: {}, receipt: {} } as unknown as WorldAuthoringExecuteOutcome);
    expect(await secondEnding).toMatchObject({ ok: true, operationId: "scene-area-op" });
  });

  it("keeps the authoritative commit and warns when journal adoption is refused", async () => {
    const adoptHistory = vi.fn(() => ({ ok: false as const, reason: "正在结算上一次操作，请稍候" }));
    const { deps, execute } = runtimeHarness({ adoptHistory });
    const port = createSceneAreaGestures(deps);
    port.begin({ point: { x: 500, y: 500 }, areaNodeId: "area", card: true });
    port.update({ x: 700, y: 800 });
    const result = await port.end();
    // The real write succeeded: never fake "not committed".
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      operationId: "scene-area-op",
      warning: expect.stringContaining("未加入撤销历史")
    });
    expect(sceneAreaGestureStore.getSnapshot()).toMatchObject({
      phase: "idle",
      message: expect.stringContaining("未加入撤销历史")
    });
    // The private fallback stack is not used when the page journal refused.
    expect(sceneAreaHistoryStore.getSnapshot().canUndo).toBe(false);
  });

  it("rejects a delete receipt for a different operation before adopting it", async () => {
    const adoptHistory = vi.fn(() => ({ ok: true as const }));
    const execute = vi.fn(async () => ({
      ok: true as const, canvasId: "c1", operationId: "other", commandId: "c", revision: 4,
      duplicate: false, plan: {}, receipt: {}
    }));
    const { deps } = runtimeHarness({ adoptHistory, execute: execute as never });
    const port = createSceneAreaGestures(deps);
    const result = await port.deleteArea("area", false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, code: "version-conflict", message: "场景删除回执不匹配" });
    expect(adoptHistory).not.toHaveBeenCalled();
  });

  it("rejects stale prepare snapshots without committing", async () => {
    const { deps, execute } = runtimeHarness({
      prepare: async () => ({ ok: true as const, snapshot: preparedSnapshot({ area: { areaId: "area", scopeVersion: "area-v2", bounds: AREA_BOUNDS } }) })
    });
    const port = createSceneAreaGestures(deps);
    port.begin({ point: { x: 500, y: 500 }, areaNodeId: "area", card: true });
    port.update({ x: 600, y: 600 });
    const result = await port.end();
    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses to start or delete while the page is read-only", async () => {
    const { deps, prepare, execute } = runtimeHarness({ writable: () => false });
    const port = createSceneAreaGestures(deps);
    expect(port.begin({ point: { x: 500, y: 500 }, areaNodeId: "area", card: true })).toBeNull();
    const result = await port.deleteArea("area", true);
    expect(result.ok).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not submit a zero-delta drag", async () => {
    const { deps, execute } = runtimeHarness();
    const port = createSceneAreaGestures(deps);
    port.begin({ point: { x: 500, y: 500 }, areaNodeId: "area", card: true });
    expect(await port.end()).toEqual({ ok: true, noop: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("deletes the area by default and with contents on explicit choice", async () => {
    let sequence = 0;
    const { deps, execute } = runtimeHarness({ newOperationId: () => `scene-area-op-${++sequence}` });
    const port = createSceneAreaGestures(deps);
    await port.deleteArea("area", false);
    await port.deleteArea("area", true);
    expect(execute).toHaveBeenCalledTimes(2);
    const first = execute.mock.calls[0]![0] as unknown as { request: { intent: string } };
    const second = execute.mock.calls[1]![0] as unknown as { request: { intent: string } };
    expect(first.request.intent).toBe("delete-area");
    expect(second.request.intent).toBe("delete-area-with-contents");
    expect(sceneAreaHistoryStore.getSnapshot()).toMatchObject({ canUndo: true, undoLabel: "删除导演区与内容" });
  });

  it("deletes by the scene-area identity rather than the canvas node id", async () => {
    const nodeId = "asset-scene-area-x";
    const areaId = "area-main";
    const canvas = sceneCanvas(
      [{ id: nodeId, type: "scene-area", position: { x: 500, y: 500 } }],
      { [nodeId]: { sceneArea: { kind: "scene-area", version: SHARED_WORLD_VERSION, areaId, scopeVersion: "area-v1", bounds: AREA_BOUNDS } } }
    );
    const snapshot = {
      ...preparedSnapshot(),
      areaNodeId: nodeId,
      area: { areaId, scopeVersion: "area-v1", bounds: AREA_BOUNDS },
      scope: { scope: { kind: "scene-area" as const, areaId }, scopeVersion: "area-v1" }
    };
    const prepare = vi.fn(async () => ({ ok: true as const, snapshot }));
    const { deps } = runtimeHarness({ getCanvas: () => canvas, prepare });
    const port = createSceneAreaGestures(deps);
    expect((await port.deleteArea(nodeId, false)).ok).toBe(true);
    expect(prepare).toHaveBeenCalledWith(areaId, expect.any(AbortSignal));
  });

  it("adopts a verified scene receipt into the shared journal and fails closed on an uncertain replay", async () => {
    const adoptHistory = vi.fn((_entry: unknown) => ({ ok: true }));
    const { deps, history } = runtimeHarness({ adoptHistory });
    const port = createSceneAreaGestures(deps);
    port.begin({ point: { x: 500, y: 500 }, areaNodeId: "area", card: true });
    port.update({ x: 700, y: 800 });
    expect((await port.end()).ok).toBe(true);
    expect(adoptHistory).toHaveBeenCalledTimes(1);
    const adopted = adoptHistory.mock.calls[0]![0] as unknown as {
      operationId: string;
      undo: () => Promise<{ ok: boolean }>;
      redo: () => Promise<{ ok: boolean }>;
    };
    expect(adopted.operationId).toBe("scene-area-op");
    expect(await adopted.undo()).toEqual({ ok: true });
    expect(history).toHaveBeenCalledWith("undo", { canvasId: "c1", operationId: "scene-area-op" });
    // A receipt for a different operation/direction must not move the shared history.
    history.mockResolvedValueOnce({
      ok: true, canvasId: "c1", operationId: "other", commandId: "c", revision: 6,
      duplicate: false, direction: "redo", plan: {}, receipt: {}
    });
    expect(await adopted.redo()).toEqual({ ok: false, reason: "场景历史回执不匹配" });
    // The private fallback stack is not populated when the shared journal owns history.
    expect(sceneAreaHistoryStore.getSnapshot().canUndo).toBe(false);
  });

  it("routes undo and redo through the authority history route", async () => {
    const { deps, execute, history } = runtimeHarness();
    const port = createSceneAreaGestures(deps);
    port.begin({ point: { x: 500, y: 500 }, areaNodeId: "area", card: true });
    port.update({ x: 600, y: 600 });
    await port.end();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await port.undo()).toMatchObject({ ok: true, operationId: "scene-area-op" });
    expect(history).toHaveBeenCalledWith("undo", { canvasId: "c1", operationId: "scene-area-op" });
    expect(sceneAreaHistoryStore.getSnapshot()).toMatchObject({ canUndo: false, canRedo: true });
    expect(await port.redo()).toMatchObject({ ok: true, operationId: "scene-area-op" });
    expect(history).toHaveBeenLastCalledWith("redo", { canvasId: "c1", operationId: "scene-area-op" });
    expect(sceneAreaHistoryStore.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false });
  });
});

describe("2D group organization", () => {
  const groupCanvas = () => sceneCanvas(
    [
      { id: "g", type: "workflow-group-2d", position: { x: 100, y: 200 } },
      { id: "a", type: "image", position: { x: 0, y: 0 } },
      { id: "b", type: "text", position: { x: 400, y: 400 } }
    ],
    {
      g: { workflowGroup2d: { kind: "workflow-group-2d", version: SHARED_WORLD_VERSION, groupId: "g", scopeVersion: "g-v1", memberNodeIds: ["a", "b", "missing", "g"] } }
    }
  );

  it("reads only resolvable non-group members", () => {
    const result = readGroupLayout(groupCanvas(), "g");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layout.members.map(member => member.nodeId)).toEqual(["a", "b"]);
    expect(result.layout.width).toBe(GROUP_DEFAULT_WIDTH);
    expect(result.layout.height).toBe(GROUP_DEFAULT_HEIGHT);
  });

  it("tidies members into a grid and grows the group once", () => {
    const layout = readGroupLayout(groupCanvas(), "g");
    if (!layout.ok) throw new Error(layout.reason);
    const plan = planGroupTidy(layout.layout);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.commands[0]).toMatchObject({ type: "node.update", nodeId: "g" });
    const group = plan.commands[0] as { width: number; height: number };
    expect(group.width).toBeGreaterThan(GROUP_DEFAULT_WIDTH);
    expect(plan.commands.slice(1).map(command => command.type)).toEqual(["node.update", "node.update"]);
    const firstMember = plan.commands[1] as { nodeId: string; position: { x: number; y: number } };
    expect(firstMember.nodeId).toBe("a");
    expect(firstMember.position).toEqual({ x: 100 + GROUP_TIDY_PADDING, y: 200 + GROUP_TIDY_PADDING });
  });

  it("fits the group to the members without moving them", () => {
    const canvas = sceneCanvas(
      [
        { id: "g", type: "workflow-group-2d", position: { x: 100, y: 200 } },
        { id: "a", type: "image", position: { x: 0, y: 0 }, width: 100, height: 100 },
        { id: "b", type: "image", position: { x: 300, y: 200 }, width: 100, height: 100 }
      ],
      { g: { workflowGroup2d: { kind: "workflow-group-2d", version: SHARED_WORLD_VERSION, groupId: "g", scopeVersion: "g-v1", memberNodeIds: ["a", "b"] } } }
    );
    const layout = readGroupLayout(canvas, "g");
    if (!layout.ok) throw new Error(layout.reason);
    const plan = planGroupFit(layout.layout);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({
      type: "node.update",
      nodeId: "g",
      position: { x: -GROUP_TIDY_PADDING, y: -GROUP_TIDY_PADDING },
      width: 400 + GROUP_TIDY_PADDING * 2,
      height: 300 + GROUP_TIDY_PADDING * 2
    });
  });

  it("moves the group and every member together", () => {
    const layout = readGroupLayout(groupCanvas(), "g");
    if (!layout.ok) throw new Error(layout.reason);
    const plan = planGroupMove(layout.layout, { x: 20, y: -10 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.commands.map(command => command.type)).toEqual(["node.update", "node.update", "node.update"]);
    expect(plan.commands.map(command => (command as { nodeId: string }).nodeId)).toEqual(["g", "a", "b"]);
  });

  it("records group actions through the existing journal and refuses read-only", async () => {
    const record = vi.fn(async () => ({ ok: true }));
    const actions = createGroupActions({ getCanvas: () => groupCanvas(), writable: () => true, edit: { record } });
    expect(await actions.tidy("g")).toEqual({ ok: true });
    expect(record).toHaveBeenCalledWith(expect.any(Array), "宫格整理 2D 组成员");
    const readOnly = createGroupActions({ getCanvas: () => groupCanvas(), writable: () => false, edit: { record } });
    expect(await readOnly.fit("g")).toEqual({ ok: false, reason: "当前不可写" });
  });

  it("adds and removes members with one journal command and a new scopeVersion", async () => {
    const canvas = sceneCanvas(
      [
        { id: "g", type: "workflow-group-2d", position: { x: 100, y: 200 } },
        { id: "a", type: "image", position: { x: 0, y: 0 } },
        { id: "b", type: "text", position: { x: 400, y: 400 } }
      ],
      {
        g: {
          workflowGroup2d: { kind: "workflow-group-2d", version: SHARED_WORLD_VERSION, groupId: "g", scopeVersion: "g-v1", memberNodeIds: ["a"] },
          title: "画布组"
        }
      }
    );
    const plan = planGroupMembership(canvas, "g", ["a", "b"], "g-v2");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({ type: "nodeData.patch", nodeId: "g" });
    const value = (plan.commands[0] as unknown as { value: { title: string; workflowGroup2d: { scopeVersion: string; memberNodeIds: string[] } } }).value;
    expect(value.title).toBe("画布组");
    expect(value.workflowGroup2d.scopeVersion).toBe("g-v2");
    expect(value.workflowGroup2d.memberNodeIds).toEqual(["a", "b"]);

    const record = vi.fn(async () => ({ ok: true }));
    const actions = createGroupActions({ getCanvas: () => canvas, writable: () => true, edit: { record } });
    expect(await actions.addMembers("g", ["b"])).toEqual({ ok: true });
    expect(record).toHaveBeenLastCalledWith([expect.objectContaining({ type: "nodeData.patch", nodeId: "g" })], "添加 2D 组成员");
    expect(await actions.removeMember("g", "a")).toEqual({ ok: true });
    expect(record).toHaveBeenLastCalledWith([expect.objectContaining({ type: "nodeData.patch", nodeId: "g" })], "移除 2D 组成员");
  });

  it("rejects nesting, scene areas and world models as 2D-group members", () => {
    const canvas = sceneCanvas(
      [
        { id: "g", type: "workflow-group-2d", position: { x: 0, y: 0 } },
        { id: "g2", type: "workflow-group-2d", position: { x: 0, y: 0 } },
        { id: "area", type: "scene-area", position: { x: 0, y: 0 } },
        { id: "m", type: "model3d", position: { x: 0, y: 0 } }
      ],
      {
        g: { workflowGroup2d: { kind: "workflow-group-2d", version: SHARED_WORLD_VERSION, groupId: "g", scopeVersion: "g-v1", memberNodeIds: [] } },
        area: { sceneArea: { kind: "scene-area", version: SHARED_WORLD_VERSION, areaId: "area", scopeVersion: "a-v1", bounds: AREA_BOUNDS } },
        m: { sharedWorldInstance: { kind: "world-instance", version: SHARED_WORLD_VERSION, instanceId: "i1", transform: { version: SHARED_WORLD_VERSION, position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } } }
      }
    );
    expect(planGroupMembership(canvas, "g", ["g2"], "g-v2")).toMatchObject({ ok: false, reason: "不能嵌套 2D 组" });
    expect(planGroupMembership(canvas, "g", ["area"], "g-v2")).toMatchObject({ ok: false, reason: "导演区不是画布卡片，不能加入 2D 组" });
    expect(planGroupMembership(canvas, "g", ["m"], "g-v2")).toMatchObject({ ok: false, reason: "共享世界模型没有卡片，不能加入 2D 组" });
  });
});

describe("interaction controller wiring", () => {
  const fakePort = (start: { areaNodeId: string; intent: "move" | "resize"; edge?: { u: -1 | 0 | 1; v: -1 | 0 | 1 } } | null) => ({
    begin: vi.fn(() => start),
    update: vi.fn(() => true),
    end: vi.fn(async () => ({ ok: true as const, noop: true as const })),
    cancel: vi.fn(),
    active: vi.fn(() => false),
    ending: vi.fn(() => false),
    mode: vi.fn((): "auto" | "move" | "resize" => "auto"),
    deleteArea: vi.fn(async () => ({ ok: false as const, code: "not-ready", message: "unused" })),
    undo: vi.fn(async () => ({ ok: false as const, code: "not-ready", message: "unused" })),
    redo: vi.fn(async () => ({ ok: false as const, code: "not-ready", message: "unused" }))
  });

  const setup = (options: {
    nodes: ServerCanvas["document"]["nodes"];
    nodeData: ServerCanvas["nodeData"];
    pointHit: (input: { x: number; y: number }) => { kind: string; nodeId?: string } | null;
    ground?: (point: { x: number; y: number }) => { u: number; v: number } | null;
    port: SceneAreaGesturePort;
    modelPick?: (input: { x: number; y: number; width: number; height: number }) => { nodeId: string; target: [number, number, number]; radius: number } | null;
  }) => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(sceneCanvas(options.nodes, options.nodeData));
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing({
      pointHit: input => options.pointHit(input) as never,
      ...(options.modelPick ? { modelPick: options.modelPick } : {})
    });
    runtime.queryWorldGround = point => {
      const ground = options.ground ? options.ground(point) : { u: point.x / 100, v: point.y / 100 };
      return ground ? { ok: true, generation: 1, value: ground } : { ok: false, reason: "unavailable" as const };
    };
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      sceneAreaGestures: options.port as never
    });
    controller.flush();
    return { dom, controller, scenes };
  };

  const areaData = { area: { sceneArea: { kind: "scene-area", version: SHARED_WORLD_VERSION, areaId: "area", scopeVersion: "area-v1", bounds: AREA_BOUNDS } } };

  it("keeps marquee for an interior ground press when no scene gesture starts", () => {
    const port = fakePort(null);
    const { dom, controller, scenes } = setup({
      nodes: [areaNode()], nodeData: areaData, pointHit: () => null, port
    });
    dom.fire("pointerdown", { clientX: 500, clientY: 500, button: 0 });
    expect(port.begin).toHaveBeenCalledWith(expect.objectContaining({ card: false, areaNodeId: null }));
    dom.fire("pointermove", { clientX: 560, clientY: 560, button: 0 });
    controller.flush();
    expect((scenes.at(-1) as unknown as { marquee: unknown }).marquee).toBeTruthy();
    dom.fire("pointerup", { clientX: 560, clientY: 560, button: 0 });
    controller.dispose();
  });

  it("forwards a scene-area card drag to the runtime instead of moving the card", () => {
    const port = fakePort({ areaNodeId: "area", intent: "move" });
    const { dom, controller } = setup({
      nodes: [areaNode()], nodeData: areaData,
      pointHit: () => ({ kind: "node", nodeId: "area" }), port
    });
    dom.fire("pointerdown", { clientX: 100, clientY: 100, button: 0 });
    expect(port.begin).toHaveBeenCalledWith(expect.objectContaining({ areaNodeId: "area", card: true }));
    dom.fire("pointermove", { clientX: 180, clientY: 140, button: 0 });
    expect(port.update).toHaveBeenCalledWith({ x: 180, y: 140 });
    dom.fire("pointerup", { clientX: 180, clientY: 140, button: 0 });
    expect(port.end).toHaveBeenCalled();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("keeps ordinary model-card dragging on the existing command path", () => {
    const port = fakePort({ areaNodeId: "area", intent: "move" });
    const { dom } = setup({
      nodes: [
        { id: "m1", type: "image", position: { x: 0, y: 0 } }
      ],
      nodeData: areaData,
      pointHit: () => ({ kind: "node", nodeId: "m1" }), port
    });
    dom.fire("pointerdown", { clientX: 100, clientY: 100, button: 0 });
    dom.fire("pointermove", { clientX: 160, clientY: 140, button: 0 });
    dom.fire("pointerup", { clientX: 160, clientY: 140, button: 0 });
    expect(port.begin).not.toHaveBeenCalled();
    expect(submitted.some(command => command.type === "node.update")).toBe(true);
  });

  it("uses a drag cursor and move gesture on the director title", () => {
    const port = fakePort({ areaNodeId: "area", intent: "move" });
    const { dom, controller } = setup({ nodes: [{ id: "area", type: "scene-area", position: { x: 0, y: 0 } }],
      nodeData: areaData, pointHit: () => ({ kind: "node", nodeId: "area" }), port });
    const style = { cursor: "" };
    Object.defineProperty(dom.canvas, "style", { value: style });
    dom.fire("pointermove", { clientX: 500, clientY: 0 });
    expect(style.cursor).toBe("grab");
    dom.fire("pointerdown", { clientX: 500, clientY: 0 });
    expect(port.begin).toHaveBeenCalledWith(expect.objectContaining({ areaNodeId: "area", card: true }));
    expect(style.cursor).toBe("grabbing");
    dom.fire("pointermove", { clientX: 520, clientY: 30 });
    expect(style.cursor).toBe("grabbing");
    dom.fire("pointerup", { clientX: 520, clientY: 30 });
    controller.dispose();
  });

  it("preserves the same director edge resize cursor while dragging", () => {
    const port = fakePort({ areaNodeId: "area", intent: "resize", edge: { u: -1, v: 0 } });
    const { dom, controller } = setup({ nodes: [{ id: "area", type: "scene-area", position: { x: 0, y: 0 } }],
      nodeData: areaData, pointHit: () => null, port });
    const style = { cursor: "" };
    Object.defineProperty(dom.canvas, "style", { value: style });
    dom.fire("pointermove", { clientX: 0, clientY: 500 });
    const cursor = style.cursor;
    expect(cursor).toMatch(/resize$/);
    dom.fire("pointerdown", { clientX: 0, clientY: 500 });
    expect(style.cursor).toBe(cursor);
    dom.fire("pointermove", { clientX: -50, clientY: 500 });
    expect(style.cursor).toBe(cursor);
    dom.fire("pointerup", { clientX: -80, clientY: 500 });
    expect(port.update).toHaveBeenLastCalledWith({ x: -80, y: 500 });
    controller.dispose();
  });

  it("moves a 2D group together with its members on a title drag", () => {
    const port = fakePort(null);
    const { dom } = setup({
      nodes: [
        { id: "g", type: "workflow-group-2d", position: { x: 0, y: 0 } },
        { id: "a", type: "image", position: { x: 300, y: 300 } }
      ],
      nodeData: {
        ...areaData,
        g: { workflowGroup2d: { kind: "workflow-group-2d", version: SHARED_WORLD_VERSION, groupId: "g", scopeVersion: "g-v1", memberNodeIds: ["a"] } }
      },
      pointHit: () => ({ kind: "node", nodeId: "g" }), port
    });
    dom.fire("pointerdown", { clientX: 100, clientY: 0, button: 0 });
    dom.fire("pointermove", { clientX: 160, clientY: 40, button: 0 });
    dom.fire("pointerup", { clientX: 160, clientY: 40, button: 0 });
    const moved = submitted.filter(command => command.type === "node.update") as Array<{ nodeId: string }>;
    expect(moved.map(command => command.nodeId).sort()).toEqual(["a", "g"]);
  });

});
