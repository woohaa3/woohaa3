import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { NodeDownloadService } from "./node-download.js";
import { readCanonicalMedia } from "./media-remote.js";

function canvas(): ServerCanvas {
  return { ...createEmptyWoohaa3ServerCanvas("test"),
    document: { schemaVersion: "asset-canvas-v1", updatedAt: "2026-10-10T00:00:00Z", nodes: [{ id: "image", type: "image", position: { x: 20, y: 30 } }], edges: [] },
    nodeData: { image: { title: "人/物.webm", outputAssetId: "asset" } },
    assets: [{ id: "asset", title: "图片", source: "uploaded", mediaKind: "image", status: "ready", createdAt: "2026-10-10T00:00:00Z", url: "/api/media/sha256-test" }]
  };
}
beforeEach(() => vi.stubGlobal("window", globalThis));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("node download recovery", () => {
  it("retries after failure, uses the actual MIME extension and never writes canvas data", async () => {
    const state = canvas(), before = JSON.stringify(state), save = vi.fn();
    const readMedia = vi.fn().mockRejectedValueOnce(new Error("HTTP 404"))
      .mockResolvedValueOnce(new Blob(["original"], { type: "image/png" }));
    const service = new NodeDownloadService({ getCanvas: () => state, readMedia, save });
    await service.download("image");
    expect(service.getSnapshot()).toMatchObject({ busy: false, error: true, text: "HTTP 404" });
    expect(save).not.toHaveBeenCalled();
    await service.download("image");
    expect(save).toHaveBeenCalledWith(expect.any(Blob), "人_物.png");
    expect(service.getSnapshot()).toMatchObject({ busy: false, error: false });
    expect(JSON.stringify(state)).toBe(before);
    service.dispose();
  });

  it("cancellation and scope disposal prevent even a late successful response from saving", async () => {
    for (const dispose of [false, true]) {
      let complete!: (blob: Blob) => void;
      const readMedia = vi.fn(() => new Promise<Blob>(resolve => { complete = resolve; })), save = vi.fn();
      const service = new NodeDownloadService({ getCanvas: canvas, readMedia, save });
      const pending = service.download("image");
      await service.download("image");
      expect(readMedia).toHaveBeenCalledTimes(1);
      if (dispose) service.dispose(); else service.cancel();
      complete(new Blob(["original"], { type: "image/png" }));
      await pending;
      expect(save).not.toHaveBeenCalled();
      if (!dispose) expect(service.getSnapshot()).toEqual({ busy: false, error: false, text: "下载已取消" });
      service.dispose();
    }
  });

  it("missing output and error pages do not become downloads", async () => {
    const state = canvas(), save = vi.fn(), readMedia = vi.fn().mockResolvedValue(new Blob(["error"], { type: "text/html" }));
    const service = new NodeDownloadService({ getCanvas: () => state, save, readMedia });
    await service.download("image");
    expect(service.getSnapshot()?.text).toContain("文件类型不正确");
    state.assets = [];
    await service.download("image");
    expect(service.getSnapshot()?.text).toContain("尚未就绪");
    expect(readMedia).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    service.dispose();
  });

  it("original-byte adapter rejects unavailable, empty and uncontrolled media", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("error", { status: 404 }))
      .mockResolvedValueOnce(new Response(new Blob([])));
    vi.stubGlobal("fetch", fetcher);
    await expect(readCanonicalMedia({ url: "https://example.com/image.png" })).rejects.toThrow("文件地址");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(readCanonicalMedia({ url: "/api/media/missing" })).rejects.toThrow("HTTP 404");
    await expect(readCanonicalMedia({ url: "/api/media/empty" })).rejects.toThrow("文件为空");
  });

  it("times out an unresponsive transfer and allows a fresh download", async () => {
    vi.useFakeTimers();
    const readMedia = vi.fn((_asset, signal: AbortSignal) => new Promise<Blob>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const service = new NodeDownloadService({ getCanvas: canvas, readMedia, save: vi.fn() });
    const pending = service.download("image");
    await vi.advanceTimersByTimeAsync(120_000); await pending;
    expect(service.getSnapshot()).toEqual({ busy: false, error: true, text: "下载超时，请重试" });
    service.dispose();
  });
});
