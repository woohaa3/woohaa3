/**
 * 稳定媒体结果 verify-and-adopt（change: 2026-10-20-reserve-remote-generation-provider，任务 4.1–4.3）。
 *
 * 覆盖：
 * 1. `MediaClient.verify` 把 canvasId 放进**请求体**（无作用域时保持旧形状）；
 * 2. worker 终态 succeeded 的稳定媒体结果走 adopt：按画布作用域 verify，命中直接写
 *    `TaskResultSummary`（含 poster/duration），不 import 字节；
 * 3. 对象不存在/metadata 不匹配 → 写 failed（MediaImportError），绝不落「无产物 succeeded」；
 * 4. 稳定媒体结果不会被误走 URL/bytes 路径。
 */
import { describe, expect, it } from "vitest";
import type { PptaskTaskRecord, PptaskTaskStore, PptaskWorkerServer } from "@sdppp/pptask-worker-server";
import type { ExecutionRecord } from "@sdppp/pptask-worker-server/history";
import type { MediaMetadata } from "@woohaa3/contracts";
import { createMediaClient } from "../src/clients/media-client.js";
import type { MediaClient } from "../src/clients/media-client.js";
import type { SqliteTaskHistoryRepository } from "../src/repository/history-repository.js";
import { createTaskRuntime } from "../src/worker/runtime.js";

const VIDEO_KEY = `generation-outputs/${"c".repeat(64)}.mp4`;
const POSTER_KEY = `generation-outputs/${"d".repeat(64)}.png`;

function metadataFor(storageKey: string, mediaKind: MediaMetadata["mediaKind"], size = 100): MediaMetadata {
  const checksum = storageKey.slice("generation-outputs/".length, "generation-outputs/".length + 64);
  return { storageKey, contentType: mediaKind === "video" ? "video/mp4" : "image/png", size, checksum, mediaKind };
}

/** provider 原始结果是稳定媒体引用：`{ media: {...} }`（没有字节、没有 URL）。 */
function stableRecord(): ExecutionRecord {
  return {
    id: "run-stable-1",
    providerId: "remote-server",
    modelType: "video",
    state: "succeeded",
    result: {
      outputCount: 0,
      outputs: [],
      value: {
        media: {
          storageKey: VIDEO_KEY,
          contentType: "video/mp4",
          size: 100,
          checksum: "c".repeat(64),
          durationSeconds: 8,
          poster: { storageKey: POSTER_KEY, contentType: "image/png", size: 10, checksum: "d".repeat(64) }
        }
      }
    },
    events: [],
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:01.000Z",
    finishedAt: "2026-10-20T00:00:01.000Z",
    durationMs: 1000
  };
}

type VerifyCall = { storageKey: string; expected?: Partial<MediaMetadata>; scope?: { canvasId?: string } };

function harness(options: { verify: (call: VerifyCall) => Promise<{ exists: boolean; matches: boolean; metadata?: MediaMetadata }> }) {
  const records: Array<Record<string, unknown>> = [];
  const verifyCalls: VerifyCall[] = [];
  const imports: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const history = {
    upsertRecord: (input: Record<string, unknown>) => {
      records.push(input);
      return 1;
    },
    appendEvent: () => 1,
    lastEventTail: () => undefined,
    lastEvent: () => undefined,
    stateOf: () => "running"
  } as unknown as SqliteTaskHistoryRepository;
  const mediaClient = {
    async verify(storageKey: string, expected?: Partial<MediaMetadata>, scope?: { canvasId?: string }) {
      const call = { storageKey, ...(expected ? { expected } : {}), ...(scope ? { scope } : {}) };
      verifyCalls.push(call);
      return options.verify(call);
    },
    async sign() {
      return "https://cos.example/signed";
    },
    async importFromUrl(input: { url: string }) {
      imports.push(input.url);
      return metadataFor(VIDEO_KEY, "video");
    },
    async importBytes() {
      imports.push("bytes");
      return metadataFor(VIDEO_KEY, "video");
    }
  } as unknown as MediaClient;
  const taskStore = {
    find: async (key: string) =>
      ({
        key,
        providerId: "remote-server",
        status: "completed",
        attempt: 0,
        consecutiveFailures: 0,
        context: { canvasId: "canvas-remote", nodeId: "node-1", runId: "run-stable-1", jobId: "job-1" },
        createdAt: new Date("2026-10-20T00:00:00.000Z"),
        updatedAt: new Date("2026-10-20T00:00:01.000Z")
      }) as unknown as PptaskTaskRecord
  } as unknown as PptaskTaskStore;

  let listener: ((record: ExecutionRecord) => void) | undefined;
  const server = {
    submit: async () => ({ created: true, record: { key: "run-stable-1", providerId: "remote-server", status: "queued", attempt: 0 } }),
    cancel: async () => undefined,
    status: async () => null,
    history: { subscribe: () => () => undefined },
    subscribe: (fn: (record: ExecutionRecord) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    stop: () => undefined,
    drained: async () => undefined,
    abortAll: () => undefined,
    close: async () => undefined
  } as unknown as PptaskWorkerServer;

  return {
    records,
    verifyCalls,
    imports,
    logs,
    emit: () => listener?.(stableRecord()),
    create: () =>
      createTaskRuntime({
        taskStore,
        history,
        provider: {} as never,
        providerId: "remote-server",
        mediaClient,
        server,
        shutdownGraceMs: 5_000,
        logger: (event) => logs.push(event)
      })
  };
}

describe("worker 采用稳定媒体结果", () => {
  it("verify 命中后直接写 succeeded summary（含 poster/duration），不 import 字节", async () => {
    const h = harness({
      verify: async ({ storageKey }) =>
        storageKey === VIDEO_KEY
          ? { exists: true, matches: true, metadata: metadataFor(VIDEO_KEY, "video") }
          : { exists: true, matches: true, metadata: metadataFor(POSTER_KEY, "image", 10) }
    });
    const runtime = await h.create();
    h.emit();
    await runtime.close();

    // 主媒体与 poster 都按 durable task context 的画布作用域核验。
    expect(h.verifyCalls.map((call) => [call.storageKey, call.scope])).toEqual([
      [VIDEO_KEY, { canvasId: "canvas-remote" }],
      [POSTER_KEY, { canvasId: "canvas-remote" }]
    ]);
    expect(h.verifyCalls[0]!.expected).toEqual({ contentType: "video/mp4", size: 100, checksum: "c".repeat(64) });
    expect(h.imports).toEqual([]);
    expect(h.records.at(-1)).toMatchObject({
      taskKey: "run-stable-1",
      state: "succeeded",
      result: {
        mediaKind: "video",
        storageKey: VIDEO_KEY,
        contentType: "video/mp4",
        size: 100,
        checksum: "c".repeat(64),
        durationSeconds: 8,
        poster: { storageKey: POSTER_KEY, contentType: "image/png", size: 10, checksum: "d".repeat(64) }
      }
    });
  });

  it("对象不存在 → failed（MediaImportError），不落无产物 succeeded", async () => {
    const h = harness({ verify: async () => ({ exists: false, matches: false }) });
    const runtime = await h.create();
    h.emit();
    await runtime.close();

    const last = h.records.at(-1)!;
    expect(last).toMatchObject({ taskKey: "run-stable-1", state: "failed", error: { name: "MediaImportError" } });
    expect(last).not.toHaveProperty("result.storageKey");
    expect(h.logs.map((event) => event.event)).toContain("media-output-adopt-failed");
  });

  it("metadata 不匹配 → failed（MediaImportError）", async () => {
    const h = harness({
      verify: async ({ storageKey }) => ({
        exists: true,
        matches: false,
        metadata: metadataFor(storageKey, "video")
      })
    });
    const runtime = await h.create();
    h.emit();
    await runtime.close();

    expect(h.records.at(-1)).toMatchObject({ state: "failed", error: { name: "MediaImportError" } });
  });
});

describe("MediaClient.verify 的画布作用域", () => {
  function captureClient() {
    const bodies: Array<Record<string, unknown>> = [];
    const client = createMediaClient({
      baseUrl: "http://media.test",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ exists: true, matches: true, metadata: metadataFor(VIDEO_KEY, "video") }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }) as unknown as typeof globalThis.fetch
    });
    return { bodies, client };
  }

  it("带作用域时请求体包含 canvasId 与 expected", async () => {
    const { bodies, client } = captureClient();
    const result = await client.verify(
      VIDEO_KEY,
      { contentType: "video/mp4", size: 100, checksum: "c".repeat(64) },
      { canvasId: "canvas-remote" }
    );
    expect(bodies[0]).toEqual({
      storageKey: VIDEO_KEY,
      expected: { contentType: "video/mp4", size: 100, checksum: "c".repeat(64) },
      canvasId: "canvas-remote"
    });
    expect(result).toMatchObject({ exists: true, matches: true });
  });

  it("不带作用域时请求体保持旧形状", async () => {
    const { bodies, client } = captureClient();
    await client.verify(VIDEO_KEY);
    expect(bodies[0]).toEqual({ storageKey: VIDEO_KEY });
  });
});
