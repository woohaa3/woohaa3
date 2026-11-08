import { afterEach, expect, it, vi } from "vitest";
import { worldCamerasExtension } from "./plugin.js";
import * as videoRecorder from "./world-camera-video-recorder.js";
import { createDefaultWorldCameraData, createEmptyWoohaa3ServerCanvas, createWorldAnimationScript, worldCaptureDynamicFrameCount, worldCaptureFrameTime } from "@woohaa3/contracts";

import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { worldCameraShotStore } from "../../services/world-camera-shot-store.js";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.useRealTimers(); vi.restoreAllMocks(); worldCameraShotStore.clear(); woohaa3CanvasStore.getState().applyRemoteCanvas(null as never); });

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

it("长录制逐帧保持采样覆盖，仅在完成后恢复用户播放头", async () => {
  vi.useFakeTimers();
  const key = {
    canvasId: "canvas", cameraId: "camera", cameraSettingsVersion: "settings", worldContentVersion: "world",
    bindingVersion: "binding", outputVersion: "output", animation: { areaId: "area", scriptRevision: 1,
      sourceHash: "source", durationSeconds: 1 }, timeRange: { startSeconds: 0, endSeconds: 1 }, fps: 8
  };
  const item = { canvasId: "canvas", cameraId: "camera", width: 32, height: 32, key,
    kind: "dynamic", dynamicKey: key, animationNodeId: "area-node" };
  const times: Array<number | null> = [];
  const sampled: number[] = [];
  let current: number | null = null;
  let committed = false;
  vi.spyOn(videoRecorder, "encodeWorldCameraVideo").mockImplementation(async ({ frames }) => {
    for await (const _frame of frames) { /* Consume the production sampling generator. */ }
    return { ok: true, mp4: new Uint8Array([1]), width: 32, height: 32, fps: 8,
      frames: sampled.length, durationSeconds: 1 };
  });
  worldCamerasExtension({ canvasId: "canvas" })({
    slots: { register: () => () => {} },
    effect: (run: () => (() => void), id: string) => { if (id === "world-cameras-capture-producer") cleanups.push(run()); },
    canvasRuntime: {
      getStatus: () => ({ phase: "ready" }), runtime: () => ({ isReady: () => true }),
      captureWorldCamera: vi.fn(), subscribeScene: () => () => {},
      setCaptureAnimationTimes: (value: ReadonlyMap<string, number> | null) => {
        current = value?.get("area-node") ?? null; times.push(current);
      },
      captureWorldCameraRaw: async () => {
        sampled.push(current!);
        // Model slow GPU readback: recording crosses the previous 400ms reset interval.
        await new Promise(resolve => setTimeout(resolve, 120));
        return { ok: true, rgba: new Uint8Array(32 * 32 * 4), width: 32, height: 32 };
      }
    },
    canvasRemote: {
      listPendingPageCaptures: async () => ({ ok: true, captures: committed ? [] : [item] }),
      commitPageVideoCapture: async () => { committed = true; return { ok: true }; }
    }
  } as never, undefined);
  await vi.advanceTimersByTimeAsync(3000);
  const expected = Array.from({ length: worldCaptureDynamicFrameCount(key) }, (_, i) => worldCaptureFrameTime(key, i));
  expect(sampled).toEqual(expected);
  expect(times).toEqual([...expected, null]);
  expect(committed).toBe(true);
});


it("动态镜头启动保持预览，通过动作栏录制与重录，并阻止只读或进行中重复提交", async () => {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas");
  canvas.document.nodes = [{ id: "camera", type: "world-camera", position: { x: 0, y: 0 } }, { id: "area", type: "scene-area" }];
  canvas.nodeData.camera = { worldCamera: createDefaultWorldCameraData("camera", "v1", { u: 0, v: 0 }) } as never;
  canvas.nodeData.area = { sceneArea: { kind: "scene-area", version: "shared-world-v1", areaId: "area", scopeVersion: "scope",
    bounds: { min: { u: -30, v: -30 }, max: { u: 30, v: 30 } },
    animationScript: createWorldAnimationScript({ script: "function build(motion) {}", duration: 2, loop: false }) } } as never;
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const retry = vi.fn(async () => true);
  const actions = new Map<string, { describe(input: { nodeId: string; writable: boolean }): { label: string; enabled: boolean } | null;
    activate(input: { nodeId: string; writable: boolean }): void }>();
  worldCamerasExtension({ canvasId: canvas.id })({
    slots: { register: (_slot: string, entry: { id: string }) => { actions.set(entry.id, entry as never); return () => {}; } },
    effect: (run: () => (() => void), id: string) => { if (id === "world-cameras-capture-producer") cleanups.push(run()); },
    canvasRuntime: { getStatus: () => ({ phase: "ready" }), runtime: () => ({ isReady: () => true }),
      captureWorldCamera: vi.fn(), subscribeScene: () => () => {} },
    canvasSession: { isWritable: () => true },
    canvasRemote: { listPendingPageCaptures: async () => ({ ok: true, captures: [] }), retryPageCapture: retry }
  } as never, undefined);
  await Promise.resolve();
  const action = actions.get("world-camera-capture-progress")!;
  const target = { nodeId: "camera", writable: true };
  expect(action.describe(target)).toMatchObject({ label: "录制", enabled: true });
  expect(retry).not.toHaveBeenCalled();
  action.activate({ ...target, writable: false });
  expect(retry).not.toHaveBeenCalled();
  action.activate(target);
  await Promise.resolve();
  expect(retry).toHaveBeenCalledOnce();
  worldCameraShotStore.set([{ canvasId: canvas.id, cameraId: "camera", phase: "ready", stale: false,
    key: null, video: { storageKey: "recording.mp4" } as never }]);
  expect(action.describe(target)).toMatchObject({ label: "重新录制", enabled: true });
  action.activate(target);
  await Promise.resolve();
  expect(retry).toHaveBeenCalledTimes(2);
  worldCameraShotStore.set([{ canvasId: canvas.id, cameraId: "camera", phase: "waiting", stale: false, key: null }]);
  expect(action.describe(target)?.enabled).toBe(false);
  action.activate(target);
  expect(retry).toHaveBeenCalledTimes(2);
});
