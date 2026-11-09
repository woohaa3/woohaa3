/**
 * Web host 运行单元：把「前端静态资源 + 本机宿主后端 + Yjs WebSocket」组合成一个
 * 普通 HTTP 服务，由浏览器的其他机器/本机访问。不依赖 Tauri，也不走 stdin 控制流。
 *
 * 与 `desktop-host-runtime.mjs` 的差别（刻意不合并）：
 * - 监听地址可配（daemon 部署可能是 0.0.0.0 后面挂反代），桌面壳固定回环；
 * - 不做桌面那套「只信任自己算出来的唯一 origin」的请求过滤，Origin/CSRF 由后端的
 *   `WOOHAA3_ALLOWED_ORIGINS` 判定（与 `serve-web.mjs` 生产入口一致）；
 * - 不产出 JSONL 控制消息，只回报监听地址供启动器打印。
 */
import http from 'node:http';
import { createStaticHandler, send } from './static-server.mjs';
import { injectReleaseLinkHtml } from './extension-release-catalog.mjs';
import { applyHttpMount, applyUpgradeMount, interceptHttpMount, rejectUpgradeSocket } from './mount-adapter.mjs';
import { resolveAppPageTitle } from './app-html.mjs';

/**
 * 启动服务并返回句柄。就绪检查失败时抛错且**不**留下监听端口。
 *
 * `basePath` 由调用方从 env 规范化后传入（非法配置必须在监听前失败）。
 */
export async function startWebHostServer({
  backend,
  frontendDir,
  extensionHost = null,
  host = '127.0.0.1',
  port = 0,
  basePath = '/',
  pageTitle = 'WooHaa3',
  env = null
}) {
  const readiness = await (backend.modules ? backend.modules().canvas.readiness() : backend.readiness());
  if (!readiness.ready) {
    await backend.close();
    throw new Error(`宿主未就绪：${readiness.reason ?? 'unknown'}`);
  }

  let stopping = false;
  const sockets = new Set();
  const currentReleaseHref = () => extensionHost?.browserRelease?.href ?? null;
  const serveStatic = createStaticHandler(frontendDir, {
    basePath,
    pageTitle,
    ...(extensionHost?.browserRelease
      ? { transformHtml: (html) => { const href = currentReleaseHref(); return href ? injectReleaseLinkHtml(html, href) : html; } }
      : {})
  });

  const server = http.createServer((req, res) => {
    if (stopping) {
      send(res, 503, 'host is shutting down');
      return;
    }
    // 公开挂载边界：只剥离一次前缀；前缀外请求不进后端也不走 SPA 回退。
    const action = applyHttpMount(basePath, req);
    if (interceptHttpMount(req, res, action)) return;
    const url = req.url ?? '/';
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (url === '/health/live') {
        send(res, 200, JSON.stringify({ status: 'ok' }), 'application/json; charset=utf-8');
        return;
      }
      if (url === '/health/ready') {
        Promise.resolve(backend.readiness?.())
          .then((result) =>
            send(
              res,
              result?.ready ? 200 : 503,
              JSON.stringify(result?.ready ? { status: 'ready' } : { status: 'not-ready', reason: result?.reason }),
              'application/json; charset=utf-8'
            )
          )
          .catch(() => send(res, 503, JSON.stringify({ status: 'not-ready', reason: 'readiness-check-failed' }), 'application/json; charset=utf-8'));
        return;
      }
    }
    if (extensionHost?.handleReleaseRequest?.(req, res)) return;
    Promise.resolve(backend.handle(req, res))
      .then((handled) => {
        if (!handled) serveStatic(req, res);
      })
      .catch((error) => {
        process.stderr.write(`[web-host] request failed: ${error?.message}\n`);
        if (!res.headersSent) send(res, 502, 'backend failure');
        else res.end();
      });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    const action = applyUpgradeMount(basePath, req);
    if (action.kind !== 'forward') {
      rejectUpgradeSocket(socket);
      return;
    }
    if (stopping || !backend.upgrade?.(req, socket, head)) socket.destroy();
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    await backend.close();
    throw error;
  }

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  if (env) {
    // 本机 Agent/MCP 需要回环端口；与桌面宿主同一语义。
    env.PORT = String(actualPort);
    env.BACKEND_PORT = String(actualPort);
  }

  let closing;
  return {
    origin: `http://${host}:${actualPort}`,
    port: actualPort,
    host,
    close() {
      if (closing) return closing;
      stopping = true;
      closing = (async () => {
        const serverClosed = new Promise((resolve) => server.close(resolve));
        try {
          const task = backend.modules?.().task;
          if (task) {
            // 退出前先持久化取消：进程结束不能被当成「稍后继续跑队列」。
            const seen = new Set();
            for (;;) {
              const pending = task.history().listUnsettled(1000).filter((record) => !seen.has(record.taskKey));
              if (!pending.length) break;
              for (const record of pending) {
                seen.add(record.taskKey);
                await task.port().cancel(record.taskKey);
              }
            }
          }
        } finally {
          await backend.close();
          for (const socket of sockets) socket.destroy();
          await serverClosed;
        }
      })();
      return closing;
    }
  };
}
