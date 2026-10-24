/**
 * 图片失败分类与有界自动重试的回归测试
 * （change: 2026-10-23-scale-canvas-media-residency，design D2/D8）。
 *
 * 真实运行时缺陷：媒体服务重启期间在途的 `<img>` 请求收到 502，`onerror` 被记成
 * 「图片加载失败」并永久不再尝试，健康素材被钉在错误态。这里固定「传输失败可自动重试、
 * 内容失败不自动重试」的边界。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_RETRY_MAX_ATTEMPTS,
  ImageLoadError,
  classifyImageFailure,
  isTransientImageFailure
} from "./image-load.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("classifyImageFailure", () => {
  it("treats gateway/unavailable statuses as transient", async () => {
    for (const status of [502, 503, 504, 500, 429, 408]) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status })));
      const failure = await classifyImageFailure("/api/media/sha256-x");
      expect(failure.transient, `HTTP ${status}`).toBe(true);
      expect(failure.message).toContain(String(status));
    }
  });

  it("treats 4xx as content failures so they are not retried automatically", async () => {
    for (const status of [403, 404, 410]) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status })));
      expect((await classifyImageFailure("/api/media/sha256-x")).transient, `HTTP ${status}`).toBe(false);
    }
  });

  it("treats an unreachable media service as transient", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect((await classifyImageFailure("/api/media/sha256-x")).transient).toBe(true);
  });

  it("treats a decodable-but-undecodable byte stream as a content failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
    expect((await classifyImageFailure("/api/media/sha256-x")).transient).toBe(false);
  });

  it("does not probe non-http sources (ghost object URLs)", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await classifyImageFailure("blob:http://localhost/abc")).transient).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("only retries failures explicitly classified as transient", () => {
    expect(isTransientImageFailure(new ImageLoadError("x", true))).toBe(true);
    expect(isTransientImageFailure(new ImageLoadError("x", false))).toBe(false);
    expect(isTransientImageFailure(new Error("图片加载失败。"))).toBe(false);
    expect(isTransientImageFailure("string")).toBe(false);
  });
});

describe("retry budget", () => {
  it("is bounded so a parked failure never becomes an endless retry loop", async () => {
    const { IMAGE_RETRY_DELAYS_MS } = await import("./image-load.js");
    expect(IMAGE_RETRY_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(IMAGE_RETRY_DELAYS_MS).toHaveLength(IMAGE_RETRY_MAX_ATTEMPTS);
    // 总退避有界（一次后端重启的恢复窗口，而不是无限重连）。
    expect(IMAGE_RETRY_DELAYS_MS.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(30_000);
  });
});
