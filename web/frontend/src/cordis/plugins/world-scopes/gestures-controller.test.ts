/**
 * Controller-level regression tests for world-scope gestures.
 *
 * Split from gestures.test.ts to stay inside the 800-line review guard. These tests
 * exercise the real InteractionController frame/settlement path and the overlay bridge,
 * not only the gesture runtime in isolation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHARED_WORLD_VERSION,
  createEmptyWoohaa3ServerCanvas,
  type ServerCanvas,
  type WorldAuthoringPrepareOutcome,
  type WorldCameraData,
  type WorldPreparedAuthoritySnapshot
} from "@woohaa3/contracts";
import {
  createSceneAreaGestures,
  resetSceneAreaGestures,
  type SceneAreaGestureDeps,
  type SceneAreaGesturePort
} from "./gestures.js";
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
  const deps: SceneAreaGestureDeps = {
    canvasId: () => "c1",
    writable: () => true,
    getCanvas: () => woohaa3CanvasStore.getState().working ?? woohaa3CanvasStore.getState().canvas,
    prepare,
    execute: execute as never,
    history: history as never,
    queryGround: point => ({ u: point.x / 100, v: point.y / 100 }),
    preview: vi.fn(),
    mode: () => "auto",
    tolerance: () => 0.2,
    newOperationId: () => "scene-area-op",
    ...overrides
  };
  return { deps, prepare, execute, history, prepared };
}

const fakePort = (start: { areaNodeId: string; intent: "move" | "resize" } | null) => ({
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

beforeEach(() => {
  resetSceneAreaGestures();
});

describe("interaction controller wiring regressions", () => {
  it("does not let performFrame cancel an overlay-started scene gesture", async () => {
    let release!: (value: WorldAuthoringPrepareOutcome) => void;
    let signal: AbortSignal | undefined;
    const { deps, execute, prepared } = runtimeHarness({
      prepare: (_areaId, nextSignal) => {
        signal = nextSignal;
        return new Promise<WorldAuthoringPrepareOutcome>(resolve => { release = resolve; });
      }
    });
    const port = createSceneAreaGestures(deps);
    const { controller } = setup({ nodes: [areaNode()], nodeData: areaData, pointHit: () => null, port });
    const started = controller.beginSceneAreaGesture({ point: { x: 500, y: 500 }, areaNodeId: "area", card: true, mode: "move" });
    expect(started).toEqual({ areaNodeId: "area", intent: "move" });
    // The old defect: the very next frame reconciliation called cancel().
    controller.flush();
    expect(port.active()).toBe(true);
    expect(signal?.aborted).toBe(false);
    release({ ok: true, snapshot: prepared });
    await Promise.resolve();
    await Promise.resolve();
    port.update({ x: 700, y: 800 });
    controller.flush();
    expect(port.active()).toBe(true);
    const result = await controller.endSceneAreaGesture();
    expect(result).toMatchObject({ ok: true, operationId: "scene-area-op" });
    expect(execute).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("commits a pointer release after performFrame while prepare is pending", async () => {
    let release!: (value: WorldAuthoringPrepareOutcome) => void;
    let signal: AbortSignal | undefined;
    const { deps, execute, prepared } = runtimeHarness({
      prepare: (_areaId, nextSignal) => {
        signal = nextSignal;
        return new Promise<WorldAuthoringPrepareOutcome>(resolve => { release = resolve; });
      }
    });
    const port = createSceneAreaGestures(deps);
    const { dom, controller } = setup({
      nodes: [areaNode()], nodeData: areaData,
      pointHit: () => ({ kind: "node", nodeId: "area" }), port
    });
    dom.fire("pointerdown", { clientX: 100, clientY: 100, button: 0 });
    expect(port.active()).toBe(true);
    dom.fire("pointermove", { clientX: 180, clientY: 140, button: 0 });
    dom.fire("pointerup", { clientX: 180, clientY: 140, button: 0 });
    expect(port.ending()).toBe(true);
    expect(port.active()).toBe(true);
    // The release frame lands while scene-area-prepare is still unresolved.
    controller.flush();
    expect(signal?.aborted).toBe(false);
    release({ ok: true, snapshot: prepared });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    controller.dispose();
  });

  it("lets explicit move mode start the scene gesture before world-model picking", () => {
    const port = fakePort({ areaNodeId: "area", intent: "move" });
    port.mode.mockReturnValue("move");
    const model = modelNode("m1", "i1");
    const { dom, controller } = setup({
      nodes: [areaNode(), model],
      nodeData: { ...areaData, m1: model.nodeData as never },
      pointHit: () => null,
      port,
      modelPick: () => ({ nodeId: "m1", target: [0, 0, 0], radius: 1 })
    });
    dom.fire("pointerdown", { clientX: 1, clientY: 1, button: 0 });
    expect(port.begin).toHaveBeenCalledWith(expect.objectContaining({ card: false, areaNodeId: null }));
    controller.dispose();
  });

  it("keeps world-model picking ahead of auto scene-area edges", () => {
    const port = fakePort({ areaNodeId: "area", intent: "resize" });
    const model = modelNode("m1", "i1");
    const { dom, controller } = setup({
      nodes: [areaNode(), model],
      nodeData: { ...areaData, m1: model.nodeData as never },
      pointHit: () => null,
      port,
      modelPick: () => ({ nodeId: "m1", target: [0, 0, 0], radius: 1 })
    });
    dom.fire("pointerdown", { clientX: 1, clientY: 1, button: 0 });
    expect(port.begin).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("expands every selected 2D group on a mixed multi-select drag", () => {
    const port = fakePort(null);
    let target = "b";
    const { dom, controller } = setup({
      nodes: [
        // 组**标题**才是搬动命中区（边框按下是调范围）：标题在 y-11…y+11、x+12 起，
        // 所以组框要挪到测试按下点 (100,100) 下方，标题才覆盖它。
        { id: "g", type: "workflow-group-2d", position: { x: 0, y: 100 } },
        { id: "a", type: "image", position: { x: 300, y: 300 } },
        { id: "b", type: "image", position: { x: 600, y: 600 } }
      ],
      nodeData: {
        ...areaData,
        g: { workflowGroup2d: { kind: "workflow-group-2d", version: SHARED_WORLD_VERSION, groupId: "g", scopeVersion: "g-v1", memberNodeIds: ["a"] } }
      },
      pointHit: () => ({ kind: "node", nodeId: target }), port
    });
    controller.selectNode("g");
    dom.fire("pointerdown", { clientX: 100, clientY: 100, button: 0, shiftKey: true });
    dom.fire("pointerup", { clientX: 100, clientY: 100, button: 0, shiftKey: true });
    target = "g";
    dom.fire("pointerdown", { clientX: 100, clientY: 100, button: 0 });
    dom.fire("pointermove", { clientX: 160, clientY: 140, button: 0 });
    dom.fire("pointerup", { clientX: 160, clientY: 140, button: 0 });
    const moved = submitted.filter(command => command.type === "node.update") as Array<{ nodeId: string }>;
    expect(moved.map(command => command.nodeId).sort()).toEqual(["a", "b", "g"]);
    controller.dispose();
  });
});
