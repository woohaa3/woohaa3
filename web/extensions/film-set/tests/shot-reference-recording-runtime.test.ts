/**
 * 镜头参考录制的生产接线测试（任务 8.4；2026-10-17 缺陷修复）。
 *
 * 回归点：录制驱动**不得**通过 `ctx.filmSetPlayback` 取播放时钟。片场扩展插件没有声明该服务的
 * `inject`，装配时同步触发的第一次录制（正是「进画布时补录」那一次）会抛
 * `cannot get property "filmSetPlayback" without inject`，录制随即失败且原因不可见。
 * 播放时钟必须由扩展装配**显式注入**。
 */
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createShotReferenceRecordDeps,
  type ShotReferencePlaybackPort
} from "../src/authoring/browser/shot-reference-recording-runtime.js";
import type { ShotReferenceRecordTarget } from "../src/authoring/browser/shot-reference-recorder.js";
import type { FilmSetContext } from "../src/integration/browser/context.js";

const target: ShotReferenceRecordTarget = {
  canvasId: "c1",
  filmSetNodeId: "film",
  clipId: "clip-1",
  previewNodeId: "shot-preview:test",
  contentIdentity: "id-a",
  profileKey: "v1-1280x720@30",
  duration: 1,
  aspect: "16:9",
  title: "片场 · 镜头 1",
  width: 320,
  height: 180
};

/** 替身 ctx：任何未列出的服务访问都失败，`filmSetPlayback` 访问复现 inject 错误。 */
function hostileContext(runtime: { isReady: () => boolean; requestCapture: (input: { nodeId: string; generation: number; width?: number; height?: number }) => Promise<{ rgba: Uint8Array; width: number; height: number } | null> }): FilmSetContext {
  const services: Record<string, unknown> = {
    canvasRuntime: {
      runtime: () => runtime,
      compositeAssetMediaSessions: () => ({ waitForTime: async () => true }),
      animationPlaybackState: () => ({ time: 1.5, playing: true })
    },
    canvasState: { getWorkingCanvas: () => null, getCanvas: () => null },
    modelWorkspace: { captureSession: { busy: false }, acquireCapture: async () => () => {} }
  };
  return new Proxy(services, {
    get(store, property) {
      if (property === "filmSetPlayback") throw new Error('cannot get property "filmSetPlayback" without inject');
      if (typeof property === "string" && property in store) return store[property];
      throw new Error(`unexpected service access: ${String(property)}`);
    }
  }) as unknown as FilmSetContext;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createShotReferenceRecordDeps（生产接线）", () => {
  function fixture() {
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
    const requestCapture = vi.fn(async () => ({ rgba: new Uint8Array(4), width: 320, height: 180 }));
    const playback: ShotReferencePlaybackPort = {
      seek: vi.fn(),
      play: vi.fn(),
      beginCaptureSession: vi.fn(),
      endCaptureSession: vi.fn()
    };
    const deps = createShotReferenceRecordDeps({
      ctx: hostileContext({ isReady: () => true, requestCapture }),
      playback,
      target,
      nextCaptureGeneration: () => 7,
      original: { time: 1.5, playing: true }
    });
    return { deps, playback, requestCapture };
  }

  it("构造依赖即开始录制会话，capture 按预览节点 id 请求该卡片的截图", async () => {
    const { deps, playback, requestCapture } = fixture();
    // 会话把播放投影锁到该镜头的预览卡片：非聚焦片场只有卡片 rig 能出画面。
    expect(playback.beginCaptureSession).toHaveBeenCalledWith({
      filmSetNodeId: "film",
      clipId: "clip-1",
      previewNodeId: "shot-preview:test"
    });
    const frame = await deps.capture(target, 0.5, new AbortController().signal);
    expect(playback.seek).toHaveBeenCalledWith(0.5);
    expect(requestCapture).toHaveBeenCalledWith({ nodeId: "shot-preview:test", source: "shot-recording", generation: 7, width: 320, height: 180 });
    expect(frame).toEqual({ rgba: expect.any(Uint8Array), width: 320, height: 180 });
  });

  it("底层捕捉失败保留采样时刻与错误码", async () => {
    const { deps, requestCapture } = fixture();
    requestCapture.mockRejectedValueOnce(new Error("捕捉视图等待渲染准备超时（capture-readiness-timeout）"));
    await expect(deps.capture(target, 0, new AbortController().signal))
      .rejects.toThrow("第 0.00 秒：捕捉视图等待渲染准备超时（capture-readiness-timeout）");
  });

  it("restore 交还录制会话并恢复用户播放状态；shouldYield 读捕捉门", () => {
    const { deps, playback } = fixture();
    deps.restore(target);
    expect(playback.endCaptureSession).toHaveBeenCalledTimes(1);
    expect(playback.seek).toHaveBeenCalledWith(1.5);
    expect(playback.play).toHaveBeenCalledTimes(1);
    expect(deps.shouldYield()).toBe(false);
  });

  it("渲染器未就绪时给出可重试的明确原因，不请求截图", async () => {
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number);
    const requestCapture = vi.fn(async () => null);
    const deps = createShotReferenceRecordDeps({
      ctx: hostileContext({ isReady: () => false, requestCapture }),
      playback: { seek: vi.fn(), play: vi.fn(), beginCaptureSession: vi.fn(), endCaptureSession: vi.fn() },
      target,
      nextCaptureGeneration: () => 1,
      original: { time: 0, playing: false }
    });
    await expect(deps.capture(target, 0, new AbortController().signal)).rejects.toThrow("画布渲染器未就绪，请稍后重试");
    expect(requestCapture).not.toHaveBeenCalled();
  });

  it("运行时接线不再引用 ctx.filmSetPlayback（本插件不声明该 inject）", async () => {
    const source = (await readFile(new URL("../src/authoring/browser/shot-reference-recording-runtime.ts", import.meta.url), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(source).not.toContain("ctx.filmSetPlayback");
  });
});
