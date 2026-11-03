/**
 * 同源路由层（change: split-web-runtime-services，任务 2.2 / 6.3 / 6.4）。
 *
 * 只负责 TLS/同源路由/传输语义：把浏览器可见路径转发到对应运行单元，**不**持有画布、
 * 任务或媒体业务状态，**不**实现任务补偿，**不**解析 Yjs（design D8）。
 *
 * 路由表：
 * ```
 * /api/canvases/*        -> Canvas Service（含 WebSocket upgrade）
 * /api/canvas-storage/*  -> Canvas Service health/ops
 * /api/model-mcp/*       -> Canvas Service（旧客户端兼容面：脚本权威提交）
 * /mcp/*                 -> MCP Service（MCP 传输与工具定义；画布权威仍在 Canvas）
 * /api/media/*           -> Media Service public HTTP
 * /api/pptask/catalog    -> Task Service
 * /api/pptask/history*   -> Task Service（受保护只读）
 * /api/extensions*          -> Application Service（站点插件公开状态与管理员配置写入）
 * /api/application/*     -> Application Service（健康/就绪）
 * /api/telemetry/*       -> Application Service（宿主 core 的本机遥测 intake 与复盘查询）
 * /internal/v1/*         -> 拒绝（服务间协议，不经公网 ingress）
 * ```
 *
 * 开发（Vite plugin）与生产（scripts/serve-web.mjs）共用本模块，协议行为一致。
 *
 * 纯 JS（不带类型标注），因为它会被 `scripts/serve-web.mjs` 直接 import，不经过构建。
 */
import http from "node:http";
import https from "node:https";
import { stripAppBasePath } from "../../web/contracts/src/base-path/app-base-path.mjs";

/**
 * 纯函数路由判定（可单测）。
 *
 * 返回目标单元；`internal` 表示明确的内部协议路径（必须拒绝）；`none` 表示不属于站点 API。
 */
export function routeFor(pathname) {
  if (pathname === "/api/scene-packages" || pathname.startsWith("/api/scene-packages/")) return "application";
  if (pathname.startsWith("/internal/")) return "internal";
  // 外部画布来源目录与旧 ID prepare/status（change: 2026-10-12-add-extension-online-canvas-migration）：
  // 由 Canvas Service 承载；prepare 状态与目标 ACL 权威都在 Canvas。
  if (pathname === "/api/canvas-sources" || pathname.startsWith("/api/canvas-sources/")) return "canvas";
  if (pathname === "/api/canvases" || pathname.startsWith("/api/canvases/")) return "canvas";
  if (pathname === "/api/canvas-storage/health" || pathname.startsWith("/api/canvas-storage/health/")) return "canvas";
  if (pathname === "/api/model-mcp" || pathname.startsWith("/api/model-mcp/")) return "canvas";
  // MCP 传输与工具定义由独立 mcp-service 承载（change: split-model-mcp-into-mcp-service）；
  // 兼容入口 /mcp/model-canvas 也指向它。画布权威仍在 Canvas。
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) return "mcp";
  // 提示词片段目录（change: add-prompt-snippet-library）：由 Canvas Service 承载（独立表）。
  if (pathname === "/api/prompt-snippets" || pathname.startsWith("/api/prompt-snippets/")) return "canvas";
  // 节点生成历史（change: add-canvas-node-generation-history）：由 Canvas Service 承载（独立表）。
  if (pathname === "/api/canvas-node-history" || pathname.startsWith("/api/canvas-node-history/")) return "canvas";
  // 画布任务活动（change: 2026-09-29-add-canvas-task-activity-feed；change:
  // unify-canvas-session-websocket 后只保留有限 snapshot/`/changes` 补偿面）：由 Canvas Service 承载。
  if (pathname === "/api/canvas-task-activity" || pathname.startsWith("/api/canvas-task-activity/")) return "canvas";
  if (pathname === "/api/media-projects") return "media";
  if (pathname === "/api/media" || pathname.startsWith("/api/media/")) return "media";
  if (pathname === "/api/pptask/catalog") return "task";
  if (pathname === "/api/pptask/history" || pathname.startsWith("/api/pptask/history/")) return "task";
  // ppserver 任务路由器的同源转发（`ppserver-provider` 扩展的 gateway 路由）。
  // **必须登记**：未登记的 `/api/...` 会被判 `none` 直接 404，请求到不了宿主 gateway，
  // 表现为「令牌配了、目录也拉到了，但前端生成一律 404」。四喜前端与登录后的会话投递
  // 都走这个前缀（`/api/ppserver/tasks/*` 与 `/api/ppserver/auth/session`）。
  if (pathname === "/api/ppserver" || pathname.startsWith("/api/ppserver/")) return "application";
  // 站点应用插件控制面与 Application 健康（change: 2026-10-05-extract-application-plugin-host）：
  // 由独立 Application Service 承载；ingress 只路由与传递可信身份，不持有配置权威。
  // 开发页面与生产入口共用后端生成的扩展发布目录及不可变资源。
  if (pathname.startsWith("/extension-releases/") || pathname.startsWith("/extensions/")) return "application";
  if (pathname === "/api/extensions" || pathname.startsWith("/api/extensions/")) return "application";
  if (pathname === "/api/generation-models" || pathname.startsWith("/api/generation-models/")) return "application";
  // 后端统一配置（设置页「后端配置」与「模型 Provider」分区）：由统一后端 SettingsService 承载，仅管理员可读写。
  if (pathname === "/api/settings" || pathname.startsWith("/api/settings/")) return "application";
  // 宿主受控重启（change: 2026-10-21-harden-extension-fault-isolation，D6）：管理员授权后排空并以 75 退出。
  if (pathname === "/api/host" || pathname.startsWith("/api/host/")) return "application";
  if (pathname === "/api/mcp-installation" || pathname.startsWith("/api/mcp-installation/")) return "application";
  // 设置页刷新网关模型目录：路径形如 `/api/providers/<providerId>/refresh`，注册它的是声明该路径的
  // Provider 插件（宿主 gateway 层）。按**模式**路由：新增 Provider 不需要改这里。
  if (/^\/api\/providers\/[a-z0-9-]+\/refresh$/.test(pathname)) return "application";
  // 个人 ChatGPT 授权与 3D 生成（change: 2026-10-08-add-chatgpt-oauth-3d-generation）：
  // 由统一后端的 ChatGPT 服务承载，同源路由；token 只在后端加密持久化。
  if (pathname === "/api/chatgpt" || pathname.startsWith("/api/chatgpt/")) return "application";
  // Agent 来源扩展的受控 HTTP 面（change: 2026-10-17-add-agent-appserver-and-sdk-connections）：
  // oauth-agent 是改名后的 OAuth 来源扩展；sdk-agent / local-agent 由各自站点扩展承载。
  // 三者都经 Application Service 的公开路由表校验与认证，再交给扩展 handler。
  if (/^\/api\/(?:oauth-agent|sdk-agent|local-agent)(?:\/|$)/.test(pathname)) return "application";
  // 服务端接入扩展的本机 OAuth 公开回调/完成页（change: 2026-10-20-add-local-oauth-login）：
  // 宿主公开路由表校验 state 后交给 remote-server 扩展；不登记会被判 none 直接 404。
  if (/^\/api\/remote-server(?:\/|$)/.test(pathname)) return "application";
  // 宿主 Agent 会话/回合（change: 2026-10-12-add-agent-conversation-panel）：由 Application Service
  // 承载（owner+canvas 隔离）；浏览器只读会话/事件与 MCP 真实发现，不接触 provider token。
  if (pathname === "/api/agent-conversations" || pathname.startsWith("/api/agent-conversations/")) return "application";
  if (pathname === "/api/application" || pathname.startsWith("/api/application/")) return "application";
  // 全局任务监控（宿主内置，无需 task-monitor 扩展）：snapshot/detail 由任务服务组合根提供。
  if (pathname === "/api/task-inspection" || pathname.startsWith("/api/task-inspection/")) return "application";
  // 本机遥测（change: 2026-10-20-add-local-client-telemetry）：intake 与复盘查询由宿主 core 的
  // `ctx.telemetry` 承载。**必须登记**：未登记的新 `/api/...` 会被判 `none` 直接 404，永远到不了宿主。
  if (pathname === "/api/telemetry" || pathname.startsWith("/api/telemetry/")) return "application";
  // 素材库（浏览器扩展「保存到四喜」保存进来的网页图片）。由宿主 core 的 library 插件承载。
  // **必须登记**：未登记的 `/api/...` 会被判 `none` 直接 404，请求永远到不了宿主 gateway。
  if (pathname === "/api/library" || pathname.startsWith("/api/library/")) return "application";
  return "none";
}

export function createIngress(options) {
  const log = options.logger ?? (() => undefined);
  // 120s：语言模型改写等同步任务可能跑 40s 以上；30s 会让浏览器先收到 502（后端其实已成功）。
  const timeoutMs = options.timeoutMs ?? 120_000;
  // change: 2026-10-15-support-configurable-app-base-path：dev Vite proxy 保留公开前缀转发、
  // 只在路由判定时按完整段剥离；实际剥离由下游 Backend 的挂载边界完成（避免重复剥离）。
  const basePath = options.basePath ?? "/";

  const targetFor = (route) => options.targets[route];
  const logicalOf = (pathname) => (basePath === "/" ? pathname : stripAppBasePath(basePath, pathname));

  const handle = async (req, res) => {
    const logical = logicalOf(safePathname(req.url));
    const route = logical === null ? "none" : routeFor(logical);

    // 内部协议不经公网 ingress。
    if (route === "internal") {
      log({ event: "ingress-internal-blocked", status: 404, code: "not-found" });
      sendJson(res, 404, { error: "not-found" });
      return true;
    }

    if (route === "none") {
      // 站点 API 命名空间下的未知路径不能落到前端 SPA（例如已删除的 `/api/dev-admin`
      // 若返回 index.html 会被误认为“接口可用”）。非 API 路径仍交给静态资源/SPA。
      if (logical === "/api" || logical?.startsWith("/api/")) {
        // 站点扩展的 publicRoutes 在运行时由各扩展声明，ingress 不枚举扩展身份；
        // 未命中的站点 API 交给 Application 的公开路由表判定（未注册路径仍由它 404）。
        const application = options.targets.application;
        if (application) return proxyHttp(req, res, application, timeoutMs, log);
        log({ event: "ingress-unknown-api", status: 404, code: "not-found" });
        sendJson(res, 404, { error: "not-found" });
        return true;
      }
      return false;
    }

    const target = targetFor(route);
    if (!target) {
      log({ event: "ingress-target-unavailable", status: 503, code: route });
      sendJson(res, 503, { error: "service-unavailable", service: route });
      return true;
    }

    return proxyHttp(req, res, target, timeoutMs, log);
  };

  const upgrade = (req, socket, head) => {
    const logical = logicalOf(safePathname(req.url));
    const route = logical === null ? "none" : routeFor(logical);
    // 只有画布同步走 WebSocket upgrade。
    if (route !== "canvas") return false;
    const target = options.targets.canvas;
    if (!target) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return true;
    }
    return proxyUpgrade(req, socket, head, target, log);
  };

  const health = async () => ({
    canvas: await probe(options.targets.canvas),
    task: await probe(options.targets.task),
    media: await probe(options.targets.media),
    mcp: await probe(options.targets.mcp),
    application: await probe(options.targets.application)
  });

  return { handle, upgrade, health };
}

/** 用实际 HTTP 请求转发；保留方法、body、Range 与认证上下文头。 */
function proxyHttp(req, res, target, timeoutMs, log) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const url = new URL(target);
    const client = url.protocol === "https:" ? https : http;
    const upstream = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req.headers)
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        upstreamRes.on("end", () => done(true));
        upstreamRes.on("error", () => done(true));
      }
    );
    // 超时与连接失败都会走下面的 error 分支；标记一下，否则两者在日志里长得一模一样。
    let timedOut = false;
    upstream.setTimeout(timeoutMs, () => {
      // 超时只终止这一跳；不缓存、不重试业务语义。
      timedOut = true;
      upstream.destroy(new Error("upstream-timeout"));
    });
    upstream.on("error", (error) => {
      if (!res.headersSent) sendJson(res, 502, { error: "upstream-unreachable" });
      else res.end();
      // 一行 502 说明不了任何问题：启动窗口里的 ECONNREFUSED、后端崩溃的 ECONNRESET、
      // 卡死的 upstream-timeout 必须能分辨，所以带上错误码、请求与目标地址。
      log?.({
        event: "ingress-upstream-error",
        status: 502,
        code: timedOut ? "upstream-timeout" : (error?.code ?? "unknown"),
        message: error?.message,
        method: req.method,
        path: req.url,
        target
      });
      done(true);
    });
    req.pipe(upstream);
    req.on("error", () => upstream.destroy());
  });
}

/** WebSocket upgrade 转发：把原始字节在两侧管道之间复制（不解析 Yjs）。 */
function proxyUpgrade(req, socket, head, target, log) {
  const url = new URL(target);
  const upstream = http.request({
    hostname: url.hostname,
    port: url.port || 80,
    method: "GET",
    path: req.url,
    headers: forwardHeaders(req.headers, true)
  });
  upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    const headers = Object.entries(upstreamRes.headers)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n`);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
    const cleanup = () => {
      socket.destroy();
      upstreamSocket.destroy();
    };
    socket.on("error", cleanup);
    upstreamSocket.on("error", cleanup);
  });
  // 下游在握手前拒绝 upgrade（例如不兼容版本 426）：把**非 101** 的 HTTP 响应原样回给
  // 客户端，而不是让原始 socket 悬挂。ingress 仍不解析任何业务 payload。
  upstream.on("response", (upstreamRes) => {
    const headers = Object.entries(upstreamRes.headers)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
    socket.write(`HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? ""}\r\n${headers.join("\r\n")}\r\n\r\n`);
    upstreamRes.pipe(socket);
    upstreamRes.on("end", () => socket.destroy());
    upstreamRes.on("error", () => socket.destroy());
    socket.on("error", () => upstreamRes.destroy());
  });
  upstream.on("error", (error) => {
    log?.({
      event: "ingress-upgrade-error",
      status: 502,
      code: error?.code ?? "unknown",
      message: error?.message,
      method: req.method,
      path: req.url,
      target
    });
    rejectUpgrade(socket, 502, "Bad Gateway");
  });
  upstream.end();
  return true;
}

/**
 * 只转发传输所需头部：剥离 hop-by-hop；保留 Range / If-Match / 认证/actor 头
 * （受信任代理语义由下游服务自行校验令牌）。
 *
 * `keepUpgrade` 时保留 `Connection: Upgrade` 与 `Upgrade`：WebSocket 握手必须原样到达
 * 下游，否则下游不会进入 upgrade 流程。
 */
/** 公网 ingress 必须剥离的客户端可伪造内部头（design D7）。 */
export const STRIPPED_PUBLIC_HEADERS = [
  "x-woohaa3-service-token",
  "x-woohaa3-admin-actor"
];

function forwardHeaders(headers, keepUpgrade = false) {
  const forwarded = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === "host") {
      // 供下游生成浏览器可访问的入口与 CSP；不接受客户端伪造的转发 Host。
      forwarded["x-forwarded-host"] = value;
      continue;
    }
    if (lower === "x-forwarded-host") continue;
    // 公网入口剥离客户端可自报的内部服务身份/管理员 actor：loopback 不授权，
    // 只有内部客户端直连服务时自行注入服务令牌。
    if (STRIPPED_PUBLIC_HEADERS.includes(lower)) continue;
    if (!keepUpgrade && (lower === "connection" || lower === "upgrade" || lower === "keep-alive")) continue;
    forwarded[key] = value;
  }
  return forwarded;
}

async function probe(target) {
  if (!target) return { up: false, reason: "未配置" };
  return new Promise((resolve) => {
    const url = new URL(target);
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      { protocol: url.protocol, hostname: url.hostname, port: url.port, method: "GET", path: "/" },
      (res) => {
        res.resume();
        resolve({ up: (res.statusCode ?? 500) < 500 });
      }
    );
    request.setTimeout(2_000, () => request.destroy(new Error("timeout")));
    request.on("error", () => resolve({ up: false, reason: "不可达" }));
    request.end();
  });
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function safePathname(url) {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "";
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}
