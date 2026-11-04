// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { CanvasNavigationStore } from "../../navigation/store.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { beginDirectorSceneSelection } from "./scene-selection.js";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); nodeSelectionStore.reset(); });

function setup() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  const canvas = createEmptyWoohaa3ServerCanvas("selection-test");
  canvas.document.nodes.push({ id: "image", type: "image", position: { x: 0, y: 0 } });
  const sync = () => woohaa3CanvasStore.getState().applyRemoteCanvas(structuredClone(canvas));
  sync();
  nodeSelectionStore.setFromRuntime({ nodeIds: ["image"], primaryNodeId: "image", editingFocus: false }, new Set(["image", "director", "other"]));
  const navigation = new CanvasNavigationStore();
  const selectNode = vi.fn(() => true);
  const ctx = { canvasNavigation: navigation, canvasRuntime: { controller: () => ({ selectNode }) } };
  const intent = beginDirectorSceneSelection(ctx as never, canvas.id);
  cleanups.push(intent.cancel);
  const addDirector = () => { canvas.document.nodes.push({ id: "director", type: "scene-area", position: { x: 0, y: 0 } }); sync(); };
  const tick = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); };
  return { canvas, sync, navigation, selectNode, ctx, intent, addDirector, tick, frames };
}

it("selects the reserved director once after delayed canvas sync and controller readiness", () => {
  const { intent, addDirector, selectNode, sync, tick, frames } = setup();
  intent.accept("director");
  tick();
  expect(selectNode).not.toHaveBeenCalled();
  addDirector();
  selectNode.mockReturnValueOnce(false);
  tick();
  tick();
  expect(selectNode.mock.calls).toEqual([["director"], ["director"]]);
  sync(); tick();
  expect(selectNode).toHaveBeenCalledTimes(2);
  expect(frames.size).toBe(0);
});

it("leaves source image focus and selects the new area in the canvas", () => {
  const { intent: old, navigation, ctx, addDirector, tick, selectNode } = setup();
  old.cancel();
  navigation.setFocusAdapter({ apply: () => ({ ok: true }), isFocused: () => true });
  navigation.enterNodeFocus({ nodeId: "image", kind: "image" });
  const intent = beginDirectorSceneSelection(ctx as never, "selection-test");
  cleanups.push(intent.cancel);
  addDirector();
  intent.accept("director");
  tick();
  expect(navigation.getSnapshot().mode.type).toBe("overview");
  expect(selectNode).toHaveBeenCalledWith("director");
});

it.each(["canvas", "selection", "focus", "dispose"])("ignores delayed acceptance after changing %s", change => {
  const { intent, navigation, addDirector, tick, selectNode } = setup();
  if (change === "canvas") woohaa3CanvasStore.getState().applyRemoteCanvas(createEmptyWoohaa3ServerCanvas("other-canvas"));
  if (change === "selection") nodeSelectionStore.setFromRuntime({ nodeIds: ["other"], primaryNodeId: "other", editingFocus: false }, new Set(["other"]));
  if (change === "focus") {
    navigation.setFocusAdapter({ apply: () => ({ ok: true }), isFocused: () => true });
    navigation.enterNodeFocus({ nodeId: "other", kind: "image" });
  }
  if (change === "dispose") intent.cancel();
  addDirector();
  intent.accept("director");
  tick();
  expect(selectNode).not.toHaveBeenCalled();
});

it("cancels selection already queued for the next frame when the user selects another node", () => {
  const { intent, addDirector, tick, selectNode, frames } = setup();
  addDirector(); intent.accept("director");
  expect(frames.size).toBe(1);
  nodeSelectionStore.setFromRuntime({ nodeIds: ["other"], primaryNodeId: "other", editingFocus: false }, new Set(["other"]));
  tick();
  expect(selectNode).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
});
