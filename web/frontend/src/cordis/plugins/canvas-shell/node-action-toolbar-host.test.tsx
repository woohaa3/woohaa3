// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BevyNodeActionsPresentation, ScreenRect } from "@woohaa3/contracts";
import { NodeActionToolbarHost, nodeActionToolbarScreenLayout } from "./node-action-toolbar-host.js";
import { setNodeActionBridge } from "./node-action-bridge.js";

const bounds = { left: 100, top: 50, width: 1000, height: 700 };
const initialNode = { left: 300, top: 300, width: 240, height: 180 };
const initialPresentation: BevyNodeActionsPresentation = { summary: "当前模型", actions: [
  { id: "download", label: "下载", enabled: true, icon: "download", iconOnly: true },
  { id: "edit", label: "编辑", enabled: true, tone: "primary", icon: "edit", menu: true },
  { id: "disabled", label: "未就绪", enabled: false, menu: true }
] };
let root: Root | undefined;
let removeBridge: (() => void) | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => { root?.unmount(); removeBridge?.(); });
  root = undefined; removeBridge = undefined;
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function signal() {
  const listeners = new Set<() => void>();
  return { subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    emit: () => listeners.forEach(listener => listener()), count: () => listeners.size };
}

async function mount() {
  const frame = signal(), viewport = signal(), scene = signal(), slots = signal(), session = signal(), navigation = signal();
  let node: ScreenRect | null = initialNode;
  let presentation: BevyNodeActionsPresentation | null = initialPresentation;
  const activate = vi.fn();
  removeBridge = setNodeActionBridge({
    toolbars: () => presentation ? new Map([["a", presentation]]) : new Map(), activate
  });
  const canvas = document.createElement("canvas"); canvas.id = "bevy-canvas";
  canvas.getBoundingClientRect = () => bounds as DOMRect;
  const host = document.createElement("div"); document.body.append(canvas, host);
  const runtime = { subscribe: signal().subscribe, subscribeFrame: frame.subscribe,
    subscribeViewport: viewport.subscribe, subscribeScene: scene.subscribe,
    nodeScreenRect: vi.fn((_id: string, part: string) => { expect(part).toBe("action-toolbar"); return node; }) };
  const ctx = { canvasRuntime: runtime, canvasNavigation: navigation, canvasSession: session, slots: { subscribe: (_: string, notify: () => void) => slots.subscribe(notify) } };
  root = createRoot(host);
  await act(async () => root!.render(<NodeActionToolbarHost ctx={ctx as never} />));
  return { host, activate, frame, viewport, scene, slots, session, navigation,
    setNode: (next: ScreenRect | null) => { node = next; },
    setPresentation: (next: BevyNodeActionsPresentation | null) => { presentation = next; } };
}

it("renders DOM actions and dispatches main/settings clicks with a fixed node identity", async () => {
  const { host, activate } = await mount();
  const buttons = host.querySelectorAll<HTMLButtonElement>("button");
  expect([...buttons].map(button => button.title)).toEqual(["下载", "编辑", "编辑设置", "未就绪", "未就绪设置"]);
  expect(buttons[0]!.textContent).toBe("");
  expect(buttons[0]!.querySelector("svg")).not.toBeNull();
  expect(host.textContent).toContain("当前模型");
  await act(async () => { buttons[0]!.click(); buttons[2]!.click(); buttons[3]!.click(); buttons[4]!.click(); });
  expect(activate.mock.calls.map(([hit]) => hit)).toEqual([
    { nodeId: "a", actionId: "download", menu: false },
    { nodeId: "a", actionId: "edit", menu: true },
    { nodeId: "a", actionId: "disabled", menu: true }
  ]);
});

it("follows accepted node movement and zoom without scaling controls, and hides offscreen targets", async () => {
  const { host, frame, viewport, scene, setNode } = await mount();
  const bar = host.querySelector<HTMLElement>(".node-action-toolbar")!;
  const width = bar.style.width;
  expect(bar.style.top).toBe("252px");
  setNode({ ...initialNode, left: 500, top: 400 });
  await act(async () => frame.emit());
  expect(bar.style.top).toBe("352px");
  expect(parseFloat(bar.style.left) + parseFloat(width) / 2).toBe(620);
  setNode({ ...initialNode, width: 24, height: 18 });
  await act(async () => viewport.emit());
  expect(bar.style.width).toBe(width);
  expect(bar.style.height).toBe("40px");
  setNode({ ...initialNode, left: -1000 });
  await act(async () => scene.emit());
  expect(bar.style.visibility).toBe("hidden");
  setNode(null);
  await act(async () => scene.emit());
  expect(bar.style.visibility).toBe("hidden");
});

it("refreshes slots, writable state and focus changes, then releases all runtime subscriptions", async () => {
  const { host, slots, session, navigation, frame, scene, viewport, setPresentation } = await mount();
  setPresentation({ actions: [{ id: "new", label: "新增动作", enabled: true }] });
  await act(async () => slots.emit());
  expect(host.textContent).toBe("新增动作");
  setPresentation({ actions: [{ id: "new", label: "新增动作", enabled: false }] });
  await act(async () => session.emit());
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  setPresentation(null);
  await act(async () => navigation.emit());
  expect(host.textContent).toBe("");
  setPresentation(initialPresentation);
  await act(async () => navigation.emit());
  expect(host.querySelector(".node-action-toolbar")).not.toBeNull();
  await act(async () => { root!.unmount(); root = undefined; });
  for (const source of [slots, session, navigation, frame, scene, viewport]) expect(source.count()).toBe(0);
});

it("isolates pointer, wheel, double click and context menu events from canvas gestures", async () => {
  const { host } = await mount();
  const bubble = vi.fn();
  const types = ["pointerdown", "pointerup", "click", "dblclick", "contextmenu", "wheel"];
  const outer = document.createElement("div"); host.before(outer); outer.append(host);
  types.forEach(type => outer.addEventListener(type, bubble));
  const button = host.querySelector("button")!;
  await act(async () => types.forEach(type => button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))));
  expect(bubble).not.toHaveBeenCalled();
});

it("keeps the canvas offset, falls below a top-edge node and clamps a huge target within the viewport", () => {
  const below = nodeActionToolbarScreenLayout({ ...initialNode, top: 55 }, bounds, initialPresentation)!;
  expect(below.placement).toBe("below");
  expect(below.bar.y).toBe(243);
  const huge = nodeActionToolbarScreenLayout({ left: 90, top: -1000, width: 2000, height: 3000 }, bounds, initialPresentation)!;
  expect(huge.bar.y).toBe(58);
  expect(huge.bar.x + huge.bar.width).toBeLessThanOrEqual(1092);
  expect(nodeActionToolbarScreenLayout({ ...initialNode, left: 1200 }, bounds, initialPresentation)).toBeNull();
});

it("shows download beside one rotation button and keeps download usable when rotation is disabled", async () => {
  const { host, slots, activate, setPresentation } = await mount();
  setPresentation({ actions: [
    { id: "download", label: "下载", enabled: true, icon: "download", iconOnly: true },
    { id: "rotate", label: "旋转 90°", enabled: false, icon: "rotate-clockwise", iconOnly: true }
  ] });
  await act(async () => slots.emit());
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons.map(button => button.title)).toEqual(["下载", "旋转 90°"]);
  expect(buttons[0]!.disabled).toBe(false);
  expect(buttons[1]!.disabled).toBe(true);
  expect(buttons.every(button => button.querySelector("svg") !== null)).toBe(true);
  await act(async () => { buttons[0]!.click(); buttons[1]!.click(); });
  expect(activate).toHaveBeenCalledTimes(1);
  expect(activate).toHaveBeenCalledWith({ nodeId: "a", actionId: "download", menu: false });
});

it("holds its screen anchor through rotation while hovered, then repositions on leave or viewport movement", async () => {
  const { host, frame, viewport, setNode } = await mount();
  const bar = host.querySelector<HTMLElement>(".node-action-toolbar")!;
  const enter = () => bar.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  const leave = () => bar.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
  await act(async () => enter());
  setNode({ ...initialNode, top: 400 });
  await act(async () => frame.emit());
  expect(bar.style.top).toBe("252px");
  await act(async () => leave());
  expect(bar.style.top).toBe("352px");
  await act(async () => enter());
  setNode({ ...initialNode, top: 500 });
  await act(async () => viewport.emit());
  expect(bar.style.top).toBe("452px");
});
