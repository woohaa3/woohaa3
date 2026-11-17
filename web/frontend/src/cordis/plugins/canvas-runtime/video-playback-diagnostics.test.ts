import { afterEach, describe, expect, it, vi } from "vitest";
import { createVideoPlaybackTrace, observeVideoPlayback, videoDiagnosticSource, videoPlaybackDiagnosticsEnabled, probeVideoSource } from "./video-playback-diagnostics.js";

afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers();
  delete (globalThis as typeof globalThis & { __woohaaVideoPlaybackLog?: unknown }).__woohaaVideoPlaybackLog;
});

describe("部署版视频诊断", () => {
  it("生产默认关闭，URL 显式开启才采集", () => {
    vi.stubEnv("DEV", false);
    vi.stubGlobal("location", { search: "", href: "https://app.test/" });
    expect(videoPlaybackDiagnosticsEnabled()).toBe(false);
    vi.stubGlobal("location", { search: "?woohaaVideoDebug=1", href: "https://app.test/?woohaaVideoDebug=1" });
    vi.spyOn(console, "info").mockImplementation(() => {});
    createVideoPlaybackTrace("video").log("start", {}, true);
    expect((globalThis as any).__woohaaVideoPlaybackLog.some((entry: any) => entry.stage === "start")).toBe(true);
  });
  it("来源摘要不包含签名、凭据或 fragment", () => {
    vi.stubGlobal("location", { href: "https://app.test/" });
    expect(videoDiagnosticSource("https://user:pass@cdn.test/video.mp4?token=secret#secret")).toBe("https://cdn.test/video.mp4");
  });
  it("Range 探测只取响应头并取消正文，不记录带令牌的 URL", async () => {
    vi.stubEnv("DEV", false);
    vi.stubGlobal("location", { search: "?woohaaVideoDebug=1", href: "https://app.test/", origin: "https://app.test" });
    vi.spyOn(console, "info").mockImplementation(() => {});
    const cancel = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValue({ status: 206, headers: new Headers({ "content-range": "bytes 0-0/123", "content-type": "video/mp4" }), body: { cancel } });
    vi.stubGlobal("fetch", request);
    const stop = probeVideoSource(createVideoPlaybackTrace("v"), "/api/media/file?token=secret");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith("https://app.test/api/media/file?token=secret", expect.objectContaining({ headers: { Range: "bytes=0-0" }, redirect: "error" }));
    expect(JSON.stringify((globalThis as any).__woohaaVideoPlaybackLog)).not.toContain("secret");
    expect((globalThis as any).__woohaaVideoPlaybackLog.find((entry: any) => entry.stage === "range-probe")).toMatchObject({ status: 206, contentRange: "bytes 0-0/123" });
    stop();
  });
  it("无媒体事件时仍记录缓冲/解码状态，释放后停止", () => {
    vi.useFakeTimers();
    vi.stubEnv("DEV", true);
    vi.stubGlobal("document", {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const video = { src: "/video", currentTime: 1, duration: 8, paused: false, readyState: 2, networkState: 2,
      videoWidth: 1280, videoHeight: 720, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      buffered: { length: 1, start: () => 0, end: () => 2 },
      getVideoPlaybackQuality: () => ({ totalVideoFrames: 30, droppedVideoFrames: 4 }) };
    const stop = observeVideoPlayback(createVideoPlaybackTrace("v"), video as never);
    vi.advanceTimersByTime(2000);
    const logs = (globalThis as any).__woohaaVideoPlaybackLog;
    expect(logs.find((entry: any) => entry.stage === "heartbeat")).toMatchObject({ currentTime: 1, networkState: 2, decodedFrames: 30, droppedFrames: 4, buffered: "[[0,2]]" });
    stop();
    const count = logs.length;
    vi.advanceTimersByTime(6000);
    expect(logs).toHaveLength(count);
    expect(video.removeEventListener).toHaveBeenCalled();
  });
});
