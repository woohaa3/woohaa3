/**
 * 本地存储后端插件测试。
 *
 * 覆盖：put/head/get 往返（含 contentType 与磁盘落点）、not-found 语义、sidecar 缺失时的
 * 扩展名推断、`..`/绝对路径越界拒绝、delete 连带 sidecar、以及插件的注册/注销形状。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageObjectNotFoundError, type HostExtensionContext, type StorageBackend } from "@woohaa3/contracts";
import { createLocalBackend, createLocalStoragePlugin } from "../src/backend.js";

let root: string;
let backend: StorageBackend;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "woohaa3-local-storage-"));
  backend = createLocalBackend({ root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("put / head / get 往返", () => {
  it("流式写入只提交完整文件，中断及取消保留原对象并清理临时文件", async () => {
    const key="media/stream.bin", source=async function*(){for(let i=0;i<17;i++)yield new Uint8Array(1024**2).fill(71);};
    await backend.putStream!(key,source(),"application/zip",{size:17*1024**2});
    expect(await backend.head(key)).toEqual({size:17*1024**2,contentType:"application/zip"});
    const read=await backend.openRead!(key);let count=0;for await(const chunk of read.bytes)count+=chunk.length;read.cancel();expect(count).toBe(17*1024**2);
    await expect(backend.putStream!(key,(async function*(){yield Uint8Array.of(1);throw Error("disconnected");})(),"video/mp4",{size:2})).rejects.toThrow("disconnected");
    const controller=new AbortController();
    await expect(backend.putStream!(key,(async function*(){yield Uint8Array.of(1);controller.abort();yield Uint8Array.of(2);})(),"video/mp4",{size:2,signal:controller.signal})).rejects.toThrow();
    expect(await backend.head(key)).toEqual({size:17*1024**2,contentType:"application/zip"});
    expect((await readdir(path.join(root,"media"))).sort()).toEqual(["stream.bin","stream.bin.meta.json"]);
  });
  it("put 后 head 与 get 都能拿到字节与 contentType", async () => {
    await backend.put("media/sha256-abc.png", Uint8Array.of(1, 2, 3), "image/png");

    expect(await backend.head("media/sha256-abc.png")).toEqual({ size: 3, contentType: "image/png" });

    const object = await backend.get("media/sha256-abc.png");
    expect(Array.from(object.bytes)).toEqual([1, 2, 3]);
    expect(object.contentType).toBe("image/png");
  });

  it("对象落在磁盘的 `${root}/${key}`，并写出 sidecar", async () => {
    await backend.put("media/sha256-abc.png", Uint8Array.of(9, 8), "image/png");

    const objectPath = path.join(root, "media", "sha256-abc.png");
    expect(Array.from(await readFile(objectPath))).toEqual([9, 8]);
    expect(JSON.parse(await readFile(`${objectPath}.meta.json`, "utf8"))).toEqual({ contentType: "image/png" });
  });

  it("忽略画布作用域：键布局与磁盘落点不变（画布维度只影响 server 后端）", async () => {
    const scope = { canvasId: "canvas-1" };
    await backend.put("media/sha256-abc.png", Uint8Array.of(1), "image/png", scope);

    // 没有 <canvasId>/ 前缀：本地后端对 StorageScope 无感。
    expect(Array.from(await readFile(path.join(root, "media", "sha256-abc.png")))).toEqual([1]);
    expect(await backend.head("media/sha256-abc.png", scope)).toEqual({ size: 1, contentType: "image/png" });
    expect(Array.from((await backend.get("media/sha256-abc.png", scope)).bytes)).toEqual([1]);
    await backend.delete!("media/sha256-abc.png", scope);
    expect(await backend.head("media/sha256-abc.png")).toBeNull();
  });

  it("覆盖写会更新 sidecar 的 contentType", async () => {
    await backend.put("media/a.bin", Uint8Array.of(1), "application/octet-stream");
    await backend.put("media/a.bin", Uint8Array.of(1, 2), "video/mp4");

    expect(await backend.head("media/a.bin")).toEqual({ size: 2, contentType: "video/mp4" });
  });
});

describe("not-found 语义", () => {
  it("head 不存在返回 null，get 抛 StorageObjectNotFoundError（保留跨 bundle 的 code/name/key）", async () => {
    expect(await backend.head("media/missing.png")).toBeNull();

    await expect(backend.get("media/missing.png")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    try {
      await backend.get("media/missing.png");
    } catch (error) {
      expect((error as StorageObjectNotFoundError).code).toBe("STORAGE_OBJECT_NOT_FOUND");
      expect((error as StorageObjectNotFoundError).name).toBe("StorageObjectNotFoundError");
      expect((error as StorageObjectNotFoundError).key).toBe("media/missing.png");
    }
  });

  it("只删掉 sidecar 时仍能读对象，contentType 回落扩展名推断", async () => {
    await backend.put("media/photo.png", Uint8Array.of(1), "image/png");
    await rm(path.join(root, "media", "photo.png.meta.json"));

    const object = await backend.get("media/photo.png");
    expect(Array.from(object.bytes)).toEqual([1]);
    expect(object.contentType).toBe("image/png");
  });
});

describe("contentType 扩展名推断", () => {
  it("无 sidecar 时按扩展名推断，未知扩展名兜底 octet-stream", async () => {
    await mkdir(path.join(root, "media"), { recursive: true });
    await writeFile(path.join(root, "media", "raw.jpg"), Uint8Array.of(1));
    await writeFile(path.join(root, "media", "clip.webm"), Uint8Array.of(1));
    await writeFile(path.join(root, "media", "sound.m4a"), Uint8Array.of(1));
    await writeFile(path.join(root, "media", "doc.json"), Uint8Array.of(1));
    await writeFile(path.join(root, "media", "blob.dat"), Uint8Array.of(1));

    expect((await backend.head("media/raw.jpg"))?.contentType).toBe("image/jpeg");
    expect((await backend.head("media/clip.webm"))?.contentType).toBe("video/webm");
    expect((await backend.head("media/sound.m4a"))?.contentType).toBe("audio/mp4");
    expect((await backend.head("media/doc.json"))?.contentType).toBe("application/json");
    expect((await backend.head("media/blob.dat"))?.contentType).toBe("application/octet-stream");
  });
});

describe("key 越界安全", () => {
  const ILLEGAL_KEYS = ["../escape.png", "media/../../escape.png", "..", "media/..", "/etc/passwd", "C:\\evil.png", "media/\0evil.png"];

  it("含 .. 段、绝对路径或 NUL 的 key 一律抛「非法的存储 key」", async () => {
    for (const key of ILLEGAL_KEYS) {
      await expect(backend.put(key, Uint8Array.of(1), "image/png")).rejects.toThrow(/非法的存储 key/);
      await expect(backend.get(key)).rejects.toThrow(/非法的存储 key/);
      await expect(backend.head(key)).rejects.toThrow(/非法的存储 key/);
      await expect(backend.delete!(key)).rejects.toThrow(/非法的存储 key/);
    }
  });

  it("越界尝试不写出 root 之外的任何文件", async () => {
    await expect(backend.put("../escape.png", Uint8Array.of(1), "image/png")).rejects.toThrow(/非法的存储 key/);
    expect(await readdir(root)).toEqual([]);
    await expect(stat(path.join(root, "..", "escape.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("delete", () => {
  it("删除对象与 sidecar，且重复删除不报错", async () => {
    await backend.put("media/gone.png", Uint8Array.of(1, 2, 3), "image/png");
    await backend.delete!("media/gone.png");

    expect(await backend.head("media/gone.png")).toBeNull();
    await expect(stat(path.join(root, "media", "gone.png"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(root, "media", "gone.png.meta.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await backend.delete!("media/gone.png");
  });
});

describe("插件形状", () => {
  it("元数据与 litellm-provider 同形，apply 经 ctx.effect 注册并可在卸载时注销", async () => {
    const plugin = createLocalStoragePlugin();
    expect(plugin.name).toBe("local-storage");
    expect(plugin.label).toBe("本地存储");
    expect(plugin.configPrefix).toBe("storage.local");
    expect(plugin.inject).toEqual(["log", "storage"]);
    expect(plugin.Config.fields.root.default).toBe(".woohaa3/storage");

    const registered: StorageBackend[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const disposers: Array<() => void> = [];
    const ctx = {
      storage: {
        register(registeredBackend: StorageBackend) {
          registered.push(registeredBackend);
          return () => {
            const index = registered.indexOf(registeredBackend);
            if (index >= 0) registered.splice(index, 1);
          };
        }
      },
      log: {
        scope: () => (event: Record<string, unknown>) => {
          logs.push(event);
        }
      },
      effect: (callback: () => () => void) => {
        disposers.push(callback());
      }
    } as unknown as HostExtensionContext;

    await plugin.apply(ctx, { root });

    expect(registered.map((item) => item.backendId)).toEqual(["local"]);
    // 「完全本地」的能力边界：没有 presign。
    expect(registered[0]?.presign).toBeUndefined();
    expect(registered[0]?.label).toBe("本地存储");
    expect(logs[0]).toMatchObject({ event: "local-storage-activated", backendId: "local" });

    disposers.forEach((dispose) => dispose());
    expect(registered).toEqual([]);
  });
});
