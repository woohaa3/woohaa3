/**
 * 视频导入域回归（U77，design D2/D4）。
 *
 * 覆盖：容器识别、缺端口/不支持时的具体原因、整段解码（不是只取首帧）、解码后预算预检、
 * 逐帧字节长度校验，以及取消后晚到结果不写入。端口是替身，不加载真实 WASM、不采集渲染。
 */
import { describe, expect, it, vi } from "vitest";
import { decodeVideoFrames, videoContainer } from "./video-decoder.js";
import type { AnimationCodecPort } from "@woohaa3/photocraft-protocol";

const TARGET = {
  width: 4,
  height: 4,
  fps: 24,
  budget: { maxFrames: 120, maxCumulativeFramePixels: 16_777_216 }
};

function frame(value: number): Uint8Array {
  return new Uint8Array(4 * 4 * 4).fill(value);
}

function port(overrides: Partial<AnimationCodecPort> = {}): AnimationCodecPort {
  return {
    supports: () => ({ supported: true, container: "mp4", codec: "avc1.42001f" }),
    decode: async () => ({ ok: true, width: 4, height: 4, fps: 30, frames: [frame(1), frame(2), frame(3)] }),
    encode: async () => ({ ok: false, reason: "未实现" }),
    cancel: () => undefined,
    ...overrides
  };
}

describe("视频容器识别", () => {
  it("只认 MP4 与 WebM，其它容器返回 null 由调用方拒绝", () => {
    expect(videoContainer("clip.mp4")).toBe("mp4");
    expect(videoContainer("clip.MOV")).toBe("mp4");
    expect(videoContainer("clip.webm")).toBe("webm");
    expect(videoContainer("clip.avi")).toBeNull();
    expect(videoContainer("clip", "video/webm")).toBe("webm");
    expect(videoContainer("clip.bin", "video/mp4")).toBe("mp4");
    expect(videoContainer("clip.bin", "video/quicktime")).toBeNull();
  });
});

describe("视频导入解码", () => {
  it("缺端口时拒绝并说明仍可用帧序列", async () => {
    const result = await decodeVideoFrames(null, { fileName: "a.mp4", bytes: new Uint8Array(8), requestId: "r1" }, TARGET);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("未注册视频编解码端口");
  });

  it("不支持的方向/容器把端口原因原样交回", async () => {
    const unsupported = port({ supports: () => ({ supported: false, reason: "缺少 H.264 解码器" }) });
    const result = await decodeVideoFrames(unsupported, { fileName: "a.mp4", bytes: new Uint8Array(8), requestId: "r1" }, TARGET);
    expect(result).toEqual({ ok: false, message: "缺少 H.264 解码器" });
  });

  it("未知容器不调用端口解码", async () => {
    const decode = vi.fn();
    const result = await decodeVideoFrames(port({ decode }), { fileName: "a.avi", bytes: new Uint8Array(8), requestId: "r1" }, TARGET);
    expect(result.ok).toBe(false);
    expect(decode).not.toHaveBeenCalled();
  });

  it("整段返回所有帧而不是只取首帧", async () => {
    const result = await decodeVideoFrames(port(), { fileName: "a.mp4", bytes: new Uint8Array(8), requestId: "r1" }, TARGET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frames).toHaveLength(3);
    expect(result.frames.map(item => item[0])).toEqual([1, 2, 3]);
    expect(result.fps).toBe(30);
  });

  it("解码端报错与抛异常都变成可显示原因", async () => {
    const rejected = await decodeVideoFrames(port({ decode: async () => ({ ok: false, reason: "容器损坏" }) }), { fileName: "a.mp4", bytes: new Uint8Array(8), requestId: "r1" }, TARGET);
    expect(rejected).toEqual({ ok: false, message: "容器损坏" });
    const thrown = await decodeVideoFrames(port({ decode: async () => { throw new Error("解码器崩溃"); } }), { fileName: "a.mp4", bytes: new Uint8Array(8), requestId: "r1" }, TARGET);
    expect(thrown).toEqual({ ok: false, message: "解码器崩溃" });
  });

  it("解码后按内核预算预检：帧数、累计像素、逐帧字节、放大", async () => {
    const many = await decodeVideoFrames(port({ decode: async () => ({
      ok: true, width: 4, height: 4, fps: 30, frames: Array.from({ length: 121 }, () => frame(1))
    }) }), { fileName: "a.mp4", bytes: new Uint8Array(8), requestId: "r1" }, TARGET);
    expect(many.ok).toBe(false);
    expect(many.ok === false && many.message).toContain("帧数超过上限");

    const pixelHeavy = await decodeVideoFrames(port({ decode: async () => ({
      ok: true, width: 4, height: 4, fps: 30, frames: [frame(1), frame(2)]
    }) }), { fileName: "a.mp4", bytes: new Uint8Array(8), requestId: "r1" }, { ...TARGET, budget: { maxFrames: 120, maxCumulativeFramePixels: 16 } });
    expect(pixelHeavy.ok).toBe(false);
    expect(pixelHeavy.ok === false && pixelHeavy.message).toContain("累计像素超过上限");

    const badLength = await decodeVideoFrames(port({ decode: async () => ({
      ok: true, width: 4, height: 4, fps: 30, frames: [new Uint8Array(4)]
    }) }), { fileName: "a.mp4", bytes: new Uint8Array(8), requestId: "r1" }, TARGET);
    expect(badLength.ok).toBe(false);
    expect(badLength.ok === false && badLength.message).toContain("字节长度与尺寸不符");

    const upscaled = await decodeVideoFrames(port({ decode: async () => ({
      ok: true, width: 8, height: 8, fps: 30, frames: [new Uint8Array(8 * 8 * 4)]
    }) }), { fileName: "a.mp4", bytes: new Uint8Array(8), requestId: "r1" }, TARGET);
    expect(upscaled.ok).toBe(false);
    expect(upscaled.ok === false && upscaled.message).toContain("放大了帧尺寸");

    const empty = await decodeVideoFrames(port({ decode: async () => ({ ok: true, width: 4, height: 4, fps: 30, frames: [] }) }),
      { fileName: "a.mp4", bytes: new Uint8Array(8), requestId: "r1" }, TARGET);
    expect(empty).toEqual({ ok: false, message: "视频里没有可导入的帧" });

    const badFps = await decodeVideoFrames(port({ decode: async () => ({ ok: true, width: 4, height: 4, fps: 0, frames: [frame(1)] }) }),
      { fileName: "a.mp4", bytes: new Uint8Array(8), requestId: "r1" }, TARGET);
    expect(badFps.ok && badFps.fps).toBe(24);
  });
});
