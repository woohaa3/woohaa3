/**
 * 材料化请求的画布作用域（change: 2026-10-20-canvas-scoped-storage）。
 *
 * 同步到远端的画布的新生成结果必须带 canvasId，否则 Media Service 只会写主存储，
 * 画布路由到的后端永远拿不到字节。覆盖：
 * 1. `MediaClient.importFromUrl/importBytes` 把 canvasId 放进**请求体**；
 * 2. 材料化从 `TaskAssociation` 取 canvasId，主媒体与视频海报都带；
 * 3. association 缺失（生产未注入解析器）时回退到 durable task record 的 `context`；
 * 4. 两者都没有时保持无作用域（扩展任务/历史任务）。
 */
import { describe, expect, it } from "vitest";
import type { ExecutionRecord } from "@sdppp/pptask-worker-server/history";
import type { PptaskTaskStore } from "@sdppp/pptask-worker-server";
import type { MediaMetadata } from "@woohaa3/contracts";
import { createMediaClient } from "../src/clients/media-client.js";
import { materializeBinaryResult, materializeVideoResult } from "../src/worker/media-materialization.js";
import type { TaskAssociation, TaskRuntimeOptions } from "../src/worker/types.js";
import type { SqliteTaskHistoryRepository } from "../src/repository/history-repository.js";

const VIDEO_KEY = `generation-outputs/${"c".repeat(64)}.mp4`;
const POSTER_KEY = `generation-outputs/${"d".repeat(64)}.png`;
const IMAGE_KEY = `generation-outputs/${"e".repeat(64)}.png`;

function metadataFor(storageKey: string, mediaKind: MediaMetadata["mediaKind"]): MediaMetadata {
  // generation-outputs/<64 hex>.<ext>：内嵌 sha256 才是合法 checksum。
  const checksum = storageKey.slice("generation-outputs/".length, "generation-outputs/".length + 64);
  return { storageKey, contentType: mediaKind === "video" ? "video/mp4" : "image/png", size: 10, checksum, mediaKind };
}

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "task-1",
    providerId: "provider-a",
    modelType: "video",
    state: "succeeded",
    events: [],
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:01.000Z",
    durationMs: 1000,
    ...overrides
  };
}

type ImportCall = { kind: "url" | "bytes"; input: Record<string, unknown> };

function harness(options: {
  association?: TaskAssociation;
  taskContext?: Record<string, unknown>;
  rawResult?: Record<string, unknown>;
}) {
  const imports: ImportCall[] = [];
  const historyUpserts: Array<Record<string, unknown>> = [];
  const mediaClient = {
    async verify() { return { exists: true, matches: true }; },
    async sign() { return "https://cos.example/signed"; },
    async importFromUrl(input: Record<string, unknown>) {
      imports.push({ kind: "url", input });
      const url = String(input.url);
      return metadataFor(url.includes("poster") ? POSTER_KEY : url.endsWith(".mp4") ? VIDEO_KEY : IMAGE_KEY, url.endsWith(".mp4") ? "video" : "image");
    },
    async importBytes(input: Record<string, unknown>) {
      imports.push({ kind: "bytes", input });
      return metadataFor(IMAGE_KEY, "image");
    }
  };
  const history = {
    upsertRecord: (input: Record<string, unknown>) => { historyUpserts.push(input); return 1; },
    lastEventTail: () => undefined,
    lastEvent: () => undefined,
    appendEvent: () => 1
  } as unknown as SqliteTaskHistoryRepository;
  const taskStore = {
    find: async (key: string) => ({
      key,
      providerId: "provider-a",
      status: "completed" as const,
      attempt: 0,
      consecutiveFailures: 0,
      createdAt: new Date("2026-10-20T00:00:00.000Z"),
      updatedAt: new Date("2026-10-20T00:00:01.000Z"),
      ...(options.taskContext ? { context: options.taskContext } : {}),
      ...(options.rawResult ? { result: options.rawResult } : {})
    })
  } as unknown as PptaskTaskStore;
  const runtime: TaskRuntimeOptions = {
    taskStore,
    history,
    provider: {} as never,
    providerId: "provider-a",
    mediaClient: mediaClient as never
  };
  return { runtime, imports, historyUpserts };
}

describe("材料化请求体带 canvasId", () => {
  it("视频主媒体与海报都带上 association.canvasId", async () => {
    const { runtime, imports, historyUpserts } = harness({
      rawResult: { posterUrl: "https://provider.example/poster.png", durationSeconds: 8 }
    });
    await materializeVideoResult(
      runtime,
      record(),
      { canvasId: "canvas-a", nodeId: "node-1", runId: "run-1", jobId: "job-1" },
      "https://provider.example/output.mp4"
    );

    expect(imports).toHaveLength(2);
    expect(imports[0]).toMatchObject({ kind: "url", input: { canvasId: "canvas-a" } });
    expect(String(imports[0].input.url)).toContain("output.mp4");
    expect(imports[1]).toMatchObject({ kind: "url", input: { canvasId: "canvas-a" } });
    expect(String(imports[1].input.url)).toContain("poster.png");
    expect(historyUpserts[0].state).toBe("succeeded");
  });

  it("association 缺失时回退到 durable task context.canvasId", async () => {
    const { runtime, imports } = harness({ taskContext: { canvasId: "canvas-b", nodeId: "n", runId: "r", jobId: "j" } });
    await materializeBinaryResult(runtime, record({ modelType: "image" }), undefined, {
      kind: "url",
      url: "https://provider.example/output.png",
      modelType: "image"
    });
    expect(imports).toHaveLength(1);
    expect(imports[0].input).toMatchObject({ canvasId: "canvas-b" });
  });

  it("bytes 路径同样带 canvasId", async () => {
    const { runtime, imports } = harness({});
    await materializeBinaryResult(
      runtime,
      record({ modelType: "image" }),
      { canvasId: "canvas-c", nodeId: "n", runId: "r", jobId: "j" },
      { kind: "bytes", bytesBase64: "AQID", contentType: "image/png", modelType: "image" }
    );
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ kind: "bytes", input: { canvasId: "canvas-c" } });
  });

  it("无 association 且无 context 时不添加 canvasId（扩展/历史任务）", async () => {
    const { runtime, imports } = harness({});
    await materializeBinaryResult(runtime, record({ modelType: "image" }), undefined, {
      kind: "url",
      url: "https://provider.example/output.png",
      modelType: "image"
    });
    expect(imports).toHaveLength(1);
    expect(imports[0].input).not.toHaveProperty("canvasId");
  });
});

describe("MediaClient 请求体", () => {
  function captureClient() {
    const bodies: Array<Record<string, unknown>> = [];
    const client = createMediaClient({
      baseUrl: "http://media.test",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          storageKey: IMAGE_KEY,
          contentType: "image/png",
          size: 3,
          checksum: "e".repeat(64),
          mediaKind: "image"
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof globalThis.fetch
    });
    return { bodies, client };
  }

  it("importFromUrl 在请求体里发送 canvasId", async () => {
    const { bodies, client } = captureClient();
    await client.importFromUrl({ url: "https://provider.example/a.png", maxBytes: 1024, canvasId: "canvas-a" });
    expect(bodies[0]).toMatchObject({ url: "https://provider.example/a.png", maxBytes: 1024, canvasId: "canvas-a" });
  });

  it("importBytes 在请求体里发送 canvasId", async () => {
    const { bodies, client } = captureClient();
    await client.importBytes({ bytesBase64: "AQID", contentType: "image/png", maxBytes: 1024, canvasId: "canvas-b" });
    expect(bodies[0]).toMatchObject({ bytesBase64: "AQID", contentType: "image/png", maxBytes: 1024, canvasId: "canvas-b" });
  });

  it("不带 canvasId 时请求体保持旧形状", async () => {
    const { bodies, client } = captureClient();
    await client.importFromUrl({ url: "https://provider.example/a.png", maxBytes: 1024 });
    expect(bodies[0]).not.toHaveProperty("canvasId");
  });
});
