import { describe, expect, it, vi } from "vitest";
import { createImageFocusLoader } from "../src/loader.js";

const decoded = () => ({ bitmap: { close: vi.fn() } as unknown as CanvasImageSource, width: 10, height: 10 });

describe("图片聚焦加载器", () => {
  it("canonical 资产走 /api/media 受控地址", async () => {
    const decode = vi.fn(async () => decoded());
    const loader = createImageFocusLoader({ decode });
    const result = await loader.load({ url: "/api/media/a.png" }, "r1");
    expect(result.ok).toBe(true);
    expect(decode).toHaveBeenCalledWith("/api/media/a.png");
  });

  it("历史预览接受 node-history 受控地址", async () => {
    const decode = vi.fn(async () => decoded());
    const loader = createImageFocusLoader({ decode });
    const result = await loader.loadHistoryPreview("/api/canvas-node-history/c/n/e/preview", "r1");
    expect(result.ok).toBe(true);
    expect(decode).toHaveBeenCalledWith("/api/canvas-node-history/c/n/e/preview");
  });

  it("历史预览拒绝其它地址且不解码", async () => {
    const decode = vi.fn(async () => decoded());
    const loader = createImageFocusLoader({ decode });
    for (const url of [
      "/api/media/a.png",
      "https://evil.example/a.png",
      "//evil.example/a.png",
      "/api/canvas-node-history/../../media/a.png"
    ]) {
      const result = await loader.loadHistoryPreview(url, "r1");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("unresolvable");
    }
    expect(decode).not.toHaveBeenCalled();
  });
});
