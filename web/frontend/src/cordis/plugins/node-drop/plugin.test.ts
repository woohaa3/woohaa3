// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import type { CompositeAssetScopeGeometryEntry } from "../canvas-runtime/bevy-runtime.js";
import { nodeDrop } from "../../services/node-drop/index.js";
import { nodeDropExtension } from "./plugin.js";
import type { NodeDropTarget } from "../canvas-shell/node-drop-dispatch.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function mount() {
  let canvas = createEmptyWoohaa3ServerCanvas("c");
  canvas.document.nodes = [
    { id: "g", type: "group", position: { x: 100, y: 50 }, width: 500, height: 500 },
    { id: "film", type: "composite-asset", parentId: "g", position: { x: 20, y: 30 }, width: 300, height: 200 },
    { id: "source", type: "image", position: { x: -500, y: -500 } }
  ];
  let targets: NodeDropTarget[] = [{ nodeType: "composite-asset", dropLabel: "Join", onDrop: () => true }];
  let zoom = 1;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback); return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const listeners = { viewport: new Set<() => void>(), canvas: new Set<() => void>(), targets: new Set<() => void>() };
  const subscribe = (set: Set<() => void>, listener: () => void) => { set.add(listener); return () => set.delete(listener); };
  // accepted scope 几何：以 working 节点绝对坐标派生，验证失效后读取最新 ancestor/viewport。
  const scopes = (): CompositeAssetScopeGeometryEntry[] => {
    const target = canvas.document.nodes.find(node => node.id === "film");
    const parent = canvas.document.nodes.find(node => node.id === "g");
    if (!target || !parent) return [];
    const { x: ox, y: oy } = target.position;
    const { x: px, y: py } = parent.position;
    const width = target.width ?? 0;
    const x = px + ox;
    const y = py + oy;
    return [{ nodeId: "film", shape: "rect",
      vertices: [[x, y], [x + width, y], [x + width, y + 200], [x, y + 200]],
      handles: [[x, y], [x + width, y], [x + width, y + 200], [x, y + 200], [x, y], [x + width, y], [x + width, y + 200], [x, y + 200]],
      aabb: [x, y, width, 200], base: [x, y, width, 200] }];
  };
  let cleanup = () => {};
  nodeDropExtension()({
    canvasRuntime: {
      worldToClient: (p: { x: number; y: number }) => ({ x: p.x * zoom, y: p.y * zoom }),
      subscribeViewport: (listener: () => void) => subscribe(listeners.viewport, listener),
      queryCompositeAssetScopes: () => ({ ok: true as const, generation: 1, value: scopes() }),
      queryDropTarget: () => ({ ok: true as const, generation: 1, value: "film" }),
    },
    canvasState: { getWorkingCanvas: () => canvas, subscribe: (listener: () => void) => subscribe(listeners.canvas, listener) },
    slots: { list: () => targets, subscribe: (_slot: string, listener: () => void) => subscribe(listeners.targets, listener) },
    effect: (effect: () => () => void) => { cleanup = effect(); }
  } as never, undefined);
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; cleanup(); } };
  cleanups.push(dispose);
  return {
    frames, listeners, dispose,
    flush: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); },
    notify: (kind: keyof typeof listeners) => listeners[kind].forEach(callback => callback()),
    setZoom: (value: number) => { zoom = value; },
    moveAncestor: () => { canvas = { ...canvas, document: { ...canvas.document,
      nodes: canvas.document.nodes.map(node => node.id === "g" ? { ...node, position: { x: 200, y: 150 } } : node) } }; },
    resizeTarget: () => { canvas = { ...canvas, document: { ...canvas.document,
      nodes: canvas.document.nodes.map(node => node.id === "film" ? { ...node, width: 400 } : node) } }; },
    removeTarget: () => { canvas = { ...canvas, document: { ...canvas.document,
      nodes: canvas.document.nodes.filter(node => node.id !== "film") } }; },
    disableOwner: () => { targets = []; }
  };
}

it("coalesces inputs and invalidations, using latest ancestor, viewport and owner state", () => {
  const host = mount();
  nodeDrop.preview(["source"], { x: 125, y: 85 });
  nodeDrop.preview(["source"], { x: 230, y: 190 });
  host.moveAncestor(); host.notify("canvas");
  host.resizeTarget(); host.notify("canvas");
  host.setZoom(2); host.notify("viewport");
  expect(host.frames.size).toBe(1);
  host.flush();
  const element = document.querySelector<HTMLElement>('[data-node-id="film"]')!;
  expect(element.style.left).toBe("440px");
  expect(element.style.top).toBe("360px");
  expect(element.style.width).toBe("800px");
  expect(element.dataset.active).toBe("true");
  host.disableOwner(); host.notify("targets"); host.flush();
  expect(element.dataset.unavailable).toBe("true");
  host.removeTarget(); host.notify("canvas"); host.flush();
  expect(document.querySelector(".node-drop-overlays")).toBeNull();
});

it("clears synchronously and fences already scheduled callbacks after cancel or disposal", () => {
  const host = mount();
  nodeDrop.preview(["source"], { x: 125, y: 85 }); host.flush();
  expect(document.querySelector(".node-drop-overlays")).not.toBeNull();
  host.notify("viewport");
  const lateCancel = [...host.frames.values()][0]!;
  nodeDrop.clear();
  expect(host.frames.size).toBe(0);
  lateCancel(0);
  expect(document.querySelector(".node-drop-overlays")).toBeNull();
  nodeDrop.preview(["source"], { x: 125, y: 85 });
  const lateDispose = [...host.frames.values()][0]!;
  host.dispose(); lateDispose(0);
  nodeDrop.preview(["source"], { x: 125, y: 85 });
  expect(document.querySelector(".node-drop-overlays")).toBeNull();
  expect(host.frames.size).toBe(0);
  expect(Object.values(host.listeners).every(set => set.size === 0)).toBe(true);
});

it("does not rewrite DOM when a frame has no net feedback or polygon change", () => {
  const host = mount();
  nodeDrop.preview(["source"], { x: 125, y: 85 }); host.flush();
  const observer = new MutationObserver(() => {});
  observer.observe(document.querySelector(".node-drop-overlays")!, { subtree: true, attributes: true, childList: true, characterData: true });
  host.notify("viewport"); host.notify("canvas"); host.notify("targets"); host.flush();
  expect(observer.takeRecords()).toHaveLength(0);
  observer.disconnect();
});
