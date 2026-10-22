/**
 * 视频聚焦会话行为测试
 * （change: 2026-10-10-add-video-node-focus-workspace，任务 5.1）。
 *
 * 用注入的 fake 解码元素与光栅 canvas 验证：
 * - 初始暂停、真实帧有界上传与取景投影；
 * - 换源/退出后的迟到回调被 generation 丢弃；
 * - 历史 override 只读切换与清除后恢复当前来源；
 * - dispose 释放媒体源、清投影/纹理并恢复进入前视口。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { VideoFocusSession, fitZoomFor } from "./session.js";
import { nodeImageRect, overviewImageView, type FocusViewport } from "../../focus/media-transition.js";
import type { VideoFocusTarget } from "./targets.js";
import type { VideoElementLike } from "../canvas-runtime/video-frame-session.js";
import type { RasterCanvas } from "../canvas-runtime/media-raster.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fakeVideo(): VideoElementLike & {
  handlers: Map<string, Array<(event: unknown) => void>>;
  fire: (type: string) => void;
  srcValue: string;
  paused: boolean;
  loadCalls: number;
} {
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  const video = {
    src: "",
    muted: false,
    loop: false,
    playsInline: false,
    preload: "",
    crossOrigin: null as string | null,
    currentTime: 0,
    duration: 2,
    videoWidth: 160,
    videoHeight: 90,
    paused: true,
    ended: false,
    readyState: 4,
    seeking: false,
    loadCalls: 0,
    handlers,
    play() { video.paused = false; return Promise.resolve(); },
    pause() { video.paused = true; },
    load() { video.loadCalls += 1; },
    removeAttribute() { /* noop */ },
    addEventListener(type: string, handler: (event: unknown) => void) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    removeEventListener(type: string, handler: (event: unknown) => void) {
      handlers.set(type, (handlers.get(type) ?? []).filter((entry) => entry !== handler));
    },
    requestVideoFrameCallback(callback: (now: number, metadata?: unknown) => void) {
      return handlers.set("rfvc", [...(handlers.get("rfvc") ?? []), callback as never]) as unknown as number;
    },
    cancelVideoFrameCallback() { /* noop */ },
    fire(type: string) {
      for (const handler of handlers.get(type) ?? []) handler({});
    },
    get srcValue() { return video.src; }
  };
  return video as never;
}

function fakeCanvas(): RasterCanvas {
  return {
    width: 1,
    height: 1,
    getContext: () => ({
      drawImage: () => undefined,
      getImageData: (_x, _y, w, h) => ({ data: new Uint8Array(w * h * 4) })
    })
  };
}

function target(url = "/api/media/sha256-video"): VideoFocusTarget {
  return {
    canvas: {} as never,
    nodeId: "vid1",
    asset: { id: "v1", mediaKind: "video", status: "ready", metadata: { storageKey: "sha256-video" } } as never,
    url,
    posterUrl: null
  };
}

function videoCanvas() {
  const canvas = createEmptyWoohaa3ServerCanvas("test", "2026-10-10T00:00:00Z");
  canvas.document.nodes.push({ id: "vid1", type: "video", position: { x: 300, y: 400 }, width: 248, height: 232 });
  return canvas;
}

function makeSession(overrides: Partial<ConstructorParameters<typeof VideoFocusSession>[0]> = {}) {
  const video = fakeVideo();
  const textures: Array<{ nodeId: string; width: number; height: number } | null> = [];
  const projections: Array<{ nodeId: string; viewport: { zoom: number } } | null> = [];
  const restored: Array<{ x: number; y: number; zoom: number }> = [];
  const session = new VideoFocusSession({
    nodeId: "vid1",
    target: target(),
    getCanvas: () => null,
    rect: { x: 0, y: 0, width: 800, height: 600 },
    createVideo: () => video,
    createCanvas: fakeCanvas,
    setProjection: (projection) => projections.push(projection as never),
    onTexture: (texture) => textures.push(texture),
    savedViewport: { x: 5, y: 6, zoom: 1.5 },
    restoreViewport: (viewport) => restored.push(viewport),
    minUploadIntervalMs: 0,
    now: () => 0,
    ...overrides
  });
  return { session, video, textures, projections, restored };
}

describe("视频聚焦会话", () => {
  it.each([24, 30, 60])("默认聚焦上传保留 %ifps 帧，容忍回调抖动与上传耗时", (fps) => {
    let clock = 1000;
    const textures: unknown[] = [];
    const { session } = makeSession({
      minUploadIntervalMs: undefined,
      now: () => clock,
      onTexture: (texture) => {
        textures.push(texture);
        clock += 4;
      }
    });
    session.start();
    for (let frame = 0; frame < 60; frame += 1) {
      clock = 1000 + frame * (1000 / fps) + (frame % 2 ? -0.4 : 0);
      session.pumpFrame(1); // start() 创建的首个来源 generation。
    }
    expect(textures.filter(Boolean)).toHaveLength(60);
    session.dispose();
  });

  it("进入即绑定自身输出并暂停，首帧解码前不切换取景", () => {
    const { session, video, projections } = makeSession();
    expect(session.start()).toBe(true);
    expect(video.src).toBe("/api/media/sha256-video");
    expect(video.muted).toBe(true);
    expect(video.paused).toBe(true);
    video.fire("loadedmetadata");
    session.setRect({ x: 64, y: 56, width: 700, height: 500 });
    expect(projections).toHaveLength(0);
    video.fire("loadeddata");
    expect(projections.at(-1)).toMatchObject({ nodeId: "vid1" });
    expect(session.state().playing).toBe(false);
  });

  it("真实帧按有界尺寸上传并在换源后丢弃迟到帧", () => {
    const { session, video, textures } = makeSession();
    session.start();
    video.fire("loadeddata");
    const first = textures.at(-1);
    expect(first).toMatchObject({ nodeId: "vid1" });
    // 换源（history override）：旧 generation 的迟到 seeked/rfvc 不得写纹理。
    const before = textures.length;
    session.setHistoryOverride({ url: "/api/media/sha256-history" });
    video.fire("seeked");
    expect(textures.length).toBe(before);
  });

  it("历史 override 只读切换，清除后恢复当前来源并暂停", () => {
    const { session, video } = makeSession();
    session.start();
    session.setHistoryOverride({ url: "/api/media/sha256-history" });
    expect(session.isHistory()).toBe(true);
    expect(video.src).toBe("/api/media/sha256-history");
    session.setHistoryOverride(null);
    expect(session.isHistory()).toBe(false);
    expect(video.src).toBe("/api/media/sha256-video");
    expect(video.paused).toBe(true);
  });

  it("历史 override 加载完成后上传历史画面纹理（中央切换来源）", () => {
    const { session, video, textures } = makeSession();
    session.start();
    video.fire("loadeddata");
    const directTextures = textures.length;
    session.setHistoryOverride({ url: "/api/media/sha256-history" });
    video.fire("loadeddata");
    // 历史来源同样上传真实帧（generation 为当前历史一代）。
    expect(textures.length).toBeGreaterThan(directTextures);
    expect(textures.at(-1)).toMatchObject({ nodeId: "vid1" });
    // 清除 override 后重载当前来源并再次上传 direct 画面。
    const beforeReturn = textures.length;
    session.setHistoryOverride(null);
    video.fire("loadeddata");
    expect(textures.length).toBeGreaterThan(beforeReturn);
    expect(session.state().historyUrl).toBeNull();
  });

  it("setTarget 换 canonical 来源时丢弃旧来源迟到帧并重新上传", () => {
    const { session, video, textures } = makeSession();
    session.start();
    video.fire("loadeddata");
    const before = textures.length;
    session.setTarget({
      ...target("/api/media/sha256-video-2"),
      nodeId: "vid1"
    });
    // 换源后旧 generation 的迟到 seeked 不写纹理（新 loadeddata 才上传）。
    video.fire("seeked");
    expect(textures.length).toBe(before);
    video.fire("loadeddata");
    expect(textures.length).toBeGreaterThan(before);
  });

  it("dispose 释放媒体源、清纹理/投影并恢复进入前视口", () => {
    const { session, video, textures, projections, restored } = makeSession();
    session.start();
    session.dispose();
    expect(video.loadCalls).toBeGreaterThan(0);
    expect(textures.at(-1)).toBeNull();
    expect(projections.at(-1)).toBeNull();
    expect(restored).toEqual([{ x: 5, y: 6, zoom: 1.5 }]);
  });

  it("适应窗口缩放保持视频比例", () => {
    expect(fitZoomFor(160, 90, { width: 800, height: 600 })).toBeCloseTo(5, 5);
    expect(fitZoomFor(90, 160, { width: 800, height: 600 })).toBeCloseTo(3.75, 5);
  });

  it("进入聚焦从节点卡片位置放大推进到适应窗口（首帧与卡片像素对齐）", () => {
    const canvas = videoCanvas();
    const { session, video, projections } = makeSession({ getCanvas: () => canvas, transitionDuration: 0 });
    session.start();
    video.fire("loadeddata");
    const rect = { x: 0, y: 0, width: 800, height: 600 };
    const world = nodeImageRect({ x: 300, y: 400, width: 248, height: 232 }, 160, 90);
    const expectedStart = overviewImageView(world, 160, rect, { x: 5, y: 6, zoom: 1.5 });
    // 首帧取景 = 卡片在概览视口下的屏幕位置（不是直接落位适应窗口）。
    const matched = projections.some(projection => projection !== null
      && Math.abs(projection.viewport.zoom - expectedStart.zoom) < 1e-6);
    expect(matched).toBe(true);
    // 末帧 = 适应窗口。
    expect(projections.at(-1)?.viewport).toEqual({ x: 0, y: 0, zoom: 5 });
  });

  it("退出聚焦从当前取景缩回节点卡片位置", async () => {
    const canvas = videoCanvas();
    const { session, video, projections } = makeSession({ getCanvas: () => canvas, transitionDuration: 0 });
    session.start();
    video.fire("loadeddata");
    session.setViewport({ x: 10, y: 20, zoom: 3 });
    await session.animateExit();
    const rect = { x: 0, y: 0, width: 800, height: 600 };
    const world = nodeImageRect({ x: 300, y: 400, width: 248, height: 232 }, 160, 90);
    const expected = overviewImageView(world, 160, rect, { x: 5, y: 6, zoom: 1.5 });
    expect(projections.at(-1)?.viewport).toMatchObject({ x: expect.closeTo(expected.x, 5), y: expect.closeTo(expected.y, 5), zoom: expect.closeTo(expected.zoom, 5) });
  });

  it("seek/未解码帧不上传，避免透明帧覆盖已呈现画面（放大后视频消失）", () => {
    const { session, video, textures } = makeSession();
    session.start();
    video.fire("loadeddata");
    const uploaded = textures.length;
    expect(uploaded).toBeGreaterThan(0);
    // 聚焦首帧前浏览器会 seek 到 0：此处 seeking=true，此时取帧只会得到空白像素。
    (video as unknown as { seeking: boolean }).seeking = true;
    session.pumpFrame(1);
    expect(textures.length).toBe(uploaded);
    (video as unknown as { seeking: boolean }).seeking = false;
    // readyState < 2（HAVE_CURRENT_DATA）同样不足以上传。
    (video as unknown as { readyState: number }).readyState = 1;
    session.pumpFrame(1);
    expect(textures.length).toBe(uploaded);
    (video as unknown as { readyState: number }).readyState = 4;
    session.pumpFrame(1);
    expect(textures.length).toBe(uploaded + 1);
  });

  it("首次取帧被跳过时，seeked 后仍会补上传（不被节流吞掉）", () => {
    let clock = 1000;
    const { session, video, textures } = makeSession({ now: () => clock, minUploadIntervalMs: undefined });
    session.start();
    video.fire("loadeddata");
    const uploaded = textures.length;
    // 进入瞬间 seeking=true：这次取帧被拒绝，且不得占用节流时间窗。
    (video as unknown as { seeking: boolean }).seeking = true;
    clock += 200;
    session.pumpFrame(1);
    expect(textures.length).toBe(uploaded);
    // seek 完成后必须补一帧真实画面：被拒绝的取帧没有推进 lastUploadedAt，因此同一时刻
    // 的 seeked 回调仍能上传（而不是被判为「刚刚上传过」而丢弃）。
    (video as unknown as { seeking: boolean }).seeking = false;
    video.fire("seeked");
    expect(textures.length).toBe(uploaded + 1);
  });

  it("loadeddata 时仍在 seek，canplay 后补上传首帧", () => {
    const { session, video, textures } = makeSession({ minUploadIntervalMs: 0, now: () => 0 });
    session.start();
    (video as unknown as { seeking: boolean }).seeking = true;
    video.fire("loadeddata");
    const uploaded = textures.length;
    // 仍在 seek：没有真实帧可用。
    expect(uploaded).toBe(0);
    (video as unknown as { seeking: boolean }).seeking = false;
    video.fire("canplay");
    expect(textures.length).toBe(uploaded + 1);
  });

  it("进入动画期间内容矩形到达：终点按新矩形重排，画面不被推出可视区", async () => {
    const canvas = videoCanvas();
    // 用可手动推进的过渡端口，模拟「首帧解码」与「焦点布局」不在同一帧到达。
    const requests: Array<{ to: FocusViewport; apply: (view: FocusViewport, progress: number) => void; resolve: (done: boolean) => void }> = [];
    const transition: import("../../focus/media-transition.js").FocusTransitionPort = {
      run: (request) => new Promise<boolean>((resolve) => {
        requests.at(-1)?.resolve(false);
        requests.push({ to: request.to, apply: request.apply, resolve });
      }),
      cancel: () => requests.at(-1)?.resolve(false),
      isActive: () => requests.length > 0
    };
    const wide = { x: 0, y: 0, width: 1400, height: 860 };
    const narrow = { x: 0, y: 56, width: 1000, height: 700 };
    const { session, video } = makeSession({ getCanvas: () => canvas, transition, rect: wide });
    session.start();
    video.fire("loadeddata");
    // 首帧用进入前的全窗口矩形推进。
    expect(requests).toHaveLength(1);
    expect(requests[0]!.to.zoom).toBeCloseTo(fitZoomFor(160, 90, wide), 5);
    // 聚焦布局到达（右侧检查器占用）：必须按新矩形重新推进终点，而不是沿用旧适应值。
    session.setRect(narrow);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.to.zoom).toBeCloseTo(fitZoomFor(160, 90, narrow), 5);
    requests[1]!.apply(requests[1]!.to, 1);
    expect(session.viewportState().zoom).toBeCloseTo(fitZoomFor(160, 90, narrow), 5);
    requests[1]!.resolve(true);
    await Promise.resolve();
  });

  it("退出动画进行中内容矩形变化不打断缩回", async () => {
    const canvas = videoCanvas();
    const pending: Array<{ apply: (view: FocusViewport, progress: number) => void; resolve: (done: boolean) => void }> = [];
    const transition: import("../../focus/media-transition.js").FocusTransitionPort = {
      run: (request) => new Promise<boolean>((resolve) => {
        pending.at(-1)?.resolve(false);
        pending.push({ apply: request.apply, resolve });
      }),
      cancel: () => pending.at(-1)?.resolve(false),
      isActive: () => pending.length > 0
    };
    const { session, video } = makeSession({ getCanvas: () => canvas, transition, transitionDuration: 0 });
    session.start();
    video.fire("loadeddata");
    session.setViewport({ x: 10, y: 20, zoom: 3 });
    const exit = session.animateExit();
    const requests = pending.length;
    session.setRect({ x: 0, y: 0, width: 1200, height: 800 });
    // 退出动画不新增取景请求（终点保持卡片位置），只更新投影/状态。
    expect(pending.length).toBe(requests);
    pending.at(-1)!.resolve(true);
    await exit;
  });

  it("无画布时进入动画直接落位适应窗口", () => {
    const { session, video, projections } = makeSession({ transitionDuration: 0 });
    session.start();
    video.fire("loadeddata");
    expect(projections.at(-1)?.viewport).toEqual({ x: 0, y: 0, zoom: 5 });
  });
});
