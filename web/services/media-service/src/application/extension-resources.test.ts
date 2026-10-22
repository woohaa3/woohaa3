/**
 * 扩展资源 facade 的画布作用域透传（进程内宿主与 HTTP 路由共用同一个实现）。
 *
 * 不变量：远端画布的媒体字节只存在服务端托管存储里（键 `<canvasId>/media/<key>`），
 * 调用方声明了 canvasId 就必须以该作用域读写；省略表示与画布无关（扩展素材、独立页），
 * 保持历史行为；非法 id 必须拒绝，不能静默降级成「无作用域」。
 */
import { describe, expect, it } from "vitest";
import type { MediaObject, MediaStorage, MediaStorageScope } from "@woohaa3/contracts";
import { MediaObjectNotFoundError } from "@woohaa3/contracts";
import { createExtensionMediaResources, ExtensionResourceError } from "./extension-resources.js";

type StorageCalls = {
  get: Array<{ key: string; scope?: MediaStorageScope }>;
  put: Array<{ key: string; scope?: MediaStorageScope }>;
  exists: Array<{ key: string; scope?: MediaStorageScope }>;
};

/** 记录每次存储调用收到的画布作用域。 */
function recordingStorage(objects = new Map<string, MediaObject>()): { storage: MediaStorage; calls: StorageCalls } {
  const calls: StorageCalls = { get: [], put: [], exists: [] };
  const storage: MediaStorage = {
    async put(key, bytes, contentType, scope) {
      calls.put.push({ key, scope });
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    async get(key, scope) {
      calls.get.push({ key, scope });
      const record = objects.get(key);
      if (!record) throw new MediaObjectNotFoundError(key);
      return record;
    },
    async exists(key, scope) {
      calls.exists.push({ key, scope });
      return objects.has(key);
    }
  };
  return { storage, calls };
}

const HTML = Uint8Array.from([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]);
const CSS = Uint8Array.from([0x62, 0x6f, 0x64, 0x79, 0x7b, 0x7d]);

describe("createExtensionMediaResources 画布作用域", () => {
  it("write 与 read 把 canvasId 变成存储作用域", async () => {
    const { storage, calls } = recordingStorage();
    const resources = createExtensionMediaResources(storage);

    const written = await resources.write({ bytes: HTML, contentType: "text/html", canvasId: "canvas-scope" });
    expect(calls.exists.at(-1)).toEqual({ key: written.storageKey, scope: { canvasId: "canvas-scope" } });
    expect(calls.put.at(-1)).toEqual({ key: written.storageKey, scope: { canvasId: "canvas-scope" } });

    const read = await resources.read(written.storageKey, "canvas-scope");
    expect(read.bytes).toEqual(HTML);
    expect(calls.get.at(-1)).toEqual({ key: written.storageKey, scope: { canvasId: "canvas-scope" } });
  });

  it("省略 canvasId 时不传作用域（与画布无关，保持旧行为）", async () => {
    const { storage, calls } = recordingStorage();
    const resources = createExtensionMediaResources(storage);

    const written = await resources.write({ bytes: CSS, contentType: "text/css" });
    expect(calls.exists.at(-1)?.scope).toBeUndefined();
    expect(calls.put.at(-1)?.scope).toBeUndefined();

    await resources.read(written.storageKey);
    expect(calls.get.at(-1)?.scope).toBeUndefined();
  });

  it("非法 canvasId 拒绝且不产生存储副作用（不能静默丢弃作用域）", async () => {
    const { storage, calls } = recordingStorage();
    const resources = createExtensionMediaResources(storage);

    await expect(resources.read("sha256-" + "a".repeat(64), "../escape")).rejects.toMatchObject({
      code: "malformed-request",
      status: 400
    });
    await expect(resources.write({ bytes: HTML, contentType: "text/html", canvasId: "../escape" })).rejects.toMatchObject({
      code: "malformed-request",
      status: 400
    });
    expect(calls.get).toHaveLength(0);
    expect(calls.exists).toHaveLength(0);
    expect(calls.put).toHaveLength(0);
    expect(new ExtensionResourceError("malformed-request", 400, "x")).toBeInstanceOf(Error);
  });
});
