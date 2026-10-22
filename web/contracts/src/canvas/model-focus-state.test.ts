/**
 * 模型聚焦查看状态机测试（change: add-model-focus-viewing，任务 1.3）。
 *
 * 覆盖：enter/exit 与快照恢复、目标失效、look/pan 手势、dolly/调速、键盘飞行倍率、
 * blur/cancel 清理，并确认投影状态不携带规范字段。
 */
import { describe, expect, it } from "vitest";
import {
  beginGesture,
  beginModelGesture,
  enterFocus,
  exitFocus,
  finishGesture,
  finishModelGesture,
  focusCameraSnapshot,
  focusedNodeId,
  FOCUS_ZOOM_OUT_RADIUS_MULTIPLIER,
  initialFocusState,
  invalidateTarget,
  isFocused,
  keyboardFly,
  moveGesture,
  reframeFocus,
  restoreFocusCamera,
  toProjection,
  wheelZoom,
  zoomFocusByFactor
} from "./model-focus-state.js";
import {
  MODEL_FOCUS_MAX_DISTANCE,
  MODEL_FOCUS_MIN_DISTANCE,
  MODEL_FOCUS_PITCH_LIMIT
} from "./model-focus.js";

function focused() {
  return enterFocus(initialFocusState(), {
    nodeId: "n1",
    target: [0, 1, 0],
    radius: 2,
    distance: 10,
    savedProjection2d: { viewport: { x: 3, y: 4, zoom: 0.8 }, camera: { z: 300 } }
  });
}

describe("enter/exit", () => {
  it("进入聚焦并投影 modelFocus", () => {
    const state = focused();
    expect(isFocused(state)).toBe(true);
    expect(focusedNodeId(state)).toBe("n1");
    const projection = toProjection(state)!;
    expect(projection.nodeId).toBe("n1");
    expect(projection.target).toEqual([0, 1, 0]);
    expect(projection.radius).toBe(2);
    expect([projection.yaw, projection.pitch, projection.distance, projection.fov].every(Number.isFinite)).toBe(true);
  });

  it("非法目标或距离不进入聚焦", () => {
    expect(isFocused(enterFocus(initialFocusState(), { nodeId: "n", target: [Number.NaN, 0, 0], radius: 1, distance: 5, savedProjection2d: null }))).toBe(false);
    expect(isFocused(enterFocus(initialFocusState(), { nodeId: "n", target: [0, 0, 0], radius: 1, distance: 0, savedProjection2d: null }))).toBe(false);
  });

  it("退出精确恢复进入快照，不从聚焦终态反推", () => {
    const state = focused();
    // 改变相机后再退出。
    const moved = moveGesture(beginGesture(state, { kind: "look", pointerId: 1, x: 0, y: 0 }), 1, 40, 10, 800);
    const { state: idle, restored } = exitFocus(moved);
    expect(isFocused(idle)).toBe(false);
    expect(restored).toEqual({ viewport: { x: 3, y: 4, zoom: 0.8 }, camera: { z: 300 } });
    expect(toProjection(idle)).toBeNull();
  });

  it("idle 退出为 no-op", () => {
    expect(exitFocus(initialFocusState()).restored).toBeNull();
  });

  it("enter 只允许 idle→focused 写入快照；同 node no-op，异 node 不覆盖 saved（design D4）", () => {
    const state = focused();
    // 同 node 再次 enter：no-op（不覆盖快照）。
    expect(
      enterFocus(state, {
        nodeId: "n1",
        target: [5, 5, 5],
        radius: 9,
        distance: 20,
        savedProjection2d: { viewport: { x: 99, y: 99, zoom: 9 } }
      })
    ).toBe(state);
    // 异 node：替换目标/相机，但保留原 savedProjection2d。
    const other = enterFocus(state, {
      nodeId: "n2",
      target: [5, 5, 5],
      radius: 9,
      distance: 20,
      savedProjection2d: { viewport: { x: 99, y: 99, zoom: 9 } }
    });
    expect(other.phase === "focused" && other.nodeId).toBe("n2");
    expect(other.phase === "focused" && other.camera.target).toEqual([5, 5, 5]);
    expect(other.phase === "focused" && other.savedProjection2d).toEqual({
      viewport: { x: 3, y: 4, zoom: 0.8 },
      camera: { z: 300 }
    });
  });

  it("reframeFocus 无快照副作用地更新目标/半径/距离（design D4）", () => {
    const state = focused();
    const reframed = reframeFocus(state, { target: [1, 2, 3], radius: 7, distance: 12 });
    expect(reframed.phase === "focused" && reframed.camera.target).toEqual([1, 2, 3]);
    expect(reframed.phase === "focused" && reframed.radius).toBe(7);
    expect(reframed.phase === "focused" && reframed.camera.distance).toBe(12);
    // savedProjection2d 不变。
    expect(reframed.phase === "focused" && reframed.savedProjection2d).toEqual({
      viewport: { x: 3, y: 4, zoom: 0.8 },
      camera: { z: 300 }
    });
    // 省略 distance 保留用户观察缩放。
    const keep = reframeFocus(reframed, { target: [0, 0, 0], radius: 2 });
    expect(keep.phase === "focused" && keep.camera.distance).toBe(12);
    // 异 node / idle 为 no-op。
    expect(reframeFocus(state, { nodeId: "other", target: [0, 0, 0], radius: 1 })).toBe(state);
    expect(reframeFocus(initialFocusState(), { target: [0, 0, 0], radius: 1 })).toEqual(initialFocusState());
  });

  it("focusCameraSnapshot / restoreFocusCamera 往返恢复 direct 相机", () => {
    const state = focused();
    const moved = moveGesture(beginGesture(state, { kind: "look", pointerId: 1, x: 0, y: 0 }), 1, 40, 10, 800);
    const snapshot = focusCameraSnapshot(moved)!;
    expect(snapshot.yaw).not.toBe(0);
    const restored = restoreFocusCamera(moved, { target: [0, 1, 0], yaw: 0, pitch: -0.35, distance: 10, flySpeed: 6 });
    expect(restored.phase === "focused" && restored.camera.yaw).toBe(0);
    // 快照可恢复原姿态。
    const back = restoreFocusCamera(restored, snapshot);
    expect(back.phase === "focused" && back.camera.yaw).toBeCloseTo(snapshot.yaw, 9);
  });
});

describe("目标失效", () => {
  it("目标不在有效集合中自动退出", () => {
    const state = focused();
    expect(isFocused(invalidateTarget(state, new Set(["n1"])))).toBe(true);
    expect(isFocused(invalidateTarget(state, new Set(["other"])))).toBe(false);
  });
});

describe("相机手势", () => {
  it("look 改变 yaw/pitch 且 pitch 不越过奇点", () => {
    let state = beginGesture(focused(), { kind: "look", pointerId: 1, x: 0, y: 0 });
    state = moveGesture(state, 1, 100, 0, 800);
    expect(state.phase === "focused" && state.camera.yaw).not.toBe(0);
    // 大幅向下拖 → pitch 被钳制。
    state = beginGesture(state, { kind: "look", pointerId: 1, x: 0, y: 0 });
    state = moveGesture(state, 1, 0, 100000, 800);
    if (state.phase === "focused") expect(Math.abs(state.camera.pitch)).toBeLessThanOrEqual(MODEL_FOCUS_PITCH_LIMIT + 1e-6);
  });

  it("非当前 pointerId 的移动被忽略", () => {
    const state = beginGesture(focused(), { kind: "look", pointerId: 1, x: 0, y: 0 });
    const moved = moveGesture(state, 2, 100, 100, 800);
    expect(moved).toBe(state);
  });

  it("pan 平移 target 且不改 distance", () => {
    let state = beginGesture(focused(), { kind: "pan", pointerId: 1, x: 0, y: 0 });
    const before = state.phase === "focused" ? state.camera.distance : 0;
    state = moveGesture(state, 1, 50, -30, 800);
    if (state.phase === "focused") {
      expect(state.camera.target).not.toEqual([0, 1, 0]);
      expect(state.camera.distance).toBe(before);
    }
  });

  it("finishGesture / 不匹配 pointer 清理", () => {
    const state = beginGesture(focused(), { kind: "look", pointerId: 1, x: 0, y: 0 });
    expect(state.phase === "focused" && state.gesture.kind).toBe("look");
    // 其它 pointer 结束不影响。
    const other = finishGesture(state, 2);
    expect(other).toBe(state);
    const finished = finishGesture(state, 1);
    expect(finished.phase === "focused" && finished.gesture.kind).toBe("none");
  });
});

describe("模型 placement 手势（change: add-model-focus-editing，任务 2.1–2.3）", () => {
  function dragState(mode: "offset" | "yaw") {
    // 命中单位 AABB（原点、边长 2）的屏幕中心 ray，从相机 z=10 处看向原点。
    const camera = { target: [0, 0, 0] as [number, number, number], yaw: 0, pitch: 0, distance: 10, flySpeed: 6 };
    const drag = {
      mode,
      origin: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      startX: 500,
      startY: 400,
      planeOrigin: [0, 0, 0] as [number, number, number],
      planeNormal: [0, 0, -1] as [number, number, number]
    };
    return { camera, drag };
  }

  it("model 手势优先于相机手势并要求 pointerId 匹配", () => {
    const { drag } = dragState("offset");
    const state = beginModelGesture(focused(), { pointerId: 7, drag });
    expect(state.phase === "focused" && state.gesture.kind).toBe("model");
    // drag=null 不改变状态。
    expect(beginModelGesture(focused(), { pointerId: 7, drag: null })).toEqual(focused());
    // 不匹配 pointer 的移动被忽略。
    expect(moveGesture(state, 9, 600, 400, 800)).toBe(state);
  });

  it("offset model 手势产生完整 preview，scale/yaw 不变", () => {
    const { camera, drag } = dragState("offset");
    let state = beginModelGesture(focused(), { pointerId: 1, drag });
    state = moveGesture(state, 1, 640, 400, 800, { surface: { width: 1000, height: 800 }, camera });
    if (state.phase !== "focused" || !state.modelPreview) throw new Error("expected preview");
    expect(state.modelPreview.scale).toBe(1);
    expect(state.modelPreview.yaw).toBe(0);
    const magnitude = Math.abs(state.modelPreview.offset.x) + Math.abs(state.modelPreview.offset.y) + Math.abs(state.modelPreview.offset.z);
    expect(magnitude).toBeGreaterThan(0);
    // model 手势不动相机。
    expect(state.camera.target).toEqual([0, 1, 0]);
  });

  it("yaw model 手势只用横向像素增量", () => {
    const { camera, drag } = dragState("yaw");
    let state = beginModelGesture(focused(), { pointerId: 1, drag });
    state = moveGesture(state, 1, 550, 700, 800, { surface: { width: 1000, height: 800 }, camera });
    if (state.phase !== "focused" || !state.modelPreview) throw new Error("expected preview");
    const expected = (50 * 0.02 * 180) / Math.PI;
    expect(state.modelPreview.yaw).toBeCloseTo(expected, 6);
    expect(state.modelPreview.offset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("finishModelGesture 返回 origin/final 且清理 preview", () => {
    const { camera, drag } = dragState("offset");
    let state = beginModelGesture(focused(), { pointerId: 1, drag });
    state = moveGesture(state, 1, 640, 400, 800, { surface: { width: 1000, height: 800 }, camera });
    const { state: finished, origin, preview } = finishModelGesture(state, 1);
    expect(origin).toEqual({ offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 });
    expect(preview).not.toBeNull();
    expect(finished.phase === "focused" && finished.gesture.kind).toBe("none");
    if (finished.phase === "focused") expect(finished.modelPreview).toBeUndefined();
    // 非 model 手势返回 null。
    const look = finishModelGesture(beginGesture(focused(), { kind: "look", pointerId: 2, x: 0, y: 0 }), 2);
    expect(look.origin).toBeNull();
    expect(look.preview).toBeNull();
  });

  it("pointercancel 清理 model preview 且不残留手势", () => {
    const { camera, drag } = dragState("offset");
    let state = beginModelGesture(focused(), { pointerId: 1, drag });
    state = moveGesture(state, 1, 640, 400, 800, { surface: { width: 1000, height: 800 }, camera });
    const cancelled = finishGesture(state, 1);
    expect(cancelled.phase === "focused" && cancelled.gesture.kind).toBe("none");
    if (cancelled.phase === "focused") expect(cancelled.modelPreview).toBeUndefined();
  });
});

describe("滚轮与键盘", () => {
  it("未按右键 dolly，按住右键改 flySpeed", () => {
    const state = focused();
    const dolly = wheelZoom(state, -100, { rightDown: false });
    if (dolly.phase === "focused" && state.phase === "focused") {
      expect(dolly.camera.distance).toBeLessThan(state.camera.distance);
      expect(dolly.camera.flySpeed).toBe(state.camera.flySpeed);
    }
    const speed = wheelZoom(state, -100, { rightDown: true });
    if (speed.phase === "focused" && state.phase === "focused") {
      expect(speed.camera.flySpeed).toBeGreaterThan(state.camera.flySpeed);
      expect(speed.camera.distance).toBe(state.camera.distance);
    }
  });

  it("dolly 限制在距离范围内，且可贴近包围球内部", () => {
    let state = focused();
    for (let i = 0; i < 100; i += 1) state = wheelZoom(state, 100, { rightDown: false });
    if (state.phase === "focused") expect(state.camera.distance).toBeLessThanOrEqual(MODEL_FOCUS_MAX_DISTANCE);
    for (let i = 0; i < 200; i += 1) state = wheelZoom(state, -100, { rightDown: false });
    if (state.phase === "focused") expect(state.camera.distance).toBeGreaterThanOrEqual(MODEL_FOCUS_MIN_DISTANCE);

    // 放开拉近后，相机可进入包围球内部（下限为半径的固定比例），但不得穿到近裁剪面以内。
    let close = enterFocus(initialFocusState(), {
      nodeId: "big",
      target: [0, 1, 0],
      radius: 185,
      distance: 400,
      savedProjection2d: null
    });
    for (let i = 0; i < 80; i += 1) close = wheelZoom(close, -100, { rightDown: false });
    if (close.phase === "focused") {
      expect(close.camera.distance).toBeLessThan(185);
      expect(close.camera.distance).toBeGreaterThanOrEqual(MODEL_FOCUS_MIN_DISTANCE);
    }
  });

  it("键盘飞行按倍率移动 target", () => {
    const state = focused();
    const normal = keyboardFly(state, { forward: 1, right: 0, up: 0 }, { fast: false, slow: false }, 1);
    const fast = keyboardFly(state, { forward: 1, right: 0, up: 0 }, { fast: true, slow: false }, 1);
    const slow = keyboardFly(state, { forward: 1, right: 0, up: 0 }, { fast: false, slow: true }, 1);
    const dist = (next: typeof state) => (next.phase === "focused" && state.phase === "focused" ? Math.hypot(...next.camera.target.map((v, i) => v - state.camera.target[i])) : 0);
    expect(dist(fast)).toBeCloseTo(dist(normal) * 3, 6);
    expect(dist(slow)).toBeCloseTo(dist(normal) * 0.333, 3);
  });
});

describe("连续缩放主观察相机（change: 对齐 xyflow-bevy 聚焦导航）", () => {
  it("factor > 1 拉近，factor < 1 推远，且 clamp 到距离范围", () => {
    const state = focused();
    const start = state.phase === "focused" ? state.camera.distance : 0;
    const near = zoomFocusByFactor(state, 2);
    if (near.phase === "focused") expect(near.camera.distance).toBeCloseTo(start / 2, 6);
    const far = zoomFocusByFactor(state, 0.5);
    if (far.phase === "focused") expect(far.camera.distance).toBeCloseTo(start * 2, 6);
    // 极端 factor 仍受距离下限约束（含包围球余量）。
    const extreme = zoomFocusByFactor(state, 1e6);
    if (extreme.phase === "focused") expect(extreme.camera.distance).toBeGreaterThanOrEqual(MODEL_FOCUS_MIN_DISTANCE);
  });

  it("非有限/非正/无变化 factor 不改变状态", () => {
    const state = focused();
    expect(zoomFocusByFactor(state, Number.NaN)).toBe(state);
    expect(zoomFocusByFactor(state, 0)).toBe(state);
    expect(zoomFocusByFactor(state, -3)).toBe(state);
    expect(zoomFocusByFactor(state, 1)).toBe(state);
    // idle 状态 no-op。
    expect(zoomFocusByFactor(initialFocusState(), 2)).toEqual(initialFocusState());
  });
});


describe("聚焦缩小边界", () => {
  it.each([0.1, 2, 1000])("按半径 %s 限制缩小，达到边界后仍可放大", (radius) => {
    const state = enterFocus(initialFocusState(), {
      nodeId: "n1", target: [0, 0, 0], radius, distance: radius * 3, savedProjection2d: null
    });
    const far = zoomFocusByFactor(state, 0.000001);
    expect(toProjection(far)!.distance).toBeCloseTo(radius * FOCUS_ZOOM_OUT_RADIUS_MULTIPLIER);
    expect(zoomFocusByFactor(far, 0.5)).toBe(far);
    expect(toProjection(zoomFocusByFactor(far, 2))!.distance).toBeCloseTo((radius * FOCUS_ZOOM_OUT_RADIUS_MULTIPLIER) / 2);
    expect(toProjection(wheelZoom(far, 120, { rightDown: false }))!.distance).toBeCloseTo(radius * FOCUS_ZOOM_OUT_RADIUS_MULTIPLIER);
  });
});
