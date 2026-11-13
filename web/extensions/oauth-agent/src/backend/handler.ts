/**
 * `/api/oauth-agent/*` 同源 HTTP 路由
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 3.1/3.5 / design D2/D3/D5）。
 *
 * - owner 只由后端可信认证（`principal.subject`）或服务端签发的 HttpOnly 本地会话 cookie 决定；
 *   前端自报 userId/localStorage ID/管理员令牌/代理头都不参与；
 * - 有状态请求做 Origin/CSRF 校验；
 * - 授权回调只返回状态快照（绝不携带 token）；生成进度经同源 SSE 传输并带 heartbeat；
 * - 公开响应/日志绝不含 access/refresh/ID token。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_CHATGPT_BASE_PATH,
  CHATGPT_ROUTES,
  addAppBasePath,
  decodeChatGptGenerateRequest,
  type ChatGptGenerateRequest,
  type PreparedAgentRoleTurn,
  decodeChatGptRequestIdQuery,
  WOOHAA3_PROTOCOL_VERSION
} from "@woohaa3/contracts";
import type { ChatGptAuthorizationService } from "./authorization.js";
import type { ChatGptGenerationService } from "./generation.js";
import { isAllowedChatGptModel } from "./models.js";
import type { OwnerResolver, OwnerResolution } from "./identity.js";

export type ChatGptApiDependencies = {
  /** 是否启用（部署配置齐全）；未启用时返回明确不可用状态。 */
  enabled: boolean;
  disabledReason?: string;
  owners: OwnerResolver;
  authorization: ChatGptAuthorizationService;
  generation: ChatGptGenerationService;
  prepareGenerationRole?: (input: {
    ownerId: string;
    request: ChatGptGenerateRequest;
  }) => Promise<{ ok: true; prepared: PreparedAgentRoleTurn } | { ok: false; code: string; message: string }>;
  models: { list: (accessToken: string) => Promise<{ ok: true; models: { id: string; label: string }[] } | { ok: false; message: string }> };
  /** 断开时终止该 owner 的活动推理会话。 */
  onOwnerDisconnect?: (ownerId: string) => void;
  /** 允许的同源 Origin 集合（回调 origin + 本地 origin）。 */
  allowedOrigins: readonly string[];
  /**
   * 本地开发姿态（无应用登录、允许本地会话）。
   *
   * 为 true 时回调 redirect URI 从请求自身的 Origin 派生（而不是固定部署 origin），
   * 使授权 popup 回调与主页面处于**同一 host**，从而共享 HttpOnly 会话 cookie 与同一 owner。
   * 生产（公网部署）必须为 false，回调固定到部署配置的公开 origin。
   */
  localDev?: boolean;
  basePath?: string;
  /**
   * 当前公开挂载路径（change: 2026-10-15-support-configurable-app-base-path）；OAuth 回调
   * redirect URI 在其上派生，且固定进 OAuth transaction（不随后续请求头变化）。
   */
  deploymentBasePath?: string;
  logger?: (event: Record<string, unknown>) => void;
};

export type ChatGptApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createChatGptApiHandler(deps: ChatGptApiDependencies): ChatGptApiHandler {
  const basePath = (deps.basePath ?? DEFAULT_CHATGPT_BASE_PATH).replace(/\/$/, "");
  const log = deps.logger ?? (() => undefined);

  return async (req, res) => {
    const url = safeUrl(req.url);
    if (!url) return false;
    const pathname = url.pathname;
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return false;
    const suffix = pathname.slice(basePath.length).replace(/^\/+/, "");

    if (!deps.enabled) {
      sendError(res, 503, "not-configured", deps.disabledReason ?? "个人 ChatGPT 授权未配置");
      return true;
    }

    // 状态快照是唯一允许无副作用解析 owner 的只读入口（会按需签发本地会话 cookie）。
    const owner = deps.owners.resolve(req);
    const applyOwnerCookie = (resolution: OwnerResolution): void => {
      if (resolution.ok && resolution.setCookie) res.setHeader("Set-Cookie", resolution.setCookie);
    };

    try {
      if (suffix === CHATGPT_ROUTES.status && req.method === "GET") {
        applyOwnerCookie(owner);
        if (!owner.ok) return sendOwnerFailure(res, owner);
        sendJson(res, 200, deps.authorization.snapshot(owner.ownerId, owner.ownerKind));
        return true;
      }

      if (suffix === CHATGPT_ROUTES.authorizeStart && req.method === "POST") {
        if (!checkOrigin(req, deps.allowedOrigins)) return sendError(res, 403, "invalid-origin", "请求 Origin 无效");
        applyOwnerCookie(owner);
        if (!owner.ok) return sendOwnerFailure(res, owner);
        const result = await deps.authorization.start({ owner, req, redirectUri: redirectUriFor(req, deps) });        if (!result.ok) return sendError(res, result.status, result.code, result.message);
        if (result.setCookie) res.setHeader("Set-Cookie", result.setCookie);
        sendJson(res, 200, { url: result.url, expiresAt: result.expiresAt });
        return true;      }

      if (suffix === CHATGPT_ROUTES.authorizeComplete && (req.method === "GET" || req.method === "POST")) {
        applyOwnerCookie(owner);
        if (!owner.ok) return sendOwnerFailure(res, owner);
        const query = Object.fromEntries(url.searchParams.entries());
        const result = await deps.authorization.complete({ owner, req, query });
        if (result.ok && result.setCookie) res.setHeader("Set-Cookie", result.setCookie);
        if (req.method === "GET") {
          // 回调页面：只通知主页面结果，不携带 token。
          sendHtml(res, result.ok ? 200 : result.status, callbackPage(result.ok, result.ok ? undefined : result.message));
          return true;
        }
        if (!result.ok) return sendError(res, result.status, result.code, result.message);
        sendJson(res, 200, result.snapshot);
        return true;
      }

      if (suffix === CHATGPT_ROUTES.authorizeCancel && req.method === "POST") {
        if (!checkOrigin(req, deps.allowedOrigins)) return sendError(res, 403, "invalid-origin", "请求 Origin 无效");
        applyOwnerCookie(owner);
        if (!owner.ok) return sendOwnerFailure(res, owner);
        deps.authorization.cancelAuthorization?.(owner.ownerId);
        sendJson(res, 200, deps.authorization.snapshot(owner.ownerId, owner.ownerKind)); return true;
      }
      if (suffix === CHATGPT_ROUTES.disconnect && req.method === "POST") {
        if (!checkOrigin(req, deps.allowedOrigins)) return sendError(res, 403, "invalid-origin", "请求 Origin 无效");
        applyOwnerCookie(owner);
        if (!owner.ok) return sendOwnerFailure(res, owner);
        const { revoked } = await deps.authorization.disconnect(owner.ownerId);
        deps.onOwnerDisconnect?.(owner.ownerId);
        const snapshot = deps.authorization.snapshot(owner.ownerId, owner.ownerKind);
        sendJson(res, 200, { ...snapshot, ...(revoked ? {} : { message: "已清除本地授权；远程撤销未确认，请在 ChatGPT 设置中断开应用。" }) });
        return true;
      }

      if (suffix === CHATGPT_ROUTES.models && req.method === "GET") {
        applyOwnerCookie(owner);
        if (!owner.ok) return sendOwnerFailure(res, owner);
        if (deps.authorization.snapshot(owner.ownerId, owner.ownerKind).state !== "ready") {
          sendError(res, 409, "authorization-required", "需要有效的 ChatGPT 订阅授权");
          return true;
        }
        try {
          const token = await deps.authorization.ensureAccessToken(owner.ownerId);
          const result = await deps.models.list(token);
          if (!result.ok) sendJson(res, 200, { models: [], error: result.message });
          else sendJson(res, 200, { models: result.models });
        } catch (error) {
          sendError(res, 409, "authorization-required", error instanceof Error ? error.message : "授权不可用");
        }
        return true;
      }

      if (suffix === CHATGPT_ROUTES.generate && req.method === "POST") {
        if (!checkOrigin(req, deps.allowedOrigins)) return sendError(res, 403, "invalid-origin", "请求 Origin 无效");
        applyOwnerCookie(owner);
        if (!owner.ok) return sendOwnerFailure(res, owner);
        if (deps.authorization.snapshot(owner.ownerId, owner.ownerKind).state !== "ready") {
          sendError(res, 409, "authorization-required", "需要有效的 ChatGPT 订阅授权");
          return true;
        }
        const body = await readJson(req);
        const decoded = decodeChatGptGenerateRequest(body);
        if (!decoded.ok) return sendError(res, 400, decoded.code, decoded.message);
        // 模型 allowlist（服务端强制）：目录只投影可用模型；这里再拒绝越权 slug，避免客户端绕过。
        if (!isAllowedChatGptModel(decoded.value.model)) {
          return sendError(res, 400, "unsupported-model", "该模型不可用于本应用生成。");
        }
        try {
          await deps.authorization.ensureAccessToken(owner.ownerId);
        } catch (error) {
          return sendError(res, 409, "authorization-required", error instanceof Error ? error.message : "授权不可用");
        }
        await streamGeneration(deps, req, res, owner.ownerId, decoded.value, log);
        return true;
      }

      if (suffix.startsWith(`${CHATGPT_ROUTES.generate}/`) && req.method === "GET") {
        applyOwnerCookie(owner);
        if (!owner.ok) return sendOwnerFailure(res, owner);
        const requestId = decodeURIComponent(suffix.slice(CHATGPT_ROUTES.generate.length + 1));
        const decoded = decodeChatGptRequestIdQuery(requestId);
        if (!decoded.ok) return sendError(res, 400, decoded.code, decoded.message);
        sendJson(res, 200, deps.generation.receipt(decoded.value.requestId, owner.ownerId));
        return true;
      }

      if (suffix === CHATGPT_ROUTES.cancel && req.method === "POST") {
        if (!checkOrigin(req, deps.allowedOrigins)) return sendError(res, 403, "invalid-origin", "请求 Origin 无效");
        applyOwnerCookie(owner);
        if (!owner.ok) return sendOwnerFailure(res, owner);
        const body = await readJson(req);
        const decoded = decodeChatGptRequestIdQuery((body as { requestId?: string } | null)?.requestId ?? url.searchParams.get("requestId"));
        if (!decoded.ok) return sendError(res, 400, decoded.code, decoded.message);
        const cancelled = deps.generation.cancel(owner.ownerId, decoded.value.requestId);
        sendJson(res, 200, { cancelled });
        return true;
      }
    } catch (error) {
      log({ event: "chatgpt-api-error", message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) sendError(res, 500, "internal", "内部错误");
      else res.end();
      return true;
    }

    sendError(res, 404, "not-found", "未知的 ChatGPT 路由");
    return true;
  };
}

async function streamGeneration(
  deps: ChatGptApiDependencies,
  req: IncomingMessage,
  res: ServerResponse,
  ownerId: string,
  request: ChatGptGenerateRequest,
  log: (event: Record<string, unknown>) => void
): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  req.on("close", () => {
    // 连接中断：保留服务端推理（可用 requestId 恢复），但停止写入。
    closed = true;
  });
  const emit = (type: string, data: unknown): void => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(": heartbeat\n\n");
  }, 15_000);

  try {
    const role = deps.prepareGenerationRole
      ? await deps.prepareGenerationRole({ ownerId, request: request as ChatGptGenerateRequest })
      : { ok: false as const, code: "role-unavailable", message: "宿主未提供 Agent 角色准备面" };
    if (!role.ok) {
      emit("error", { code: role.code, message: role.message });
      sendJson(res, role.code === "role-not-found" || role.code === "role-input-invalid" ? 400 : 409, { ok: false, code: role.code, message: role.message });
      return;
    }
    const result = await deps.generation.generate(
      {
        ownerId,
        requestId: request.requestId,
        roleId: request.roleId,
        prepared: role.prepared,
        canvasId: request.canvasId,
        nodeId: request.nodeId,
        mode: request.mode,
        model: request.model,
        prompt: request.prompt,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
        ...(request.expectedContentHash ? { expectedContentHash: request.expectedContentHash } : {}),
        ...(request.clipId ? { clipId: request.clipId } : {}),
        ...(request.itemId ? { itemId: request.itemId } : {}),
        ...(request.selectedCameraId ? { selectedCameraId: request.selectedCameraId } : {})
      },
      (progress) => emit("progress", progress)
    );
    if (result.ok) emit("result", result.receipt);
    else {
      const saved = deps.generation.receipt(request.requestId, ownerId);
      emit("result", saved.status === "failed" ? saved : { status: "failed", requestId: request.requestId, code: result.code, message: result.message });
    }
  } catch (error) {
    log({ event: "chatgpt-generate-failed", message: error instanceof Error ? error.message : String(error) });
    emit("result", { status: "failed", requestId: request.requestId, code: "internal", message: "生成失败" });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

function safeUrl(raw: string | undefined): URL | null {
  try {
    return new URL(raw ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

/**
 * 回调 redirect URI。
 *
 * - 本地开发（`localDev`）：从请求自身的 Origin 派生，保证回调 popup 与主页面**同 host**，
 *   共享会话 cookie 与同一 owner（否则 127.0.0.1 vs localhost 会被判为不同会话）。
 * - 生产：固定到部署配置的公开 origin（`allowedOrigins[0]`），不接受请求自报 origin。
 */
function redirectUriFor(req: IncomingMessage, deps: ChatGptApiDependencies): string {
  const callback = addAppBasePath(deps.deploymentBasePath ?? "/", "/api/oauth-agent/authorize/complete");
  if (deps.localDev) {
    const host = headerValue(req.headers.host) ?? "127.0.0.1";
    const origin = headerValue(req.headers.origin) ?? `http://${host}`;
    return `${origin}${callback}`;
  }
  const configured = deps.allowedOrigins[0];
  if (configured) return `${configured}${callback}`;
  const host = headerValue(req.headers.host) ?? "127.0.0.1";
  return `http://${host}${callback}`;
}

/** 有状态请求的 Origin/CSRF 校验：必须匹配允许的 origin 或请求自身 origin。 */
function checkOrigin(req: IncomingMessage, allowed: readonly string[]): boolean {
  const origin = headerValue(req.headers.origin);
  if (!origin) return true; // 同源 fetch 可能不带 Origin（GET/表单）；关键写操作由 owner cookie 保护。
  if (allowed.includes(origin)) return true;
  const host = headerValue(req.headers.host);
  if (host && origin === `http://${host}`) return true;
  if (host && origin === `https://${host}`) return true;
  // 本地开发：允许 loopback 前端（如 Vite dev 代理）的 origin；生产回调 origin 非 loopback 时
  // 该分支不生效，避免放开公网跨站。
  if (allowed.some(isLoopbackOriginText) && isLoopbackOriginText(origin)) return true;
  return false;
}

function isLoopbackOriginText(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function sendOwnerFailure(res: ServerResponse, resolution: Extract<OwnerResolution, { ok: false }>): true {
  sendError(res, resolution.status, resolution.code, resolution.message);
  return true;
}

function headerValue(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value !== "" ? value : undefined;
}

function sendError(res: ServerResponse, status: number, code: string, message: string): true {
  sendJson(res, status, { code, message, protocolVersion: WOOHAA3_PROTOCOL_VERSION });
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(html)));
  res.end(html);
}

/** 回调结果页：只向主页面 postMessage 通知，不传 token。 */
function callbackPage(ok: boolean, message?: string): string {
  const safe = (message ?? (ok ? "授权成功" : "授权失败")).replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT 授权</title></head><body><p>${
    ok ? "授权完成，可以关闭此窗口。" : `授权失败：${safe}`
  }</p><script>if(window.opener){window.opener.postMessage({type:"woohaa3-chatgpt-auth",ok:${ok ? "true" : "false"}},"*");}setTimeout(function(){window.close()},800);</script></body></html>`;
}

async function readJson(req: IncomingMessage, maxBytes = 256 * 1024): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        reject(new Error("payload-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text === "") return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}
