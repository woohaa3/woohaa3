/**
 * 工程对象接收边界（change: 2026-10-16-integrate-photocraft-image-editing，任务 2.3；
 * change: 2026-10-21-extract-photocraft-subproject，任务 3.2 / design D5）。
 *
 * 核验**实现**已迁入 `@woohaa3/photocraft-project-verifier`，但**接收政策**仍由 Media 拥有：
 * 上传路由、认证、部署更低上限、内容寻址、错误映射与引用保留。因此这里的用例只验证
 * 「拒绝不落合法对象」与入口分派，不复制核验器内部的 ZIP/manifest 细节（那些在子项目里）。
 */
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { IMAGE_PROJECT_CONTENT_TYPE } from "@woohaa3/contracts";
import type { MediaObject, MediaStorage } from "@woohaa3/contracts";
import { createMediaRequestHandler } from "./api/public-handler.js";
import { MediaIngestError, ingestMediaObject } from "./application/ingest.js";
import { buildZip, manifest, projectBytes } from "@woohaa3/photocraft-project-verifier/test-support";

function memoryStorage(): MediaStorage & { keys: () => string[] } {
  const objects = new Map<string, MediaObject>();
  return {
    async put(key, bytes, contentType) {
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    async get(key) {
      const record = objects.get(key);
      if (!record) throw new Error("not found");
      return record;
    },
    async exists(key) {
      return objects.has(key);
    },
    keys: () => [...objects.keys()]
  } as MediaStorage & { keys: () => string[] };
}

describe("工程 ingest 边界（接收政策仍在 Media）", () => {
  it("专用入口核验通过后返回稳定 metadata 并内容寻址去重", async () => {
    const storage = memoryStorage();
    const bytes = projectBytes();
    const first = await ingestMediaObject({
      storage,
      bytes,
      contentType: IMAGE_PROJECT_CONTENT_TYPE,
      projectIngest: true
    });
    expect(first.storageKey).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(first.contentType).toBe(IMAGE_PROJECT_CONTENT_TYPE);
    expect(first.deduplicated).toBe(false);
    const second = await ingestMediaObject({
      storage,
      bytes,
      contentType: IMAGE_PROJECT_CONTENT_TYPE,
      projectIngest: true
    });
    expect(second.deduplicated).toBe(true);
  });

  it("普通上传不能通过改 MIME 绕过核验", async () => {
    const storage = memoryStorage();
    try {
      await ingestMediaObject({
        storage,
        bytes: buildZip([{ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest())) }]),
        contentType: IMAGE_PROJECT_CONTENT_TYPE
      });
      throw new Error("应当拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaIngestError);
      expect((error as MediaIngestError).code).toBe("project-requires-verification");
    }
    // 拒绝不落任何对象。
    expect(storage.keys()).toEqual([]);
  });

  it("专用入口拒绝非工程 MIME", async () => {
    const storage = memoryStorage();
    await expect(
      ingestMediaObject({
        storage,
        bytes: Uint8Array.from([1, 2, 3]),
        contentType: "image/png",
        projectIngest: true
      })
    ).rejects.toMatchObject({ code: "unsupported-media-type" });
    expect(storage.keys()).toEqual([]);
  });

  it("核验失败的工程不产生可关联 metadata", async () => {
    const storage = memoryStorage();
    await expect(
      ingestMediaObject({
        storage,
        bytes: buildZip([{ name: "manifest.json", data: new TextEncoder().encode("{bad") }]),
        contentType: IMAGE_PROJECT_CONTENT_TYPE,
        projectIngest: true
      })
    ).rejects.toMatchObject({ code: "project-verification-failed" });
    expect(storage.keys()).toEqual([]);
  });

  it("非 ZIP 字节按工程核验原因拒绝，不落对象", async () => {
    const storage = memoryStorage();
    await expect(
      ingestMediaObject({
        storage,
        bytes: new TextEncoder().encode("not a zip"),
        contentType: IMAGE_PROJECT_CONTENT_TYPE,
        projectIngest: true
      })
    ).rejects.toMatchObject({ code: "project-verification-failed" });
    expect(storage.keys()).toEqual([]);
  });
});

describe("工程上传入口 /api/media-projects", () => {
  it("支持 canvas 作用域并透传给 put", async () => {
    const calls: Array<{ key: string; scope?: unknown }> = [];
    const objects = new Map<string, MediaObject>();
    const storage: MediaStorage = {
      async put(key, bytes, contentType, scope) {
        calls.push({ key, scope });
        objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
      },
      async exists(key) {
        return objects.has(key);
      },
      async get(key) {
        const record = objects.get(key);
        if (!record) throw new Error("not found");
        return record;
      },
      async stat(key) {
        const record = objects.get(key);
        if (!record) throw new Error("not found");
        return { size: record.bytes.byteLength, contentType: record.contentType };
      }
    };
    const handler = createMediaRequestHandler({ storage });
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const response = await fetch("http://127.0.0.1:" + address.port + "/api/media-projects?canvas=canvas-9", {
        method: "POST",
        headers: { "content-type": IMAGE_PROJECT_CONTENT_TYPE },
        body: projectBytes() as unknown as BodyInit
      });
      expect(response.status).toBe(201);
      const metadata = (await response.json()) as { storageKey: string };
      expect(calls).toEqual([{ key: metadata.storageKey, scope: { canvasId: "canvas-9" } }]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("部署更低上限优先生效，超限不落对象", async () => {
    const storage = memoryStorage();
    const bytes = projectBytes();
    await expect(
      ingestMediaObject({
        storage,
        bytes,
        contentType: IMAGE_PROJECT_CONTENT_TYPE,
        projectIngest: true,
        maxBytes: 16
      })
    ).rejects.toMatchObject({ code: "payload-too-large" });
    expect(storage.keys()).toEqual([]);
  });
});
