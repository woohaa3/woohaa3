/**
 * Task Service 独立生产入口（change: split-web-runtime-services，任务 2.1 / 4.6）。
 *
 * 挂载同源 catalog、受保护的浏览器 history API 与内部 v1 submit/cancel/status/history/event。
 * 模型配置来自仓库内可评审文件；provider 凭据来自环境；**不读 COS**。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTaskService } from "./composition.js";
import { parseModelsConfig } from "./config/models-config.js";

const port = Number(process.env.PORT ?? process.env.TASK_SERVICE_PORT ?? 5182);
const host = process.env.HOST ?? process.env.TASK_SERVICE_HOST ?? "127.0.0.1";

function log(event: Record<string, unknown>): void {
  process.stderr.write(`[task-service] ${JSON.stringify(event)}\n`);
}

function readModelsConfig(): ReturnType<typeof parseModelsConfig> {
  const explicit = process.env.WOOHAA3_MODELS_CONFIG_PATH;
  const candidate = explicit
    ? path.resolve(explicit)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "pptask.models.json");
  if (!fs.existsSync(candidate)) {
    return {
      ok: true,
      config: { version: 1, models: [] },
      source: `${candidate}（不存在，默认全开）`
    };
  }
  return parseModelsConfig(JSON.parse(fs.readFileSync(candidate, "utf8")), candidate);
}

async function main(): Promise<void> {
  const models = readModelsConfig();
  if (!models.ok) {
    process.stderr.write(`模型配置无效：${models.reason}\n`);
    process.exit(1);
  }

  let service;
  try {
    service = createTaskService({ modelsConfig: models.config, logger: (event) => log(event) });
  } catch (error) {
    process.stderr.write(`任务服务未启用：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    service.handle(req, res).catch((error: unknown) => {
      log({ event: "task-handler-failure", message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "task-handler-failure" }));
      } else {
        res.end();
      }
    });
  });

  server.on("error", (error) => {
    process.stderr.write(`[task-service] ${String(error)}\n`);
    process.exit(1);
  });
  const shutdown = () => {
    void service.close().finally(() => server.close(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(port, host, () => {
    process.stderr.write(`[task-service] http://${host}:${port}\n`);
  });
}

void main();
