/**
 * 规范投影复用缓存测试
 * （change: 2026-10-23-scale-canvas-media-residency，design D7 / 任务 8.1）。
 */
import { describe, expect, it, vi } from "vitest";
import { createCanonicalProjectionCache } from "./canonical-projection-cache.js";

const KEY = { canvasId: "c1", roomEpoch: "epoch-1", revision: 3, docVersion: 7 };

describe("规范投影复用", () => {
  it("同一 doc/epoch/revision/doc版本 只派生一次", () => {
    const cache = createCanonicalProjectionCache<{ nodes: string[] }>();
    const produce = vi.fn(() => ({ nodes: ["a"] }));
    expect(cache.resolve(KEY, produce).reused).toBe(false);
    expect(cache.resolve({ ...KEY }, produce).reused).toBe(true);
    expect(cache.resolve({ ...KEY }, produce).reused).toBe(true);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ derived: 1, reused: 2 });
  });

  it("revision 变化重新派生", () => {
    const cache = createCanonicalProjectionCache<number>();
    cache.resolve(KEY, () => 1);
    expect(cache.resolve({ ...KEY, revision: 4 }, () => 2).value).toBe(2);
    expect(cache.stats().derived).toBe(2);
  });

  it("同 revision 属于不同 epoch 不复用", () => {
    const cache = createCanonicalProjectionCache<number>();
    cache.resolve(KEY, () => 1);
    expect(cache.resolve({ ...KEY, roomEpoch: "epoch-2" }, () => 2).value).toBe(2);
    expect(cache.resolve({ ...KEY, roomEpoch: null }, () => 3).value).toBe(3);
  });

  it("同 revision 但 doc 版本前进（合并写入）不复用", () => {
    const cache = createCanonicalProjectionCache<number>();
    cache.resolve(KEY, () => 1);
    expect(cache.resolve({ ...KEY, docVersion: KEY.docVersion + 1 }, () => 2).value).toBe(2);
  });

  it("画布切换不复用", () => {
    const cache = createCanonicalProjectionCache<number>();
    cache.resolve(KEY, () => 1);
    expect(cache.resolve({ ...KEY, canvasId: "c2" }, () => 2).value).toBe(2);
  });

  it("派生失败不入缓存：下次仍重新校验并重新报告", () => {
    const cache = createCanonicalProjectionCache<number>();
    const failing = vi.fn(() => {
      throw new Error("broken-reference");
    });
    expect(() => cache.resolve(KEY, failing)).toThrow("broken-reference");
    expect(() => cache.resolve({ ...KEY }, failing)).toThrow("broken-reference");
    expect(failing).toHaveBeenCalledTimes(2);
    expect(cache.stats()).toMatchObject({ derived: 0, failed: 2 });
    // 失败后成功仍可缓存。
    expect(cache.resolve({ ...KEY }, () => 9).value).toBe(9);
    expect(cache.stats()).toMatchObject({ derived: 1 });
  });

  it("显式失效后重新派生", () => {
    const cache = createCanonicalProjectionCache<number>();
    cache.resolve(KEY, () => 1);
    cache.invalidate();
    expect(cache.resolve({ ...KEY }, () => 2).value).toBe(2);
    expect(cache.stats().invalidated).toBe(1);
  });

  it("身份按值保存：调用方后续改动不会造成错误命中", () => {
    const cache = createCanonicalProjectionCache<number>();
    const key = { ...KEY };
    cache.resolve(key, () => 1);
    key.revision = 99;
    expect(cache.resolve({ ...KEY }, () => 2).reused).toBe(true);
  });
});
