/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createWorldAnimationScript, worldCameraShotContext, type WorldCaptureFramingStatus } from "@woohaa3/contracts";
import { worldCameraShotStore } from "../../services/world-camera-shot-store.js";
import { cameraFramePayload } from "./seedance-plugin.js";
import { validateVideoDialogPayload } from "./definitions.js";
import { resolveNodeVideoSource } from "../canvas-runtime/video-source.js";
import { createAttachedMedia } from "../canvas-runtime/attached-media.js";
import type { BevyRuntime } from "../canvas-runtime/bevy-runtime.js";
import type { VideoElementLike } from "../canvas-runtime/video-frame-session.js";
import { createHoverTracker } from "../canvas-shell/interaction-hover.js";
import type { InteractionState } from "../canvas-shell/interaction-core.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { buildSceneWithResources } from "../canvas-shell/scene-builder.js";
import { setAppBasePathForTesting } from "../../services/app-base-path.js";

afterEach(() => {
  worldCameraShotStore.clear();
  woohaa3CanvasStore.getState().applyRemoteCanvas(null as never);
  vi.restoreAllMocks();
  setAppBasePathForTesting("/");
});

it("镜头视频读取遵循应用挂载路径并保留画布提示", () => {
  const { canvas, status } = fixture();
  worldCameraShotStore.set([status]);
  setAppBasePathForTesting("/dev/camera-review/");
  expect(resolveNodeVideoSource(canvas, "camera")?.url).toBe(
    `/dev/camera-review/api/media/${status.video!.storageKey}?canvas=${canvas.id}`
  );
});

function fixture() {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas");
  canvas.document.nodes = [
    { id: "camera", type: "world-camera", position: { x: 0, y: 0 } },
    { id: "area", type: "scene-area", position: { x: 0, y: 0 } }
  ];
  canvas.nodeData.camera = { worldCamera: {
    kind: "world-camera", version: "shared-world-v1", cameraId: "camera", settingsVersion: "settings-1",
    position: { u: 0, v: 0, h: 1.8 }, rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 },
    captureMode: { kind: "static" }, aspect: { width: 16, height: 9 }, boundInstanceId: null
  } };
  canvas.nodeData.area = { sceneArea: {
    kind: "scene-area", version: "shared-world-v1", areaId: "area", scopeVersion: "area-1",
    bounds: { min: { u: -4, v: -4 }, max: { u: 4, v: 4 } },
    animationScript: createWorldAnimationScript({ script: "function build(motion) {}", duration: 3, loop: false })
  } };
  const animation = worldCameraShotContext(canvas, "camera")!.animation!;
  const key = { canvasId: canvas.id, cameraId: "camera", cameraSettingsVersion: "settings-1",
    worldContentVersion: "world-1", bindingVersion: "binding-1", outputVersion: "output-1" };
  const status: WorldCaptureFramingStatus = { canvasId: canvas.id, cameraId: "camera", key, phase: "ready", stale: false,
    dynamicKey: { ...key, animation: { areaId: animation.areaId, scriptRevision: animation.scriptRevision,
      sourceHash: animation.sourceHash, durationSeconds: animation.duration }, timeRange: { startSeconds: 0, endSeconds: 3 }, fps: 24 },
    video: { version: "world-capture-video-media-v1", mediaId: "video-1", storageKey: `sha256-${"a".repeat(64)}`,
      checksum: "a".repeat(64), size: 10, contentType: "video/mp4", width: 320, height: 180,
      container: "video/mp4", durationSeconds: 3, fps: 24 }
  };
  return { canvas, status };
}

it("freezes full video provenance and rejects changed animation, stale or other-canvas results", () => {
  const { canvas, status } = fixture();
  worldCameraShotStore.set([status]);
  const payload = cameraFramePayload(canvas, "camera")!;
  expect(payload.cameraSource?.versionKey).toEqual(status.dynamicKey);
  expect(resolveNodeVideoSource(canvas, "camera")?.url).toBe(payload.videoUrl);
  expect(payload.cameraSource?.versionKey).not.toBe(status.dynamicKey);
  const validated = validateVideoDialogPayload(payload);
  expect(validated).toMatchObject({ ok: true, payload: { cameraSource: payload.cameraSource } });
  expect(validateVideoDialogPayload({ ...payload, cameraSource: { ...payload.cameraSource, cameraId: "other" } }).ok).toBe(false);
  const original = JSON.stringify(canvas);
  for (const patch of [{ stale: true }, { canvasId: "other" }, { dynamicKey: undefined },
    { dynamicKey: { ...status.dynamicKey!, animation: { ...status.dynamicKey!.animation, scriptRevision: 99 } } }]) {
    worldCameraShotStore.set([{ ...status, ...patch }]);
    expect(cameraFramePayload(canvas, "camera")).toBeNull();
    expect(resolveNodeVideoSource(canvas, "camera")).toBeNull();
  }
  expect(JSON.stringify(canvas)).toBe(original);
  expect(payload.videoAssetId).toBe("video-1");
});

it("动态镜头通过页面资源预算播放录制视频，移出暂停，录制更新和过期不沿用旧会话", () => {
  const { canvas, status } = fixture();
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const videos: Array<VideoElementLike & { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; emitFrame: () => void }> = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    drawImage: vi.fn(), getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
  })) as never);
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "video") return createElement(tag);
    let frame: ((now: number) => void) | undefined;
    const video = Object.assign(new EventTarget(), {
      src: "", muted: false, loop: false, playsInline: false, preload: "", crossOrigin: null,
      currentTime: 0, duration: 3, videoWidth: 320, videoHeight: 180, readyState: 2,
      play: vi.fn(() => Promise.resolve()), pause: vi.fn(), load: vi.fn(),
      removeAttribute: vi.fn(), requestVideoFrameCallback: (callback: (now: number) => void) => { frame = callback; return 1; },
      cancelVideoFrameCallback: vi.fn(), emitFrame: () => frame?.(0)
    }) as unknown as typeof videos[number];
    videos.push(video);
    return video;
  }) as typeof document.createElement);
  const invalidate = vi.fn();
  const media = createAttachedMedia({
    runtime: { setTexture: vi.fn() } as unknown as BevyRuntime,
    options: { canvasId: canvas.id, getSession: () => null, subscribeModelScenes: () => () => {}, isModalActive: () => false, emit: () => {} },
    getPreviewUrls: () => new Map(),
    getFocusTexture: () => null, isFocused: () => false, invalidate,
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    getSurface: () => ({ width: 1024, height: 768, pixelRatio: 1 })
  });
  const state = { gesture: { kind: "none" }, hoveredVideoNode: null } as InteractionState;
  const tracker = createHoverTracker({ state, videoSessions: media.videoSessions, modalActive: () => false, schedule: vi.fn() });
  const cameraTexture = () => buildSceneWithResources(
    { videoSessions: media.videoSessions } as never,
    () => ({ width: 1024, height: 768, pixelRatio: 1 }), () => new Map(),
    { selected: [], draft: null, marquee: null, localPositions: new Map(), localSizes: new Map(),
      viewportPreview: null, fallbackViewport: { x: 0, y: 0, zoom: 1 },
      hoveredNodeId: null, hoveredPort: null, hoveredEdgeId: null }
  )!.scene.nodes.find(node => node.id === "camera")!.texture;
  try {
    media.projectResidency();
    media.videoSessions.sync();
    expect(videos).toHaveLength(0);
    worldCameraShotStore.set([status]);
    expect(invalidate).toHaveBeenCalledWith("camera-video");
    media.projectResidency();
    expect(media.residency.isAdmitted("camera")).toBe(true);
    media.videoSessions.sync();
    expect(videos).toHaveLength(1);
    expect(cameraTexture()).toBe(false);
    expect(videos[0].src).toContain(status.video!.storageKey);
    tracker.updateHoveredVideo({ kind: "node", nodeId: "camera" });
    expect(media.videoSessions.playingNodeId()).toBe("camera");
    expect(videos[0].play).toHaveBeenCalledOnce();
    videos[0].emitFrame();
    expect(media.videoSessions.hasRealFrame("camera")).toBe(true);
    expect(cameraTexture()).toBe(true);
    tracker.updateHoveredVideo(null);
    expect(media.videoSessions.playingNodeId()).toBeNull();
    expect(videos[0].pause).toHaveBeenCalled();
    worldCameraShotStore.set([{ ...status, video: { ...status.video!, mediaId: "video-2", storageKey: `sha256-${"b".repeat(64)}` } }]);
    media.projectResidency();
    media.videoSessions.sync();
    expect(videos).toHaveLength(2);
    expect(videos[1].src).toContain(`sha256-${"b".repeat(64)}`);
    tracker.updateHoveredVideo({ kind: "node", nodeId: "camera" });
    expect(media.videoSessions.playingNodeId()).toBe("camera");
    worldCameraShotStore.set([{ ...status, stale: true }]);
    media.projectResidency();
    media.videoSessions.sync();
    expect(media.videoSessions.activeNodeIds()).toEqual([]);
    expect(media.videoSessions.playingNodeId()).toBeNull();
    expect(videos[1].pause).toHaveBeenCalled();
    expect(cameraTexture()).toBe(false);
  } finally {
    media.videoSessions.dispose();
    media.textureSync.dispose();
    media.dispose();
  }
});
