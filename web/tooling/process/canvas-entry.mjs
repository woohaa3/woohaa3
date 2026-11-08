#!/usr/bin/env node
/**
 * 进程级 E2E 的 Canvas Service 入口（change: split-web-runtime-services，任务 8.2）。
 *
 * 真实 SQLite 画布存储 + **真实 SQLite Yjs repository**（durable checkpoint/update）
 * + 真实 projector，client 指向 Task/Media 真实 HTTP 端点。
 * 监听 `PORT`；durable 状态在 `CANVAS_DB`。
 *
 * 额外的**测试控制端点**（仅本入口，不进入生产）：
 *   POST /__proc_enable_yjs__  { canvasId }  —— 为该画布创建初始 Yjs 文档。
 * 与 `e2e/server.mjs` 的同名能力一致，用于进程级重启演练。
 */
import http from "node:http";
import { SqliteCanvasRepository, SqliteYjsRepository, createCanvasService } from "../../services/canvas-service/dist/index.js";
import { serverCanvasToYDoc, YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import * as Y from "yjs";

const port = Number(process.env.PORT);
const dbPath = process.env.CANVAS_DB;

// 直接借用 canvas-service 的动态仓储解析：composeCanvasStorage 在 backend=sqlite 时
// 会用同一个 dbPath 建 SqliteYjsRepository。这里显式构造，便于控制控制端点。
const repository = new SqliteCanvasRepository({ path: dbPath });
const yjsRepository = new SqliteYjsRepository({ path: dbPath });

const service = await createCanvasService({
  env: {
    WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
    WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: dbPath,
    WOOHAA3_TASK_SERVICE_URL: process.env.TASK_URL,
    WOOHAA3_MEDIA_SERVICE_URL: process.env.MEDIA_URL,
    WOOHAA3_CANVAS_TO_TASK_TOKEN: process.env.TASK_TOKEN,
    WOOHAA3_CANVAS_TO_MEDIA_TOKEN: process.env.CANVAS_TOKEN
  },
  repository,
  yjsRepository,
  enableCanvasStorage: true,
  enableYjsSync: true,
  accessRuntime: {
    enabled: false,
    instance: { kind: "instance", id: "instance:process-test", ownerId: "instance:process-test", credentialOwnerId: "instance:process-test" }
  },
  // run/cancel 与 projector 需要 catalog；从 Task Service 的只读 catalog 拉取。
  // 懒求值，避免 Canvas 启动时 Task 尚不可达导致进程退出。
  resolveCatalog: async () => {
    try {
      const response = await fetch(`${process.env.TASK_URL}/api/pptask/catalog`);
      return await response.json();
    } catch {
      return { available: false, reason: "task-unreachable", models: [], defaultModels: {} };
    }
  },
  reconcileIntervalMs: 25,
  logger: () => undefined
});

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

const server = http.createServer((req, res) => {
  const url = req.url || "";
  if (url.startsWith("/__proc_enable_yjs__")) {
    void (async () => {
      try {
        const payload = JSON.parse((await readBody(req)) || "{}");
        const canvasId = String(payload.canvasId ?? "");
        const canvas = payload.canvas;
        if (!canvasId || !canvas) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "canvasId-and-canvas-required" }));
          return;
        }
        const now = new Date().toISOString();
        if (!(await yjsRepository.loadYjsState(canvasId))) {
          const doc = serverCanvasToYDoc(canvas);
          await yjsRepository.createYjsDocument({
            canvasId,
            formatVersion: YJS_CANVAS_FORMAT_VERSION,
            roomEpoch: "proc-epoch",
            checkpoint: Y.encodeStateAsUpdate(doc),
            projection: canvas,
            revision: canvas.revision ?? 0,
            createdAt: now
          });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ canvasId, roomEpoch: "proc-epoch" }));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      }
    })();
    return;
  }
  service.handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
if (service.sync) {
  server.on("upgrade", (req, socket, head) => {
    if (service.sync.matches(req.url)) service.sync.handle(req, socket, head);
    else socket.destroy();
  });
}
server.listen(port, "127.0.0.1", () => process.stderr.write(`[canvas] ${port}\n`));

const shutdown = () => {
  void service.close().finally(() => server.close(() => process.exit(0)));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
