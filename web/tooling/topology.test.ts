/**
 * 三服务真实拓扑集成测试（change: split-web-runtime-services，任务 8.1 / 6.3）。
 *
 * 不 spawn 子进程，但**经真实 HTTP 边界**把 media/task/canvas 三个服务组合起来：
 * provider 执行被替换为确定性假 worker（不接触网络/凭据），其余（Media 内容寻址、
 * Task durable store/history、Canvas Y.Doc、projector）都是真实实现。
 *
 * 覆盖一条完整链路：
 *   Canvas run -> Task submit -> 假执行 -> durable history ->
 *   Canvas projector 消费 -> 权威 Y.Doc 终态。
 */
import { YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { serverCanvasToYDoc } from "@woohaa3/contracts/canvas-yjs";
import { InMemoryYjsDocumentRepository } from "@woohaa3/canvas-service";
import { SqliteCanvasRepository } from "@woohaa3/canvas-service";
import { createMediaService } from "@woohaa3/media-service";
import { createTaskService } from "@woohaa3/task-service";
import { createCanvasService } from "@woohaa3/canvas-service";
import type { PptaskWorkerServer } from "@sdppp/pptask-worker-server";

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-topology-"));
  dirs.push(dir);
  return path.join(dir, name);
}

function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

type HistoryRecord = {
  id: string;
  providerId: string;
  state: string;
  events: unknown[];
  result?: unknown;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
};

/**
 * 假 worker server：submit 立即产生一条 succeeded history（不执行真实 provider），
 * 供 projector 消费。其余 scheduler 方法为 no-op。
 */
function fakeWorkerServer(): PptaskWorkerServer {
  const listeners = new Set<(record: HistoryRecord) => void>();
  const records = new Map<string, HistoryRecord>();
  return {
    worker: {} as never,
    async submit(input: never) {
      const value = input as { key: string; context?: Record<string, unknown> };
      const now = new Date().toISOString();
      const record: HistoryRecord = {
        id: value.key,
        providerId: "fake",
        state: "succeeded",
          events: [],
        result: { outputs: [{ kind: "text", text: "假执行结果" }] },
        createdAt: now,
        updatedAt: now,
        finishedAt: now,
        durationMs: 1,
        metadata: value.context
      };
      records.set(record.id, record);
      for (const listener of listeners) listener(record);
      return { record, created: true } as never;
    },
    async status(key: string) {
      return (records.get(key) as never) ?? null;
    },
    async cancel() {},
    history: {
      get: async () => undefined,
      list: async () => [...records.values()] as never,
      subscribe(listener: never) {
        listeners.add(listener as never);
        return () => listeners.delete(listener as never);
      },
      ingestSchedulingEvent() {},
      async flush() {},
      async dispose() {}
    } as never,
    subscribe(listener: never) {
      listeners.add(listener as never);
      return () => listeners.delete(listener as never);
    },
    stop() {},
    async drained() {},
    async close() {}
  } as unknown as PptaskWorkerServer;
}

describe("三服务真实拓扑（任务 8.1）", () => {
  it("Canvas run -> Task durable history -> projector 写权威 Y.Doc 终态", async () => {
    const canvasToken = "canvas-token";
    const taskToken = "task-token";

    // --- Media（内容寻址真实实现；对象存储是内存替身，internal 协议真实）---
    const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
    const mediaService = createMediaService({
      storage: {
        async put(key: string, bytes: Uint8Array, contentType: string) {
          objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
        },
        async get(key: string) {
          const record = objects.get(key);
          if (!record) throw new Error("missing");
          return record;
        },
        async exists(key: string) {
          return objects.has(key);
        },
        async stat(key: string) {
          const record = objects.get(key);
          if (!record) throw new Error("missing");
          return { size: record.bytes.byteLength, contentType: record.contentType };
        },
        async getHttpsUrl(key: string) {
          return `https://cos.invalid/${key}?sign=test`;
        }
      } as never,
      identities: { tokens: { "canvas-service": canvasToken, "task-service": taskToken } }
    });
    const media = await listen(mediaService.handle);
    closers.push(async () => {
      await mediaService.close();
      await new Promise<void>((resolve) => media.server.close(() => resolve()));
    });

    // --- Task（假 worker，真实 durable store/history + 真实 HTTP API）---
    const taskService = createTaskService({
      env: {
        WOOHAA3_TASK_STORE_PATH: tempDb("task.sqlite"),
        PPTASK_LITELLM_API_KEY: "test-placeholder",
        PPTASK_LITELLM_BASE_URL: "https://litellm.invalid"
      },
      modelsConfig: { version: 1, models: [{ id: "fake:fake-image", default: true }] },
      serviceToken: taskToken,
      mediaServiceUrl: `http://127.0.0.1:${media.port}`,
      workerServer: fakeWorkerServer(),
      generationProviders: () => [{
        extensionId: "test-generation",
        providerId: "fake",
        available: true,
        provider: {},
        models: [{
          providerId: "fake",
          providerModelId: "fake-image",
          modelType: "image",
          title: "Fake",
          inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
          defaultInput: {}
        }]
      }]
    });
    const task = await listen(taskService.handle);
    closers.push(async () => {
      await taskService.close();
      await new Promise<void>((resolve) => task.server.close(() => resolve()));
    });

    // --- Canvas（真实 sqlite + 共享 Yjs 仓储 + 真实 run/projector；client 指向 task/media HTTP）---
    const yjsRepository = new InMemoryYjsDocumentRepository();
    const canvasId = "topology-canvas";
    const seed = {
      id: canvasId,
      title: "topology",
      revision: 0,
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [{ id: "image-1", type: "image", position: { x: 0, y: 0 } }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        updatedAt: "2026-09-24T00:00:00.000Z"
      },
      nodeData: {},
      assets: [],
      jobs: [],
      updatedAt: "2026-09-24T00:00:00.000Z"
    };
    await yjsRepository.createYjsDocument({
      canvasId,
      formatVersion: YJS_CANVAS_FORMAT_VERSION,
      roomEpoch: "topology-epoch",
      checkpoint: Y.encodeStateAsUpdate(serverCanvasToYDoc(seed as never)),
      projection: seed as never,
      revision: 0,
      createdAt: "2026-09-24T00:00:00.000Z"
    });

    const canvasRepository = new SqliteCanvasRepository({ path: tempDb("canvas.sqlite") });
    const { createCanvasMediaClient } = await import("@woohaa3/canvas-service");
    const mediaClient = createCanvasMediaClient({
      baseUrl: `http://127.0.0.1:${media.port}`,
      serviceToken: canvasToken
    });
    const canvasService = await createCanvasService({
      env: {
        WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
        WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: tempDb("canvas-backend.sqlite"),
        WOOHAA3_CANVAS_STORAGE_SERVICE_TOKEN: canvasToken,
        WOOHAA3_TASK_SERVICE_URL: `http://127.0.0.1:${task.port}`,
        WOOHAA3_MEDIA_SERVICE_URL: `http://127.0.0.1:${media.port}`,
        WOOHAA3_CANVAS_TO_TASK_TOKEN: taskToken,
        WOOHAA3_CANVAS_TO_MEDIA_TOKEN: canvasToken
      },
      mediaClient,
      repository: canvasRepository,
      yjsRepository,
      resolveCatalog: () => taskService.catalog(),
      reconcileIntervalMs: 25
    });
    const canvas = await listen(canvasService.handle);
    if (canvasService.sync) {
      canvas.server.on("upgrade", (req, socket, head) => {
        if (canvasService.sync?.matches(req.url)) canvasService.sync.handle(req, socket, head);
      });
    }
    closers.push(async () => {
      await canvasService.close();
      await new Promise<void>((resolve) => canvas.server.close(() => resolve()));
      canvasRepository.close();
    });

    const base = `http://127.0.0.1:${canvas.port}`;

    // Task 目录可用（真实 HTTP）。
    const catalog = await fetch(`http://127.0.0.1:${task.port}/api/pptask/catalog`);
    expect(catalog.status).toBe(200);

    // runService 必须已接线（canvas 组合根在 sync+taskClient+resolveCatalog 齐备时创建）。
    expect(canvasService.runService).not.toBeNull();

    // 发起 run：只提交，202 accepted。
    const run = await fetch(`${base}/api/canvases/${canvasId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": canvasToken, "x-woohaa3-protocol-version": "1" },
      body: JSON.stringify({
        nodeId: "image-1",
        runId: "run-topology",
        jobId: "job-topology",
        modelKey: "fake:fake-image",
        prompt: "hello",
        parameters: {}
      })
    });
    if (run.status !== 202) {
      throw new Error(`run failed: ${run.status} ${await run.text()}`);
    }
    const runBody = (await run.json()) as { ok: boolean; state: string };
    expect(runBody).toEqual({ ok: true, runId: "run-topology", jobId: "job-topology", state: "accepted" });

    // 终态由 projector 从 Task durable history 消费并写入权威 Y.Doc。
    const deadline = Date.now() + 10_000;
    let nodeData: Record<string, unknown> | undefined;
    let lastHistory: unknown;
    for (;;) {
      const state = await yjsRepository.loadYjsState(canvasId);
      const projection = state?.projection as { nodeData?: Record<string, Record<string, unknown>> } | null | undefined;
      nodeData = projection?.nodeData?.["image-1"];
      if (nodeData?.taskStatus === "successed" || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (nodeData?.taskStatus !== "successed") {
      lastHistory = await (
        await fetch(`http://127.0.0.1:${task.port}/internal/v1/task-history?after=0`, {
          headers: { "x-woohaa3-service-token": taskToken, "x-woohaa3-protocol-version": "1" }
        })
      ).json();
      throw new Error(`未投影：nodeData=${JSON.stringify(nodeData)} history=${JSON.stringify(lastHistory)}`);
    }
    expect(nodeData?.taskStatus).toBe("successed");
  }, 30_000);
});
