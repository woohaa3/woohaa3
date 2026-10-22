/**
 * 视口平移过渡（change: 2026-10-09-improve-canvas-workflow，任务 4.1）。
 *
 * `panViewportTo` 应保持传入缩放、用过渡动画把目标居中；尊重减少动态效果偏好。
 * 用可手动推进的 rAF/performance 桩驱动确定性帧。
 */
import { describe, expect, it, afterEach } from "vitest";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { installInteractionController } from "./interaction-controller.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing } from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => nodeSelectionStore.reset());

/** 可手动推进的 rAF 时钟。 */
function clockHarness(reducedMotion = false) {
  const dom = harness();
  let now = 0;
  const callbacks: Array<(t: number) => void> = [];
  (dom.target as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) => {
    callbacks.push(cb);
    return callbacks.length;
  };
  (dom.target as Record<string, unknown>).cancelAnimationFrame = () => undefined;
  (dom.target as Record<string, unknown>).performance = { now: () => now };
  (dom.target as Record<string, unknown>).matchMedia = () => ({ matches: reducedMotion });
  const advance = (ms: number) => {
    now += ms;
    const pending = callbacks.splice(0, callbacks.length);
    for (const cb of pending) cb(now);
  };
  return { dom, advance };
}

describe("panViewportTo 过渡动画", () => {
  it("保持传入缩放，逐帧插值到目标", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const { dom, advance } = clockHarness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      viewportTransitionMs: 300
    });
    controller.restoreViewport({ x: 0, y: 0, zoom: 2 });
    // 起始缩放 2；目标保持 zoom=2，平移到 x=-100。
    controller.panViewportTo({ x: -100, y: -50, zoom: 2 });
    // 初始帧尚未推进：仍是起点。
    expect(controller.viewport().zoom).toBe(2);
    advance(150);
    const mid = controller.viewport();
    expect(mid.zoom).toBe(2);
    expect(mid.x).toBeGreaterThan(-100);
    expect(mid.x).toBeLessThan(0);
    advance(150);
    expect(controller.viewport()).toEqual({ x: -100, y: -50, zoom: 2 });
    controller.dispose();
  });

  it("减少动态效果偏好时瞬时跳转", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const { dom } = clockHarness(true);
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      viewportTransitionMs: 300
    });
    controller.panViewportTo({ x: -100, y: -50, zoom: 1.5 });
    expect(controller.viewport()).toEqual({ x: -100, y: -50, zoom: 1.5 });
    controller.dispose();
  });

  it("duration 为 0 时瞬时", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const { dom } = clockHarness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    controller.panViewportTo({ x: 10, y: 20, zoom: 1 }, { durationMs: 0 });
    expect(controller.viewport()).toEqual({ x: 10, y: 20, zoom: 1 });
    controller.dispose();
  });

  it("用户手动改视口会中断动画", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const { dom, advance } = clockHarness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      viewportTransitionMs: 300
    });
    controller.panViewportTo({ x: -1000, y: 0, zoom: 1 });
    advance(100);
    // 用户手动干预。
    controller.restoreViewport({ x: 0, y: 0, zoom: 1 });
    advance(300);
    // 动画应让位，视口保持在用户设定值。
    expect(controller.viewport()).toEqual({ x: 0, y: 0, zoom: 1 });
    controller.dispose();
  });
});
