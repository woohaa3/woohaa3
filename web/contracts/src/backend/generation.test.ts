/**
 * 远端托管生成 Provider 的稳定媒体结果与目录契约
 * （change: 2026-10-20-reserve-remote-generation-provider）。
 */
import { describe, expect, it } from "vitest";
import { isGenerationStableMediaResult } from "../extension/services/host/generation.js";

const KEY = "generation-outputs/" + "a".repeat(64) + ".png";
const VIDEO_KEY = "generation-outputs/" + "b".repeat(64) + ".mp4";

describe("isGenerationStableMediaResult", () => {
  it("接受主媒体与视频 poster", () => {
    expect(
      isGenerationStableMediaResult({
        media: {
          storageKey: VIDEO_KEY,
          contentType: "video/mp4",
          size: 1024,
          checksum: "b".repeat(64),
          durationSeconds: 3,
          poster: { storageKey: KEY, contentType: "image/png", size: 12, checksum: "a".repeat(64) }
        }
      })
    ).toBe(true);
  });

  it("拒绝非法或缺失字段", () => {
    expect(isGenerationStableMediaResult(null)).toBe(false);
    expect(isGenerationStableMediaResult({})).toBe(false);
    expect(isGenerationStableMediaResult({ media: {} })).toBe(false);
    expect(isGenerationStableMediaResult({ media: { storageKey: KEY, contentType: "image/png" } })).toBe(false);
    expect(isGenerationStableMediaResult({ media: { storageKey: "not-a-key", contentType: "image/png", size: 1 } })).toBe(false);
    expect(isGenerationStableMediaResult({ media: { storageKey: KEY, contentType: "", size: 1 } })).toBe(false);
    expect(isGenerationStableMediaResult({ media: { storageKey: KEY, contentType: "image/png", size: -1 } })).toBe(false);
    expect(isGenerationStableMediaResult({ media: { storageKey: KEY, contentType: "image/png", size: 1, poster: { storageKey: "bad" } } })).toBe(false);
  });

  it("忽略未知字段", () => {
    expect(
      isGenerationStableMediaResult({
        media: { storageKey: KEY, contentType: "image/png", size: 1, future: true }
      })
    ).toBe(true);
  });
});
