/**
 * wheel/pinch 归一化与视口手势（change: align-godot-canvas-interactions，任务 2.4 / 2.5；
 * 对齐修正 change: add-audio-video-generation-and-align-model-catalog）。
 *
 * 重点覆盖与 xyflow `useWheelViewportGesture` 的一致行为：
 * - 触控板**竖直**双指滚动必须判为平移（不是缩放）；
 * - 触控板平移方向为 `x - deltaX, y - deltaY`；
 * - 鼠标滚轮按 1.1 分级缩放且指针锚定；
 * - Ctrl/Cmd + wheel = pinch 连续缩放。
 */
import { describe, expect, it } from "vitest";
import {
  accumulateWheelGesture,
  applyWheelToViewport,
  classifyWheelEvent,
  classifyWheelSource,
  createWheelGestureAccumulator,
  DELTA_MODE_LINE,
  DELTA_MODE_PAGE,
  DELTA_MODE_PIXEL,
  INITIAL_WHEEL_SOURCE,
  normalizeWheelDelta,
  takeWheelGesture,
  ViewportGestureSession,
  WHEEL_ZOOM_STEP,
  viewportsEqual
} from "./wheel-gesture.js";

function wheel(overrides: Partial<Parameters<typeof classifyWheelEvent>[0]> = {}) {
  return {
    deltaX: 0,
    deltaY: 0,
    deltaMode: DELTA_MODE_PIXEL,
    ctrlKey: false,
    metaKey: false,
    clientX: 100,
    clientY: 100,
    timeStamp: 0,
    ...overrides
  };
}

/** 折叠一次事件序列的来源状态，返回每次的手势 kind/source。 */
function sequence(events: Array<Partial<Parameters<typeof classifyWheelEvent>[0]>>) {
  let state = INITIAL_WHEEL_SOURCE;
  return events.map((event) => {
    const result = classifyWheelEvent(wheel(event), state);
    state = result.control;
    return result.wheel;
  });
}

describe("wheel 分类", () => {
  it("触控板竖直双指滚动（像素、小步长、无横向）→ 平移", () => {
    const result = classifyWheelEvent(wheel({ deltaY: -3 }));
    expect(result.wheel).toMatchObject({ kind: "pan", source: "trackpad", dx: 0, dy: -3 });
  });

  it("触控板双轴滚动 → 平移", () => {
    const result = classifyWheelEvent(wheel({ deltaX: 4, deltaY: 12 }));
    expect(result.wheel).toMatchObject({ kind: "pan", source: "trackpad", dx: 4, dy: 12 });
  });

  it("鼠标滚轮（行模式）→ 分级缩放", () => {
    const result = classifyWheelEvent(wheel({ deltaY: 1, deltaMode: DELTA_MODE_LINE }));
    expect(result.wheel).toMatchObject({ kind: "zoom", source: "mouse", direction: -1 });
  });

  it("鼠标滚轮（像素、大步长、无横向）→ 分级缩放", () => {
    const result = classifyWheelEvent(wheel({ deltaY: 100 }));
    expect(result.wheel).toMatchObject({ kind: "zoom", source: "mouse", direction: -1 });
  });

  it("Ctrl/Cmd + wheel → pinch 连续缩放", () => {
    const ctrl = classifyWheelEvent(wheel({ deltaY: -100, ctrlKey: true }));
    expect(ctrl.wheel?.kind).toBe("zoom");
    expect(ctrl.wheel?.source).toBe("pinch");
    if (ctrl.wheel?.kind === "zoom" && ctrl.wheel.source === "pinch") {
      expect(ctrl.wheel.factor).toBeGreaterThan(1);
    }
    const meta = classifyWheelEvent(wheel({ deltaY: -100, metaKey: true }));
    expect(meta.wheel?.source).toBe("pinch");
  });

  it("零增量 → 不构成手势", () => {
    expect(classifyWheelEvent(wheel()).wheel).toBeNull();
  });

  it("来源状态在 200ms 内保持（连续触控板事件不被误判为鼠标）", () => {
    const wheelResults = sequence([
      { deltaY: -3, timeStamp: 0 },
      { deltaY: -30, timeStamp: 10 },
      { deltaY: -60, timeStamp: 20 }
    ]);
    expect(wheelResults.every((entry) => entry?.kind === "pan")).toBe(true);
  });

  it("超过 200ms 后来源重置（重新按步长判定）", () => {
    // 第一次判触控板（小步长），隔 500ms 后来一个像素大步长 → 重置后判鼠标。
    const results = sequence([
      { deltaY: -3, timeStamp: 0 },
      { deltaY: -100, timeStamp: 500 }
    ]);
    expect(results[0]?.kind).toBe("pan");
    expect(results[1]?.kind).toBe("zoom");
  });

  it("deltaMode 归一化：行/页换算为像素", () => {
    expect(normalizeWheelDelta({ deltaX: 0, deltaY: 2, deltaMode: DELTA_MODE_LINE })).toEqual({ dx: 0, dy: 32 });
    expect(normalizeWheelDelta({ deltaX: 1, deltaY: 0, deltaMode: DELTA_MODE_PAGE }).dx).toBe(800);
  });
});

describe("classifyWheelSource", () => {
  it("横向分量或小步长 → trackpad", () => {
    expect(classifyWheelSource(wheel({ deltaY: 5 }), INITIAL_WHEEL_SOURCE).source).toBe("trackpad");
    expect(classifyWheelSource(wheel({ deltaX: -8 }), INITIAL_WHEEL_SOURCE).source).toBe("trackpad");
  });

  it("行/页模式 → mouse", () => {
    expect(classifyWheelSource(wheel({ deltaY: 1, deltaMode: DELTA_MODE_LINE }), INITIAL_WHEEL_SOURCE).source).toBe("mouse");
  });
});

describe("wheel 应用到视口", () => {
  it("鼠标滚轮以指针为中心放大 1.1 倍", () => {
    const view = { x: 0, y: 0, zoom: 1 };
    const next = applyWheelToViewport(view, { kind: "zoom", source: "mouse", direction: 1, factor: WHEEL_ZOOM_STEP, screen: { x: 100, y: 100 } });
    expect(next.zoom).toBeCloseTo(WHEEL_ZOOM_STEP, 6);
    const logicalBefore = { x: (100 - view.x) / view.zoom, y: (100 - view.y) / view.zoom };
    const logicalAfter = { x: (100 - next.x) / next.zoom, y: (100 - next.y) / next.zoom };
    expect(logicalAfter.x).toBeCloseTo(logicalBefore.x, 6);
    expect(logicalAfter.y).toBeCloseTo(logicalBefore.y, 6);
  });

  it("触控板平移方向：x - deltaX, y - deltaY，zoom 不变", () => {
    const next = applyWheelToViewport(
      { x: 0, y: 0, zoom: 2 },
      { kind: "pan", source: "trackpad", dx: -10, dy: 5 }
    );
    expect(next).toEqual({ x: 10, y: -5, zoom: 2 });
  });

  it("缩放受规范 min/max zoom 限制", () => {
    const clamped = applyWheelToViewport(
      { x: 0, y: 0, zoom: 0.1 },
      { kind: "zoom", source: "mouse", direction: -1, factor: 1 / WHEEL_ZOOM_STEP, screen: { x: 0, y: 0 } }
    );
    expect(clamped.zoom).toBeGreaterThanOrEqual(0.1);
  });
});

describe("wheel 手势累加器（rAF 合并）", () => {
  it("平移分量相加、缩放因子相乘，锚点取最后一次", () => {
    const acc = createWheelGestureAccumulator();
    accumulateWheelGesture(acc, { kind: "pan", source: "trackpad", dx: 3, dy: 4 });
    accumulateWheelGesture(acc, { kind: "pan", source: "trackpad", dx: -1, dy: 2 });
    accumulateWheelGesture(acc, { kind: "zoom", source: "mouse", direction: 1, factor: 1.1, screen: { x: 1, y: 2 } });
    accumulateWheelGesture(acc, { kind: "zoom", source: "mouse", direction: 1, factor: 1.1, screen: { x: 9, y: 8 } });
    const message = takeWheelGesture(acc);
    expect(message?.pan).toEqual({ dx: 2, dy: 6 });
    expect(message?.zoom?.factor).toBeCloseTo(1.21, 6);
    expect(message?.zoom?.screen).toEqual({ x: 9, y: 8 });
  });

  it("无分量时返回 null", () => {
    const acc = createWheelGestureAccumulator();
    expect(takeWheelGesture(acc)).toBeNull();
  });

  it("取出后清空，可复用", () => {
    const acc = createWheelGestureAccumulator();
    accumulateWheelGesture(acc, { kind: "pan", source: "trackpad", dx: 5, dy: 5 });
    expect(takeWheelGesture(acc)?.pan).toEqual({ dx: 5, dy: 5 });
    expect(takeWheelGesture(acc)).toBeNull();
    accumulateWheelGesture(acc, { kind: "zoom", source: "pinch", factor: 0.5, deltaY: 10, screen: { x: 0, y: 0 } });
    const second = takeWheelGesture(acc);
    expect(second?.zoom?.factor).toBeCloseTo(0.5, 6);
    expect(second?.pan).toBeUndefined();
  });
});

describe("视口手势会话", () => {
  it("连续预览只产生一条最终提交", () => {
    const session = new ViewportGestureSession();
    session.begin({ x: 0, y: 0, zoom: 1 });
    session.update({ x: 10, y: 0, zoom: 1 });
    session.update({ x: 30, y: 0, zoom: 1 });
    expect(session.finish()).toEqual({ x: 30, y: 0, zoom: 1 });
    expect(session.finish()).toBeNull();
  });

  it("回到起始值 → 无净变化不提交", () => {
    const session = new ViewportGestureSession();
    session.begin({ x: 0, y: 0, zoom: 1 });
    session.update({ x: 10, y: 10, zoom: 1.2 });
    session.update({ x: 0, y: 0, zoom: 1 });
    expect(session.finish()).toBeNull();
  });

  it("cancel 丢弃预览且不提交", () => {
    const session = new ViewportGestureSession();
    session.begin({ x: 0, y: 0, zoom: 1 });
    session.update({ x: 100, y: 0, zoom: 1 });
    session.cancel();
    expect(session.active).toBe(false);
    expect(session.finish()).toBeNull();
  });

  it("viewportsEqual 对浮点容差", () => {
    expect(viewportsEqual({ x: 0, y: 0, zoom: 1 }, { x: 1e-12, y: 0, zoom: 1 })).toBe(true);
  });
});
