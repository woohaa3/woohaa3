import { describe, expect, it, vi } from "vitest";
import { createThumbnailLoader, THUMBNAIL_CONCURRENCY } from "./image-thumbnails.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("图库缩略图", () => {
  it("同一 URL 只生成一次，就绪后能取到 Blob URL", async () => {
    const generate = vi.fn(async () => new Blob(["x"]));
    const loader = createThumbnailLoader({ generate, createObjectUrl: () => "blob:thumb" });
    expect(loader.get("u")).toBeNull();

    loader.request("u");
    loader.request("u");
    await vi.waitFor(() => expect(loader.get("u")).toBe("blob:thumb"));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("并发不超过上限，其余的排队", async () => {
    const gates: Array<ReturnType<typeof deferred<Blob | null>>> = [];
    const generate = vi.fn(() => {
      const d = deferred<Blob | null>();
      gates.push(d);
      return d.promise;
    });
    const loader = createThumbnailLoader({ generate, createObjectUrl: () => "blob:x" });
    for (let i = 0; i < 6; i += 1) loader.request(`u${i}`);
    expect(generate).toHaveBeenCalledTimes(THUMBNAIL_CONCURRENCY);

    gates[0]!.resolve(new Blob(["a"]));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(THUMBNAIL_CONCURRENCY + 1));
  });

  it("失败不重试，也不返回地址（回退占位而不是原图）", async () => {
    const generate = vi.fn(async () => null);
    const loader = createThumbnailLoader({ generate });
    loader.request("u");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    loader.request("u");
    await new Promise((r) => setTimeout(r, 10));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(loader.get("u")).toBeNull();
  });

  it("就绪时通知订阅者", async () => {
    const generate = vi.fn(async () => new Blob(["x"]));
    const loader = createThumbnailLoader({ generate, createObjectUrl: () => "blob:t" });
    const listener = vi.fn();
    loader.subscribe("u", listener);
    loader.request("u");
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
  });

  it("dispose 释放已生成的 Blob URL，之后仍可继续用（StrictMode 会这样两轮）", async () => {
    const revoke = vi.fn();
    const generate = vi.fn(async () => new Blob(["x"]));
    const loader = createThumbnailLoader({ generate, createObjectUrl: () => "blob:d", revokeObjectUrl: revoke });
    loader.request("u");
    await vi.waitFor(() => expect(loader.get("u")).toBe("blob:d"));

    loader.dispose();
    expect(revoke).toHaveBeenCalledWith("blob:d");
    expect(loader.get("u")).toBeNull();

    /*
     * **不能**因为 dispose 过就永久失效：开发模式下 `StrictMode` 会把 effect 跑成
     * 「执行 → 清理（dispose）→ 执行」，同一个实例还要接着用。曾经用永久开关实现，
     * 结果面板里一张缩略图都不生成。
     */
    generate.mockClear();
    loader.request("v");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledWith("v", 256));
    expect(loader.get("v")).toBe("blob:d");
  });

  it("dispose 之后到达的在途结果被丢弃，不写回缓存", async () => {
    const gate = deferred<Blob | null>();
    const generate = vi.fn(() => gate.promise);
    const loader = createThumbnailLoader({ generate, createObjectUrl: () => "blob:late" });
    loader.request("u");
    loader.dispose();
    gate.resolve(new Blob(["x"]));
    await new Promise((r) => setTimeout(r, 10));
    expect(loader.get("u")).toBeNull();
  });
});
