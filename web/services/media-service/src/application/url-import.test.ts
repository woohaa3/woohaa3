/**
 * Provider URL 转存的有界重试（change: 2026-11-06-fix-media-output-readiness，任务 2.1）。
 *
 * - 超时/网络/5xx 才重试（默认 2 次退避）；
 * - 4xx 立即失败，错误保留 HTTP 状态与稳定分类；
 * - 全部失败仍只暴露安全分类，不含 provider 临时 URL。
 */
import { describe, expect, it } from "vitest";
import type { MediaObject, MediaStorage } from "@woohaa3/contracts";
import { MediaObjectNotFoundError } from "@woohaa3/contracts";
import { createMediaApplicationService, MediaApplicationError } from "./internal-service.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PROVIDER_URL = "https://provider.example/temp/out.png?signature=secret";

function memoryStorage(objects = new Map<string, MediaObject>()): MediaStorage {
  return {
    async put(key, bytes, contentType) {
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    async get(key): Promise<MediaObject> {
      const record = objects.get(key);
      if (!record) throw new MediaObjectNotFoundError(key);
      return record;
    },
    async exists(key) {
      return objects.has(key);
    },
    async stat(key) {
      const record = objects.get(key);
      if (!record) throw new MediaObjectNotFoundError(key);
      return { size: record.bytes.byteLength, contentType: record.contentType };
    }
  } as MediaStorage;
}

function service(fetchImpl: typeof globalThis.fetch) {
  const objects = new Map<string, MediaObject>();
  const logs: Array<Record<string, unknown>> = [];
  const app = createMediaApplicationService({
    storage: memoryStorage(objects),
    fetchImpl,
    importRetryDelaysMs: [0, 0],
    importSleep: async () => undefined,
    logger: (event) => logs.push(event as unknown as Record<string, unknown>)
  });
  return { app, objects, logs };
}

function pngResponse(): Response {
  return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
}

describe("importFromUrl 有界重试", () => {
  it("5xx 是瞬时失败：重试后成功写入稳定键", async () => {
    let calls = 0;
    const h = service((async () => {
      calls += 1;
      return calls === 1 ? new Response("busy", { status: 503 }) : pngResponse();
    }) as unknown as typeof globalThis.fetch);

    const metadata = await h.app.importFromUrl({ url: PROVIDER_URL });
    expect(calls).toBe(2);
    expect(metadata.storageKey).toMatch(/^generation-outputs\/[0-9a-f]{64}\.png$/);
    expect(h.objects.has(metadata.storageKey)).toBe(true);
    // 日志只留状态与分类，不含临时 URL。
    expect(JSON.stringify(h.logs)).not.toContain("provider.example");
  });

  it("网络错误/超时会重试，用尽后按可重试分类失败", async () => {
    let calls = 0;
    const h = service((async () => {
      calls += 1;
      throw new TypeError(`fetch failed ${PROVIDER_URL}`);
    }) as unknown as typeof globalThis.fetch);

    const error = await h.app.importFromUrl({ url: PROVIDER_URL }).catch((cause: unknown) => cause);
    expect(calls).toBe(3);
    expect(error).toBeInstanceOf(MediaApplicationError);
    expect(error).toMatchObject({ code: "storage-failed" });
    expect(JSON.stringify(error)).not.toContain("provider.example");
    expect(JSON.stringify(h.logs)).not.toContain("provider.example");
  });

  it("4xx 立即失败，不重试，并保留上游 HTTP 状态", async () => {
    let calls = 0;
    const h = service((async () => {
      calls += 1;
      return new Response("gone", { status: 404 });
    }) as unknown as typeof globalThis.fetch);

    const error = await h.app.importFromUrl({ url: PROVIDER_URL }).catch((cause: unknown) => cause);
    expect(calls).toBe(1);
    expect(error).toMatchObject({ code: "media-not-found", status: 404 });
    expect(h.logs.at(-1)).toMatchObject({ code: "media-not-found", upstreamStatus: 404 });
  });

  it("持续 5xx 用尽重试后保留最后一次上游状态", async () => {
    let calls = 0;
    const h = service((async () => {
      calls += 1;
      return new Response("busy", { status: 503 });
    }) as unknown as typeof globalThis.fetch);

    const error = await h.app.importFromUrl({ url: PROVIDER_URL }).catch((cause: unknown) => cause);
    expect(calls).toBe(3);
    expect(error).toMatchObject({ code: "storage-failed", status: 503 });
  });

  it("403 等非 404 的 4xx 也不重试，分类为不可重试", async () => {
    let calls = 0;
    const h = service((async () => {
      calls += 1;
      return new Response("denied", { status: 403 });
    }) as unknown as typeof globalThis.fetch);

    const error = await h.app.importFromUrl({ url: PROVIDER_URL }).catch((cause: unknown) => cause);
    expect(calls).toBe(1);
    expect(error).toMatchObject({ code: "unsupported", status: 403 });
  });
});
