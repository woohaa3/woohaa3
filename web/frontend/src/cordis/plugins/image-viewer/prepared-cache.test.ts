import { describe, expect, it, vi } from "vitest";
import { ViewerImageCache } from "./prepared-cache.js";

const image = () => ({ width: 2, height: 1, sourceWidth: 4, sourceHeight: 2, pixels: new Uint8Array(8) });
describe("viewer prepared images", () => {
  it("reuses preparation on re-entry, but separates source URLs and sizes", async () => {
    const prepare = vi.fn(async () => image());
    const cache = new ViewerImageCache(prepare, 24);
    const first = await cache.prepare("/a?canvas=one", 2048);
    expect(await cache.prepare("/a?canvas=one", 2048)).toBe(first);
    await cache.prepare("/a?canvas=two", 2048);
    await cache.prepare("/a?canvas=one", 1024);
    expect(prepare).toHaveBeenCalledTimes(3);
  });
  it("bounds retained bytes, evicts least recently used, and clears on page disposal", async () => {
    const prepare = vi.fn(async () => image());
    const cache = new ViewerImageCache(prepare, 16);
    await cache.prepare("/a", 2048); await cache.prepare("/b", 2048);
    await cache.prepare("/a", 2048); await cache.prepare("/c", 2048);
    await cache.prepare("/a", 2048);
    expect(prepare).toHaveBeenCalledTimes(3);
    await cache.prepare("/b", 2048);
    expect(prepare).toHaveBeenCalledTimes(4);
    cache.dispose();
    await cache.prepare("/a", 2048);
    await cache.prepare("/a", 2048);
    expect(prepare).toHaveBeenCalledTimes(6);
  });
  it("does not retain failed, cancelled or oversized results", async () => {
    const controller = new AbortController();
    const prepare = vi.fn(async () => { controller.abort(); return image(); });
    const cache = new ViewerImageCache(prepare, 4);
    await expect(cache.prepare("/a", 2048, controller.signal)).rejects.toThrow("image-cancelled");
    await cache.prepare("/a", 2048); await cache.prepare("/a", 2048);
    expect(prepare).toHaveBeenCalledTimes(3);
    const failed = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(image());
    const retry = new ViewerImageCache(failed);
    await expect(retry.prepare("/a", 2048)).rejects.toThrow("offline");
    await retry.prepare("/a", 2048);
    expect(failed).toHaveBeenCalledTimes(2);
  });
  it("does not restore the cache when a decode finishes after disposal", async () => {
    let finish!: (result: ReturnType<typeof image>) => void;
    const prepare = vi.fn(() => new Promise<ReturnType<typeof image>>(resolve => { finish = resolve; }));
    const cache = new ViewerImageCache(prepare);
    const first = cache.prepare("/a", 2048);
    cache.dispose();
    finish(image()); await first;
    const second = cache.prepare("/a", 2048);
    expect(prepare).toHaveBeenCalledTimes(2);
    finish(image()); await second;
  });
});
