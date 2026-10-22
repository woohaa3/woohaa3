/**
 * 统一后端进程生产入口
 * （change: 2026-10-06-unify-backend-runtime-with-cordis，任务 4.1）。
 *
 * 单一 node 进程承载 Canvas/Task/Media/MCP 的同源 API、Yjs upgrade 与站点插件控制面。
 * 前端静态资源由部署侧入口（`scripts/serve-web.mjs`）加载并把同源 API/WS 交给本进程。
 */
import http from "node:http";
import { createBackendService } from "./composition.js";
import { loadExtensionHostFromEnv } from "./extensions/host-boot.js";
import { applyHttpMount, applyUpgradeMount, resolveBasePathFromEnv } from "./mount.js";

const port = Number(process.env.PORT ?? process.env.BACKEND_PORT ?? 5180);
const host = process.env.HOST ?? process.env.BACKEND_HOST ?? "127.0.0.1";

function logEvent(event: Record<string, unknown>): void {
  process.stderr.write(`[backend] ${JSON.stringify(event)}\n`);
}

async function main(): Promise<void> {
  // change: 2026-10-15-support-configurable-app-base-path：直接后端端口也认识公开挂载前缀；
  // 非法配置在监听前失败。
  const { basePath, error } = resolveBasePathFromEnv(process.env);
  if (error) {
    process.stderr.write(
      `[backend] WOOHAA3_BASE_PATH 配置非法（${error}）：${JSON.stringify(process.env.WOOHAA3_BASE_PATH)}\n`
    );
    process.exit(1);
  }
  let service;
  try {
    // 不传 logger：组合根用内置 sink（stderr 一行 JSON + 默认日志目录的轮转文件）。
    // 启动期扫描配置根并加载扩展声明（槽位发现与运行期发布目录）：声明非法时在监听前 fail-fast。
    const extensionHost = await loadExtensionHostFromEnv({ logger: logEvent });
    service = await createBackendService({ basePath, ...(extensionHost ? { extensionHost } : {}) });
  } catch (error) {
    // 稳定错误码一并打印：运维要能直接区分「声明非法 / 槽位冲突 / 配置缺失」。
    const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
    process.stderr.write(`后端未启用${code ? ` [${code}]` : ""}：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  const { log } = service;
  if (service.logDir) process.stderr.write(`[backend] logs → ${service.logDir}\n`);

  const server = http.createServer((req, res) => {
    if (applyHttpMount(basePath, req, res)) return;
    void service.handle(req, res).then((handled) => {
      // 网关只返回 false 表示「没有处理器认领」；直接端口也要给出确定的 404，
      // 不能把连接悬空（移除 `/api/dev-admin` 等路由后尤其重要）。
      if (handled || res.headersSent) return;
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("not found");
    }).catch((error: unknown) => {
      log({ event: "backend-handler-failure", message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "backend-handler-failure" }));
      } else {
        res.end();
      }
    });
  });

  if (service.upgrade) {
    server.on("upgrade", (req, socket, head) => {
      if (!applyUpgradeMount(basePath, req)) { socket.destroy(); return; }
      if (!service.upgrade?.(req, socket, head)) socket.destroy();
    });
  }

  server.on("error", (error) => {
    process.stderr.write(`[backend] ${String(error)}\n`);
    process.exit(1);
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void service.close().finally(() => server.close(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(port, host, () => {
    process.stderr.write(`[backend] http://${host}:${port}\n`);
  });
}

void main();
