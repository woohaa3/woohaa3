/**
 * Provider 凭据管理 API
 * （change: 2026-10-06-add-runninghub-api-models-and-provider-credentials，任务 2.1/2.2 / design D3/D5；
 *  change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 3.2/3.5）。
 *
 * ```
 * GET    /api/providers                              公开凭据状态（不含明文）
 * PUT    /api/providers/:providerId/credentials      受保护写入（providers.credentials.write；内存，不落盘）
 * DELETE /api/providers/:providerId/credentials      受保护清除
 * ```
 *
 * 授权复用宿主统一执行边界：写操作经 identity provider 认证后校验具名 action；loopback、
 * 静态 Token 或来路 admin 头不授权。地址字段一律忽略。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  APPLICATION_EXTENSION_ERROR_STATUS,
  DEFAULT_PROVIDERS_BASE_PATH,
  PROVIDERS_CREDENTIALS_ACTION,
  WOOHAA3_PROTOCOL_VERSION,
  decodeProviderCredentialsWrite,
  type ApplicationExtensionErrorCode,
  type ProviderCredentialsSnapshot
} from "@woohaa3/contracts";
import type { ApplicationRequestAuthenticator } from "@woohaa3/application-service";
import { statusForAccessError, type AccessEnforcer } from "@woohaa3/application-service";

export type ProvidersApiDependencies = {
  snapshot: () => Promise<ProviderCredentialsSnapshot>;
  write: (input: { providerId: string; fields: Record<string, string>; actor: string }) => Promise<
    | { ok: true; snapshot: ProviderCredentialsSnapshot }
    | { ok: false; code: ApplicationExtensionErrorCode; message: string }
  >;
  clear: (input: { providerId: string; actor: string }) => Promise<
    | { ok: true; snapshot: ProviderCredentialsSnapshot }
    | { ok: false; code: ApplicationExtensionErrorCode; message: string }
  >;
  authenticator?: ApplicationRequestAuthenticator;
  accessEnforcer?: AccessEnforcer;
  basePath?: string;
  logger?: (event: Record<string, unknown>) => void;
};

export type ProvidersApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createProvidersApiHandler(deps: ProvidersApiDependencies): ProvidersApiHandler {
  const basePath = (deps.basePath ?? DEFAULT_PROVIDERS_BASE_PATH).replace(/\/$/, "");
  const log = deps.logger ?? (() => undefined);

  const authorize = async (req: IncomingMessage): Promise<{ ok: true; actor: string } | { ok: false; status: number }> => {
    let principal: Awaited<ReturnType<ApplicationRequestAuthenticator>> = null;
    try { principal = deps.accessEnforcer?.runtime?.enabled === false ? null : deps.authenticator ? await deps.authenticator(req, "http") : null; }
    catch { return { ok: false, status: 503 }; }
    if (!principal && deps.accessEnforcer?.runtime?.enabled !== false) return { ok: false, status: 401 };
    if (!deps.accessEnforcer) return { ok: false, status: 503 };
    try {
      await deps.accessEnforcer.assertAction(principal, PROVIDERS_CREDENTIALS_ACTION);
    } catch (error) {
      return { ok: false, status: statusForAccessError(error) ?? 403 };
    }
    return { ok: true, actor: principal?.displayName ?? principal?.subject ?? "instance" };
  };

  return async (req, res) => {
    const url = safeUrl(req.url);
    if (!url) {
      sendError(res, 400, "malformed-request", "请求 URL 非法");
      return true;
    }
    const pathname = url.pathname;
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return false;

    const suffix = pathname.slice(basePath.length).replace(/^\/+/, "");
    if (req.method === "GET" && suffix === "") {
      sendJson(res, 200, await deps.snapshot());
      return true;
    }

    const match = /^([^/]+)\/credentials$/.exec(suffix);
    if (!match) {
      if (req.method !== "GET") {
        sendError(res, 405, "unsupported", "不支持的凭据路由");
        return true;
      }
      sendError(res, 404, "extension-not-found", "未知的凭据路由");
      return true;
    }
    const providerId = decodeURIComponent(match[1]!);

    if (req.method === "PUT") {
      const auth = await authorize(req);
      if (!auth.ok) {
        log({ event: "provider-credentials-unauthorized", providerId, status: auth.status });
        sendError(res, auth.status, auth.status === 401 ? "unauthorized" : "forbidden", "需要站点管理员授权");
        return true;
      }
      const body = await readJson(req);
      const decoded = decodeProviderCredentialsWrite(body);
      if (!decoded.ok) {
        sendError(res, 400, decoded.code as ApplicationExtensionErrorCode, decoded.message);
        return true;
      }
      const outcome = await deps.write({ providerId, fields: decoded.value.fields, actor: auth.actor });
      if (!outcome.ok) {
        sendError(res, APPLICATION_EXTENSION_ERROR_STATUS[outcome.code], outcome.code, outcome.message);
        return true;
      }
      log({ event: "provider-credentials-configured", providerId, actor: auth.actor });
      sendJson(res, 200, outcome.snapshot);
      return true;
    }

    if (req.method === "DELETE") {
      const auth = await authorize(req);
      if (!auth.ok) {
        log({ event: "provider-credentials-unauthorized", providerId, status: auth.status });
        sendError(res, auth.status, auth.status === 401 ? "unauthorized" : "forbidden", "需要站点管理员授权");
        return true;
      }
      const outcome = await deps.clear({ providerId, actor: auth.actor });
      if (!outcome.ok) {
        sendError(res, APPLICATION_EXTENSION_ERROR_STATUS[outcome.code], outcome.code, outcome.message);
        return true;
      }
      log({ event: "provider-credentials-cleared", providerId, actor: auth.actor });
      sendJson(res, 200, outcome.snapshot);
      return true;
    }

    sendError(res, 405, "unsupported", "不支持的凭据方法");
    return true;
  };
}

function safeUrl(raw: string | undefined): URL | null {
  try {
    return new URL(raw ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

function sendError(res: ServerResponse, status: number, code: ApplicationExtensionErrorCode, message: string): void {
  sendJson(res, status, { code, message, protocolVersion: WOOHAA3_PROTOCOL_VERSION });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
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
