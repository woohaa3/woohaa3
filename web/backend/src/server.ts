/**
 * 统一后端进程生产入口
 * （change: 2026-10-06-unify-backend-runtime-with-cordis，任务 4.1）。
 *
 * 单一 node 进程承载 Canvas/Task/Media/MCP 的同源 API、Yjs upgrade 与站点插件控制面。
 * 前端静态资源由部署侧入口（`scripts/serve-web.mjs`）加载并把同源 API/WS 交给本进程。
 */
import http from "node:http";
import fs from "node:fs";
import { HOST_RESTART_EXIT_CODE } from "./api/host-restart-api.js";
import { createBackendService } from "./composition.js";
import { beginBoot, bootFailureFromLog, formatBootFailure, markReady, recordBootFailure } from "./host/boot-state.js";
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
  let boot: ReturnType<typeof beginBoot>;
  // 启动阶段耗时：调启动速度前先看这几行（模块 boot，落到宿主日志）。
  const bootStartedAt = Date.now();
  const phase = (name: string): void => logEvent({ module: "boot", event: "boot-phase", phase: name, ms: Date.now() - bootStartedAt });
  try {
    // 不传 logger：组合根用内置 sink（stderr 一行 JSON + 默认日志目录的轮转文件）。
    // 启动期扫描配置根并加载扩展声明（槽位发现与运行期发布目录）：声明非法时在监听前 fail-fast。
    // 启动守卫（change: 2026-10-21-harden-extension-fault-isolation，D7）：加载扩展前计数加一，
    // 连续未就绪次数超过阈值时本次以安全模式启动；就绪后清零。
    boot = beginBoot({ log: logEvent });
    const bootFile = boot.file;
    // 就绪前的扩展启动失败写进启动守卫（只记 extensionId / 错误码 / 脱敏截断消息），供下一次安全模式提示。
    let ready = false;
    const captureFailure = (event: Record<string, unknown>) => {
      if (ready) return;
      const failure = bootFailureFromLog(event);
      if (failure) recordBootFailure(bootFile, failure, undefined, logEvent);
    };
    const extensionHost = await loadExtensionHostFromEnv({
      logger: (event) => {
        logEvent(event);
        captureFailure(event);
      },
      safeMode: boot.safeMode !== null
    });
    phase("extension-host-scan");
    const lastFailure = boot.lastFailure ? formatBootFailure(boot.lastFailure) : undefined;
    service = await createBackendService({
      basePath,
      logTap: captureFailure,
      ...(extensionHost ? { extensionHost } : {}),
      ...(boot.safeMode
        ? { safeMode: { ...boot.safeMode, suspended: extensionHost?.safeMode?.suspended ?? [], ...(lastFailure ? { lastFailure } : {}) } }
        : {})
    });
    phase("backend-service");
    ready = true;
    markReady(bootFile, undefined, logEvent);
    phase("ready");
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
  let restartEntryTouched = false;
  const exitProcess = (exitCode: number) => {
    // Node's --watch supervisor treats exit code 75 as a failed child and waits for a
    // file change instead of exiting. Touch the entry in dev mode so it relaunches the
    // backend after a controlled restart (the production launcher is unaffected).
    if (exitCode === HOST_RESTART_EXIT_CODE && process.env.WOOHAA3_DEV_WATCH === "1" && !restartEntryTouched) {
      restartEntryTouched = true;
      const entry = process.argv[1];
      if (entry) {
        try {
          const now = new Date();
          fs.utimesSync(entry, now, now);
        } catch {
          // Restart must still complete when the entry is read-only or unavailable.
        }
      }
    }
    process.exit(exitCode);
  };
  // 受控重启与终止信号走同一条排空关闭，只是退出码不同（75 = 请求重启，
  // change: 2026-10-21-harden-extension-fault-isolation，D6）。
  const shutdown = (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    void service.close().finally(() => {
      server.close(() => exitProcess(exitCode));
      // 浏览器的 keep-alive 连接会让 close 回调一直不来：排空完成后不再接新请求，直接断开剩余连接。
      server.closeIdleConnections?.();
      setTimeout(() => {
        server.closeAllConnections?.();
        exitProcess(exitCode);
      }, 5000).unref();
    });
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  service.onRestartRequested((request) => {
    process.stderr.write(`[backend] 受控重启：${JSON.stringify({ reason: request.reason, exitSafeMode: request.exitSafeMode })}，排空后以 ${HOST_RESTART_EXIT_CODE} 退出\n`);
    shutdown(HOST_RESTART_EXIT_CODE);
  });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = address !== null && typeof address === "object" ? address.port : port;
    // 监听成功后才登记：端口为 0 时只有此刻才知道真实端口，提前写会登记一个连不上的地址。
    const originHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    try {
      service.publishOrigin(`http://${originHost}:${actualPort}`);
    } catch (error) {
      process.stderr.write(`[backend] 实例登记失败：${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.stderr.write(`[backend] http://${host}:${actualPort}\n`);
  });
}

void main();
