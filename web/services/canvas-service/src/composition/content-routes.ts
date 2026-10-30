/**
 * `/content/<extensionId>/...` 内容路由（change: 2026-10-28-generic-extension-content-ownership，任务 5.1）。
 *
 * 宿主只做通用边界：路径拆分、鉴权、body 上限、超时与稳定状态码；业务处理与状态由 owner
 * 声明。路由在注册表注册时已做冲突拒绝，因此运行期不会覆盖已有 handler。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ContentContributionResolver } from "@woohaa3/contracts";
import { dispatchContentRoute } from "@woohaa3/contracts";
import { readJsonBody, sendError, sendJson } from "../api/canvas-api/http-codec.js";
import { authorizeCanvasRequest, httpStatusForCanvasAccess } from "../access/resolve-access.js";
import type { CanvasRequestAuthenticator, CanvasAccessPort } from "../access/resolve-access.js";

const MAX_CONTENT_BODY_BYTES = 256 * 1024;
const CONTENT_TIMEOUT_MS = 15_000;

export type ContentRouteHandlerOptions = {
  readonly content: ContentContributionResolver;
  readonly authenticate?: CanvasRequestAuthenticator;
  readonly access?: CanvasAccessPort;
  readonly log?: (event: { readonly event: string; readonly status: number; readonly code?: string }) => void;
};

type Parsed = { readonly extensionId: string; readonly segments: readonly string[] };

function parseContentPath(url: string | undefined): Parsed | null {
  if (!url) return null;
  let pathname: string;
  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    return null;
  }
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "content" || parts.length < 2) return null;
  let extensionId: string;
  let segments: string[];
  try {
    extensionId = decodeURIComponent(parts[1]!);
    segments = parts.slice(2).map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  return extensionId ? { extensionId, segments } : null;
}

function queryCanvasId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, "http://localhost").searchParams.get("canvasId");
  } catch {
    return null;
  }
}

/** 权限与主画布 API 一致：读 GET/HEAD，其余按写。未注入认证时保持历史本机行为。 */
async function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  method: string,
  options: ContentRouteHandlerOptions
): Promise<boolean> {
  if (!options.authenticate) return true;
  const decision = await authorizeCanvasRequest({
    req,
    canvasId,
    permission: method === "GET" || method === "HEAD" ? "read" : "write",
    authenticate: options.authenticate,
    access: options.access ?? { authorize: async () => ({ allowed: false, code: "provider-unavailable", message: "画布授权提供者不可用" }) }
  });
  if (decision.ok) return true;
  const mapped = httpStatusForCanvasAccess(decision.decision);
  options.log?.({ event: "content-route-access-denied", status: mapped.status, code: mapped.code });
  sendError(res, mapped.status, mapped.code, decision.decision.message);
  return false;
}

export function createContentRouteHandler(
  options: ContentRouteHandlerOptions
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const parsed = parseContentPath(req.url);
    if (!parsed) return false;
    const method = (req.method ?? "GET").toUpperCase();
    const canvasId = queryCanvasId(req.url);
    if (!canvasId) {
      sendError(res, 400, "INVALID_REQUEST", "内容路由需要 canvasId");
      return true;
    }
    if (!(await authorize(req, res, canvasId, method, options))) return true;

    let body: unknown;
    if (method !== "GET" && method !== "HEAD") {
      try {
        body = await readJsonBody(req, MAX_CONTENT_BODY_BYTES);
      } catch {
        sendError(res, 400, "INVALID_REQUEST", "内容请求体非法或过大");
        return true;
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race([
        dispatchContentRoute(options.content, parsed.extensionId, method, parsed.segments, body),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), CONTENT_TIMEOUT_MS);
        })
      ]);
      if (!raced.ok) {
        sendError(res, raced.status, raced.code, raced.code);
        return true;
      }
      const { status, body: responseBody } = raced.result;
      if (responseBody === undefined) {
        res.statusCode = status;
        res.end();
      } else {
        sendJson(res, status, responseBody);
      }
      return true;
    } catch {
      sendError(res, 503, "content-route-timeout", "内容路由超时");
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
