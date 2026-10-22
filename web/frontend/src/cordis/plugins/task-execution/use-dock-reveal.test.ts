// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { dockRevealOffset, watchDockReveal } from "./dock-reveal.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";

const dock = { left: 300, right: 900, top: 600, bottom: 780 };
const node = { left: 400, right: 650, top: 450, bottom: 650 };

describe("执行面板遮挡避让", () => {
  it("只移动遮挡量并在面板上方留 16px", () => {
    const offset = dockRevealOffset(node, dock, 0);
    expect(offset).toBe(66);
    expect(node.bottom - offset).toBe(dock.top - 16);
  });
  it("已露出、横向错开、面板下方的节点不移动", () => {
    expect(dockRevealOffset({ ...node, bottom: 600 }, dock, 0)).toBe(0);
    expect(dockRevealOffset({ ...node, left: 900, right: 1100 }, dock, 0)).toBe(0);
    expect(dockRevealOffset({ ...node, top: 780, bottom: 980 }, dock, 0)).toBe(0);
  });
  it("超大节点保留顶部；宿主不从屏幕顶端开始时使用宿主边界", () => {
    expect(dockRevealOffset({ ...node, top: 120, bottom: 900 }, dock, 80)).toBe(24);
    expect(dockRevealOffset({ ...node, top: 70, bottom: 900 }, dock, 80)).toBe(0);
  });
  it("按缩放后的屏幕几何计算，适配移动端面板高度", () => {
    expect(dockRevealOffset({ left: 20, right: 370, top: 300, bottom: 700 },
      { left: 8, right: 382, top: 560, bottom: 820 }, 0)).toBe(156);
  });
  it("复用本地平移动画；焦点、失效选区与用户接管镜头均不触发移动，卸载取消观察", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c1", "2026-10-12T00:00:00Z");
    canvas.document.nodes = [{ id: "a", type: "image", position: { x: 800, y: 0 }, width: 250, height: 400 }];
    vi.spyOn(woohaa3CanvasStore, "getState").mockReturnValue({ ...woohaa3CanvasStore.getState(), canvas, working: null });
    let primaryNodeId: string | null = "a";
    const snapshot = nodeSelectionStore.getSnapshot();
    vi.spyOn(nodeSelectionStore, "getSnapshot").mockImplementation(() => ({ ...snapshot, primaryNodeId }));
    document.body.innerHTML = '<canvas id="bevy-canvas"></canvas><div class="node-execution-dock" data-node-id="a"></div>';
    vi.spyOn(document.querySelector(".node-execution-dock")!, "getBoundingClientRect")
      .mockReturnValue({ ...dock, height: 180, width: 600 } as DOMRect);
    let frame: FrameRequestCallback = () => {};
    let resize = () => {};
    const disconnect = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", cancel);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    let viewport = { x: 11, y: 450, zoom: 0.5 };
    let focused = true;
    const panViewportTo = vi.fn();
    const runtime = {
      controller: () => ({ viewport: () => viewport, panViewportTo }),
      isFocused: () => focused,
      worldToClient: (point: { x: number; y: number }) => ({ x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y })
    };
    let dispose: (() => void) | undefined;
    try {
      dispose = watchDockReveal(runtime as never, "a");
      frame(0);
      expect(panViewportTo).not.toHaveBeenCalled();
      focused = false;
      primaryNodeId = null;
      resize(); frame(0);
      expect(panViewportTo).not.toHaveBeenCalled();
      primaryNodeId = "a";
      resize(); frame(0);
      expect(panViewportTo).toHaveBeenCalledWith({ x: 11, y: 384, zoom: 0.5 });
      viewport = { ...viewport, y: 700 };
      resize(); frame(0);
      expect(panViewportTo).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalled();
      expect(canvas.revision).toBe(0);
    } finally {
      dispose?.();
      expect(cancel).toHaveBeenCalled();
      document.body.innerHTML = "";
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("骨架被真实面板替换后仍对新面板测量并避让", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c1", "2026-10-12T00:00:00Z");
    canvas.document.nodes = [{ id: "a", type: "image", position: { x: 800, y: 0 }, width: 250, height: 400 }];
    vi.spyOn(woohaa3CanvasStore, "getState").mockReturnValue({ ...woohaa3CanvasStore.getState(), canvas, working: null });
    const snapshot = nodeSelectionStore.getSnapshot();
    vi.spyOn(nodeSelectionStore, "getSnapshot").mockImplementation(() => ({ ...snapshot, primaryNodeId: "a" }));
    document.body.innerHTML = '<canvas id="bevy-canvas"></canvas>'
      + '<div class="node-execution-dock" data-node-id="a"><div class="authoring-generate-placeholder"></div></div>';
    let frame: FrameRequestCallback = () => {};
    const observed: Element[] = [];
    const dockRect = { ...dock, height: 180, width: 600, x: dock.left, y: dock.top, toJSON: () => ({}) } as DOMRect;
    const surfaceRect = { left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    // dock 贴底；画布表面从视口顶端开始（surfaceTop=0）。
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.classList?.contains("node-execution-dock") ? dockRect : surfaceRect;
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const resizeCallbacks: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resizeCallbacks.push(callback); }
      observe(element: Element) { observed.push(element); }
      unobserve() {}
      disconnect() {}
    });
    let viewport = { x: 11, y: 450, zoom: 0.5 };
    const panViewportTo = vi.fn();
    const runtime = {
      controller: () => ({ viewport: () => viewport, panViewportTo }),
      isFocused: () => false,
      worldToClient: (point: { x: number; y: number }) => ({ x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y })
    };
    let dispose: (() => void) | undefined;
    try {
      dispose = watchDockReveal(runtime as never, "a");
      // 首帧：骨架 dock 已被观察，按骨架位置避让。
      frame(0);
      expect(panViewportTo).toHaveBeenCalledTimes(1);
      // 懒加载完成：骨架 dock 被替换为真实面板 dock（MutationObserver 异步回调）。
      document.body.innerHTML = '<canvas id="bevy-canvas"></canvas>'
        + '<div class="node-execution-dock" data-node-id="a"><div class="mc-panel"></div></div>';
      await Promise.resolve();
      frame(0);
      // 真实面板 dock 也要进入观察，否则后续增高不再避让。
      const observedDocks = observed.filter((element) => element.classList.contains("node-execution-dock"));
      expect(observedDocks.length).toBeGreaterThanOrEqual(2);
      expect(observedDocks.at(-1)!.querySelector(".mc-panel")).not.toBeNull();
      expect(canvas.revision).toBe(0);
    } finally {
      dispose?.();
      document.body.innerHTML = "";
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
