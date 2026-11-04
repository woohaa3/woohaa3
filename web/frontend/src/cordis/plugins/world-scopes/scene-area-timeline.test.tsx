// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type WorldAnimationScript, type ScreenRect } from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { WorldAnimationTransport } from "../canvas-runtime/world-animation-transport.js";
import { SceneAreaTimeline, timelinePlacement } from "./scene-area-timeline.js";

const canvasRect = { left: 100, top: 50, width: 1000, height: 700 };
const titleRect = { left: 300, top: 300, width: 140, height: 40 };
const animationScript: WorldAnimationScript = {
  script: 'motion.instance.tween("model", { property: "scale", startTime: 0, endTime: 4, from: [1], to: [2], easing: "linear" });',
  scriptLanguage: "javascript",
  scriptVersion: "woohaa-world-animation-js-v1",
  revision: 1,
  sourceHash: "hash-timeline",
  duration: 4,
  loop: false
};
let root: Root | undefined;
let player: WorldAnimationTransport | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => { root?.unmount(); player?.dispose(); nodeSelectionStore.reset(); });
  root = undefined; player = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function select(ids: string[]) {
  nodeSelectionStore.setFromRuntime({ nodeIds: ids, primaryNodeId: ids[0] ?? null, editingFocus: false }, new Set(["a", "b"]));
}
async function mount(withAnimation = true) {
  const canvas = createEmptyWoohaa3ServerCanvas("timeline");
  canvas.document.nodes = ["a", "b"].map(id => ({ id, type: "scene-area", position: { x: 0, y: 0 } }));
  for (const id of ["a", "b"]) canvas.nodeData[id] = { sceneArea: {
    kind: "scene-area", version: "shared-world-v1", areaId: id, scopeVersion: "v1",
    bounds: { min: { u: 0, v: 0 }, max: { u: 4, v: 4 } }, ...(withAnimation ? { animationScript } : {})
  } };
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const bevy = document.createElement("canvas"); bevy.id = "bevy-canvas";
  bevy.getBoundingClientRect = () => canvasRect as DOMRect;
  const host = document.createElement("div"); document.body.append(bevy, host);
  player = new WorldAnimationTransport(() => {}, { now: () => 0, request: () => 1, cancel: () => {} });
  const transport = player;
  transport.sync("timeline", ["a", "b"].map(nodeId => ({ nodeId, key: "v1", duration: 4, loop: false })), "a");
  const unsubscribe = () => () => {};
  let title: ScreenRect = titleRect;
  const runtime = {
    worldAnimationState: transport.snapshot, subscribeWorldAnimation: transport.subscribe,
    playWorldAnimation: transport.play, pauseWorldAnimation: transport.pause,
    seekWorldAnimation: transport.seek, setWorldAnimationLoop: transport.setLoop,
    nodeScreenRect: vi.fn(() => title), subscribeViewport: unsubscribe, subscribeScene: unsubscribe, subscribeFrame: unsubscribe
  };
  root = createRoot(host);
  await act(async () => { select(["a"]); root!.render(<SceneAreaTimeline ctx={{ canvasRuntime: runtime } as never} canvasId="timeline" />); });
  return { host, runtime, transport, setTitle: (rect: ScreenRect) => { title = rect; } };
}
function pointer(target: Element, type: string, x: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x });
  Object.defineProperty(event, "pointerId", { value: pointerId }); target.dispatchEvent(event);
}

it("has one player only for a singly selected animated director", async () => {
  const { host } = await mount();
  expect(host.querySelectorAll(".scene-area-timeline")).toHaveLength(1);
  expect(host.querySelectorAll("button")).toHaveLength(2);
  expect(host.textContent).not.toContain("重播");
  await act(async () => { select(["a", "b"]); });
  expect(host.querySelector(".scene-area-timeline")).toBeNull();
  await act(async () => { select([]); });
  expect(host.textContent).toBe("");
});

it("keeps non-animated directors free of playback controls", async () => {
  const { host } = await mount(false);
  expect(host.querySelector(".scene-area-timeline")).toBeNull();
});

it("plays, pauses and toggles local looping through the single capsule", async () => {
  const { host, transport } = await mount();
  const buttons = host.querySelectorAll<HTMLButtonElement>("button");
  await act(async () => buttons[0]!.click());
  expect(transport.snapshot().playing).toBe(true);
  expect(buttons[0]!.title).toBe("暂停动画");
  await act(async () => buttons[0]!.click());
  expect(transport.snapshot().playing).toBe(false);
  await act(async () => buttons[1]!.click());
  expect(transport.snapshot().loop).toBe(true);
  expect(buttons[1]!.classList.contains("is-active")).toBe(true);
});

it("scrubs with captured pointers, uses the release location and resumes prior playback", async () => {
  const { host, transport } = await mount();
  const track = host.querySelector<HTMLElement>("[data-timeline-track]")!;
  track.getBoundingClientRect = () => ({ left: 200, width: 200 }) as DOMRect;
  track.setPointerCapture = vi.fn(); track.hasPointerCapture = () => true; track.releasePointerCapture = vi.fn();
  await act(async () => transport.play());
  await act(async () => pointer(track, "pointerdown", 250));
  expect(transport.snapshot()).toMatchObject({ time: 1, playing: false });
  expect(track.setPointerCapture).toHaveBeenCalledWith(1);
  await act(async () => pointer(track, "pointermove", 300));
  expect(transport.snapshot().time).toBe(2);
  expect(host.querySelector<HTMLElement>(".scene-area-timeline")!.style.getPropertyValue("--timeline-progress")).toBe("0.5");
  await act(async () => pointer(track, "pointerup", 350));
  expect(transport.snapshot()).toMatchObject({ time: 3, playing: true });
  expect(track.releasePointerCapture).toHaveBeenCalledWith(1);
  await act(async () => pointer(track, "pointerdown", 200));
  await act(async () => pointer(track, "pointercancel", 200));
  expect(transport.snapshot()).toMatchObject({ time: 3, playing: true });
  await act(async () => pointer(track, "pointerdown", 500));
  await act(async () => pointer(track, "pointerup", 500));
  expect(transport.snapshot()).toMatchObject({ time: 4, playing: false });
});

it("uses a matching execution panel when open and returns to the title after it closes", async () => {
  const { host, runtime, setTitle } = await mount();
  const timeline = host.querySelector<HTMLElement>(".scene-area-timeline")!;
  expect(runtime.nodeScreenRect).toHaveBeenCalledWith("a", "scope-title");
  Object.defineProperties(timeline, { offsetWidth: { value: 328 }, offsetHeight: { value: 36 } });
  const panel = document.createElement("div"); panel.className = "node-execution-dock"; panel.dataset.nodeId = "a";
  panel.getBoundingClientRect = () => ({ left: 200, top: 500, width: 600, height: 180 }) as DOMRect;
  // A visible dock remains a usable anchor even if the ground label is outside the viewport.
  setTitle({ ...titleRect, left: -1000 });
  panel.style.visibility = "hidden";
  await act(async () => { document.body.append(panel); });
  expect(timeline.style.visibility).toBe("hidden");
  await act(async () => { panel.style.visibility = "visible"; });
  expect(timeline.style.visibility).toBe("visible");
  expect(timeline.style.top).toBe("456px");
  expect(timeline.style.left).toBe("336px");
  setTitle(titleRect);
  await act(async () => panel.remove());
  expect(timeline.style.top).toBe("350px");
  expect(timeline.style.left).toBe("206px");
});

it("clamps the capsule within the canvas and hides it when its label is offscreen", () => {
  expect(timelinePlacement(canvasRect, titleRect, null, 328, 36)).toEqual({ left: 206, top: 350 });
  expect(timelinePlacement(canvasRect, { left: 1050, top: 720, width: 40, height: 20 }, null, 328, 36))
    .toEqual({ left: 760, top: 702 });
  expect(timelinePlacement(canvasRect, { ...titleRect, left: -1000 }, null, 328, 36)).toBeNull();
  expect(timelinePlacement(canvasRect, titleRect, { left: 300, top: 65, width: 400, height: 100 }, 328, 36)?.top).toBe(173);
});
