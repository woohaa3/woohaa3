// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDefaultWorldCameraData } from "@woohaa3/contracts";
import { worldCameraEditorStore } from "../../services/world-camera-editor-store.js";
import { attachCameraFlightInput } from "./flight-input.js";

let lock: Element | null;
let tick: FrameRequestCallback;
let detach: () => void;
const onExit = vi.fn();
const onLockChange = vi.fn();
const key = (code: string) => window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { tick = callback; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  lock = document.documentElement;
  Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => lock });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.exitPointerLock = vi.fn(() => { lock = null; document.dispatchEvent(new Event("pointerlockchange")); });
  document.documentElement.requestPointerLock = vi.fn(() => { lock = document.documentElement; document.dispatchEvent(new Event("pointerlockchange")); return Promise.resolve(); });
  worldCameraEditorStore.begin("canvas", "node", createDefaultWorldCameraData("camera", "v1", { u: 0, v: 0 }));
  detach = attachCameraFlightInput({ session: worldCameraEditorStore.getSnapshot()!, onExit, onLockChange });
});
afterEach(() => { detach(); worldCameraEditorStore.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("Tab ends free movement and never recaptures on its own", () => {
  key("Tab");
  expect(lock).toBeNull();
  expect(onExit).toHaveBeenCalled();
  expect(onLockChange).toHaveBeenLastCalledWith(false);
  key("Tab");
  expect(document.documentElement.requestPointerLock).not.toHaveBeenCalled();
});

it("handles browser Escape reported only as pointer-lock loss", () => {
  document.exitPointerLock();
  expect(onExit).toHaveBeenCalledTimes(1);
});

it("clears held movement on blur, so returning to the window cannot keep moving", () => {
  const source = worldCameraEditorStore.getSnapshot()!.draft;
  key("KeyW");
  tick(performance.now() + 16);
  const moved = worldCameraEditorStore.getSnapshot()!.draft;
  expect(moved.position).not.toEqual(source.position);
  window.dispatchEvent(new Event("blur"));
  expect(lock).toBeNull();
  tick(performance.now() + 32);
  expect(worldCameraEditorStore.getSnapshot()!.draft).toBe(moved);
  expect(onExit).toHaveBeenCalled();
});

it("routes Z/X to world height and cancels opposite held keys", () => {
  const initial = worldCameraEditorStore.getSnapshot()!.draft.position;
  key("KeyZ");
  tick(performance.now() + 16);
  const raised = worldCameraEditorStore.getSnapshot()!.draft.position;
  expect(raised.h).toBeGreaterThan(initial.h);
  expect(raised.u).toBe(initial.u);
  expect(raised.v).toBe(initial.v);
  key("KeyX");
  tick(performance.now() + 32);
  expect(worldCameraEditorStore.getSnapshot()!.draft.position).toEqual(raised);
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyZ", bubbles: true }));
  tick(performance.now() + 48);
  expect(worldCameraEditorStore.getSnapshot()!.draft.position.h).toBeLessThan(raised.h);
});
