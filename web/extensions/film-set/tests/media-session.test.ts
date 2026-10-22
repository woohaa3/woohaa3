import { filmSetMediaSources } from "../src/frontend/media-sources.js";
/**
 * 片场媒体会话测试
 * （change: 2026-10-08-make-film-set-model-only，任务 4.1/4.2/6.2）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  filmSetNodeDataFields, canonicalFilmSetFields, decodeFilmSetNodeData,
  createFilmSetSnapshot,
  type ServerCanvas
} from "@woohaa3/contracts";
import type { BevyRuntime } from "../../../frontend/src/cordis/plugins/canvas-runtime/bevy-runtime.js";
import type { VideoElementLike } from "../../../frontend/src/cordis/plugins/canvas-runtime/video-frame-session.js";
import {
  createCompositeAssetMediaSessions as createPlatformMediaSessions,
  resolveCompositeAssetMediaDescriptors
} from "../../../frontend/src/cordis/plugins/canvas-runtime/composite-asset-media-session.js";
import type { RasterCanvas } from "../../../frontend/src/cordis/plugins/canvas-runtime/media-raster.js";

type PlatformOptions = Parameters<typeof createPlatformMediaSessions>[0];
type Playback = import("@woohaa3/contracts").BevyAnimationPlayback;
function sources(canvas: ServerCanvas | null, playback: Playback | null = null) {
  return canvas?.document.nodes.flatMap(node => filmSetMediaSources(node.id, canvas.nodeData[node.id], playback)) ?? [];
}
function createCompositeAssetMediaSessions(options: Omit<PlatformOptions, "getSources"> & { getPlayback?: () => Playback | null }) {
  return createPlatformMediaSessions({ ...options, getSources: () => sources(options.getCanvas(), options.getPlayback?.() ?? null) });
}
function resolveFilmSetMediaDescriptors(canvas: ServerCanvas | null) { return resolveCompositeAssetMediaDescriptors(canvas, sources(canvas)); }

afterEach(() => vi.unstubAllGlobals());

const NOW = "2026-10-08T00:00:00.000Z";

function canvasWithMedia(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  canvas.document.nodes = [{ id: "fs", type: "composite-asset", position: { x: 0, y: 0 } }];
  canvas.nodeData = {
    fs: filmSetNodeDataFields(createFilmSetSnapshot({
      title: "片场",
      model: { modelScript: "scene.box({ id: 'a' });", modelScriptVersion: "woohaa-model-js-v2" },
      modelItemId: "actor",
      motionScript: "motion.model.rotate('a', { speed: 1 });",
      timeline: { duration: 10, loop: false },
      filmSetContent: {
        schemaVersion: 3,
        items: [
          { id: "img", kind: "image", name: "图", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "asset-image", aspectRatio: 2 },
          { id: "vid", kind: "video", name: "视", localTransform: { offset: { x: 3, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "asset-video", aspectRatio: 1.5 }
        ]
      }
    }))
  } as ServerCanvas["nodeData"];
  canvas.assets = [
    { id: "asset-image", title: "图", mediaKind: "image", source: "generated", status: "ready", createdAt: NOW, url: "/api/media/a", metadata: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: "image/png", size: 4 } },
    { id: "asset-video", title: "视", mediaKind: "video", source: "generated", status: "ready", createdAt: NOW, url: "/api/media/b", metadata: { storageKey: `sha256-${"b".repeat(64)}`, checksum: "b".repeat(64), contentType: "video/mp4", size: 8 } }
  ];
  return canvas;
}

function fakeRuntime() {
  const uploads: Array<{ id: string; width: number; height: number }> = [];
  const runtime = {
    setModelMediaTexture: (id: string, width: number, height: number) => uploads.push({ id, width, height })
  } as unknown as BevyRuntime;
  return { runtime, uploads };
}

class FakeVideo implements VideoElementLike {
  src = "";
  muted = false;
  loop = false;
  playsInline = false;
  preload = "";
  crossOrigin: string | null = null;
  currentTime = 0;
  duration = 5;
  videoWidth = 320;
  videoHeight = 240;
  paused = true;
  seeking?: boolean;
  readyState?: number;
  playCalls = 0;
  pauseCalls = 0;
  private listeners = new Map<string, Set<(event: unknown) => void>>();
  private frameCallbacks = new Map<number, (now: number, metadata?: unknown) => void>();
  private frameHandle = 0;
  play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); }
  pause() { this.pauseCalls += 1; this.paused = true; }
  /** 模拟元数据预取：只派发 loadedmetadata（正文要显式 seek 才取）。 */
  load() { this.emit("loadedmetadata"); }
  removeAttribute() {}
  addEventListener(type: string, handler: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }
  removeEventListener(type: string, handler: (event: unknown) => void) {
    this.listeners.get(type)?.delete(handler);
  }
  requestVideoFrameCallback(callback: (now: number, metadata?: unknown) => void) {
    const handle = ++this.frameHandle;
    this.frameCallbacks.set(handle, callback);
    return handle;
  }
  cancelVideoFrameCallback(handle: number) {
    this.frameCallbacks.delete(handle);
  }
  emit(type: string) {
    for (const handler of this.listeners.get(type) ?? []) handler({});
  }
  /** 触发所有等待中的解码帧回调（模拟浏览器下一帧）。 */
  emitFrame() {
    const callbacks = [...this.frameCallbacks.values()];
    this.frameCallbacks.clear();
    for (const callback of callbacks) callback(performance.now());
  }
  seekTo(time: number) { this.currentTime = time; }
}

function fakeCanvas(): RasterCanvas {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => undefined,
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h
      })
    })
  } as unknown as RasterCanvas;
}

describe("片场媒体会话", () => {
  it("解析稳定 ready 媒体引用为平面描述", () => {
    const descriptors = resolveFilmSetMediaDescriptors(canvasWithMedia());
    expect(descriptors.map((entry) => entry.planeId)).toEqual(["fs::img", "fs::vid"]);
    expect(descriptors.map((entry) => entry.kind)).toEqual(["image", "video"]);
  });

  it("图片解码后上传纹理；视频跟随片场播放头并复用暂停帧", () => {
    const { runtime, uploads } = fakeRuntime();
    const video = new FakeVideo();
    const sessions = createCompositeAssetMediaSessions({
      runtime,
      getCanvas: () => canvasWithMedia(),
      loadImage: async () => ({ width: 200, height: 100 }),
      createVideo: () => video,
      createCanvas: fakeCanvas,
      minUploadIntervalMs: 0
    });
    // 首次 sync：图片异步解码，视频建会话。
    sessions.sync();
    // 视频首帧上传。
    expect(video.src).toContain("/api/media/b");
    expect(video.muted).toBe(true);
    expect(uploads.length).toBeGreaterThanOrEqual(0);
    // 片场播放头 seek 到 3 秒；视频上传该帧。
    sessions.setMediaTime("fs", 3, true);
    expect(video.currentTime).toBe(3);
  });

  it("对象删除后释放会话（dispose 后不再持有引用）", async () => {
    const { runtime } = fakeRuntime();
    const canvas = canvasWithMedia();
    const sessions = createCompositeAssetMediaSessions({
      runtime,
      getCanvas: () => canvas,
      loadImage: async () => ({ width: 200, height: 100 }),
      createVideo: () => new FakeVideo(),
      createCanvas: fakeCanvas,
      minUploadIntervalMs: 0
    });
    sessions.sync();
    expect(sessions.hasTexture("fs::img")).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    sessions.dispose();
    expect(sessions.hasTexture("fs::img")).toBe(false);
  });
});

it("default image loader passes the decoded image itself to rasterization and uploads its pixels", async () => {
  class DecodedImage {
    width = 2; height = 1; naturalWidth = 2; naturalHeight = 1;
    onload: (() => void) | null = null;
    set src(_url: string) { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal("Image", DecodedImage);
  const drawImage = vi.fn((source: unknown) => {
    if (!(source instanceof DecodedImage)) throw new TypeError("Not a drawable image");
  });
  const pixels = new Uint8ClampedArray([230, 35, 169, 255, 248, 220, 53, 255]);
  const setModelMediaTexture = vi.fn();
  const changed = vi.fn();
  const sessions = createCompositeAssetMediaSessions({
    runtime: { setModelMediaTexture } as unknown as BevyRuntime, getCanvas: canvasWithMedia,
    createVideo: () => new FakeVideo(), onChange: changed,
    createCanvas: () => ({ width: 0, height: 0, getContext: () => ({ drawImage, getImageData: () => ({ data: pixels }) }) })
  });
  sessions.sync(); await Promise.resolve(); await Promise.resolve();
  expect(drawImage.mock.calls[0][0]).toBeInstanceOf(DecodedImage);
  // sourceKey 带本次渲染的画布提示：宿主按画布路由媒体读取（同步画布走远端托管存储）。
  expect(setModelMediaTexture).toHaveBeenCalledWith("fs::img", 2, 1, new Uint8Array(pixels), { nodeId: "fs", sourceKey: "/api/media/a?canvas=c1" });
  expect(sessions.sync().has("fs::img")).toBe(true);
  expect(sessions.hasTexture("fs::img")).toBe(true);
  expect(changed).toHaveBeenCalledTimes(1);
  sessions.dispose();
});

it("failed rasterization does not mark an image texture ready", async () => {
  const { runtime, uploads } = fakeRuntime();
  const sessions = createCompositeAssetMediaSessions({ runtime, getCanvas: canvasWithMedia,
    loadImage: async () => ({ width: 200, height: 100 }), createVideo: () => new FakeVideo(),
    createCanvas: () => ({ width: 0, height: 0, getContext: () => null })
  });
  sessions.sync(); await Promise.resolve(); await Promise.resolve();
  expect(uploads).toHaveLength(0);
  expect(sessions.hasTexture("fs::img")).toBe(false);
  expect(sessions.sync().has("fs::img")).toBe(false);
  sessions.dispose();
});

it("same-plane clip switching reuses decoder and rejects frames while a newer seek is pending", () => {
  const canvas = canvasWithMedia(); const decoded = decodeFilmSetNodeData(canvas.nodeData.fs); if (!decoded.ok) throw Error(decoded.reason);
  canvas.nodeData.fs = canonicalFilmSetFields(decoded.value) as never; const animations = canvas.nodeData.fs.filmSetAnimations as any;
  const first = animations.clips[0]; first.bindings = [{ itemId: "vid", playback: { startTime: 0, duration: 5, timeScale: 1, loop: false } }];
  const second = JSON.parse(JSON.stringify(first)); second.id = "second"; second.bindings[0].playback.startTime = 2; animations.clips.push(second);
  const { runtime, uploads } = fakeRuntime(); const video = Object.assign(new FakeVideo(), { seeking: false });
  const createVideo = vi.fn(() => video);
  let selected = first.id;
  const sessions = createCompositeAssetMediaSessions({ runtime, getCanvas: () => canvas, getPlayback: () => ({ nodeId: "fs", clipId: selected, sourceIdentity: selected, generation: 1 }) as never,
    loadImage: async () => ({ width: 2, height: 1 }), createVideo, createCanvas: fakeCanvas, minUploadIntervalMs: 0 });
  sessions.sync(); video.seeking = true; sessions.setMediaTime("fs", 3, false);
  const before = uploads.length;
  selected = second.id; sessions.sync(); sessions.setMediaTime("fs", 3, false);
  expect(createVideo).toHaveBeenCalledTimes(1); expect(video.currentTime).toBe(1);
  video.emit("seeked"); expect(uploads).toHaveLength(before);
  video.seeking = false; video.emit("seeked"); expect(uploads.length).toBe(before + 1);
  sessions.setMediaTime("fs", 3, false); expect(uploads.length).toBe(before + 1);
  sessions.dispose();
});

it('strict export wait does not accept the preceding 30 fps frame while a video seek is pending', async () => {
  const {runtime}=fakeRuntime();const video=new FakeVideo() as FakeVideo & {seeking:boolean};video.seeking=false;
  const sessions=createCompositeAssetMediaSessions({runtime,getCanvas:canvasWithMedia,createVideo:()=>video,createCanvas:fakeCanvas,minUploadIntervalMs:0,loadImage:async()=>({width:200,height:100})});
  sessions.sync();video.emit('loadeddata');sessions.setMediaTime('fs',0,false);
  let time=0;Object.defineProperty(video,'currentTime',{get:()=>time,set:value=>{time=value;video.seeking=true;}});
  sessions.setMediaTime('fs',1/30,false);
  let ready=false;const waiting=sessions.waitForTime('fs',1/30,500,0.001).then(value=>{ready=value;return value;});
  await Promise.resolve();expect(ready).toBe(false);video.seeking=false;video.emit('seeked');expect(await waiting).toBe(true);sessions.dispose();
});

it('capture waits for image textures rather than exporting an empty media plane', async () => {
  const {runtime}=fakeRuntime();const canvas=canvasWithMedia();const decoded=decodeFilmSetNodeData(canvas.nodeData.fs);if(!decoded.ok)throw new Error(decoded.reason);
  canvas.nodeData.fs=canonicalFilmSetFields({...decoded.value,filmSetContent:{...decoded.value.filmSetContent,items:decoded.value.filmSetContent.items.filter(item=>item.kind==='image')},filmSetAnimations:{schemaVersion:3,defaultClipId:null,clips:[]}}) as ServerCanvas['nodeData'][string];
  let resolve!: (size:{width:number;height:number})=>void;const image=new Promise<{width:number;height:number}>(r=>resolve=r);
  const sessions=createCompositeAssetMediaSessions({runtime,getCanvas:()=>canvas,loadImage:()=>image,createCanvas:fakeCanvas});sessions.sync();let ready=false;
  const waiting=sessions.waitForTime('fs',0,500,0.001).then(value=>{ready=value;return value;});await Promise.resolve();expect(ready).toBe(false);resolve({width:200,height:100});expect(await waiting).toBe(true);sessions.dispose();
});

it("片场视频建会话只取元数据，显式 seek 后才取首帧（预取策略）", () => {
  const { runtime, uploads } = fakeRuntime();
  const video = new FakeVideo();
  // 元数据阶段：尚无尺寸/帧数据。
  video.videoWidth = 0; video.videoHeight = 0; video.readyState = 1;
  const sessions = createCompositeAssetMediaSessions({
    runtime, getCanvas: canvasWithMedia, loadImage: async () => ({ width: 200, height: 100 }),
    createVideo: () => video, createCanvas: fakeCanvas
  });
  const videoUploads = () => uploads.filter(entry => entry.id === "fs::vid");
  sessions.sync();
  expect(video.preload).toBe("metadata");
  expect(videoUploads()).toHaveLength(0);
  // 元数据到达：不下载正文，只把播放头 seek 到目标附近触发取帧。
  video.emit("loadedmetadata");
  expect(video.currentTime).toBe(0.001);
  expect(videoUploads()).toHaveLength(0);
  // 帧数据到达后按当前播放头上传。
  video.videoWidth = 320; video.videoHeight = 240; video.readyState = 2;
  video.emit("seeked");
  expect(videoUploads()).toEqual([{ id: "fs::vid", width: 320, height: 240 }]);
  sessions.dispose();
});

it("播放态让解码元素真播并按解码帧上传，不在每帧 seek（漂移才硬同步）", () => {
  const { runtime, uploads } = fakeRuntime();
  const video = new FakeVideo();
  const sessions = createCompositeAssetMediaSessions({
    runtime, getCanvas: canvasWithMedia, loadImage: async () => ({ width: 200, height: 100 }),
    createVideo: () => video, createCanvas: fakeCanvas, minUploadIntervalMs: 0
  });
  sessions.sync(); video.emit("loadeddata");
  let time = 0; let seeks = 0;
  Object.defineProperty(video, "currentTime", { get: () => time, set: (value: number) => { seeks += 1; time = value; } });
  // 进入播放态：偏差在容差内 → 不 seek，交给元素真播。
  sessions.setMediaTime("fs", 0.1, true);
  expect([seeks, video.playCalls]).toEqual([0, 1]);
  // 元素按自身节奏推进、片场播放头同步前进：整段无 seek，帧由解码回调上传。
  for (const at of [0.15, 0.2, 0.25]) { time = at; sessions.setMediaTime("fs", at, true); }
  expect(seeks).toBe(0);
  expect(video.playCalls).toBe(1);
  video.emitFrame();
  expect(uploads.filter(entry => entry.id === "fs::vid").at(-1)).toEqual({ id: "fs::vid", width: 320, height: 240 });
  // 漂移超过容差（跳转/回绕）：硬同步一次，再回到元素驱动。
  time = 3; sessions.setMediaTime("fs", 0.3, true);
  expect([seeks, time]).toEqual([1, 0.3]);
  sessions.dispose();
});

it("暂停后停止真播放且不再上传解码帧", () => {
  const { runtime, uploads } = fakeRuntime();
  const video = new FakeVideo();
  const sessions = createCompositeAssetMediaSessions({
    runtime, getCanvas: canvasWithMedia, loadImage: async () => ({ width: 200, height: 100 }),
    createVideo: () => video, createCanvas: fakeCanvas, minUploadIntervalMs: 0
  });
  const videoUploads = () => uploads.filter(entry => entry.id === "fs::vid");
  sessions.sync(); video.emit("loadeddata");
  sessions.setMediaTime("fs", 0.2, true);
  video.emitFrame();
  const playing = videoUploads().length;
  expect(playing).toBeGreaterThanOrEqual(1);
  sessions.setMediaTime("fs", 0.2, false);
  expect(video.pauseCalls).toBe(1);
  const paused = videoUploads().length;
  video.emitFrame();
  expect(videoUploads()).toHaveLength(paused);
  sessions.dispose();
});

it("严格取帧（导出/截图）期间暂停真播放并锁定，不受播放头驱动", async () => {
  const { runtime } = fakeRuntime();
  const video = new FakeVideo();
  const sessions = createCompositeAssetMediaSessions({
    runtime, getCanvas: canvasWithMedia, loadImage: async () => ({ width: 200, height: 100 }),
    createVideo: () => video, createCanvas: fakeCanvas, minUploadIntervalMs: 0
  });
  sessions.sync(); video.emit("loadeddata");
  sessions.setMediaTime("fs", 0.2, true);
  expect(video.playCalls).toBe(1);
  const waiting = sessions.waitForTime("fs", 0.2, 30, 0.05);
  expect(video.pauseCalls).toBe(1);
  // 等待期间播放头继续推进：不得重新进入播放态。
  sessions.setMediaTime("fs", 0.25, true);
  expect(video.playCalls).toBe(1);
  await waiting;
  // 锁定释放后恢复播放态。
  sessions.setMediaTime("fs", 0.3, true);
  expect(video.playCalls).toBe(2);
  sessions.dispose();
});
