/**
 * 存储扩展点 → Media 存储端口适配器测试。
 *
 * 锁定边界语义：namespace 固定 media、`exists`/`stat` 走 `head`、`getHttpsUrl` 走 `ctx.exposer`、
 * 存储 not-found 翻译成 `MediaObjectNotFoundError`、每次调用现查 bucket（主存储热切换），
 * 调用方声明的画布作用域按调用透传给 `ctx.storage.bucket` 与 `ctx.exposer`（适配器自己不理解路由），
 * 以及「没有 exposer 时不挂 getHttpsUrl」——能力缺席要让调用方看得见，而不是迟到的拒绝。
 */
import { describe, expect, it } from "vitest";
import {
  MediaObjectNotFoundError,
  isMediaObjectNotFoundError,
  StorageObjectNotFoundError,
  type HostExposerService,
  type HostStorageService,
  type StorageBucket,
  type StorageExposeInput,
  type StorageObject
} from "@woohaa3/contracts";
import { MEDIA_STORAGE_NAMESPACE, createMediaStorageFromStorage } from "./media-storage.js";

type FakeBucket = StorageBucket & { objects: Map<string, StorageObject> };

function fakeBucket(namespace: string): FakeBucket {
  const objects = new Map<string, StorageObject>();
  return {
    namespace,
    objects,
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
    }
  };
}

function fakeExposer(): { exposer: HostExposerService; calls: StorageExposeInput[] } {
  const calls: StorageExposeInput[] = [];
  return {
    calls,
    exposer: {
      register: () => () => undefined,
      unregister: () => undefined,
      list: () => [],
      resolve: () => undefined,
      selectedId: () => "cos",
      available: () => true,
      async expose(input) {
        calls.push(input);
        return `https://storage.invalid/${input.namespace}/${input.key}?expires=${input.expiresSeconds ?? 900}`;
      },
      temporaryHosting: () => ({ mode: "manual", selectionSource: "manual", selectedId: "cos", candidates: [], error: null, lastFailure: null })
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
      current: () => ({ backendId: "local" }),
      replicate: async () => false,
      readLocator: async () => ({ bytes: new Uint8Array([1]) }),
      primaryId: () => "local",
      readiness: () => ({ ready: true })
    },
    swap: (bucket) => {
      current = bucket;
    }
  };
}

describe("createMediaStorageFromStorage", () => {
  it("读写都落到 media namespace，并透传 contentType", async () => {
    const { storage } = fakeStorage();
    const media = createMediaStorageFromStorage(storage, fakeExposer().exposer);

    await media.put("sha256-abc.png", Uint8Array.of(1, 2), "image/png");
    expect((await media.exists("sha256-abc.png"))).toBe(true);
    expect(await media.stat!("sha256-abc.png")).toEqual({ size: 2, contentType: "image/png" });
    expect((await media.get("sha256-abc.png")).bytes.byteLength).toBe(2);
  });

  it("exists=false、stat/get 抛 Media not-found（下游按字符串判定）", async () => {
    const { storage } = fakeStorage();
    const media = createMediaStorageFromStorage(storage, fakeExposer().exposer);

    expect(await media.exists("gone.png")).toBe(false);
    await expect(media.get("gone.png")).rejects.toBeInstanceOf(MediaObjectNotFoundError);
    await expect(media.stat!("gone.png")).rejects.toBeInstanceOf(MediaObjectNotFoundError);
    try {
      await media.get("gone.png");
    } catch (error) {
      expect(isMediaObjectNotFoundError(error)).toBe(true);
    }
  });

  it("getHttpsUrl 走 ctx.exposer，并带上有效期与画布作用域", async () => {
    const { storage } = fakeStorage();
    const { exposer, calls } = fakeExposer();
    const media = createMediaStorageFromStorage(storage, exposer);

    expect(await media.getHttpsUrl!("sha256-abc.png", { expiresSeconds: 60 })).toBe(
      "https://storage.invalid/media/sha256-abc.png?expires=60"
    );
    await media.getHttpsUrl!("sha256-abc.png", { expiresSeconds: 60 }, { canvasId: "canvas-1" });
    expect(calls).toEqual([
      { namespace: MEDIA_STORAGE_NAMESPACE, key: "sha256-abc.png", expiresSeconds: 60 },
      { namespace: MEDIA_STORAGE_NAMESPACE, key: "sha256-abc.png", scope: { canvasId: "canvas-1" }, expiresSeconds: 60 }
    ]);
  });

  it("没有 exposer 时不挂 getHttpsUrl（能力缺席可见）", () => {
    const { storage } = fakeStorage();
    expect(createMediaStorageFromStorage(storage, undefined).getHttpsUrl).toBeUndefined();
  });

  it("每次调用现查 bucket：主存储热切换对 media 无感", async () => {
    const { storage, swap } = fakeStorage();
    const media = createMediaStorageFromStorage(storage, fakeExposer().exposer);
    await media.put("a.png", Uint8Array.of(1), "image/png");

    const next = fakeBucket("media");
    swap(next);
    await media.put("b.png", Uint8Array.of(2), "image/png");

    expect(await media.exists("a.png")).toBe(false);
    expect(await media.exists("b.png")).toBe(true);
  });

  it("画布作用域按调用透传给 bucket；缺省调用不带作用域", async () => {
    const { storage, scopes } = fakeStorage();
    const media = createMediaStorageFromStorage(storage, fakeExposer().exposer);
    const scope = { canvasId: "canvas-1" };

    await media.put("a.png", Uint8Array.of(1), "image/png", scope);
    await media.exists("a.png", scope);
    await media.get("a.png", scope);
    await media.stat!("a.png", scope);
    await media.openRead!("a.png", undefined, scope);
    await media.put("b.png", Uint8Array.of(2), "image/png");

    expect(scopes).toEqual([
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
    await expect(createMediaStorageFromStorage(storage, fakeExposer().exposer).get("a.png")).rejects.toThrow(/storage down/);
  });
});

it("流式读取保留取消入口，旧 bucket 回退仍支持区间与 not-found 翻译", async () => {
  const { storage, swap } = fakeStorage();
  const current = fakeBucket("media");
  current.objects.set("video.mp4", { bytes: Uint8Array.of(0, 1, 2, 3) });
  swap(current);
  const media = createMediaStorageFromStorage(storage, fakeExposer().exposer);
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
