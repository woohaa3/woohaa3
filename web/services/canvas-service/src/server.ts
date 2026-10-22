/**
 * Canvas Service 独立生产入口（change: split-web-runtime-services，任务 2.1 / 5.2 / 5.6）。
 *
 * 挂载同源 `/api/canvases`、`/api/canvas-storage/health`、`/mcp/model-canvas`
 * 与 Yjs WebSocket upgrade。
 * 缺数据库配置时 fail-fast；单实例 writer lock 由 composition 保证。
 */
import http from "node:http";
import { createCanvasService } from "./composition.js";
import { resolveCanvasStorageConfig } from "./storage/composition.js";
import type { CanvasTaskCatalog } from "@woohaa3/contracts";

const port = Number(process.env.PORT ?? process.env.CANVAS_SERVICE_PORT ?? 5183);
const host = process.env.HOST ?? process.env.CANVAS_SERVICE_HOST ?? "127.0.0.1";

function log(event: Record<string, unknown>): void {
  process.stderr.write(`[canvas-service] ${JSON.stringify(event)}\n`);
}

/**
 * 从 Task Service 的只读 catalog 读取模型目录。
 *
 * run/cancel 的权威校验需要 catalog（`CanvasRunService` 依赖 `resolveCatalog`），而模型目录
 * 由 Task Service 独占（`GET /api/pptask/catalog`，浏览器可见的同源路径；服务间经内部地址
 * 也能直接读）。这里用 `WOOHAA3_TASK_SERVICE_URL` 拉取并按需缓存：
 * - 失败时返回 `available:false` 而不是抛错，让 run 得到可诊断的 `catalog-unavailable`，
 *   而不是让整个 canvas 进程不可用；
 * - 成功后缓存，catalog 在运行期是静态的。
 */
function createCatalogResolver(): () => Promise<CanvasTaskCatalog> {
  const baseUrl = (process.env.WOOHAA3_TASK_SERVICE_URL ?? "").replace(/\/+$/, "");
  let cached: CanvasTaskCatalog | null = null;
  return async () => {
    if (cached) return cached;
    if (baseUrl === "") {
      return { available: false, reason: "未配置 WOOHAA3_TASK_SERVICE_URL", models: [], defaultModels: {} };
    }
    try {
      const response = await fetch(`${baseUrl}/api/pptask/catalog`, { method: "GET" });
      const body = (await response.json().catch(() => null)) as CanvasTaskCatalog | null;
      if (!response.ok || !body) {
        const reason = (body as { reason?: string } | null)?.reason ?? `任务目录请求失败（HTTP ${response.status}）`;
        return { available: false, reason, models: [], defaultModels: {} };
      }
      if (body.available) cached = body;
      return body;
    } catch {
      return { available: false, reason: "任务服务暂时不可达", models: [], defaultModels: {} };
    }
  };
}

async function main(): Promise<void> {
  const check = resolveCanvasStorageConfig(process.env as Record<string, string | undefined>);
  if (!check.ok) {
    process.stderr.write(`画布存储配置无效：${check.reason}\n`);
    process.exit(1);
  }

  let service;
  try {
    service = await createCanvasService({ logger: log, resolveCatalog: createCatalogResolver() });
  } catch (error) {
    process.stderr.write(`画布服务未启用：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    service.handle(req, res).catch((error: unknown) => {
      log({ event: "canvas-handler-failure", message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "canvas-handler-failure" }));
      } else {
        res.end();
      }
    });
  });

  if (service.sync) {
    const sync = service.sync;
    server.on("upgrade", (req, socket, head) => {
      if (sync.matches(req.url)) sync.handle(req, socket, head);
    });
  }

  server.on("error", (error) => {
    process.stderr.write(`[canvas-service] ${String(error)}\n`);
    process.exit(1);
  });
  const shutdown = () => {
    void service.close().finally(() => server.close(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(port, host, () => {
    process.stderr.write(`[canvas-service] http://${host}:${port}\n`);
  });
}

void main();
