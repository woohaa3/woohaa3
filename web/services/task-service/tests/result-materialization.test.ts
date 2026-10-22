/**
 * 四媒体结果转存与 history 投影（change: add-audio-video-generation-and-align-model-catalog，任务 5.4 / 6.6 / 10.1）。
 */
import { describe, expect, it } from "vitest";
import { resultFromMedia } from "../src/worker/runtime.js";

const VIDEO_KEY = `generation-outputs/${"c".repeat(64)}.mp4`;
const POSTER_KEY = `generation-outputs/${"d".repeat(64)}.png`;

describe("resultFromMedia 四媒体", () => {
  it("视频主媒体 + poster + duration", () => {
    const result = resultFromMedia(
      { storageKey: VIDEO_KEY, contentType: "video/mp4", size: 100, checksum: "c".repeat(64), mediaKind: "video" },
      { poster: { storageKey: POSTER_KEY, contentType: "image/png", size: 10, checksum: "d".repeat(64), mediaKind: "image" }, durationSeconds: 8 }
    );
    expect(result).toEqual({
      mediaKind: "video",
      storageKey: VIDEO_KEY,
      contentType: "video/mp4",
      size: 100,
      checksum: "c".repeat(64),
      durationSeconds: 8,
      poster: { storageKey: POSTER_KEY, contentType: "image/png", size: 10, checksum: "d".repeat(64) }
    });
  });

  it("音频媒体只带 duration", () => {
    const result = resultFromMedia(
      { storageKey: `generation-outputs/${"e".repeat(64)}.mp3`, contentType: "audio/mpeg", size: 20, checksum: "e".repeat(64), mediaKind: "audio" },
      { durationSeconds: 12 }
    );
    expect(result).toMatchObject({ mediaKind: "audio", durationSeconds: 12 });
    expect(result.poster).toBeUndefined();
  });

  it("mediaKind 缺失时回落 image 且不含 poster", () => {
    const result = resultFromMedia({ storageKey: VIDEO_KEY, contentType: "image/png", size: 1, checksum: "c".repeat(64) });
    expect(result.mediaKind).toBe("image");
    expect(result.poster).toBeUndefined();
  });
});
