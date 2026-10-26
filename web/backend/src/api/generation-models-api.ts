/**
 * 生成模型管理 API（change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 5.1 / design D2；
 * change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 3.2/3.5）。
 *
 * ```
 * GET /api/generation-models            公开模型策略 snapshot（不含秘密）
 * PUT /api/generation-models/config     受保护写入（models.manage + expectedRevision）
 * ```
 *
 * 授权复用宿主统一执行边界：写操作经 identity provider 认证后校验具名 action `models.manage`；
 * loopback、静态 Token 或来路 admin 头不授权。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  APPLICATION_EXTENSION_ERROR_STATUS,
  DEFAULT_GENERATION_MODELS_BASE_PATH,
  MODELS_MANAGE_ACTION,
  WOOHAA3_PROTOCOL_VERSION,
  decodeGenerationModelsWrite,
  type ApplicationExtensionErrorCode,
  type GenerationModelsSnapshot
} from "@woohaa3/contracts";
import type { ApplicationRequestAuthenticator } from "@woohaa3/application-service";
import { statusForAccessError, type AccessEnforcer } from "@woohaa3/application-service";

export type GenerationModelsApiDependencies = {
  snapshot: () => Promise<GenerationModelsSnapshot>;
  write: (input: {
    expectedRevision: number;
    models: import("@woohaa3/contracts").GenerationModelsWriteRequest["models"];
    actor: string;
  }) => Promise<
    | { ok: true; revision: number; snapshot: GenerationModelsSnapshot }
    | { ok: false; code: ApplicationExtensionErrorCode; message: string; currentRevision?: number }
  >;
  authenticator?: ApplicationRequestAuthenticator;
  accessEnforcer?: AccessEnforcer;
  basePath?: string;
  logger?: (event: Record<string, unknown>) => void;
};

export type GenerationModelsApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createGenerationModelsApiHandler(
  deps: GenerationModelsApiDependencies
): GenerationModelsApiHandler {
  const basePath = (deps.basePath ?? DEFAULT_GENERATION_MODELS_BASE_PATH).replace(/\/$/, "");
  const log = deps.logger ?? (() => undefined);

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
    if (req.method === "PUT" && suffix === "config") {
      let principal: Awaited<ReturnType<ApplicationRequestAuthenticator>> = null;
      try {
        principal = deps.accessEnforcer?.runtime?.enabled === false ? null : deps.authenticator ? await deps.authenticator(req, "http") : null;
        if (!principal && deps.accessEnforcer?.runtime?.enabled !== false) {
          log({ event: "generation-models-unauthorized", status: 401 });
          sendError(res, 401, "unauthorized", "需要站点管理员授权");
          return true;
        }
        if (!deps.accessEnforcer) throw Object.assign(new Error("授权提供者不可用"), { code: "access-provider-unavailable" });
        await deps.accessEnforcer.assertAction(principal, MODELS_MANAGE_ACTION);
      } catch (error) {
        const status = statusForAccessError(error) ?? 403;
        log({ event: "generation-models-unauthorized", status });
        sendError(res, status, status === 401 ? "unauthorized" : "forbidden", "需要站点管理员授权");
        return true;
      }
      const body = await readJson(req);
      if (body === null) {
        sendError(res, 400, "malformed-request", "请求体不是合法 JSON");
        return true;
      }
      const decoded = decodeGenerationModelsWrite(body);
      if (!decoded.ok) {
        sendError(res, 400, decoded.code as ApplicationExtensionErrorCode, decoded.message);
        return true;
      }
      const outcome = await deps.write({ expectedRevision: decoded.value.expectedRevision, models: decoded.value.models, actor: principal?.displayName ?? principal?.subject ?? "instance" });
      if (!outcome.ok) {
        if (outcome.code === "revision-conflict") {
          sendJson(res, APPLICATION_EXTENSION_ERROR_STATUS[outcome.code], {
            code: outcome.code,
            message: outcome.message,
            currentRevision: outcome.currentRevision
          });
          return true;
        }
        sendError(res, APPLICATION_EXTENSION_ERROR_STATUS[outcome.code], outcome.code, outcome.message);
        return true;
      }
      sendJson(res, 200, { revision: outcome.revision, snapshot: outcome.snapshot });
      return true;
    }
    // 本 handler 只拥有 `GET <base>` 与 `PUT <base>/config`；其余 `/api/extensions/*` 必须交下游，
    // 否则扩展层用 gateway.route 注册的自有路由（如 `POST /api/extensions/<id>/refresh`）会被这里
    // 以 405 截走——C 方向取消子进程转发后，这条遮蔽才暴露出来。
    return false;
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
