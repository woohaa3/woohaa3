// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { CanvasRuntimeHost } from "./host.js";
import { hoverNodeStore } from "../../services/hover-store.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { canvasWith, getSession, installSharedSession, runtimeCapturing } from "../canvas-shell/test-support/controller-harness.js";
import { sceneDiagnostics, resetSceneDiagnostics } from "./scene-diagnostics.js";

installSharedSession();
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); nodeSelectionStore.reset(); hoverNodeStore.reset(); });

it("连续滚动只提交视口；重复停止播放不触发 full，停止滚动后重新查询固定指针", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  const callbacks = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { callbacks.set(++sequence, cb); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  const advance = () => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(cb => cb(0)); };
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n", x: 0, y: 0 }]));
  const { runtime, scenes, viewports } = runtimeCapturing();
  runtime.dispose = vi.fn();
  const host = new CanvasRuntimeHost({ canvasId: "c1", loadRuntime: async () => runtime,
    getSession: () => getSession() as never, subscribeModelScenes: () => () => {},
    isModalActive: () => false, emit: () => {} });
  await host.load();
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 800 }) as DOMRect;
  document.body.append(canvas);
  host.attach(canvas); advance();
  // 播放插件在资格撤销时会再次发布 null。这里走真实宿主与交互控制器。
  const unsubscribe = hoverNodeStore.subscribe(() => host.setAnimationPlayback(null));
  try {
    canvas.dispatchEvent(new MouseEvent("pointermove", { clientX: 900, clientY: 700 }));
    advance();
    const query = vi.spyOn(runtime, "queryPoint");
    const fullBefore = scenes.length;
    resetSceneDiagnostics();
    for (let i = 0; i < 30; i++) {
      canvas.dispatchEvent(new WheelEvent("wheel", { clientX: 900, clientY: 700, deltaX: 4, deltaY: 2 }));
      advance();
    }
    expect(viewports).toHaveLength(30);
    expect(scenes).toHaveLength(fullBefore);
    expect(sceneDiagnostics.sceneBuilds).toBe(0);
    expect(query).not.toHaveBeenCalled();
    expect(hoverNodeStore.getPlaybackSnapshot().blocked).toBe(true);
    vi.advanceTimersByTime(120); advance();
    expect(query).toHaveBeenCalledOnce();
    expect(hoverNodeStore.getPlaybackSnapshot().blocked).toBe(false);
    expect(host.controller()?.viewport()).toMatchObject({ x: -120, y: -60 });
  } finally { unsubscribe(); host.dispose(); canvas.remove(); }
});

it("聚焦有效性使用轻量查询，显式宿主目标覆盖优先", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  const callbacks = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { callbacks.set(++sequence, cb); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  const advance = () => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(cb => cb(0)); };
  const { modelCanvas, targetFor } = await import("../canvas-shell/test-support/model-focus-harness.js");
  const state = modelCanvas();
  const target = targetFor(state);
  woohaa3CanvasStore.getState().applyRemoteCanvas(state);
  const { runtime } = runtimeCapturing();
  runtime.dispose = vi.fn();
  const available = vi.fn(() => true);
  const host = new CanvasRuntimeHost({ canvasId: "c1", loadRuntime: async () => runtime,
    getSession: () => getSession() as never, subscribeModelScenes: () => () => {},
    getModelFocusTargets: () => [target], hasModelFocusTarget: available,
    isModalActive: () => false, emit: () => {} });
  await host.load();
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 800 }) as DOMRect;
  document.body.append(canvas);
  try {
    host.attach(canvas); advance();
    expect(host.controller()?.enterModelFocusForNode(target.nodeId)).toBe(true);
    advance();
    expect(available).toHaveBeenCalledWith(target.nodeId);
    host.setModelFocusTargets([target]);
    available.mockClear();
    advance();
    expect(available).not.toHaveBeenCalled();
  } finally { host.dispose(); canvas.remove(); }
});
