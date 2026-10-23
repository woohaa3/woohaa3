import { describe, expect, it } from "vitest";
import {
  ANIMATION_CAPABILITIES,
  animationCodecAvailability,
  animationFrameBytes,
  feature,
  isAnimationCodecPort,
  type AnimationCodecPort
} from "./index.js";
import { ANIMATION_CAPABILITIES as FROM_ROOT } from "../../index.js";

describe("动画域纯协议", () => {
  it("能力 id 已发布，且与阶段声明同序", () => {
    expect([...ANIMATION_CAPABILITIES]).toEqual([
      "animation.timeline",
      "animation.video-layers",
      "animation.frame-import",
      "animation.frame-delivery"
    ]);
    // 根入口导出的同名常量是同一份数据。
    expect([...FROM_ROOT]).toEqual([...ANIMATION_CAPABILITIES]);
    expect(feature.id).toBe("animation");
    // 阶段声明与能力清单必须一一对应（顺序即 `capabilityHandshake` 的顺序）。
    expect(feature.capabilities.map(entry => entry.id)).toEqual([...ANIMATION_CAPABILITIES]);
    expect(feature.capabilities.map(entry => entry.stage)).toEqual(["P7", "P7", "P7", "P7"]);
  });

  it("帧字节长度按 RGBA8 计算并拒绝非法尺寸", () => {
    expect(animationFrameBytes(8, 8)).toBe(8 * 8 * 4);
    expect(animationFrameBytes(8, 8, 3)).toBe(8 * 8 * 4 * 3);
    for (const [width, height, frames] of [[0, 8, 1], [8, -1, 1], [8.5, 8, 1], [8, 8, 0]] as const) {
      expect(animationFrameBytes(width, height, frames)).toBeNull();
    }
    // 溢出返回 null 而不是 Infinity/NaN。
    expect(animationFrameBytes(Number.MAX_SAFE_INTEGER, 2, 1)).toBeNull();
  });

  it("缺端口时给出具体原因，而不是静默退回只取首帧", () => {
    const missing = animationCodecAvailability(null);
    expect(missing.enabled).toBe(false);
    expect(missing.enabled === false && missing.reason).toContain("没有视频编解码端口");

    const unsupported = animationCodecAvailability({ supported: false, reason: "容器不受支持：AVI" });
    expect(unsupported).toEqual({ enabled: false, reason: "容器不受支持：AVI" });

    const ok = animationCodecAvailability({ supported: true, container: "mp4", codec: "avc1.42001f" });
    expect(ok).toEqual({ enabled: true, container: "mp4", codec: "avc1.42001f" });
  });

  it("端口守卫拒绝不完整实现", () => {
    const complete: AnimationCodecPort = {
      supports: () => ({ supported: false, reason: "无" }),
      decode: async () => ({ ok: false, reason: "无" }),
      encode: async () => ({ ok: false, reason: "无" }),
      cancel: () => undefined
    };
    expect(isAnimationCodecPort(complete)).toBe(true);
    expect(isAnimationCodecPort({ ...complete, cancel: undefined })).toBe(false);
    expect(isAnimationCodecPort(null)).toBe(false);
    expect(isAnimationCodecPort({})).toBe(false);
  });
});
