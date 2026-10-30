/**
 * 产物位置诊断（只读）测试。
 *
 * 锁住四件事：先问路由后端、未命中再跨后端找、都找不到时返回 null、单个后端报错不影响整体。
 * 这层允许跨后端，是因为它回答的是「现在在哪」，且答案不会被任何读写路径复用。
 */
import { describe, expect, it } from "vitest";
import type { HostStorageService, StorageBackend, StorageObject } from "@woohaa3/contracts";
import { StorageObjectNotFoundError } from "@woohaa3/contracts";
import { createStorageRegistry } from "./storage.js";
import { locateArtifact } from "./artifact-location.js";

type MemoryBackend = StorageBackend & { objects: Map<string, StorageObject>; heads: string[] };

function memoryBackend(
  backendId: string,
  options: { presign?: boolean; failHead?: boolean; locator?: (key: string) => string } = {}
): MemoryBackend {
  const objects = new Map<string, StorageObject>();
  const heads: string[] = [];
  return {
    backendId,
    label: backendId,
    objects,
    heads,
    async head(key) {
      heads.push(key);
      if (options.failHead) throw new Error("backend down");
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength } : null;
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) throw new StorageObjectNotFoundError(key);
      return object;
    },
    async put(key, bytes, contentType) {
      objects.set(key, { bytes, contentType });
    },
    ...(options.locator ? { async locatorOf(key: string) { return options.locator!(key); } } : {})
  };
}

function storageWith(backends: readonly StorageBackend[], primary = "local"): HostStorageService {
  const storage = createStorageRegistry({ settings: { primary: () => primary } });
  for (const backend of backends) storage.register(backend);
  return storage;
}

const KEY = "generation-outputs/a.png";

describe("locateArtifact", () => {
  it("路由后端命中：只问它一次", async () => {
    const local = memoryBackend("local");
    const cos = memoryBackend("cos");
    local.objects.set(`media/${KEY}`, { bytes: Uint8Array.of(1) });
    const logs: Array<Record<string, unknown>> = [];

    const located = await locateArtifact({ storage: storageWith([local, cos]), storageKey: KEY, logger: (e) => logs.push(e) });
    expect(located).toEqual({ backendId: "local", key: `media/${KEY}`, locator: `media://local/media/${KEY}` });
    expect(cos.heads).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("主存储没有时跨后端找到它，并记一笔「在别处」", async () => {
    const local = memoryBackend("local");
    const cos = memoryBackend("cos", { locator: (key) => `media://cos/${key}` });
    cos.objects.set(`media/${KEY}`, { bytes: Uint8Array.of(1, 2) });
    const logs: Array<Record<string, unknown>> = [];

    const located = await locateArtifact({ storage: storageWith([local, cos]), storageKey: KEY, logger: (e) => logs.push(e) });
    expect(located?.backendId).toBe("cos");
    // 后端自己给 locator 时用它的值，不派生。
    expect(located?.locator).toBe(`media://cos/media/${KEY}`);
    expect(logs).toContainEqual({ event: "artifact-locate-elsewhere", backendId: "cos", routedId: "local", storageKey: KEY });
  });

  it("哪个后端都没有时返回 null，不编位置", async () => {
    const local = memoryBackend("local");
    const cos = memoryBackend("cos");
    const logs: Array<Record<string, unknown>> = [];

    expect(await locateArtifact({ storage: storageWith([local, cos]), storageKey: KEY, logger: (e) => logs.push(e) })).toBeNull();
    expect(logs).toContainEqual({ event: "artifact-locate-missed", routedId: "local", storageKey: KEY });
  });

  it("单个后端报错只记日志，继续问下一个", async () => {
    const local = memoryBackend("local", { failHead: true });
    const cos = memoryBackend("cos");
    cos.objects.set(`media/${KEY}`, { bytes: Uint8Array.of(1) });
    const logs: Array<Record<string, unknown>> = [];

    const located = await locateArtifact({ storage: storageWith([local, cos]), storageKey: KEY, logger: (e) => logs.push(e) });
    expect(located?.backendId).toBe("cos");
    expect(logs).toContainEqual({ event: "artifact-locate-failed", backendId: "local", reason: "Error" });
  });

  it("带画布作用域时把 scope 透传给后端", async () => {
    const local = memoryBackend("local");
    const seen: Array<string | undefined> = [];
    local.head = async (key, scope) => {
      seen.push(scope?.canvasId);
      return local.objects.get(key) ? { size: 1 } : null;
    };
    local.objects.set(`media/${KEY}`, { bytes: Uint8Array.of(1) });

    await locateArtifact({ storage: storageWith([local]), storageKey: KEY, scope: { canvasId: "c1" } });
    expect(seen).toEqual(["c1"]);
  });
});
