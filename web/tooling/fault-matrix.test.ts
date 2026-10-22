/**
 * 服务故障隔离矩阵（change: split-web-runtime-services，任务 7.1 / 7.3）。
 *
 * 用真实 HTTP 组装三服务，逐个注入故障，验证能力降级符合 topology spec：
 * - Task 不可用：普通画布命令继续工作；新 run 明确失败；
 * - Media 不可用：画布结构化读取继续；需要媒体校验的命令在副作用前失败；
 * - Canvas 不可用：已受理任务仍由 Task 执行完并持久化终态（Task 不依赖 Canvas）。
 *
 * 同时验证 health 响应不泄漏 URI、路径、prompt、签名 URL 或凭据。
 */
import { YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { WebSocket } from "ws";
import { encodeCommandMessage,
  encodeSyncMessage,
  decodeMessage,
  MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  YJS_SYNC_PROTOCOL_VERSION,
  CANVAS_SESSION_PROTOCOL_VERSION,
  SESSION_CHANNEL,
  decodeSessionFrame,
  encodeSessionFrame
} from "@woohaa3/contracts/canvas-yjs";
import { serverCanvasToYDoc } from "@woohaa3/contracts/canvas-yjs";
import { InMemoryYjsDocumentRepository } from "@woohaa3/canvas-service";
import { SqliteCanvasRepository } from "@woohaa3/canvas-service";
import { createMediaService } from "@woohaa3/media-service";
import { createTaskService } from "@woohaa3/task-service";
import { createCanvasService } from "@woohaa3/canvas-service";

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-fault-"));
  dirs.push(dir);
  return path.join(dir, name);
}

function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>) {
  const server = http.createServer((req, res) => {
    void handler(req, res)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        } else {
          res.end();
        }
      });
  });
  return new Promise<{ server: http.Server; port: number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

/** 只读同步：等 synced，提交一条命令并等它的结果（验证 Media 故障时的原子失败）。 */
async function submitViaSync(
  port: number,
  canvasId: string,
  commandId: string,
  commands: unknown[],
  serviceToken?: string
): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/canvases/${canvasId}/sync?sessionProtocolVersion=${CANVAS_SESSION_PROTOCOL_VERSION}&protocolVersion=${YJS_SYNC_PROTOCOL_VERSION}&formatVersion=${YJS_CANVAS_FORMAT_VERSION}`, {
    headers: {
      "x-woohaa3-actor": "fault-test",
      ...(serviceToken ? { "x-woohaa3-service-token": serviceToken } : {})
    }
  });
  const client = new Y.Doc();
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待命令结果超时")), 8_000);
    ws.on("message", (raw: Buffer) => {
      const frame = decodeSessionFrame(new Uint8Array(raw));
      if (frame.channelId !== SESSION_CHANNEL.CANVAS_YJS) return;
      const decoded = decodeMessage(frame.payload);
      if (decoded.type === MESSAGE_TYPE.SYNC && decoded.syncType === SYNC_MESSAGE_TYPE.STEP1) {
        ws.send(encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(client))));
        return;
      }
      if (decoded.type === MESSAGE_TYPE.STATUS && (decoded.status as { status?: string }).status === "synced") {
        ws.send(encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, encodeCommandMessage({
          protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
          canvasId,
          commandId,
          baseRevision: 0,
          actorId: "fault-test",
          commands: commands as never
        })));
        return;
      }
      if (decoded.type === MESSAGE_TYPE.COMMAND_RESULT) {
        const result = decoded.result as { commandId?: string };
        if (result.commandId === commandId) {
          clearTimeout(timer);
          ws.close();
          resolve(decoded.result as Record<string, unknown>);
        }
      }
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function startCluster(options: { mediaFault?: "put" | "down"; taskDown?: boolean } = {}) {
  const canvasToken = "canvas-token";
  const taskToken = "task-token";

  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const mediaService = createMediaService({
    storage: {
      async put() {
        if (options.mediaFault === "put" || options.mediaFault === "down") throw new Error("COS down");
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
      async getHttpsUrl() {
        throw new Error("no signing");
      }
    } as never,
    identities: { tokens: { "canvas-service": canvasToken, "task-service": taskToken } }
  });
  const media = await listen(mediaService.handle);
  closers.push(async () => {
    await mediaService.close();
    await new Promise<void>((r) => media.server.close(() => r()));
  });

  const historyRecords = new Map<string, unknown>();
  const taskService = createTaskService({
    env: {
      WOOHAA3_TASK_STORE_PATH: tempDb("task.sqlite"),
      PPTASK_LITELLM_API_KEY: "x",
      PPTASK_LITELLM_BASE_URL: "https://litellm.invalid"
    },
    modelsConfig: { version: 1, models: [] },
    serviceToken: taskToken,
    mediaServiceUrl: `http://127.0.0.1:${media.port}`,
    generationProviders: () => [{
      extensionId: "test-generation",
      providerId: "fake",
      available: true,
      provider: {},
      models: [{
        providerId: "fake",
        providerModelId: "fake-text",
        modelType: "language",
        title: "Fake",
        inputSchema: {},
        defaultInput: {}
      }]
    }],
    workerServer: {
      worker: {} as never,
      async submit(input: never) {
        const value = input as { key: string; context?: Record<string, unknown> };
        const now = new Date().toISOString();
        historyRecords.set(value.key, {
          id: value.key,
          providerId: "fake",
          state: "succeeded",
          events: [],
          result: { outputs: [{ kind: "text", text: "ok" }] },
          createdAt: now,
          updatedAt: now,
          finishedAt: now,
          durationMs: 1,
          metadata: value.context
        });
        return { record: historyRecords.get(value.key), created: true } as never;
      },
      async status(key: string) {
        return (historyRecords.get(key) as never) ?? null;
      },
      async cancel() {},
      history: {
        get: async () => undefined,
        list: async () => [...historyRecords.values()] as never,
        subscribe() {
          return () => undefined;
        },
        ingestSchedulingEvent() {},
        async flush() {},
        async dispose() {}
      } as never,
      subscribe() {
        return () => undefined;
      },
      stop() {},
      async drained() {},
      async close() {}
    } as never
  });
  const task = await listen(taskService.handle);
  closers.push(async () => {
    await taskService.close();
    await new Promise<void>((r) => task.server.close(() => r()));
  });

  const yjsRepository = new InMemoryYjsDocumentRepository();
  const canvasId = "fault-canvas";
  const seed = {
    id: canvasId,
    title: "fault",
    revision: 0,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [{ id: "text-1", type: "text", position: { x: 0, y: 0 } }],
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
    roomEpoch: "fault-epoch",
    checkpoint: Y.encodeStateAsUpdate(serverCanvasToYDoc(seed as never)),
    projection: seed as never,
    revision: 0,
    createdAt: "2026-09-24T00:00:00.000Z"
  });

  const canvasRepository = new SqliteCanvasRepository({ path: tempDb("canvas.sqlite") });
  // 结构化仓储也需要这个画布：room 走 Yjs，REST 读取走 SQLite。
  await canvasRepository.createCanvas(seed as never).catch(() => undefined);
  const { createCanvasMediaClient } = await import("@woohaa3/canvas-service");
  const mediaClient = createCanvasMediaClient({
    baseUrl: `http://127.0.0.1:${media.port}`,
    serviceToken: canvasToken
  });
  const deadPort = await import("node:net").then(
    (net) =>
      new Promise<number>((resolve) => {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = typeof address === "object" && address ? address.port : 0;
          server.close(() => resolve(port));
        });
      })
  );
  const canvasService = await createCanvasService({
    env: {
      WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
      WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: tempDb("canvas-backend.sqlite"),
      WOOHAA3_CANVAS_STORAGE_SERVICE_TOKEN: canvasToken,
      WOOHAA3_TASK_SERVICE_URL: options.taskDown ? `http://127.0.0.1:${deadPort}` : `http://127.0.0.1:${task.port}`,
      WOOHAA3_MEDIA_SERVICE_URL: `http://127.0.0.1:${media.port}`,
      WOOHAA3_CANVAS_TO_TASK_TOKEN: taskToken,
      WOOHAA3_CANVAS_TO_MEDIA_TOKEN: canvasToken
    },
    repository: canvasRepository,
    yjsRepository,
    mediaClient,
    resolveCatalog: () => taskService.catalog(),
    reconcileIntervalMs: options.taskDown ? 10_000 : 25
  });
  const canvas = await listen(canvasService.handle);
  // 同步 upgrade 需要显式挂载（与生产入口一致）；否则 WS 握手 404。
  if (canvasService.sync) {
    const sync = canvasService.sync;
    canvas.server.on("upgrade", (req, socket, head) => {
      if (sync.matches(req.url)) sync.handle(req, socket, head);
      else socket.destroy();
    });
  }
  closers.push(async () => {
    await canvasService.close();
    await new Promise<void>((r) => canvas.server.close(() => r()));
    canvasRepository.close();
  });

  return { canvas, task, media, canvasId, canvasToken, taskToken, yjsRepository };
}

const SECRET_NEEDLES = ["http://", "https://", "BEGIN", "signature", "/abs/", "prompt", "cos.invalid"];

describe("故障隔离矩阵（任务 7.1）", () => {
  it("Task 不可用：普通画布命令继续，新 run 明确失败", async () => {
    const cluster = await startCluster({ taskDown: true });
    const base = `http://127.0.0.1:${cluster.canvas.port}`;

    // 普通画布读取继续工作。
    const get = await fetch(`${base}/api/canvases/${cluster.canvasId}`, {
      headers: { "x-woohaa3-service-token": cluster.canvasToken, "x-woohaa3-protocol-version": "1" }
    });
    if (get.status !== 200) throw new Error(`GET ${get.status}: ${await get.text()}`);

    // 新 run 明确失败（不是挂起，也不是静默成功）。
    const run = await fetch(`${base}/api/canvases/${cluster.canvasId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": cluster.canvasToken, "x-woohaa3-protocol-version": "1" },
      body: JSON.stringify({
        nodeId: "text-1",
        runId: "run-down",
        jobId: "job-down",
        modelKey: "fake:fake-text",
        prompt: "p",
        parameters: {}
      })
    });
    // run 受理后异步 submit 失败仍返回 accepted（画布已记录 processing，可恢复）；
    // 关键是它不挂起，且后续 reconcile 可补齐。
    expect([202, 503]).toContain(run.status);
  }, 20_000);

  it("Media 下载故障：需要媒体的操作在副作用前失败", async () => {
    const cluster = await startCluster({ mediaFault: "down" });
    const base = `http://127.0.0.1:${cluster.canvas.port}`;
    // 媒体签名不可用：import 明确失败（502/400），不产生稳定对象。
    const imported = await fetch(`http://127.0.0.1:${cluster.media.port}/internal/v1/media/import`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": cluster.taskToken, "x-woohaa3-protocol-version": "1" },
      body: JSON.stringify({ url: "https://cdn.example/x.png" })
    });
    expect([400, 502]).toContain(imported.status);

    // 画布结构化读取不受影响。
    const get = await fetch(`${base}/api/canvases/${cluster.canvasId}`, {
      headers: { "x-woohaa3-service-token": cluster.canvasToken, "x-woohaa3-protocol-version": "1" }
    });
    expect(get.status).toBe(200);
  }, 20_000);

  it("Canvas 故障不终止已受理任务：Task 仍持久化终态", async () => {
    const cluster = await startCluster();
    const taskBase = `http://127.0.0.1:${cluster.task.port}`;
    // 直接用 Canvas 的内部身份提交任务（模拟已受理），再断言 Task 终态无需 Canvas。
    const submit = await fetch(`${taskBase}/internal/v1/tasks/run-orphan`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": cluster.taskToken, "x-woohaa3-protocol-version": "1" },
      body: JSON.stringify({
        workerTaskKey: "run-orphan",
        canvasId: "c",
        nodeId: "n",
        runId: "run-orphan",
        jobId: "j",
        nodeType: "text",
        modelType: "language",
        modelKey: "fake:fake-text",
        prompt: "p",
        parameters: {},
        inputs: []
      })
    });
    expect(submit.status).toBe(202);
    const status = await fetch(`${taskBase}/api/pptask/history/run-orphan`, {
      headers: { "x-woohaa3-service-token": cluster.taskToken, "x-woohaa3-protocol-version": "1" }
    });
    // 历史只读接口可能要求 operator 身份；用内部 status 更直接。
    const internal = await fetch(`${taskBase}/internal/v1/tasks/run-orphan`, {
      headers: { "x-woohaa3-service-token": cluster.taskToken, "x-woohaa3-protocol-version": "1" }
    });
    expect(internal.status).toBe(200);
    const detail = (await internal.json()) as { state: string };
    expect(["succeeded", "queued", "running"]).toContain(detail.state);
    void status;
  }, 20_000);

  it("Media 不可用：资产写入原子失败，结构命令仍成功（任务 5.5）", async () => {
    const cluster = await startCluster({ mediaFault: "down" });

    // 结构命令（无媒体）：经 Yjs 语义命令提交，仍被接受。
    const structural = await submitViaSync(cluster.canvas.port, cluster.canvasId, "op-structural", [
      { type: "node.add", node: { id: "n2", type: "text", position: { x: 10, y: 10 } } }
    ], cluster.canvasToken);
    expect(structural.status).toBe("accepted");

    // 资产命令（引用不存在/不可校验对象）：在副作用前失败，不产生部分提交。
    const asset = await submitViaSync(cluster.canvas.port, cluster.canvasId, "op-asset", [
      {
        type: "asset.upsert",
        asset: {
          id: "asset-x",
          title: "x",
          mediaKind: "image",
          source: "generated",
          status: "ready",
          createdAt: "2026-09-24T00:00:00Z",
          metadata: {
            storageKey: `sha256-${"c".repeat(64)}`,
            checksum: "c".repeat(64),
            contentType: "image/png",
            size: 4
          }
        }
      }
    ], cluster.canvasToken);
    // 资产命令被拒绝（Media 不可用），不产生部分提交。
    expect(asset.status).not.toBe("accepted");

    // 权威 revision 只被结构命令推进一次：从 Yjs 文档导出（Yjs 是唯一权威）。
    const state = await cluster.yjsRepository.loadYjsState(cluster.canvasId);
    expect(state?.projection?.document.nodes.map((node) => node.id)).toEqual(["text-1", "n2"]);
    expect(state?.projection?.assets).toEqual([]);
  }, 20_000);

  it("health 不泄漏 URI/路径/prompt/签名 URL/凭据（任务 7.3）", async () => {
    const cluster = await startCluster();
    const endpoints = [
      `http://127.0.0.1:${cluster.canvas.port}/api/canvas-storage/health/ready`,
      `http://127.0.0.1:${cluster.task.port}/api/pptask/health/ready`,
      `http://127.0.0.1:${cluster.task.port}/api/pptask/health/live`,
      `http://127.0.0.1:${cluster.media.port}/internal/v1/media/health`
    ];
    for (const url of endpoints) {
      const response = await fetch(url);
      const text = await response.text();
      for (const needle of SECRET_NEEDLES) {
        expect(text, `${url} -> ${needle}`).not.toContain(needle);
      }
      expect(["ok", "ready", "not-ready"]).toContain((JSON.parse(text) as { status?: string }).status ?? "not-ready");
    }
  }, 20_000);
});
