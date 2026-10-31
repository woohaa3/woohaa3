/**
 * 交互控制器：模型聚焦相机与失效测试
 * （由 interaction-controller.test.ts 机械拆分，断言不变）。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { FOCUS_ZOOM_OUT_RADIUS_MULTIPLIER, MODEL_FOCUS_FOV } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { isDomConsumingInputTarget } from "./input/shortcuts.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { CanvasNavigationStore } from "../../navigation/store.js";
import type { BevyModelEditor } from "@woohaa3/contracts";
import {
  canvasWith, domFire, getSession, harness, installSharedSession, runtimeCapturing
} from "./test-support/controller-harness.js";
import { focusHarness, modelCanvas, modelCenter, modelPickForTargets, targetFor } from "./test-support/model-focus-harness.js";

installSharedSession();

describe("聚焦滚轮事件目标分类（change: fix-model-focus-navigation-and-camera-parity）", () => {
  it("input/select/textarea 与可滚动容器由 DOM 消费；canvas 与 viewfinder 归聚焦相机", () => {
    const input = document.createElement("input");
    expect(isDomConsumingInputTarget(input)).toBe(true);
    const select = document.createElement("select");
    expect(isDomConsumingInputTarget(select)).toBe(true);
    const textarea = document.createElement("textarea");
    expect(isDomConsumingInputTarget(textarea)).toBe(true);

    const scrollable = document.createElement("div");
    scrollable.setAttribute("data-canvas-scrollable", "true");
    expect(isDomConsumingInputTarget(scrollable)).toBe(true);

    const historyDrawer = document.createElement("div");
    historyDrawer.className = "node-history";
    expect(isDomConsumingInputTarget(historyDrawer)).toBe(true);

    const viewfinder = document.createElement("div");
    viewfinder.setAttribute("data-focus-canvas-chrome", "true");
    expect(isDomConsumingInputTarget(viewfinder)).toBe(false);

    // 不可滚动普通元素：仍由聚焦相机消费。
    const plain = document.createElement("div");
    expect(isDomConsumingInputTarget(plain)).toBe(false);
  });

  it("聚焦时 history drawer 上的 wheel 不改变主观察相机", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    const distanceBefore = h.controller.focusProjection()!.distance;
    const drawer = document.createElement("div");
    drawer.className = "node-history";
    h.dom.fire("wheel", {
      deltaX: 0,
      deltaY: -200,
      deltaMode: 0,
      ctrlKey: false,
      metaKey: false,
      clientX: 500,
      clientY: 300,
      buttons: 0,
      target: drawer
    });
    expect(h.controller.focusProjection()!.distance).toBe(distanceBefore);
    h.controller.dispose();
  });
});

const shotEditor: BevyModelEditor = {
  version: "woohaa-model-editor-v2",
  nodeId: "m1",
  toolMode: "camera",
  cameraId: "cam",
  focus: [0, 0, 0],
  radius: 1,
  shot: {
    position: [0, 1, 1],
    focus: [0, 0, 0],
    fov: MODEL_FOCUS_FOV,
    azimuth: 0,
    elevation: Math.PI / 4,
    distance: 4,
    aspect: "16:9"
  }
};

describe("选中镜头时观察相机与 rig 输入分离", () => {
  it("滚轮只缩放观察相机，不调用镜头 distance", () => {
    const wheels: number[] = [];
    const h = focusHarness({
      getModelEditor: () => shotEditor,
      shotWheel: {
        wheel: (deltaY) => { wheels.push(deltaY); },
        scaleBegin() {},
        scale() {},
        scaleEnd() {}
      }
    });
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    const before = h.controller.focusProjection()!.distance;
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: -200, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 500, clientY: 300, buttons: 0 });
    expect(h.controller.focusProjection()!.distance).toBeLessThan(before);
    expect(wheels).toEqual([]);
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: 10000, deltaMode: 0, clientX: 500, clientY: 300, buttons: 0 });
    const limit = h.controller.focusProjection()!;
    expect(limit.distance).toBeCloseTo(limit.radius * FOCUS_ZOOM_OUT_RADIUS_MULTIPLIER);
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: 1000, deltaMode: 0, clientX: 500, clientY: 300, buttons: 0 });
    expect(h.controller.focusProjection()!.distance).toBe(limit.distance);
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: -200, deltaMode: 0, clientX: 500, clientY: 300, buttons: 0 });
    expect(h.controller.focusProjection()!.distance).toBeLessThan(limit.distance);
    expect(wheels).toEqual([]);
    h.controller.dispose();
  });

  it("没有 shot 时滚轮仍缩放聚焦相机", () => {
    const h = focusHarness({
      getModelEditor: () => ({ ...shotEditor, shot: undefined, cameraId: undefined })
    });
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    const before = h.controller.focusProjection()!.distance;
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: -200, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 500, clientY: 300, buttons: 0 });
    expect(h.controller.focusProjection()!.distance).toBeLessThan(before);
    h.controller.dispose();
  });

  it("右键旋转、中键平移观察相机，不编辑 rig", () => {
    const handles: string[] = [];
    const h = focusHarness({
      getModelEditor: () => shotEditor,
      shotGesture: {
        begin: (handle) => {
          handles.push(handle);
          return true;
        },
        move() {},
        end() {},
        cancel() {}
      }
    });
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    const before = h.controller.focusProjection()!;
    domFire(h.dom, "pointerdown", { button: 2, clientX: 400, clientY: 300 });
    domFire(h.dom, "pointermove", { clientX: 460, clientY: 320 });
    domFire(h.dom, "pointerup", { button: 2, clientX: 460, clientY: 320 });
    domFire(h.dom, "pointerdown", { button: 1, clientX: 400, clientY: 300 });
    domFire(h.dom, "pointermove", { clientX: 430, clientY: 340 });
    domFire(h.dom, "pointerup", { button: 1, clientX: 430, clientY: 340 });
    const after = h.controller.focusProjection()!;
    expect(handles).toEqual([]);
    expect(after.yaw).not.toBe(before.yaw);
    expect(after.pitch).not.toBe(before.pitch);
    expect(after.target).not.toEqual(before.target);
    h.controller.dispose();
  });

  it("右键按住时 pointerleave 不取消观察相机旋转", () => {
    const calls: string[] = [];
    const h = focusHarness({
      getModelEditor: () => shotEditor,
      shotGesture: {
        begin: () => {
          calls.push("begin");
          return true;
        },
        move: () => {
          calls.push("move");
        },
        end: () => {
          calls.push("end");
        },
        cancel: () => {
          calls.push("cancel");
        }
      }
    });
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    const before = h.controller.focusProjection()!;
    domFire(h.dom, "pointerdown", { button: 2, buttons: 2, clientX: 400, clientY: 300 });
    domFire(h.dom, "pointerleave", { buttons: 2, clientX: 400, clientY: 300 });
    domFire(h.dom, "pointermove", { buttons: 2, clientX: 520, clientY: 300 });
    domFire(h.dom, "pointerup", { button: 2, buttons: 0, clientX: 520, clientY: 300 });
    expect(calls).toEqual([]);
    expect(h.controller.focusProjection()!.yaw).not.toBe(before.yaw);
    h.controller.dispose();
  });
});

describe("模型聚焦相机与失效（change: add-model-focus-viewing）", () => {
  function connectNavigation(h: ReturnType<typeof focusHarness>, isTargetValid: () => boolean = () => true) {
    const navigation = new CanvasNavigationStore();
    navigation.setFocusAdapter({
      apply: (target) => {
        if (!target || !("nodeId" in target)) {
          h.controller.exitModelFocus();
          return { ok: true };
        }
        return h.controller.enterModelFocusForNode(target.nodeId)
          ? { ok: true }
          : { ok: false, reason: "invalid-focus-target" };
      },
      isFocused: () => h.controller.isModelFocused(),
      isTargetValid: () => isTargetValid()
    });
    return navigation;
  }

  it("Escape 经宿主 Navigation 退出聚焦并恢复 overview", () => {
    let navigation: CanvasNavigationStore | null = null;
    const h = focusHarness({ onModelFocusIntent: (intent) => {
      if (intent.type === "exit") navigation?.exitNodeFocus();
    } });
    navigation = connectNavigation(h);
    expect(navigation.enterNodeFocus({ nodeId: "m1", kind: "extension" }).ok).toBe(true);
    expect(h.controller.isModelFocused()).toBe(true);

    domFire(h.dom, "keydown", { key: "Escape" });

    expect(navigation.getSnapshot().mode).toEqual({ type: "overview" });
    expect(h.controller.isModelFocused()).toBe(false);
    h.controller.dispose();
  });

  it("弹窗已消费的 Escape 不连带退出宿主聚焦", () => {
    let navigation: CanvasNavigationStore | null = null;
    const h = focusHarness({ onModelFocusIntent: (intent) => {
      if (intent.type === "exit") navigation?.exitNodeFocus();
    } });
    navigation = connectNavigation(h);
    expect(navigation.enterNodeFocus({ nodeId: "m1", kind: "extension" }).ok).toBe(true);

    domFire(h.dom, "keydown", { key: "Escape", defaultPrevented: true });

    expect(navigation.getSnapshot().mode.type).toBe("node-focus");
    expect(h.controller.isModelFocused()).toBe(true);
    h.controller.dispose();
  });

  it("聚焦时 RMB 路由到 freelook（改变 yaw）且不打开右键菜单", () => {
    let menuOpened = 0;
    const h = focusHarness({ onContextMenu: () => { menuOpened += 1; } });
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    const before = h.controller.focusProjection()!;
    domFire(h.dom, "pointerdown", { button: 2, clientX: 400, clientY: 300 });
    domFire(h.dom, "pointermove", { clientX: 460, clientY: 320 });
    domFire(h.dom, "pointerup", { button: 2, clientX: 460, clientY: 320 });
    const after = h.controller.focusProjection()!;
    expect(after.yaw).not.toBe(before.yaw);
    expect(menuOpened).toBe(0);
    h.controller.dispose();
  });

  it("聚焦时 Escape 退出并恢复进入前的 2D 视口", () => {
    const h = focusHarness();
    // 进入前把本地视口设成非默认值。
    h.controller.zoomTo(2);
    const saved = h.controller.viewport();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    expect(h.controller.isModelFocused()).toBe(true);

    domFire(h.dom, "keydown", { key: "Escape" });
    expect(h.controller.isModelFocused()).toBe(false);
    expect(h.controller.focusProjection()).toBeNull();
    expect(h.projections.at(-1)).toBeNull();
    expect(h.controller.viewport()).toEqual(saved);
    h.controller.dispose();
  });

  it("非模态 panel 打开时仍可在 focus canvas 滚轮/双击进入（design D6）", () => {
    // 模拟编辑器/历史 panel 打开：blocksCanvas 为 true，但 true modal 未打开。
    const panelGate = { blocked: true };
    const h = focusHarness({
      isModalActive: () => panelGate.blocked,
      isFocusInputBlocked: () => false
    });
    // 双击进入聚焦不受非模态 panel 阻断。
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    expect(h.controller.isModelFocused()).toBe(true);

    // 滚轮缩放主观察相机。
    const before = h.controller.focusProjection()!.distance;
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: -200, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 500, clientY: 300, buttons: 0 });
    expect(h.controller.focusProjection()!.distance).toBeLessThan(before);

    // 真正 modal 打开后阻断 focus 输入。
    panelGate.blocked = true;
    const guarded = focusHarness({ isModalActive: () => true, isFocusInputBlocked: () => true });
    domFire(guarded.dom, "wheel", { deltaX: 0, deltaY: -200, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 500, clientY: 300, buttons: 0 });
    expect(guarded.controller.isModelFocused()).toBe(false);
    h.controller.dispose();
    guarded.controller.dispose();
  });

  it("聚焦时滚轮不改变 2D 视口（改为 dolly）", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    const viewportBefore = h.controller.viewport();
    const distanceBefore = h.controller.focusProjection()!.distance;
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: -120, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 500, clientY: 300, buttons: 0 });
    expect(h.controller.viewport()).toEqual(viewportBefore);
    expect(h.controller.focusProjection()!.distance).toBeLessThan(distanceBefore);
    h.controller.dispose();
  });

  it("聚焦时 ctrl+wheel（捏合）连续缩放主观察相机且不改 2D 视口", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    const viewportBefore = h.controller.viewport();
    const distanceBefore = h.controller.focusProjection()!.distance;
    // 捏合放大：ctrlKey + 负 deltaY → 更近。
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: -200, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 500, clientY: 300, buttons: 0 });
    const afterZoom = h.controller.focusProjection()!.distance;
    expect(afterZoom).toBeLessThan(distanceBefore);
    expect(h.controller.viewport()).toEqual(viewportBefore);
    // 反向捏合推远。
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: 200, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 500, clientY: 300, buttons: 0 });
    expect(h.controller.focusProjection()!.distance).toBeGreaterThan(afterZoom);
    h.controller.dispose();
  });

  it("聚焦时 Safari GestureEvent 连续缩放主观察相机", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    const distanceBefore = h.controller.focusProjection()!.distance;
    // gesturestart 记录基准，gesturechange（scale > 1 放大）连续缩放。
    domFire(h.dom, "gesturestart", { scale: 1 });
    domFire(h.dom, "gesturechange", { scale: 2 });
    const afterZoom = h.controller.focusProjection()!.distance;
    expect(afterZoom).toBeLessThan(distanceBefore);
    domFire(h.dom, "gesturechange", { scale: 0.5 });
    expect(h.controller.focusProjection()!.distance).toBeGreaterThan(afterZoom);
    domFire(h.dom, "gestureend", {});
    h.controller.dispose();
  });

  it("非聚焦时 document 阶段滚轮不干预（放行给 2D 视口缩放）", () => {
    // 普通画布：ctrl+wheel 走既有视口缩放，不应被聚焦逻辑吞掉。
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    const before = controller.viewport().zoom;
    dom.fire("wheel", { deltaX: 0, deltaY: -120, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 500, clientY: 300 });
    expect(controller.viewport().zoom).not.toBe(before);
    controller.dispose();
  });

  it("聚焦时 editable 目标上的 Escape 不退出（DOM 优先）", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    expect(h.controller.isModelFocused()).toBe(true);
    // 事件目标是 input：Escape 留给编辑面。
    domFire(h.dom, "keydown", { key: "Escape", target: { tagName: "INPUT" } });
    expect(h.controller.isModelFocused()).toBe(true);
    h.controller.dispose();
  });

  it("聚焦时键盘飞行按帧推进，且 blur 清理 held", () => {
    // 自定义 target：手动驱动 rAF 回调，验证飞行与 blur 清理。
    const callbacks: Array<() => void> = [];
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const add = (type: string, handler: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    };
    const remove = (type: string, handler: (event: unknown) => void) => listeners.get(type)?.delete(handler);
    let clock = 1000;
    const target: Record<string, unknown> = {
      navigator: { platform: "Linux" },
      addEventListener: add,
      removeEventListener: remove,
      requestAnimationFrame: (callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      performance: { now: () => clock }
    };
    const canvas = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }),
      addEventListener: add,
      removeEventListener: remove,
      setPointerCapture: () => undefined,
      releasePointerCapture: () => undefined
    } as unknown as HTMLCanvasElement;
    const fire = (type: string, event: Record<string, unknown>) => {
      const payload = { preventDefault: () => undefined, pointerId: 1, button: 0, clientX: 0, clientY: 0, ...event };
      for (const handler of listeners.get(type) ?? []) handler(payload);
    };
    const canvasState = modelCanvas();
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasState as never);
    const { runtime } = runtimeCapturing({ modelPick: modelPickForTargets([targetFor(canvasState)], canvasState) });
    const controller = installInteractionController({
      canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: target as never,
      getModelFocusTargets: () => [targetFor(canvasState)]
    });
    const point = modelCenter(targetFor(canvasState));
    fire("dblclick", { clientX: point.x, clientY: point.y });
    expect(controller.isModelFocused()).toBe(true);
    const before = controller.focusProjection()!.target;

    // 按住 W，推进两帧（首帧建立时间基准，第二帧产生位移）。
    fire("keydown", { code: "KeyW", key: "w" });
    clock = 1016;
    callbacks.forEach((callback) => callback());
    clock = 1032;
    callbacks.splice(0).forEach((callback) => callback());
    expect(controller.focusProjection()!.target).not.toEqual(before);

    // blur 清理 held：再推帧不再移动。
    fire("blur", {});
    const afterBlur = controller.focusProjection()!.target;
    clock = 1048;
    callbacks.splice(0).forEach((callback) => callback());
    clock = 1064;
    callbacks.splice(0).forEach((callback) => callback());
    expect(controller.focusProjection()!.target).toEqual(afterBlur);
    controller.dispose();
  });

  it("聚焦时 modal 门禁优先：不进入聚焦", () => {
    const canvas = modelCanvas();
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    const dom = harness();
    const { runtime } = runtimeCapturing();
    let modal = true;
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      getModelFocusTargets: () => [targetFor(canvas)],
      isModalActive: () => modal
    });
    const point = modelCenter(targetFor(canvas));
    domFire(dom, "dblclick", { clientX: point.x, clientY: point.y });
    expect(controller.isModelFocused()).toBe(false);
    modal = false;
    controller.dispose();
  });

  it("目标从有效集合移除后 flush 上报失效（由 Navigation 收敛退出）", () => {
    let valid = true;
    const canvas = modelCanvas();
    const h = focusHarness({
      canvas,
      targets: () => (valid ? [targetFor(canvas)] : []),
      onModelFocusInvalid: () => {
        navigation.invalidateNodeFocus("focus-target-invalid");
      }
    });
    const navigation = connectNavigation(h, () => valid);
    h.controller.zoomTo(2);
    const saved = h.controller.viewport();
    expect(navigation.enterNodeFocus({ nodeId: "m1", kind: "extension" }).ok).toBe(true);
    expect(h.controller.isModelFocused()).toBe(true);

    valid = false;
    h.controller.flush();
    expect(navigation.getSnapshot().mode).toEqual({ type: "overview" });
    expect(h.controller.isModelFocused()).toBe(false);
    expect(h.controller.viewport()).toEqual(saved);
    expect(h.projections.at(-1)).toBeNull();
    h.controller.dispose();
  });
});

it("观察预设保持观察目标和距离，俯视从场景上方观察且不改保存镜头", () => {
  const h = focusHarness({ getModelEditor: () => shotEditor });
  const point = modelCenter(h.target);
  domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
  const before = h.controller.focusProjection()!;
  h.controller.setFocusedModelView("top");
  expect(h.controller.focusProjection()).toMatchObject({ target: before.target, distance: before.distance, yaw: 0 });
  expect(h.controller.focusProjection()!.pitch).toBeLessThan(-1.5);
  h.controller.setFocusedModelView("perspective");
  expect(h.controller.focusProjection()!.pitch).toBeLessThan(0);
  h.controller.setFocusedModelView("right");
  expect(h.controller.focusProjection()).toMatchObject({ yaw: Math.PI / 2, pitch: 0 });
  expect(shotEditor.shot!.distance).toBe(4);
  h.controller.dispose();
});
