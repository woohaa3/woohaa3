/**
 * 统一失效调度与单帧提交（change: 2026-10-10-optimize-canvas-interaction-hot-path，design D2）。
 *
 * 核心不变式：
 * - 一帧内多个失效来源（Store/输入/主题/媒体/模型）只合并成一次 full build + 一次 set_scene；
 * - 无净变化（fingerprint 相同）时不再提交，只计 dedupe；
 * - 静止帧不构建、不提交；
 * - 提交失败保留最近合法画面，下一帧以最新状态重试；
 * - dispose 后迟到通知不构建、不提交。
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { MODEL_FOCUS_VERSION } from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { resetSceneDiagnostics, sceneDiagnostics } from "../canvas-runtime/scene-diagnostics.js";
import { installInteractionController } from "./interaction-controller.js";
import { shouldRouteObserverOnly } from "./interaction-frame-plan.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing } from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => { nodeSelectionStore.reset(); resetSceneDiagnostics(); });

/** 可手动推进的 rAF 时钟（无 rAF 时控制器会同步推进，无法观察同帧合并）。 */
function frameClock() {
  const dom = harness();
  const callbacks: Array<(t: number) => void> = [];
  (dom.target as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) => {
    callbacks.push(cb);
    return callbacks.length;
  };
  (dom.target as Record<string, unknown>).cancelAnimationFrame = () => undefined;
  (dom.target as Record<string, unknown>).performance = { now: () => 0 };
  const advance = () => {
    const pending = callbacks.splice(0, callbacks.length);
    for (const cb of pending) cb(0);
  };
  return { dom, advance };
}

function setup(
  textureSync?: Parameters<typeof installInteractionController>[0]["textureSync"],
  onSceneSubmitted?: () => void,
  onFrame?: () => void
) {
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
  const { dom, advance } = frameClock();
  const { runtime, scenes, viewports, failNextSetScene, failNextSetViewport } = runtimeCapturing();
  const controller = installInteractionController({
    canvas: dom.canvas,
    getRuntime: () => runtime,
    getSession: () => getSession() as never,
    target: dom.target as never,
    textureSync,
    onSceneSubmitted,
    onFrame
  });
  return { dom, advance, scenes, viewports, runtime, controller, failNextSetScene, failNextSetViewport };
}

describe("纯视口增量路由（design D3）", () => {
  it("每个画布刷新帧都通知瞬时 overlay，即使场景没有失效", () => {
    const onFrame = vi.fn();
    const { controller, advance } = setup(undefined, undefined, onFrame);
    controller.flush();
    expect(onFrame).toHaveBeenCalledTimes(1);
    advance();
    advance();
    expect(onFrame).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  it("首次构建中的范围查询不递归提交未完成的场景", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const { dom, advance } = frameClock();
    const { runtime, scenes } = runtimeCapturing();
    let builds = 0;
    const controller = installInteractionController({
      canvas: dom.canvas, getRuntime: () => runtime, getSession: () => getSession() as never,
      target: dom.target as never,
      getNodeActionToolbars: () => {
        builds++;
        if (builds > 3) throw new Error("recursive scene build");
        controller.queryCompositeAssetScopes();
        return new Map();
      }
    });
    try {
      controller.flush();
      expect(builds).toBe(1);
      expect(scenes).toHaveLength(1);
      expect(controller.renderError()).toBeNull();
      advance();
      expect(builds).toBeLessThanOrEqual(2);
      expect(scenes).toHaveLength(1);
    } finally { controller.dispose(); }
  });

  it("范围观察者只在成功提交后收到通知，静止、去重、失败和卸载不伪造变化", () => {
    const changed = vi.fn();
    const { controller, advance, dom, failNextSetScene } = setup(undefined, changed);
    controller.flush();
    expect(changed).toHaveBeenCalledOnce();
    controller.flush(); advance();
    expect(changed).toHaveBeenCalledOnce();
    dom.fire("wheel", { deltaX: 6, deltaY: 2, deltaMode: 0, clientX: 900, clientY: 700, timeStamp: 1 });
    advance();
    expect(changed).toHaveBeenCalledTimes(2);
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 50, y: 0 }]));
    failNextSetScene("boom"); controller.invalidate("input"); advance();
    expect(changed).toHaveBeenCalledTimes(2);
    advance();
    expect(changed).toHaveBeenCalledTimes(3);
    controller.dispose(); controller.invalidate("late"); advance();
    expect(changed).toHaveBeenCalledTimes(3);
  });
  it("滚轮后未到下一 rAF 就点击时，native 查询前先排入最新视口", () => {
    const { dom, runtime, controller } = setup(); controller.flush();
    const calls: string[] = [];
    runtime.queueViewport = input => { calls.push(`viewport:${input.viewport.x}`); };
    const query = runtime.queryPoint!;
    runtime.queryPoint = vi.fn<NonNullable<typeof runtime.queryPoint>>(input => { calls.push("query"); return query(input); });
    dom.fire("wheel", { deltaX: 6, deltaY: 2, deltaMode: 0, clientX: 900, clientY: 700, timeStamp: 1 });
    expect(calls).toEqual([]);
    dom.fire("pointerdown", { clientX: 900, clientY: 700, button: 0 });
    expect(calls.slice(0, 2)).toEqual(["viewport:-6", "query"]);
    controller.dispose();
  });
  it("点击清除悬停与导航同帧时，查询前的 full 也包含最新视口", () => {
    const { dom, runtime, controller, scenes } = setup(); controller.flush();
    dom.fire("pointermove", { clientX: 100, clientY: 100 }); controller.flush();
    runtime.queueViewport = () => {};
    const query = runtime.queryPoint!;
    runtime.queryPoint = vi.fn<NonNullable<typeof runtime.queryPoint>>(input => {
      expect(scenes.at(-1)?.viewport).toMatchObject({ x: -6, y: -2 });
      return query(input);
    });
    dom.fire("wheel", { deltaX: 6, deltaY: 2, deltaMode: 0, clientX: 900, clientY: 700, timeStamp: 1 });
    dom.fire("pointerdown", { clientX: 900, clientY: 700, button: 0 });
    controller.dispose();
  });
  it("仅 pan/zoom 走固定大小 set_viewport，不重建/序列化完整场景", () => {
    const { dom, advance, scenes, viewports, controller } = setup();
    // 引导帧建立合法 full 基线（base 身份）。
    controller.flush();
    resetSceneDiagnostics();
    const fullBuilds = scenes.length;

    // 中键平移（纯 viewport 预览）→ 本帧失效只有 viewport。
    dom.fire("pointerdown", { button: 1, clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 160, clientY: 100 });
    advance();

    expect(sceneDiagnostics.viewportSubmits).toBe(1);
    expect(sceneDiagnostics.sceneBuilds).toBe(0);
    expect(sceneDiagnostics.sceneSubmits).toBe(0);
    expect(scenes.length).toBe(fullBuilds);
    expect(viewports.at(-1)?.viewport).toMatchObject({ x: 60, y: 0, zoom: 1 });
    controller.dispose();
  });

  it("滚轮缩放走视口增量且复用同一 full 基线", () => {
    const { dom, advance, viewports, controller } = setup();
    controller.flush();
    resetSceneDiagnostics();
    dom.fire("wheel", { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, clientX: 200, clientY: 200, timeStamp: 1 });
    advance();
    expect(sceneDiagnostics.viewportSubmits).toBe(1);
    expect(sceneDiagnostics.sceneBuilds).toBe(0);
    // base 身份始终是引导帧的 full generation。
    expect(viewports.at(-1)?.base).toBe(1);
    controller.dispose();
  });

  it("结构变化与视口同帧只发 full，不发 viewport", () => {
    const { dom, advance, scenes, controller } = setup();
    controller.flush();
    resetSceneDiagnostics();
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }, { id: "n2", x: 300, y: 0 }]));
    dom.fire("pointerdown", { button: 1, clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 160, clientY: 100 });
    // 结构变化经 Store 订阅进入同一失效账本（生产由 host 订阅触发）。
    controller.invalidate("canvas-store");
    advance();
    expect(sceneDiagnostics.viewportSubmits).toBe(0);
    expect(sceneDiagnostics.sceneBuilds).toBe(1);
    expect(sceneDiagnostics.sceneSubmits).toBe(1);
    const last = scenes.at(-1) as { viewport: { x: number }; nodes: unknown[] };
    expect(last.viewport.x).toBe(60);
    expect(last.nodes).toHaveLength(2);
    controller.dispose();
  });

  it("增量被拒绝时下一帧用最新 full 恢复（旧 base 协议错误恢复）", () => {
    const { dom, advance, scenes, controller, failNextSetViewport } = setup();
    controller.flush();
    resetSceneDiagnostics();
    const fullBuilds = scenes.length;
    // 视口增量被 Rust 原子拒绝（如旧 base）：不污染合法画面，记录 renderError。
    failNextSetViewport("stale-base");
    dom.fire("pointerdown", { button: 1, clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 160, clientY: 100 });
    advance();
    expect(sceneDiagnostics.viewportSubmits).toBe(1);
    expect(sceneDiagnostics.sceneSubmits).toBe(0);
    expect(controller.renderError()).toBe("stale-base");
    // 拒绝后 sceneInvalidated 保留：下一帧用最新 full 恢复（design D3）。
    advance();
    expect(sceneDiagnostics.sceneSubmits).toBe(1);
    expect(scenes.length).toBe(fullBuilds + 1);
    expect(controller.renderError()).toBeNull();
    controller.dispose();
  });
});

describe("统一失效账本（design D2）", () => {
  it("聚焦纹理上传失败后帧循环继续，返回后仍能平移画布", () => {
    let invalidFocusTexture = false;
    const { dom, advance, controller, scenes, viewports } = setup({
      sync: () => { if (invalidFocusTexture) throw "Invalid texture"; },
      textureNodeIds: () => new Set(),
      dispose: () => undefined
    });
    controller.flush();
    invalidFocusTexture = true;
    expect(() => advance()).not.toThrow();
    // 失败的纹理步骤已隔离，当前场景仍能成功提交。
    expect(controller.renderError()).toBeNull();
    expect(scenes.length).toBeGreaterThan(0);
    invalidFocusTexture = false;
    advance();
    dom.fire("pointerdown", { button: 1, clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 160, clientY: 100 });
    advance();
    expect(viewports.at(-1)?.viewport).toMatchObject({ x: 60, y: 0 });
    controller.dispose();
  });

  it("同帧多源通知只构建一次并提交一次完整场景", () => {
    const { dom, advance, controller } = setup();
    // 先结算引导帧，建立合法画面。
    controller.flush();
    resetSceneDiagnostics();

    // 一个帧周期内多个来源（输入/Store/主题/媒体）连续失效。
    dom.fire("pointermove", { clientX: 120, clientY: 90 });
    controller.invalidate("canvas-store");
    controller.invalidate("theme");
    controller.invalidate("film-set-media");
    controller.invalidate("model-scenes");
    // rAF 尚未结算：不构建、不提交。
    expect(sceneDiagnostics.sceneBuilds).toBe(0);
    expect(sceneDiagnostics.sceneSubmits).toBe(0);

    advance();
    expect(sceneDiagnostics.sceneBuilds).toBe(1);
    expect(sceneDiagnostics.sceneSubmits).toBe(1);

    // 再过一帧无新失效（且净无变化）→ 不再构建/提交。
    advance();
    expect(sceneDiagnostics.sceneBuilds).toBe(1);
    expect(sceneDiagnostics.sceneSubmits).toBe(1);
    controller.dispose();
  });

  it("同帧结构变化 + viewport 预览只提交一份包含最终状态的完整场景", () => {
    const { dom, advance, scenes, controller } = setup();
    controller.flush();
    resetSceneDiagnostics();
    // 中键平移（viewport 预览）与远端 selection 变化在同帧到达。
    dom.fire("pointerdown", { button: 1, clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 160, clientY: 100 });
    controller.invalidate("canvas-store");
    advance();
    expect(sceneDiagnostics.sceneBuilds).toBe(1);
    expect(sceneDiagnostics.sceneSubmits).toBe(1);
    const last = scenes.at(-1) as { viewport: { x: number; y: number } };
    expect(last.viewport.x).toBe(60);
    controller.dispose();
  });

  it("净无变化时不提交，只计 dedupe", () => {
    const { controller } = setup();
    controller.flush();
    resetSceneDiagnostics();
    // 强制一次相同的完整构建：fingerprint 未变 → dedupe，不提交。
    controller.flush();
    expect(sceneDiagnostics.sceneBuilds).toBe(1);
    expect(sceneDiagnostics.sceneSubmits).toBe(0);
    expect(sceneDiagnostics.sceneDedupes).toBe(1);
    controller.dispose();
  });

  it("静态画布不因持续帧推进而构建或提交", () => {
    const { advance, controller } = setup();
    controller.flush();
    resetSceneDiagnostics();
    for (let i = 0; i < 5; i += 1) advance();
    expect(sceneDiagnostics.sceneBuilds).toBe(0);
    expect(sceneDiagnostics.sceneSubmits).toBe(0);
    controller.dispose();
  });

  it("提交失败保留最近合法画面并在下一帧用最新状态重试", () => {
    const { advance, controller, failNextSetScene } = setup();
    controller.flush();
    resetSceneDiagnostics();

    // 一次真实净变化（远端位置更新）叠加提交失败。
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 50, y: 0 }]));
    failNextSetScene("boom");
    controller.invalidate("input");
    advance();
    // 失败帧：尝试提交但不记成功 fingerprint；renderError 上报。
    expect(sceneDiagnostics.sceneSubmits).toBe(1);
    expect(controller.renderError()).toBe("boom");

    // 下一帧无需新的外部失效即可重试（sceneInvalidated 保留）。
    advance();
    expect(sceneDiagnostics.sceneSubmits).toBe(2);
    expect(controller.renderError()).toBeNull();
    controller.dispose();
  });

  it("dispose 后迟到通知不构建、不提交", () => {
    const { advance, controller } = setup();
    controller.flush();
    resetSceneDiagnostics();
    controller.dispose();
    controller.invalidate("late");
    advance();
    expect(sceneDiagnostics.sceneBuilds).toBe(0);
    expect(sceneDiagnostics.sceneSubmits).toBe(0);
  });
});

describe("聚焦观察镜头增量", () => {
  function focused() {
    const focus = {
      version: MODEL_FOCUS_VERSION,
      nodeId: "n1",
      target: [0, 0, 0] as [number, number, number],
      yaw: 0.2, pitch: -0.1, distance: 4, fov: 0.8, radius: 1
    };
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const { dom, advance } = frameClock();
    const captured = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => captured.runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      getModelFocus: () => focus
    });
    return { advance, controller, captured, focus };
  }

  it("只允许 focus-active / baseline-focus 的朝向失效走 observer", () => {
    expect(shouldRouteObserverOnly(new Set(["model-focus"]), false, "focus-active", true)).toBe(true);
    expect(shouldRouteObserverOnly(new Set(["model-preview", "model-focus"]), false, "baseline-focus", true)).toBe(true);
    expect(shouldRouteObserverOnly(new Set(["model-focus", "model-editor"]), false, "baseline-focus", true)).toBe(false);
    expect(shouldRouteObserverOnly(new Set(["model-focus", "model-editor"]), false, "baseline-focus", true, true)).toBe(true);
    expect(shouldRouteObserverOnly(new Set(["model-focus", "theme"]), false, "focus-active", true)).toBe(false);
    expect(shouldRouteObserverOnly(new Set(["model-focus"]), false, "focus-active", false)).toBe(false);
    expect(shouldRouteObserverOnly(new Set(["model-focus"]), true, "focus-active", true)).toBe(false);
  });

  it("已聚焦且只改朝向时走 set_observer，不重建完整场景", () => {
    const { advance, controller, captured, focus } = focused();
    controller.flush();
    resetSceneDiagnostics();
    const fullBuilds = captured.scenes.length;
    focus.yaw += 0.3;
    controller.invalidate("model-focus");
    advance();
    expect(sceneDiagnostics.observerSubmits).toBe(1);
    expect(sceneDiagnostics.sceneBuilds).toBe(0);
    expect(sceneDiagnostics.sceneSubmits).toBe(0);
    expect(captured.scenes.length).toBe(fullBuilds);
    expect(captured.observers.at(-1)).toMatchObject({ nodeId: "n1", yaw: focus.yaw });
    controller.dispose();
  });

  it("缺少 setObserver 时聚焦朝向回退完整场景", () => {
    const { advance, controller, captured, focus } = focused();
    controller.flush();
    delete captured.runtime.setObserver;
    resetSceneDiagnostics();
    focus.yaw += 0.2;
    controller.invalidate("model-focus");
    advance();
    expect(sceneDiagnostics.observerSubmits).toBe(0);
    expect(sceneDiagnostics.sceneSubmits).toBe(1);
    controller.dispose();
  });

  it("主题与朝向同帧仍走完整场景", () => {
    const { advance, controller, captured, focus } = focused();
    controller.flush();
    resetSceneDiagnostics();
    focus.yaw += 0.2;
    controller.invalidate("theme");
    controller.invalidate("model-focus");
    advance();
    expect(sceneDiagnostics.observerSubmits).toBe(0);
    expect(sceneDiagnostics.sceneSubmits).toBe(1);
    expect(captured.observers).toHaveLength(0);
    expect(sceneDiagnostics.lastSubmitRoute).toBe("full");
    expect(sceneDiagnostics.lastDirtyReasons).toEqual(expect.arrayContaining(["theme", "model-focus"]));
    controller.dispose();
  });

  it("gizmo 未变的 model-editor 失效仍走 observer", () => {
    const { advance, controller, captured, focus } = focused();
    controller.flush();
    resetSceneDiagnostics();
    focus.yaw += 0.3;
    controller.invalidate("model-focus");
    controller.invalidate("model-editor");
    advance();
    expect(sceneDiagnostics.observerSubmits).toBe(1);
    expect(sceneDiagnostics.sceneSubmits).toBe(0);
    expect(sceneDiagnostics.lastSubmitRoute).toBe("observer");
    expect(captured.observers.at(-1)).toMatchObject({ nodeId: "n1", yaw: focus.yaw });
    controller.dispose();
  });
});

describe("图片资源状态增量", () => {
  it("图片完成与缩放同帧分别提交增量，保留基线且不构建指纹", () => {
    let rows = [{id: "n1", texture: true, mediaLoading: false}];
    const uploader = { sync() {}, textureNodeIds: () => new Set<string>(), dispose() {},
      resourceStateChanges: () => rows, acknowledgeResourceStates: vi.fn(() => { rows = []; }) };
    const { runtime, controller, advance, scenes, viewports, dom } = setup(uploader);
    const setResourceStates = vi.fn(() => runtime.interactionGeneration!());
    Object.assign(runtime, { setResourceStates });
    controller.flush();
    rows = [{id: "n1", texture: true, mediaLoading: false}];
    const builds = sceneDiagnostics.fingerprintBuilds;
    dom.fire("wheel", {deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, clientX: 100, clientY: 100, timeStamp: 1});
    controller.invalidate("image-resources");
    advance();
    expect(setResourceStates).toHaveBeenCalledTimes(1);
    expect(viewports).toHaveLength(1);
    expect(viewports[0]?.base).toBe(1);
    expect(scenes).toHaveLength(1);
    expect(sceneDiagnostics.fingerprintBuilds).toBe(builds);
    expect(rows).toHaveLength(0);
    controller.dispose();
  });

  it("只提交变化节点，不构建/指纹/提交完整场景；混合变更仍走 full", () => {
    let rows: import("@woohaa3/contracts").CanvasNodeResourceState[] = [];
    const uploader = { sync() {}, textureNodeIds: () => new Set<string>(), dispose() {},
      resourceStateChanges: () => rows, acknowledgeResourceStates: vi.fn(() => { rows = []; }) };
    const { runtime, controller, advance, scenes } = setup(uploader);
    const setResourceStates = vi.fn(() => runtime.interactionGeneration!());
    Object.assign(runtime, { setResourceStates });
    controller.flush();
    const builds = sceneDiagnostics.fingerprintBuilds;
    rows = [{id: "n1", texture: true, mediaLoading: true}];
    controller.invalidate("image-resources"); advance();
    expect(setResourceStates).toHaveBeenCalledWith({baseSceneGeneration: runtime.baseSceneGeneration!(), nodes: [{id: "n1", texture: true, mediaLoading: true}]});
    expect(sceneDiagnostics.fingerprintBuilds).toBe(builds);
    expect(scenes).toHaveLength(1);
    rows = [{id: "n1", texture: true, mediaLoading: false}];
    controller.invalidate("image-resources"); advance();
    expect(setResourceStates).toHaveBeenCalledTimes(2);
    controller.invalidate("image-resources"); controller.invalidate("theme"); advance();
    expect(sceneDiagnostics.fingerprintBuilds).toBeGreaterThan(builds);
    controller.dispose();
  });
  it("资源增量拒绝后重建完整基线，不吞掉待应用状态", () => {
    let pending = false;
    const uploader = { sync() {}, textureNodeIds: () => new Set<string>(), dispose() {},
      resourceStateChanges: () => pending ? [{id:"n1",texture:true,mediaLoading:false}] : [],
      acknowledgeResourceStates: () => { pending = false; } };
    const {runtime, controller, advance, scenes} = setup(uploader);
    Object.assign(runtime, {setResourceStates: () => { throw new Error("stale-base"); }});
    controller.flush(); pending = true;
    controller.invalidate("image-resources"); advance();
    expect(pending).toBe(true);
    advance();
    expect(scenes).toHaveLength(2);
    expect(pending).toBe(false);
    controller.dispose();
  });
});
