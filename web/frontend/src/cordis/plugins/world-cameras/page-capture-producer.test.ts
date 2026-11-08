import { afterEach, expect, it, vi } from "vitest";
import { worldCamerasExtension } from "./plugin.js";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.useRealTimers(); });

it("a throwing static camera does not skip the next camera and retries have a bounded cooldown", async () => {
  vi.useFakeTimers();
  const items = ["bad", "good"].map(cameraId => ({ canvasId: "canvas", cameraId, width: 16, height: 16, key: { cameraId } }));
  const capture = vi.fn(async ({ cameraId }: { cameraId: string }) => {
    if (cameraId === "bad") throw new Error("renderer reset");
    return { ok: true, png: new Uint8Array([1]) };
  });
  const commit = vi.fn(async () => ({ ok: true }));
  const actions: string[] = [];
  worldCamerasExtension({ canvasId: "canvas" })({
    slots: { register: (_slot: string, entry: { id: string }) => { actions.push(entry.id); return () => {}; } },
    effect: (run: () => (() => void), id: string) => { if (id === "world-cameras-capture-producer") cleanups.push(run()); },
    canvasRuntime: { getStatus: () => ({ phase: "ready" }), runtime: () => ({ isReady: () => true }), captureWorldCamera: capture, subscribeScene: () => () => {} },
    canvasRemote: { listPendingPageCaptures: async () => ({ ok: true, captures: items }), commitPageCapture: commit }
  } as never, undefined);
  await vi.advanceTimersByTimeAsync(0);
  expect(capture.mock.calls.map(([input]) => input.cameraId)).toEqual(["bad", "good"]);
  expect(commit).toHaveBeenCalledWith(expect.objectContaining({ cameraId: "good" }));
  await vi.advanceTimersByTimeAsync(800);
  expect(capture.mock.calls.filter(([input]) => input.cameraId === "bad")).toHaveLength(1);
  expect(actions).toContain("world-camera-capture-progress");
});

it("waits for renderer startup before consuming pending page attempts", async () => {
  vi.useFakeTimers();
  let phase = "loading";
  let rendererReady = false;
  const capture = vi.fn(async () => ({ ok: true, png: new Uint8Array([1]) }));
  const pending = vi.fn(async () => ({ ok: true, captures: [{ canvasId: "canvas", cameraId: "camera", width: 16, height: 16, key: {} }] }));
  worldCamerasExtension({ canvasId: "canvas" })({
    slots: { register: () => () => {} },
    effect: (run: () => (() => void), id: string) => { if (id === "world-cameras-capture-producer") cleanups.push(run()); },
    canvasRuntime: { getStatus: () => ({ phase }), runtime: () => ({ isReady: () => rendererReady }), captureWorldCamera: capture, subscribeScene: () => () => {} },
    canvasRemote: { listPendingPageCaptures: pending, commitPageCapture: async () => ({ ok: true }) }
  } as never, undefined);
  await vi.advanceTimersByTimeAsync(800);
  expect(pending).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
  phase = "ready";
  await vi.advanceTimersByTimeAsync(400);
  expect(capture).not.toHaveBeenCalled();
  rendererReady = true;
  await vi.advanceTimersByTimeAsync(400);
  expect(capture).toHaveBeenCalledOnce();
});
