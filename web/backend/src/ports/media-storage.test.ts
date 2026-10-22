/**
 * 存储扩展点 → Media 存储端口适配器测试。
 *
 * 锁定边界语义：namespace 固定 media、`exists`/`stat` 走 `head`、`getHttpsUrl` 走 `expose`、
 * 存储 not-found 翻译成 `MediaObjectNotFoundError`、每次调用现查 bucket（主存储热切换），以及
 * 调用方声明的画布作用域按调用透传给 `ctx.storage.bucket`（适配器自己不理解路由）。
 */
import { describe, expect, it } from "vitest";
import {
  MediaObjectNotFoundError,
  isMediaObjectNotFoundError,
  StorageObjectNotFoundError,
  type HostStorageService,
  type StorageBucket,
  type StorageObject
} from "@woohaa3/contracts";
import { MEDIA_STORAGE_NAMESPACE, createMediaStorageFromStorage } from "./media-storage.js";

type FakeBucket = StorageBucket & { objects: Map<string, StorageObject>; exposed: string[] };

function fakeBucket(namespace: string): FakeBucket {
  const objects = new Map<string, StorageObject>();
  const exposed: string[] = [];
  return {
    namespace,
    objects,
    exposed,
    backendId: () => "local",
    async head(key) {
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength, ...(object.contentType ? { contentType: object.contentType } : {}) } : null;
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) throw new StorageObjectNotFoundError(key);
      return object;
    },
    async put(key, bytes, contentType) {
      objects.set(key, { bytes, contentType });
    },
    canExpose: () => true,
    async expose(key, options) {
      exposed.push(`${key}:${options?.expiresSeconds ?? ""}`);
      return `https://storage.invalid/${key}?expires=${options?.expiresSeconds ?? 900}`;
    }
  };
}

function fakeStorage(): {
  storage: HostStorageService;
  buckets: string[];
  scopes: Array<{ canvasId?: string }>;
  swap: (bucket: FakeBucket) => void;
} {
  const buckets: string[] = [];
  const scopes: Array<{ canvasId?: string }> = [];
  let current = fakeBucket("media");
  return {
    buckets,
    scopes,
    storage: {
      register: () => () => undefined,
      unregister: () => undefined,
      list: () => [],
      resolve: () => undefined,
      bucket: (namespace, scope) => {
        buckets.push(namespace);
        scopes.push(scope ? { canvasId: scope.canvasId } : {});
        return current;
      },
      replicate: async () => false,
      primaryId: () => "local",
      exposeId: () => undefined,
      readiness: () => ({ ready: true })
    },
    swap: (bucket) => {
      current = bucket;
    }
  };
}

describe("createMediaStorageFromStorage", () => {
  it("读写都落到 media namespace，并透传 contentType", async () => {
    const { storage, buckets } = fakeStorage();
    const media = createMediaStorageFromStorage(storage);

    await media.put("sha256-abc.png", Uint8Array.of(1, 2), "image/png");
    expect(buckets.every((namespace) => namespace === MEDIA_STORAGE_NAMESPACE)).toBe(true);
    expect(await media.exists("sha256-abc.png")).toBe(true);
    expect(await media.stat!("sha256-abc.png")).toEqual({ size: 2, contentType: "image/png" });
    expect((await media.get("sha256-abc.png")).bytes.byteLength).toBe(2);
  });

  it("exists=false、stat/get 抛 Media not-found（下游按字符串判定）", async () => {
    const { storage } = fakeStorage();
    const media = createMediaStorageFromStorage(storage);

    expect(await media.exists("gone.png")).toBe(false);
    await expect(media.get("gone.png")).rejects.toBeInstanceOf(MediaObjectNotFoundError);
    await expect(media.stat!("gone.png")).rejects.toBeInstanceOf(MediaObjectNotFoundError);
    try {
      await media.get("gone.png");
    } catch (error) {
      expect(isMediaObjectNotFoundError(error)).toBe(true);
    }
  });

  it("getHttpsUrl 走 bucket.expose，并带上有效期", async () => {
    const { storage } = fakeStorage();
    const media = createMediaStorageFromStorage(storage);

    expect(await media.getHttpsUrl!("sha256-abc.png", { expiresSeconds: 60 })).toBe(
      "https://storage.invalid/sha256-abc.png?expires=60"
    );
  });

  it("每次调用现查 bucket：主存储热切换对 media 无感", async () => {
    const { storage, swap } = fakeStorage();
    const media = createMediaStorageFromStorage(storage);
    await media.put("a.png", Uint8Array.of(1), "image/png");

    const next = fakeBucket("media");
    swap(next);
    await media.put("b.png", Uint8Array.of(2), "image/png");

    expect(await media.exists("a.png")).toBe(false);
    expect(await media.exists("b.png")).toBe(true);
  });

  it("画布作用域按调用透传给 bucket；缺省调用不带作用域", async () => {
    const { storage, scopes } = fakeStorage();
    const media = createMediaStorageFromStorage(storage);
    const scope = { canvasId: "canvas-1" };

    await media.put("a.png", Uint8Array.of(1), "image/png", scope);
    await media.exists("a.png", scope);
    await media.get("a.png", scope);
    await media.stat!("a.png", scope);
    await media.openRead!("a.png", undefined, scope);
    await media.getHttpsUrl!("a.png", { expiresSeconds: 60 }, scope);
    await media.put("b.png", Uint8Array.of(2), "image/png");

    expect(scopes).toEqual([
      { canvasId: "canvas-1" },
      { canvasId: "canvas-1" },
      { canvasId: "canvas-1" },
      { canvasId: "canvas-1" },
      { canvasId: "canvas-1" },
      { canvasId: "canvas-1" },
      {}
    ]);
  });

  it("非存储 not-found 的错误原样抛出，不伪装成媒体 not-found", async () => {
    const { storage, swap } = fakeStorage();
    swap({
      ...fakeBucket("media"),
      async get() {
        throw new Error("storage down");
      }
    });
    await expect(createMediaStorageFromStorage(storage).get("a.png")).rejects.toThrow(/storage down/);
  });
});


it("流式读取保留取消入口，旧 bucket 回退仍支持区间与 not-found 翻译", async () => {
  const { storage, swap } = fakeStorage();
  const current = fakeBucket("media");
  current.objects.set("video.mp4", { bytes: Uint8Array.of(0, 1, 2, 3) });
  swap(current);
  const media = createMediaStorageFromStorage(storage);
  const fallback = await media.openRead!("video.mp4", { start: 1, end: 2 });
  const chunks: number[] = [];
  for await (const chunk of fallback.bytes) chunks.push(...chunk);
  expect(chunks).toEqual([1, 2]);
  await expect(media.openRead!("missing.mp4")).rejects.toBeInstanceOf(MediaObjectNotFoundError);
  let cancelled = false;
  current.openRead = async (key, range) => {
    expect({ key, range }).toEqual({ key: "video.mp4", range: { start: 10, end: 19 } });
    return { bytes: (async function* () { yield Uint8Array.of(7); })(), cancel() { cancelled = true; } };
  };
  const stream = await media.openRead!("video.mp4", { start: 10, end: 19 });
  stream.cancel();
  expect(cancelled).toBe(true);
});
