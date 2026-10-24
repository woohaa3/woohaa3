/**
 * 画布视频帧会话测试（change: enable-video-node-live-preview，任务 5.2）。
 *
 * 覆盖：首帧替换 poster、循环播放、帧率限制、source generation 迟到防护、
 * 解码失败回退、hover 单会话切换与 dispose 清理。
 */
import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import {
  createVideoFrameSessions,
  resolveNodeVideoSource,
  VIDEO_FRAME_MIN_UPLOAD_INTERVAL_MS,
  type VideoElementLike
} from "./video-frame-session.js";
import type { RasterCanvas } from "./media-raster.js";
import type { BevyRuntime } from "./bevy-runtime.js";

const STORAGE = `sha256-${"a".repeat(64)}`;

function videoCanvas(
  nodes: Array<{ id: string; outputAssetId?: string }>,
  options: { posterUrl?: string; status?: StoredAsset["status"]; mediaKind?: StoredAsset["mediaKind"] } = {}
): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: nodes.map((node) => ({ id: node.id, type: "video", position: { x: 0, y: 0 } })) },
    nodeData: Object.fromEntries(
      nodes.map((node) => [node.id, node.outputAssetId ? { outputAssetId: node.outputAssetId } : {}])
    ) as ServerCanvas["nodeData"],
    assets: nodes
      .filter((node) => node.outputAssetId)
      .map((node) => ({
        id: node.outputAssetId!,
        title: "v",
        mediaKind: options.mediaKind ?? "video",
        source: "generated",
        status: options.status ?? "ready",
        url: `/api/media/${STORAGE}`,
        ...(options.posterUrl ? { posterUrl: options.posterUrl } : {}),
        createdAt: "2026-09-26T00:00:00.000Z",
        metadata: { storageKey: STORAGE, checksum: "a".repeat(64), contentType: "video/mp4", size: 4 }
      }))
  };
}

type FakeVideo = VideoElementLike & {
  emit(type: string): void;
  /** 触发 loadeddata + 模拟渲染帧。 */
  emitLoaded(): void;
  emitFrame(): void;
  playCalls: number;
  pauseCalls: number;
};

function fakeVideo(options: { width?: number; height?: number; duration?: number; rvfc?: boolean; rejectPlay?: boolean } = {}): FakeVideo {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  let rvfcHandle = 0;
  const pendingCallbacks = new Map<number, (now: number) => void>();
  const video: FakeVideo = {
    src: "",
    muted: false,
    loop: false,
    playsInline: false,
    preload: "",
    crossOrigin: null,
    currentTime: 0,
    duration: options.duration ?? 2,
    videoWidth: options.width ?? 160,
    videoHeight: options.height ?? 90,
    playCalls: 0,
    pauseCalls: 0,
    play(this: void) {
      video.playCalls += 1;
      return options.rejectPlay ? Promise.reject(new Error("autoplay blocked")) : Promise.resolve();
    },
    pause() {
      video.pauseCalls += 1;
    },
    removeAttribute() {
      video.src = "";
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    emit(type) {
      for (const handler of listeners.get(type) ?? []) handler({});
    },
    emitLoaded() {
      for (const handler of listeners.get("loadeddata") ?? []) handler({});
    },
    emitFrame() {
      if (options.rvfc === false) return;
      // 触发所有仍在等待的 rvfc 回调（模拟浏览器下一帧）。
      const callbacks = [...pendingCallbacks.entries()];
      pendingCallbacks.clear();
      for (const [, callback] of callbacks) callback(0);
    }
  };
  if (options.rvfc !== false) {
    video.requestVideoFrameCallback = (callback) => {
      const handle = ++rvfcHandle;
      pendingCallbacks.set(handle, callback);
      return handle;
    };
    video.cancelVideoFrameCallback = (handle) => {
      pendingCallbacks.delete(handle);
    };
  }
  return video;
}

function fakeCanvas(): RasterCanvas {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => undefined,
      getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) })
    })
  };
}

function runtimeRecorder(): { runtime: BevyRuntime; uploads: Array<{ id: string; width: number; height: number }> } {
  const uploads: Array<{ id: string; width: number; height: number }> = [];
  const runtime = {
    setTexture: (id: string, width: number, height: number) => uploads.push({ id, width, height })
  } as unknown as BevyRuntime;
  return { runtime, uploads };
}

describe("resolveNodeVideoSource", () => {
  it("只解析节点自身的 ready 视频输出（带画布读提示）", () => {
    const canvas = videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]);
    expect(resolveNodeVideoSource(canvas, "n1")).toEqual({ url: `/api/media/${STORAGE}?canvas=c1`, posterUrl: null });
  });

  it("未 ready / 非视频 / 缺 output / 非受控 URL 时拒绝", () => {
    expect(resolveNodeVideoSource(videoCanvas([{ id: "n1", outputAssetId: "asset-1" }], { status: "generating" }), "n1")).toBeNull();
    expect(resolveNodeVideoSource(videoCanvas([{ id: "n1", outputAssetId: "asset-1" }], { mediaKind: "image" }), "n1")).toBeNull();
    expect(resolveNodeVideoSource(videoCanvas([{ id: "n1" }]), "n1")).toBeNull();
    const external = videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]);
    external.assets = external.assets.map((asset) => ({ ...asset, url: "https://evil.example/v.mp4" }));
    expect(resolveNodeVideoSource(external, "n1")).toBeNull();
  });
});

describe("createVideoFrameSessions", () => {
  it("异步解码帧上传异常不会抛到浏览器；同源不重复失败，其他视频及重试仍工作", () => {
    const videos: FakeVideo[] = [];
    let rejected = true;
    let retryVersion = 0;
    const upload = vi.fn((id: string) => { if (id === "bad" && rejected) throw "Invalid texture"; });
    const report = vi.fn();
    const sessions = createVideoFrameSessions({
      runtime: { setTexture: upload, retryVersion: () => retryVersion, reportRuntimeIssue: report } as unknown as BevyRuntime,
      getCanvas: () => videoCanvas([{ id: "bad", outputAssetId: "a" }, { id: "good", outputAssetId: "b" }]),
      createVideo: () => { const video = fakeVideo(); videos.push(video); return video; },
      createCanvas: fakeCanvas, minUploadIntervalMs: 0
    });
    sessions.sync();
    for (const video of videos) { video.emitLoaded(); expect(() => video.emitFrame()).not.toThrow(); }
    expect(sessions.hasRealFrame("bad")).toBe(false);
    expect(sessions.hasRealFrame("good")).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    sessions.setHovered("bad");
    for (let frame = 0; frame < 3; frame++) expect(() => videos[0].emitFrame()).not.toThrow();
    expect(upload.mock.calls.filter(call => call[0] === "bad")).toHaveLength(1);
    rejected = false; retryVersion++; sessions.sync();
    expect(sessions.hasRealFrame("bad")).toBe(true);
    sessions.dispose();
  });

  it("已有视频在首帧和播放缓冲期间显示加载中，解码就绪、失败或删除后结束", () => {
    const { runtime } = runtimeRecorder();
    let canvas = videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]);
    const videos: FakeVideo[] = [];
    const sessions = createVideoFrameSessions({
      runtime, getCanvas: () => canvas,
      createVideo: () => { const video = fakeVideo(); videos.push(video); return video; },
      createCanvas: fakeCanvas, minUploadIntervalMs: 0
    });
    sessions.sync();
    expect(sessions.isLoading?.("n1")).toBe(true);
    videos[0].emitLoaded();
    expect(sessions.isLoading?.("n1")).toBe(true);
    videos[0].emitFrame();
    expect(sessions.isLoading?.("n1")).toBe(false);
    sessions.setHovered("n1");
    videos[0].emit("waiting");
    expect(sessions.isLoading?.("n1")).toBe(true);
    videos[0].emitFrame();
    expect(sessions.isLoading?.("n1")).toBe(false);
    canvas = { ...canvas, assets: canvas.assets.map(asset => ({ ...asset, url: "/api/media/sha256-replacement" })) };
    sessions.sync();
    expect(sessions.isLoading?.("n1")).toBe(true);
    videos[0].emit("error"); // 已被替换的解码器不能清除新来源的等待状态。
    expect(sessions.isLoading?.("n1")).toBe(true);
    videos[1].emit("error");
    expect(sessions.isLoading?.("n1")).toBe(false);
    canvas = { ...canvas, document: { ...canvas.document, nodes: [] } };
    sessions.sync();
    expect(sessions.isLoading?.("n1")).toBe(false);
    sessions.dispose();
  });
  it("退出图片聚焦不重新读取或上传未被覆盖的视频帧", () => {
    const { runtime, uploads } = runtimeRecorder();
    const video = fakeVideo();
    let focused = false;
    const sessions = createVideoFrameSessions({
      runtime, getCanvas: () => videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]),
      isSuspended: () => focused, createVideo: () => video, createCanvas: fakeCanvas
    });
    sessions.sync(); video.emitLoaded(); video.emitFrame();
    expect(sessions.hasRealFrame("n1")).toBe(true);
    const before = uploads.length;
    focused = true; sessions.sync();
    focused = false; sessions.sync();
    expect(uploads).toHaveLength(before);
    sessions.dispose();
  });

  it("视频聚焦退出只恢复被覆盖节点，不刷新其他视频", () => {
    const { runtime, uploads } = runtimeRecorder();
    const videos = [fakeVideo(), fakeVideo()];
    let focused = false, next = 0;
    const sessions = createVideoFrameSessions({
      runtime, getCanvas: () => videoCanvas([{ id: "n1", outputAssetId: "asset-1" }, { id: "n2", outputAssetId: "asset-2" }]),
      isSuspended: () => focused,
      getFocusTextureNodeId: () => focused ? "n1" : null,
      createVideo: () => videos[next++], createCanvas: fakeCanvas
    });
    sessions.sync();
    for (const video of videos) { video.emitLoaded(); video.emitFrame(); }
    expect(sessions.hasRealFrame("n1")).toBe(true);
    expect(sessions.hasRealFrame("n2")).toBe(true);
    const before = uploads.length;
    focused = true; sessions.sync();
    focused = false; sessions.sync();
    expect(uploads.slice(before).map(upload => upload.id)).toEqual(["n1"]);
    sessions.dispose();
  });

  it("已有封面的节点退出图片聚焦不补抓真实帧", async () => {
    const { runtime, uploads } = runtimeRecorder();
    let focused = false;
    const video = fakeVideo();
    const sessions = createVideoFrameSessions({
      runtime, getCanvas: () => videoCanvas([{ id: "n1", outputAssetId: "asset-1" }], { posterUrl: `/api/media/sha256-${"b".repeat(64)}` }),
      isSuspended: () => focused, createVideo: () => video, createCanvas: fakeCanvas,
      loadPosterImage: async () => ({ width: 80, height: 45 })
    });
    sessions.sync(); await Promise.resolve();
    expect(uploads).toHaveLength(1);
    expect(sessions.hasRealFrame("n1")).toBe(false);
    focused = true; sessions.sync();
    focused = false; sessions.sync();
    expect(uploads).toHaveLength(1);
    sessions.dispose();
  });

  it("多个待恢复视频分帧处理，不在退出的一帧内全部上传", () => {
    const { runtime, uploads } = runtimeRecorder();
    let focused = true;
    const sessions = createVideoFrameSessions({
      runtime, getCanvas: () => videoCanvas([{ id: "n1", outputAssetId: "asset-1" }, { id: "n2", outputAssetId: "asset-2" }]),
      isSuspended: () => focused, createVideo: () => fakeVideo(), createCanvas: fakeCanvas
    });
    sessions.sync();
    focused = false; sessions.sync();
    expect(uploads.map(upload => upload.id)).toEqual(["n1"]);
    focused = true; sessions.sync();
    expect(uploads).toHaveLength(1);
    focused = false; sessions.sync();
    expect(uploads.map(upload => upload.id)).toEqual(["n1", "n2"]);
    sessions.sync(); expect(uploads).toHaveLength(2);
    sessions.dispose();
  });

  it("聚焦接管纹理时停止 hover 并丢弃迟到首帧，退出恢复 canonical 帧且可再次 hover", () => {
    const { runtime, uploads } = runtimeRecorder();
    const video = fakeVideo();
    let focused = false;
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]),
      isSuspended: () => focused,
      getFocusTextureNodeId: () => focused ? "n1" : null,
      createVideo: () => video,
      createCanvas: fakeCanvas,
      minUploadIntervalMs: 0
    });
    sessions.sync();
    video.emitLoaded();
    focused = true;
    sessions.sync();
    video.emitFrame();
    expect(uploads).toHaveLength(0);
    sessions.setHovered("n1");
    expect(video.playCalls).toBe(0);

    focused = false;
    sessions.sync();
    expect(uploads).toHaveLength(1);
    sessions.setHovered("n1");
    expect(sessions.playingNodeId()).toBe("n1");
    focused = true;
    sessions.sync();
    expect(sessions.playingNodeId()).toBeNull();
    expect(video.pauseCalls).toBe(1);
    const before = uploads.length;
    video.emitFrame();
    expect(uploads).toHaveLength(before);
    focused = false;
    sessions.sync();
    expect(uploads).toHaveLength(before + 1);
    sessions.setHovered("n1");
    video.emitFrame();
    expect(video.playCalls).toBe(2);
    expect(uploads).toHaveLength(before + 2);
    sessions.dispose();
  });

  it("普通静态卡片优先保留 poster；hover 取真实帧后替换 poster 回退", async () => {
    const { runtime } = runtimeRecorder();
    const poster = { width: 80, height: 45 };
    const video = fakeVideo();
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => videoCanvas([{ id: "n1", outputAssetId: "asset-1" }], { posterUrl: `/api/media/sha256-${"b".repeat(64)}` }),
      createVideo: () => video,
      createCanvas: fakeCanvas,
      loadPosterImage: async () => poster
    });
    sessions.sync();
    // 异步 poster 回退：尚未有真实帧。
    expect(sessions.hasRealFrame("n1")).toBe(false);
    // poster 已有：静态卡片不抢首帧名额，metadata/loadeddata 不触发取帧（change: 2026-10-23，任务 3.3）。
    video.emitLoaded();
    video.emitFrame();
    expect(sessions.hasRealFrame("n1")).toBe(false);
    expect(sessions.diagnostics?.().staticActive).toBe(0);
    // hover 是交互需求：此时才按需取真实帧并替换 poster。
    sessions.setHovered("n1");
    video.emitFrame();
    expect(sessions.hasRealFrame("n1")).toBe(true);
    sessions.dispose();
  });

  it("聚焦期间迟到的 poster 不抢写纹理，退出后解码失败仍可恢复 poster", async () => {
    const { runtime, uploads } = runtimeRecorder();
    let focused = false;
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => videoCanvas([{ id: "n1", outputAssetId: "asset-1" }], { posterUrl: `/api/media/sha256-${"b".repeat(64)}` }),
      isSuspended: () => focused,
      createVideo: () => fakeVideo({ width: 0, height: 0 }),
      createCanvas: fakeCanvas,
      loadPosterImage: async () => ({ width: 80, height: 45 })
    });
    sessions.sync();
    focused = true;
    sessions.sync();
    await Promise.resolve();
    expect(uploads).toHaveLength(0);
    focused = false;
    sessions.sync();
    await Promise.resolve();
    expect(uploads).toEqual([{ id: "n1", width: 80, height: 45 }]);
    sessions.dispose();
  });

  it("退出聚焦时换源尚未解码，不把 metadata 就绪误当成可绘制帧", () => {
    const { runtime, uploads } = runtimeRecorder();
    const video = Object.assign(fakeVideo(), { readyState: 1 });
    let focused = true;
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]),
      isSuspended: () => focused,
      createVideo: () => video,
      createCanvas: fakeCanvas
    });
    sessions.sync();
    focused = false;
    sessions.sync();
    expect(uploads).toHaveLength(0);
    video.readyState = 2;
    video.emitLoaded();
    video.emitFrame();
    expect(uploads).toHaveLength(1);
    sessions.dispose();
  });

  it("loadeddata 后 seek 并上传真实首帧", async () => {
    const { runtime, uploads } = runtimeRecorder();
    const video = fakeVideo();
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]),
      createVideo: () => video,
      createCanvas: fakeCanvas
    });
    sessions.sync();
    video.emitLoaded();
    video.emitFrame();
    expect(uploads).toEqual([{ id: "n1", width: 160, height: 90 }]);
    expect(sessions.hasRealFrame("n1")).toBe(true);
    sessions.dispose();
  });

  it("hover 播放、同一时刻最多一个会话，离开暂停并保留最后帧", () => {
    const { runtime, uploads } = runtimeRecorder();
    const videos = new Map<string, FakeVideo>();
    const makeVideo = () => {
      const video = fakeVideo();
      return video;
    };
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () =>
        videoCanvas([
          { id: "n1", outputAssetId: "asset-1" },
          { id: "n2", outputAssetId: "asset-2" }
        ]),
      createVideo: () => {
        const video = makeVideo();
        videos.set(`v${videos.size + 1}`, video);
        return video;
      },
      createCanvas: fakeCanvas,
      minUploadIntervalMs: 0
    });
    sessions.sync();
    const [v1, v2] = [...videos.values()];
    sessions.setHovered("n1");
    expect(v1.playCalls).toBe(1);
    expect(sessions.playingNodeId()).toBe("n1");
    // 从 A 切到 B：A 先暂停。
    sessions.setHovered("n2");
    expect(v1.pauseCalls).toBe(1);
    expect(v2.playCalls).toBe(1);
    expect(sessions.playingNodeId()).toBe("n2");
    // 离开全部：暂停，保留最后帧（纹理不撤销）。
    const uploadsBefore = uploads.length;
    sessions.setHovered(null);
    expect(v2.pauseCalls).toBe(1);
    expect(sessions.playingNodeId()).toBeNull();
    expect(uploads.length).toBe(uploadsBefore);
    sessions.dispose();
  });

  it("帧上传按 minUploadInterval 节流", () => {
    const { runtime, uploads } = runtimeRecorder();
    let clock = 1000;
    const video = fakeVideo();
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]),
      createVideo: () => video,
      createCanvas: fakeCanvas,
      now: () => clock,
      minUploadIntervalMs: VIDEO_FRAME_MIN_UPLOAD_INTERVAL_MS
    });
    sessions.sync();
    sessions.setHovered("n1");
    // 首次帧在 interval 内：不重复上传。
    video.emitFrame();
    const first = uploads.length;
    clock += 5;
    video.emitFrame();
    expect(uploads.length).toBe(first);
    clock += VIDEO_FRAME_MIN_UPLOAD_INTERVAL_MS + 1;
    video.emitFrame();
    expect(uploads.length).toBe(first + 1);
    sessions.dispose();
  });

  it.each([24, 30, 60])("默认上传不跳过 %ifps 的解码帧，容忍回调抖动与上传耗时", (fps) => {
    let clock = 1000;
    const video = fakeVideo();
    const { runtime, uploads } = runtimeRecorder();
    const recordTexture = runtime.setTexture;
    runtime.setTexture = (...args) => {
      recordTexture(...args);
      clock += 4; // 模拟 RGBA 传输耗时。
    };
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]),
      createVideo: () => video,
      createCanvas: fakeCanvas,
      now: () => clock
    });
    sessions.sync();
    sessions.setHovered("n1");
    for (let frame = 0; frame < 60; frame += 1) {
      clock = 1000 + frame * (1000 / fps) + (frame % 2 ? -0.4 : 0);
      video.emitFrame();
    }
    expect(uploads).toHaveLength(60);
    sessions.dispose();
  });

  it("source 替换后迟到帧不覆盖新纹理（generation 防护）", () => {
    const { runtime, uploads } = runtimeRecorder();
    const videos: FakeVideo[] = [];
    let canvas = videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]);
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => canvas,
      createVideo: () => {
        const video = fakeVideo();
        videos.push(video);
        return video;
      },
      createCanvas: fakeCanvas
    });
    sessions.sync();
    const stale = videos[0];
    // 换源：新 asset URL。
    canvas = {
      ...canvas,
      assets: canvas.assets.map((asset) => ({ ...asset, url: `/api/media/sha256-${"c".repeat(64)}` }))
    };
    sessions.sync();
    const fresh = videos[1];
    // 旧会话的迟到帧回调：不得上传。
    stale.emitLoaded();
    stale.emitFrame();
    expect(uploads).toHaveLength(0);
    fresh.emitLoaded();
    fresh.emitFrame();
    expect(uploads).toEqual([{ id: "n1", width: 160, height: 90 }]);
    sessions.dispose();
  });

  it("自动播放被拒时保持静态帧且不报错", async () => {
    const { runtime } = runtimeRecorder();
    const video = fakeVideo({ rejectPlay: true });
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]),
      createVideo: () => video,
      createCanvas: fakeCanvas
    });
    sessions.sync();
    sessions.setHovered("n1");
    await Promise.resolve();
    await Promise.resolve();
    expect(sessions.playingNodeId()).toBeNull();
    sessions.dispose();
  });

  it("reduced-motion 下 hover 不自动播放但保留静态帧", () => {
    const { runtime } = runtimeRecorder();
    const video = fakeVideo();
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]),
      createVideo: () => video,
      createCanvas: fakeCanvas,
      isReducedMotion: () => true
    });
    sessions.sync();
    sessions.setHovered("n1");
    expect(video.playCalls).toBe(0);
    expect(sessions.playingNodeId()).toBeNull();
    sessions.dispose();
  });

  it("节点删除后释放媒体源并阻止迟到帧", () => {
    const { runtime, uploads } = runtimeRecorder();
    const video = fakeVideo();
    let canvas = videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]);
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => canvas,
      createVideo: () => video,
      createCanvas: fakeCanvas
    });
    sessions.sync();
    sessions.setHovered("n1");
    canvas = videoCanvas([]);
    sessions.sync();
    expect(video.src).toBe("");
    const before = uploads.length;
    video.emitFrame();
    expect(uploads.length).toBe(before);
    sessions.dispose();
  });

  it("dispose 后不再上传", () => {
    const { runtime, uploads } = runtimeRecorder();
    const video = fakeVideo();
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]),
      createVideo: () => video,
      createCanvas: fakeCanvas
    });
    sessions.sync();
    sessions.dispose();
    video.emitLoaded();
    video.emitFrame();
    expect(uploads).toHaveLength(0);
  });

  it("多次 hydrate/替换/删除后无会话与元素泄漏（任务 6.2）", () => {
    const { runtime } = runtimeRecorder();
    const videos: FakeVideo[] = [];
    let generation = 0;
    let canvas = videoCanvas([{ id: "n1", outputAssetId: "asset-1" }]);
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => canvas,
      createVideo: () => {
        const video = fakeVideo();
        videos.push(video);
        return video;
      },
      createCanvas: fakeCanvas,
      maxSessions: 2
    });
    // 反复换源 + hydrate：每次应替换旧会话并释放它。
    for (let i = 0; i < 6; i += 1) {
      generation += 1;
      canvas = {
        ...canvas,
        assets: canvas.assets.map((asset) => ({ ...asset, url: `/api/media/sha256-${String(generation).padStart(64, "0")}` }))
      };
      sessions.sync();
    }
    // 只有最新会话存活。
    expect(sessions.activeNodeIds()).toEqual(["n1"]);
    // 所有旧会话都被暂停且移除 src（除当前会话外）。
    const released = videos.slice(0, -1);
    expect(released.every((video) => video.src === "" && video.pauseCalls >= 1)).toBe(true);
    // 删除节点后会话清空。
    canvas = videoCanvas([]);
    sessions.sync();
    expect(sessions.activeNodeIds()).toEqual([]);
    expect(videos.at(-1)!.src).toBe("");
    sessions.dispose();
  });

  it("会话数量超过上限时只创建准入名额内的 decoder（不先建全部再 prune）", () => {
    const { runtime } = runtimeRecorder();
    const videos: FakeVideo[] = [];
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () =>
        videoCanvas([
          { id: "n1", outputAssetId: "asset-1" },
          { id: "n2", outputAssetId: "asset-2" },
          { id: "n3", outputAssetId: "asset-3" }
        ]),
      createVideo: () => {
        const video = fakeVideo();
        videos.push(video);
        return video;
      },
      createCanvas: fakeCanvas,
      maxSessions: 2
    });
    sessions.sync();
    expect(sessions.activeNodeIds()).toEqual(["n1", "n2"]);
    // 关键：超出名额的节点从不创建 decoder（change: 2026-10-23，design D1；旧实现创建 3 个再释放 1 个）。
    expect(videos).toHaveLength(2);
    expect(videos.every((video) => video.src !== "")).toBe(true);
    // 重复同步保持稳定，不会重复创建。
    sessions.sync();
    expect(videos).toHaveLength(2);
    sessions.dispose();
  });

  it("建会话只取元数据，元数据到达即取首帧，只有 hover 会话升为 auto（预取策略）", () => {
    const { runtime, uploads } = runtimeRecorder();
    const videos: FakeVideo[] = [];
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () =>
        videoCanvas([
          { id: "n1", outputAssetId: "asset-1" },
          { id: "n2", outputAssetId: "asset-2" }
        ]),
      createVideo: () => { const video = fakeVideo(); videos.push(video); return video; },
      createCanvas: fakeCanvas
    });
    sessions.sync();
    const [v1, v2] = videos;
    // 建会话不拉正文，也不立即取帧。
    expect([v1.preload, v2.preload]).toEqual(["metadata", "metadata"]);
    expect(uploads).toHaveLength(0);
    // 元数据到达即 seek 首帧并上传，无需等 loadeddata（预取正文只到首帧所需范围）。
    v1.emit("loadedmetadata");
    expect(v1.currentTime).toBe(0.1);
    v1.emitFrame();
    expect(uploads).toEqual([{ id: "n1", width: 160, height: 90 }]);
    expect(sessions.hasRealFrame("n1")).toBe(true);
    // 只有 hover 的那个会话升级预取，其他会话保持元数据。
    sessions.setHovered("n1");
    expect(v1.preload).toBe("auto");
    expect(v2.preload).toBe("metadata");
    expect(v1.playCalls).toBe(1);
    sessions.dispose();
  });
});
