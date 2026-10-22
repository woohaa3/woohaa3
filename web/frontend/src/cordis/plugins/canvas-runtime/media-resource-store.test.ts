/**
 * 有界媒体资源 store 测试
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D8/D9，任务 4.1）。
 *
 * 覆盖：稳定来源 identity 共享、引用计数、并发去重、CPU/GPU 分离语义（只关闭 CPU 位图）、
 * 预算回收只作用于无 lease/无 pin 条目、pin 保护、换源失效与幂等 dispose。
 */
import { describe, expect, it, vi } from "vitest";
import { MediaResourceStore, estimateBitmapBytes, type MediaBitmap } from "./media-resource-store.js";

function bitmap(width = 10, height = 10, tooLarge = false): MediaBitmap {
  return { bitmap: { width, height, close: vi.fn() } as unknown as CanvasImageSource, width, height, tooLarge };
}

function storeWith(values: Record<string, MediaBitmap> = {}, options: { maxEntries?: number; maxBytes?: number } = {}) {
  const made = new Map<string, MediaBitmap>(Object.entries(values));
  const decode = vi.fn(async (source: { key: string }) => {
    if (!made.has(source.key)) made.set(source.key, bitmap());
    return { ok: true as const, value: made.get(source.key)! };
  });
  const store = new MediaResourceStore({ decode, ...options });
  const closeSpy = (key: string): ReturnType<typeof vi.fn> =>
    (made.get(key)!.bitmap as unknown as { close: ReturnType<typeof vi.fn> }).close;
  return { store, decode, closeSpy };
}

describe("MediaResourceStore（任务 4.1）", () => {
  it("同 identity 只解码一次并共享位图", async () => {
    const { store, decode } = storeWith({ a: bitmap() });
    const first = await store.acquire({ key: "a" });
    const second = await store.acquire({ key: "a" });
    expect(decode).toHaveBeenCalledTimes(1);
    expect(first?.key).toBe("a");
    expect(second?.key).toBe("a");
    expect(store.peek("a")).toBeTruthy();
  });

  it("并发 acquire 同一 identity 去重解码", async () => {
    const value = bitmap();
    const decode = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true as const, value };
    });
    const store = new MediaResourceStore({ decode });
    const [a, b] = await Promise.all([store.acquire({ key: "x" }), store.acquire({ key: "x" })]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(a?.key).toBe("x");
    expect(b?.key).toBe("x");
  });

  it("release 幂等；引用归零后条目可被回收（CPU 位图关闭）", async () => {
    const { store, closeSpy } = storeWith({ a: bitmap() }, { maxEntries: 1 });
    const lease = await store.acquire({ key: "a" });
    lease?.release();
    lease?.release();
    // 用新条目触发预算回收：旧条目引用归零但仍在缓存内，可被关闭回收。
    await store.acquire({ key: "b" });
    expect(closeSpy("a")).toHaveBeenCalled();
  });

  it("持有 lease 的条目不被预算回收", async () => {
    const { store, closeSpy } = storeWith({ a: bitmap() }, { maxEntries: 1 });
    const lease = await store.acquire({ key: "a" });
    await store.acquire({ key: "b" });
    await store.acquire({ key: "c" });
    // a 仍被 lease 持有：不被回收。
    expect(store.has("a")).toBe(true);
    expect(closeSpy("a")).not.toHaveBeenCalled();
    lease?.release();
    await store.acquire({ key: "d" });
    expect(closeSpy("a")).toHaveBeenCalled();
  });

  it("显式 pin 阻止回收，unpin 后恢复可回收", async () => {
    const { store, closeSpy } = storeWith({ a: bitmap() }, { maxEntries: 1 });
    const lease = await store.acquire({ key: "a" });
    store.pin("a", "capture");
    // 释放 lease：只剩 pin 保护。
    lease?.release();
    await store.acquire({ key: "b" });
    expect(store.has("a")).toBe(true);
    store.unpin("a", "capture");
    await store.acquire({ key: "c" });
    expect(closeSpy("a")).toHaveBeenCalled();
  });

  it("字节预算超限时回收最久未用条目", async () => {
    // 每个位图 100*100*4 = 40,000 bytes；预算 90,000 只能容纳两个。
    const { store } = storeWith({ a: bitmap(100, 100), b: bitmap(100, 100), c: bitmap(100, 100) }, { maxEntries: 10, maxBytes: 90_000 });
    for (const key of ["a", "b", "c"]) {
      (await store.acquire({ key }))?.release();
    }
    expect(store.bytes()).toBeLessThanOrEqual(90_000);
    expect(store.size()).toBeLessThanOrEqual(2);
  });

  it("invalidateSource 丢弃缓存并在无引用时关闭位图（换源/设备恢复）", async () => {
    const { store, closeSpy } = storeWith({ a: bitmap() });
    (await store.acquire({ key: "a" }))?.release();
    store.invalidateSource("a");
    expect(store.has("a")).toBe(false);
    expect(closeSpy("a")).toHaveBeenCalled();
  });

  it("被 lease 持有的来源失效后延迟到释放时关闭", async () => {
    const { store, closeSpy } = storeWith({ a: bitmap() });
    const lease = await store.acquire({ key: "a" });
    store.invalidateSource("a");
    expect(closeSpy("a")).not.toHaveBeenCalled();
    lease?.release();
    expect(closeSpy("a")).toHaveBeenCalled();
  });

  it("解码失败不建立缓存，返回 null（保留上一合法表示）", async () => {
    const decode = vi.fn(async () => ({ ok: false as const, code: "decode-failed" as const, message: "boom" }));
    const store = new MediaResourceStore({ decode });
    await expect(store.acquire({ key: "missing" })).resolves.toBeNull();
    expect(store.size()).toBe(0);
  });

  it("dispose 幂等释放全部无引用条目", async () => {
    const { store, closeSpy } = storeWith({});
    (await store.acquire({ key: "a" }))?.release();
    (await store.acquire({ key: "b" }))?.release();
    store.dispose();
    store.dispose();
    expect(store.size()).toBe(0);
    expect(closeSpy("a")).toHaveBeenCalledTimes(1);
    expect(closeSpy("b")).toHaveBeenCalledTimes(1);
  });

  it("estimateBitmapBytes 按 RGBA8 估算", () => {
    expect(estimateBitmapBytes({ bitmap: {} as never, width: 4, height: 2, tooLarge: false })).toBe(32);
  });
});
