/**
 * URL 转存失败后的字节回退（2026-10-22 现场回归）。
 *
 * 现场：tokenhub 生图成功，pptask 已把 provider 结果归一成 bytes 落进 durable 记录
 * （6,985,950 B，sha256 与可下载文件一致），但 worker 走 URL 路径二次受控下载时超时，
 * 任务被判 failed —— 产物在手却报错。这里钉住回退语义：
 * 1. URL 失败 + 记录里有字节 → 用 importBytes 采用同一份字节，写 succeeded；
 * 2. 视频不回退（大对象只接受地址），仍按 failed 落；
 * 3. 没有字节时保持既有 MediaImportError 行为。
 */
import { describe, expect, it } from "vitest";
import type { ExecutionRecord } from "@sdppp/pptask-worker-server/history";
import type { PptaskTaskStore } from "@sdppp/pptask-worker-server";
import type { MediaMetadata } from "@woohaa3/contracts";
import { materializeBinaryBytesFromStore, materializeBinaryResult } from "../src/worker/media-materialization.js";
import type { TaskAssociation, TaskRuntimeOptions } from "../src/worker/types.js";
import type { SqliteTaskHistoryRepository } from "../src/repository/history-repository.js";

const IMAGE_KEY = `generation-outputs/${"a".repeat(64)}.png`;
const AUDIO_KEY = `generation-outputs/${"b".repeat(64)}.mp3`;

function metadataFor(storageKey: string, mediaKind: MediaMetadata["mediaKind"]): MediaMetadata {
  const checksum = storageKey.slice("generation-outputs/".length, "generation-outputs/".length + 64);
  return {
    storageKey,
    contentType: mediaKind === "audio" ? "audio/mpeg" : "image/png",
    size: 10,
    checksum,
    mediaKind
  };
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "run-fallback",
    providerId: "tokenhub",
    modelType: "image",
    state: "succeeded",
    events: [],
    createdAt: "2026-10-22T07:42:05.000Z",
    updatedAt: "2026-10-22T07:42:20.000Z",
    durationMs: 15_000,
    ...overrides
  };
}

function harness(options: { rawResult?: Record<string, unknown> | null; rawState?: Record<string, unknown>; urlError?: Error }) {
  const imports: Array<{ kind: "url" | "bytes"; input: Record<string, unknown> }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const historyUpserts: Array<Record<string, unknown>> = [];
  const mediaClient = {
    async verify() {
      return { exists: true, matches: true, metadata: metadataFor(IMAGE_KEY, "image") };
    },
    async sign() {
      return "https://cos.example/signed";
    },
    async importFromUrl(input: Record<string, unknown>) {
      imports.push({ kind: "url", input });
      throw options.urlError ?? new Error("受控下载失败");
    },
    async importBytes(input: Record<string, unknown>) {
      imports.push({ kind: "bytes", input });
      const contentType = String(input.contentType ?? "image/png");
      return metadataFor(contentType.startsWith("audio/") ? AUDIO_KEY : IMAGE_KEY, contentType.startsWith("audio/") ? "audio" : "image");
    }
  };
  const history = {
    upsertRecord: (input: Record<string, unknown>) => {
      historyUpserts.push(input);
      return 1;
    },
    lastEventTail: () => undefined,
    lastEvent: () => undefined,
    appendEvent: () => 1
  } as unknown as SqliteTaskHistoryRepository;
  const taskStore = {
    find: async (key: string) => ({
      key,
      providerId: "tokenhub",
      status: "completed" as const,
      attempt: 1,
      consecutiveFailures: 0,
      createdAt: new Date("2026-10-22T07:42:05.000Z"),
      updatedAt: new Date("2026-10-22T07:42:20.000Z"),
      context: { canvasId: "canvas-1", nodeId: "node-1", runId: "run-fallback", jobId: "job-1" },
      ...(options.rawResult !== undefined ? (options.rawResult === null ? {} : { result: options.rawResult }) : { result: {} }),
      ...(options.rawState ? { state: options.rawState } : {})
    })
  } as unknown as PptaskTaskStore;
  const runtime: TaskRuntimeOptions = {
    taskStore,
    history,
    provider: {} as never,
    providerId: "tokenhub",
    mediaClient: mediaClient as never,
    logger: (event) => logs.push(event as unknown as Record<string, unknown>)
  };
  const association: TaskAssociation = { canvasId: "canvas-1", nodeId: "node-1", runId: "run-fallback", jobId: "job-1" };
  return { runtime, imports, logs, historyUpserts, association };
}

describe("URL 转存失败后的字节回退", () => {
  it("图片：URL 超时但记录里有字节 → 用 importBytes 写 succeeded", async () => {
    const { runtime, imports, logs, historyUpserts, association } = harness({
      rawResult: { images: [PNG_BYTES] },
      urlError: Object.assign(new Error("受控下载失败"), { code: "storage-failed" })
    });
    await materializeBinaryResult(runtime, record(), association, {
      kind: "url",
      url: "https://provider.example/out.png",
      modelType: "image"
    });

    expect(imports.map((call) => call.kind)).toEqual(["url", "bytes"]);
    expect(imports[1].input).toMatchObject({ contentType: "image/png", canvasId: "canvas-1" });
    expect(historyUpserts.at(-1)).toMatchObject({
      state: "succeeded",
      result: { mediaKind: "image", storageKey: IMAGE_KEY }
    });
    expect(logs.map((event) => event.event)).toEqual(
      expect.arrayContaining(["media-output-imported-from-store"])
    );
  });

  it("只有 worker 快照含字节时也能恢复媒体（兼容终态 save 竞态）", async () => {
    const { runtime, imports, historyUpserts, association } = harness({
      rawResult: null,
      rawState: { record: { result: { images: [PNG_BYTES] } } }
    });
    await materializeBinaryBytesFromStore(runtime, record(), association, "image");

    expect(imports.map((call) => call.kind)).toEqual(["bytes"]);
    expect(historyUpserts.at(-1)).toMatchObject({
      state: "succeeded",
      result: { mediaKind: "image", storageKey: IMAGE_KEY }
    });
  });

  it("记录里已是稳定媒体引用（落库前已归档）→ verify-and-adopt，不再 importBytes", async () => {
    const { runtime, imports, historyUpserts, association } = harness({
      rawResult: {
        media: { storageKey: IMAGE_KEY, contentType: "image/png", size: 10, checksum: "a".repeat(64) }
      }
    });
    await materializeBinaryResult(runtime, record(), association, {
      kind: "url",
      url: "https://provider.example/out.png",
      modelType: "image"
    });

    // 只有 URL 那次尝试：字节已归档成引用，不应该再从 SQLite 读回来 import 一遍。
    expect(imports.map((call) => call.kind)).toEqual(["url"]);
    expect(historyUpserts.at(-1)).toMatchObject({
      state: "succeeded",
      result: { mediaKind: "image", storageKey: IMAGE_KEY }
    });
  });

  it("音频：URL 失败但记录里有 audios 字节 → 用 importBytes 写 succeeded", async () => {
    const { runtime, imports, historyUpserts, association } = harness({
      rawResult: { audios: [new Uint8Array([73, 68, 51])] }
    });
    await materializeBinaryResult(runtime, record({ modelType: "audio" }), association, {
      kind: "url",
      url: "https://provider.example/out.mp3",
      modelType: "audio"
    });

    expect(imports.map((call) => call.kind)).toEqual(["url", "bytes"]);
    expect(imports[1].input).toMatchObject({ contentType: "audio/mpeg" });
    expect(historyUpserts.at(-1)).toMatchObject({ state: "succeeded", result: { storageKey: AUDIO_KEY } });
  });

  it("视频：不回退字节，仍落 failed（大对象只接受地址）", async () => {
    const { runtime, imports, historyUpserts, association } = harness({
      rawResult: { videos: [PNG_BYTES] }
    });
    await materializeBinaryResult(runtime, record({ modelType: "video" }), association, {
      kind: "url",
      url: "https://provider.example/out.mp4",
      modelType: "video"
    });

    expect(imports.map((call) => call.kind)).toEqual(["url"]);
    expect(historyUpserts.at(-1)).toMatchObject({
      state: "failed",
      error: { name: "MediaImportError" }
    });
  });

  it("视频：即使 durable 记录里只有 bytes，也不走字节回退，落 failed", async () => {
    const { runtime, imports, historyUpserts, association } = harness({
      rawResult: { videos: [PNG_BYTES] }
    });
    await materializeBinaryBytesFromStore(runtime, record({ modelType: "video" }), association, "video");

    expect(imports).toEqual([]);
    expect(historyUpserts.at(-1)).toMatchObject({
      state: "failed",
      result: { mediaKind: "video" },
      error: { name: "MediaImportError", code: "video-bytes-not-supported" }
    });
    expect(historyUpserts.at(-1)).not.toHaveProperty("result.storageKey");
  });

  it("图像：URL 失败且记录里没有字节 → 保持 MediaImportError（不伪造成功）", async () => {
    const { runtime, imports, logs, historyUpserts, association } = harness({ rawResult: { images: [] } });
    await materializeBinaryResult(runtime, record(), association, {
      kind: "url",
      url: "https://provider.example/out.png",
      modelType: "image"
    });

    expect(imports.map((call) => call.kind)).toEqual(["url"]);
    expect(historyUpserts.at(-1)).toMatchObject({
      state: "failed",
      error: { name: "MediaImportError", message: expect.stringContaining("provider image 结果转存失败") }
    });
    expect(logs.map((event) => event.event)).toEqual(
      expect.arrayContaining(["media-output-import-bytes-unavailable", "media-output-import-failed"])
    );
  });
});
