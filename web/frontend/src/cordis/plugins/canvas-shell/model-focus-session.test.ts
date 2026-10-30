/**
 * 模型聚焦会话测试（change: add-model-focus-viewing，任务 3.1–3.4）。
 *
 * 覆盖：双击命中有效模型进入、卡片空白/失败模型不进入、pending-only 节点被拒绝、
 * look/pan/wheel/fly 路由、Escape 恢复、目标失效、editable/modal 门禁与 blur 清理。
 */
import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  createFilmSetGroupMarker,
  createModelSnapshot,
  composeFilmSetScene,
  prepareModelResource,
  type SceneV2Op,
  type ServerCanvas
} from "@woohaa3/contracts";
import {
  framingDistance,
  ModelFocusSession,
  modelBounds,
  type FocusTargetInput
} from "./model-focus-session.js";

const V2 = "woohaa-model-scene-ir-v2";

/** 位于原点的单位立方体，经 view rotation + unit 后落在节点下方。 */
function unitBox(): SceneV2Op {
  return {
    t: "box",
    id: "b",
    parent: null,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    material: null,
    color: "#ffffff",
    size: [1, 1, 1]
  } as SceneV2Op;
}

function canvasWithModel(nodeId = "m1", type = "model3d"): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: [{ id: nodeId, type, position: { x: 200, y: 100 }, width: 196, height: 64 }]
    },
    // 片场业务身份：composite-asset + extensionId="film-set"（D11）。
    nodeData: type === "composite-asset" ? { [nodeId]: { extensionId: "film-set" } } as ServerCanvas["nodeData"] : base.nodeData
  } as ServerCanvas;
}

function targetFor(canvas: ServerCanvas, nodeId = "m1", placement: FocusTargetInput["placement"] = null): FocusTargetInput {
  return {
    canvas,
    nodeId,
    viewport: { x: 0, y: 0, zoom: 1 },
    surface: { width: 1000, height: 800 },
    sceneVersion: V2,
    ops: [unitBox()],
    extent: 2,
    placement
  };
}

const SURFACE = { width: 1000, height: 800 };

/**
 * 旧 `hitModelAtScreen` 已迁至 Rust `queryModelPick`
 * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.2/5.5）。
 * 这里只保留 `modelBounds` 取景/锚点一致性的断言。
 */
describe("modelBounds 取景锚点（Rust 相机事实源）", () => {
  it("模型 AABB 位于卡片下方（锚点一致）", () => {
    const canvas = canvasWithModel();
    const bounds = modelBounds(targetFor(canvas))!;
    // 卡片底部 = 100 + 64 = 164；模型 AABB min y 低于卡片底部。
    expect(bounds.aabb.min[1]).toBeLessThan(800 - 164);
  });

  it("显式尺寸的 model3d 节点与渲染层同尺寸（锚点一致）", () => {
    const base = createEmptyWoohaa3ServerCanvas("c1");
    const canvas = {
      ...base,
      revision: 1,
      document: {
        ...base.document,
        nodes: [{ id: "m1", type: "model3d", position: { x: 200, y: 100 }, width: 260, height: 195 }]
      }
    } as ServerCanvas;
    const bounds = modelBounds(targetFor(canvas))!;
    expect(bounds.aabb.min[1]).toBeLessThan(800 - 164);
  });

  it("uses absolute group coordinates and world-space bounds for nested film sets", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("nested");
    canvas.document.nodes = [
      { id: "parent", type: "group", position: { x: 300, y: 150 } },
      { id: "film", type: "group", parentId: "parent", position: { x: 40, y: 20 }, width: 300, height: 200 }
    ];
    canvas.nodeData.film = { filmSetGroup: { schemaVersion: 1, sceneBindings: [] } };
    const nested = modelBounds(targetFor(canvas, "film"))!;
    const absolute = structuredClone(canvas);
    absolute.document.nodes[1]!.parentId = undefined;
    absolute.document.nodes[1]!.position = { x: 340, y: 170 };
    expect(modelBounds(targetFor(absolute, "film"))).toEqual(nested);
    expect(nested.aabb.max[0] - nested.aabb.min[0]).toBeCloseTo(nested.aabb.max[1] - nested.aabb.min[1]);
    expect(nested.aabb.max[1] - nested.aabb.min[1]).toBeCloseTo(nested.aabb.max[2] - nested.aabb.min[2]);
  });

  it("empty film set groups keep a finite editing workspace", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("empty-group");
    canvas.document.nodes = [{ id: "film", type: "group", position: { x: 0, y: 0 }, width: 400, height: 300 }];
    canvas.nodeData.film = { filmSetGroup: createFilmSetGroupMarker() };
    // 空片场组只有场景根 op，没有任何可见绑定或地面。
    const target: FocusTargetInput = {
      ...targetFor(canvas, "film"),
      ops: [{ t: "group", id: "\u0000scene", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } as SceneV2Op],
      aabb: null,
      extent: 0
    };
    const bounds = modelBounds(target)!;
    expect(bounds.radius).toBeGreaterThan(0);
    expect(bounds.center.every(Number.isFinite)).toBe(true);
    expect(bounds.aabb.min.every(Number.isFinite) && bounds.aabb.max.every(Number.isFinite)).toBe(true);
    // 普通 group 与空模型卡片仍不可聚焦。
    const plain = { ...target, canvas: { ...canvas, nodeData: { film: {} } } as ServerCanvas };
    expect(modelBounds(plain)).toBeNull();
  });

  it("frames live group binding and scene transforms without changing badge fit", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("live-group");
    canvas.document.nodes = [{ id: "film", type: "group", position: { x: 0, y: 0 }, width: 300, height: 200 }, { id: "source", type: "model3d", parentId: "film", position: { x: 10, y: 10 } }];
    const model = createModelSnapshot({ modelScript: "scene.box({id:'b'});", modelScriptVersion: "woohaa-model-js-v2" });
    canvas.nodeData.source = { modelScript: model.modelScript, modelScriptVersion: model.modelScriptVersion, modelScriptLanguage: model.modelScriptLanguage, modelContentVersion: model.contentVersion };
    canvas.nodeData.film = { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "actor", sourceNodeId: "source", kind: "model3d", contentKey: "v1", visibility: true, transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 } }] }) };
    const ops = composeFilmSetScene({ models: [{ itemId: "actor", localTransform: { offset: { x: 0, y: 0, z: 0 }, yaw: 0, scale: 1 }, ops: [unitBox()] }] }).ops;
    const resource = prepareModelResource({ sceneVersion: V2, ops });
    const target = { ...targetFor(canvas, "film"), ops, aabb: resource.aabb, extent: resource.extent };
    const before = modelBounds(target)!;
    canvas.nodeData.film.filmSetGroup!.sceneBindings[0]!.transform.x = 4;
    const moved = modelBounds(target)!;
    expect(moved.center[0]).toBeGreaterThan(before.center[0]);
    expect(moved.radius).toBeCloseTo(before.radius);
    expect(moved.anchor).toEqual(before.anchor);
    canvas.nodeData.film.filmSetGroup!.sceneTransform = { x: 2, y: 0, z: 0, yaw: 0, scale: 1 };
    const shifted = modelBounds(target)!;
    expect(shifted.center[0]).toBeGreaterThan(moved.center[0]);
    expect(shifted.anchor).toEqual(before.anchor);
  });
});

describe("ModelFocusSession", () => {
  it("enter 后投影携带稳定 nodeId 与有限相机值", () => {
    const session = new ModelFocusSession();
    const canvas = canvasWithModel();
    const target = targetFor(canvas);
    const bounds = modelBounds(target)!;
    const entered = session.enter({
      nodeId: "m1",
      target: bounds.center,
      radius: bounds.radius,
      distance: framingDistance(bounds.radius, SURFACE),
      saved: { viewport: { x: 0, y: 0, zoom: 1 } }
    });
    expect(entered).toBe(true);
    expect(session.active).toBe(true);
    expect(session.nodeId).toBe("m1");
    const projection = session.projection()!;
    expect(projection.nodeId).toBe("m1");
    expect([projection.yaw, projection.pitch, projection.distance, projection.fov, projection.radius].every(Number.isFinite)).toBe(true);
  });

  it("非法距离不进入聚焦", () => {
    const session = new ModelFocusSession();
    const entered = session.enter({ nodeId: "m1", target: [0, 0, 0], radius: 1, distance: 0, saved: null });
    expect(entered).toBe(false);
    expect(session.active).toBe(false);
  });

  it("look / pan / wheel / fly 路由改变相机", () => {
    const session = new ModelFocusSession();
    session.enter({ nodeId: "m1", target: [0, 0, 0], radius: 2, distance: 10, saved: null });

    expect(session.beginPointer(2, 1, 0, 0)).toBe(true);
    expect(session.movePointer(1, 50, 20, 800)).toBe(true);
    const looked = session.projection()!;
    expect(looked.yaw).not.toBe(0);
    session.endPointer(1);

    expect(session.beginPointer(1, 2, 0, 0)).toBe(true);
    expect(session.movePointer(2, 40, 0, 800)).toBe(true);
    const panned = session.projection()!;
    expect(panned.target).not.toEqual(looked.target);
    session.endPointer(2);

    const beforeDolly = session.projection()!.distance;
    expect(session.wheel(-100, { rightDown: false })).toBe(true);
    expect(session.projection()!.distance).toBeLessThan(beforeDolly);

    const beforeFly = session.projection()!.target[0];
    expect(session.fly({ forward: true, back: false, left: false, right: false, up: false, down: false }, { fast: false, slow: false }, 1)).toBe(true);
    expect(session.projection()!.target[0]).not.toBe(beforeFly);

    // 非 look/pan 按键不成为手势。
    expect(session.beginPointer(0, 3, 0, 0)).toBe(false);
  });

  it("Escape 退出返回进入快照并清空投影", () => {
    const session = new ModelFocusSession();
    const saved = { viewport: { x: 12, y: 34, zoom: 0.5 } };
    session.enter({ nodeId: "m1", target: [0, 0, 0], radius: 2, distance: 10, saved });
    const { restored } = session.exit();
    expect(restored).toEqual(saved);
    expect(session.active).toBe(false);
    expect(session.projection()).toBeNull();
  });

  it("目标失效（不在有效集合）自动退出", () => {
    const session = new ModelFocusSession();
    session.enter({ nodeId: "m1", target: [0, 0, 0], radius: 2, distance: 10, saved: null });
    expect(session.syncValidTargets(new Set(["m1"]))).toBe(false);
    expect(session.active).toBe(true);
    expect(session.syncValidTargets(new Set(["other"]))).toBe(true);
    expect(session.active).toBe(false);
  });

  it("clearHeld 保留聚焦但结束相机手势", () => {
    const session = new ModelFocusSession();
    session.enter({ nodeId: "m1", target: [0, 0, 0], radius: 2, distance: 10, saved: null });
    session.beginPointer(2, 1, 0, 0);
    session.clearHeld();
    // 手势已结束：pointerId 不匹配的移动被忽略。
    expect(session.movePointer(1, 100, 0, 800)).toBe(false);
    expect(session.active).toBe(true);
  });

  it("content rect 投影把目标平移到未遮挡左区中心", () => {
    const session = new ModelFocusSession();
    session.enter({ nodeId: "m1", target: [0, 0, 0], radius: 2, distance: 10, saved: null });
    const centered = session.projection()!;
    expect(session.setContentRect({ right: 400, surfaceHeight: 800 })).toBe(true);
    const shifted = session.projection()!;
    // yaw=0 时相机右方向为 +x：目标向右平移半个遮挡宽度。
    expect(shifted.target[0]).toBeGreaterThan(centered.target[0]);
    // 无变化时返回 false（不触发多余 flush）。
    expect(session.setContentRect({ right: 400, surfaceHeight: 800 })).toBe(false);
  });

  it("模型 placement 手势：preview 推进、结束返回 origin/final", () => {
    const session = new ModelFocusSession();
    session.enter({ nodeId: "m1", target: [0, 0, 0], radius: 2, distance: 10, saved: null });
    const drag = {
      mode: "offset" as const,
      origin: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      startX: 500,
      startY: 400,
      planeOrigin: [0, 0, 0] as [number, number, number],
      planeNormal: [0, 0, -1] as [number, number, number]
    };
    expect(session.beginModelPointer(3, drag)).toBe(true);
    expect(session.hasModelGesture).toBe(true);
    expect(session.movePointer(3, 620, 400, 800, { width: 1000, height: 800 })).toBe(true);
    expect(session.modelPreview()).not.toBeNull();
    const finished = session.endModelPointer(3)!;
    expect(finished.origin.yaw).toBe(0);
    expect(session.hasModelGesture).toBe(false);
    expect(session.modelPreview()).toBeNull();
  });

  it("drag 为 null 不建立 model 手势", () => {
    const session = new ModelFocusSession();
    session.enter({ nodeId: "m1", target: [0, 0, 0], radius: 2, distance: 10, saved: null });
    expect(session.beginModelPointer(1, null)).toBe(false);
    expect(session.hasModelGesture).toBe(false);
  });
});

it("empty film sets retain a finite editing workspace while empty model cards remain unavailable", () => {
  const film = targetFor(canvasWithModel("m1", "composite-asset"));
  film.ops = [{ t: "group", id: "root", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }];
  film.aabb = null;
  const bounds = modelBounds(film)!;
  expect(bounds.radius).toBeGreaterThan(0);
  expect(bounds.center.every(Number.isFinite)).toBe(true);
  const model = { ...film, canvas: canvasWithModel("m1", "model3d") };
  expect(modelBounds(model)).toBeNull();
});
