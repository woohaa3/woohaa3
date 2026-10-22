/**
 * MCP Service 独立生产入口（change: split-model-mcp-into-mcp-service）。
 *
 * 单一可执行运行单元：只挂载 MCP Streamable HTTP 面（`/mcp/*`）。画布权威在 Canvas
 * Service，本进程经内部协议访问；未配置 Canvas 内部地址时 readiness 失败（不静默降级）。
 */
import http from "node:http";
import { createMcpService } from "./composition.js";

const port = Number(process.env.PORT ?? process.env.MCP_SERVICE_PORT ?? 5184);
const host = process.env.HOST ?? process.env.MCP_SERVICE_HOST ?? "127.0.0.1";

function log(event: Record<string, unknown>): void {
  process.stderr.write(`[mcp-service] ${JSON.stringify(event)}\n`);
}

async function main(): Promise<void> {
  const service = createMcpService({ logger: log });

  const server = http.createServer((req, res) => {
    service.handle(req, res).catch((error: unknown) => {
      log({ event: "mcp-handler-failure", message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "mcp-handler-failure" }));
      } else {
        res.end();
      }
    });
  });

  server.on("error", (error) => {
    process.stderr.write(`[mcp-service] ${String(error)}\n`);
    process.exit(1);
  });
  const shutdown = () => {
    void service.close().finally(() => server.close(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const readiness = await service.readiness();
  if (!readiness.ready) {
    log({ event: "mcp-readiness-degraded", reason: readiness.reason ?? "unknown" });
  }

  server.listen(port, host, () => {
    process.stderr.write(`[mcp-service] http://${host}:${port}\n`);
  });
}

void main();
