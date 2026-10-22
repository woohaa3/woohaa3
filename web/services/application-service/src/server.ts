/**
 * Application Service 独立生产入口
 * （change: 2026-10-05-extract-application-plugin-host，任务 2.1）。
 *
 * 挂载站点同源插件 API 与健康检查；领域路径由部署侧 ingress 代理。
 * 有序停止：先关闭新准入并释放 owner，再关闭 server。
 */
import http from "node:http";
import { createApplicationService } from "./composition.js";

const port = Number(process.env.PORT ?? process.env.APPLICATION_SERVICE_PORT ?? 5185);
const host = process.env.HOST ?? process.env.APPLICATION_SERVICE_HOST ?? "127.0.0.1";

function log(event: Record<string, unknown>): void {
  process.stderr.write(`[application-service] ${JSON.stringify(event)}\n`);
}

async function main(): Promise<void> {
  let service;
  try {
    service = createApplicationService({ logger: (event) => log(event) });
  } catch (error) {
    process.stderr.write(`Application Service 未启用：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    service.handle(req, res).catch((error: unknown) => {
      log({ event: "application-handler-failure", message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "application-handler-failure" }));
      } else {
        res.end();
      }
    });
  });

  server.on("error", (error) => {
    process.stderr.write(`[application-service] ${String(error)}\n`);
    process.exit(1);
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    // 先关闭准入并释放插件资源，再关闭 HTTP server。
    void service.close().finally(() => server.close(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(port, host, () => {
    process.stderr.write(`[application-service] http://${host}:${port}\n`);
  });
}

void main();
