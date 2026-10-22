/**
 * Application extension API：公有原始/结构化 HTTP 分派（含 SSE 预算/心跳）
 * （自 `extension-api.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R15）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_PLUGIN_STREAM_BUDGET,
  type AccessAction,
  type ApplicationExtensionHttpMethod,
  type ApplicationExtensionHttpRequest,
  type ApplicationExtensionHttpResponse,
  type ApplicationExtensionHandlerPurpose,
  type ApplicationExtensionPublicRouteMapping,
  type ApplicationExtensionRawRequest,
  type ApplicationExtensionRawResponse,
  type DataScope,
  type PrincipalContext
} from "@woohaa3/contracts";
import type { ApplicationExtensionApiDependencies, ApiLogger } from "./types.js";
import { assertActions, buildDispatchContext, resolveAuth } from "./auth.js";
import { statusForAccessError } from "../../extensions/access-enforcement.js";
import { readRawBody, safeUrl, sendError, withTimeout } from "./http-helpers.js";

/** 匹配可信清单声明的固定公开路径（前缀或精确）。 */
export function matchPublicRoute(
  routes: readonly ApplicationExtensionPublicRouteMapping[],
  pathname: string
): ApplicationExtensionPublicRouteMapping | undefined {
  let best: ApplicationExtensionPublicRouteMapping | undefined;
  for (const route of routes) {
    const base = route.publicPath.replace(/\/$/, "");
    if (pathname === base || pathname.startsWith(`${base}/`)) {
      if (!best || base.length > best.publicPath.length) best = route;
    }
  }
  return best;
}

export async function handlePublicHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApplicationExtensionApiDependencies,
  mapping: ApplicationExtensionPublicRouteMapping,
  log: ApiLogger
): Promise<boolean> {
  const host = deps.host;
  const method = (req.method ?? "GET").toUpperCase() as ApplicationExtensionHttpMethod;
  if (!mapping.methods.includes(method)) {
    sendError(res, 405, "unsupported", "方法不允许");
    return true;
  }
  const url = safeUrl(req.url)!;
  const base = mapping.publicPath.replace(/\/$/, "");
  const subPath = url.pathname.slice(base.length).replace(/^\/+/, "");
  const route = subPath === "" ? mapping.route : `${mapping.route}/${subPath}`;

  const status = deps.controlPlane.status(mapping.extensionId);
  const auth = await resolveAuth(req, deps, "http");
  const purpose = purposeForPublicRoute(mapping.extensionId, route, method, deps);
  // draining：站点托管插件进入非 active 时拒绝新工作；后端无条件激活的插件由其自身 host.work 治理。
  const siteManaged = status?.configVersion !== null && status?.configVersion !== undefined;
  if (siteManaged && status?.actualState !== "active" && purpose === "new-work") {
    log({ event: "extension-http-unavailable", status: 503, extensionId: mapping.extensionId, route, actualState: status?.actualState });
    sendError(res, 503, "unavailable", "插件当前不可用");
    return true;
  }
  const controller = new AbortController();
  const onClose = () => controller.abort();
  req.on("close", onClose);
  try {
    const owned = host?.resolvePublicRoute(mapping.extensionId, route, method).owned ?? false;
    if (!host || !owned) {
      sendError(res, 404, "extension-not-found", "插件未激活");
      return true;
    }
    // 具名 action 在进入插件逻辑前校验（change: 2026-10-13-...，任务 1.4/3.3）。
    await assertActions(deps, auth.principal, publicRouteActions(deps, mapping.extensionId, route, method));
    const budget = { ...DEFAULT_PLUGIN_STREAM_BUDGET, ...resolveStreamBudget(deps, mapping.extensionId, route, method) };
    const deadlineTimer = budget.deadlineMs > 0 ? setTimeout(() => {
      controller.abort();
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          /* 已断开的连接 */
        }
      }
    }, budget.deadlineMs) : undefined;
    deadlineTimer?.unref?.();
    const stopHeartbeat = isStreamRoute(deps, mapping.extensionId, route, method) ? startHeartbeat(res, budget, controller) : (() => undefined);
    const dispatchContext = { ...buildDispatchContext(req, auth), signal: controller.signal };
    try {
      const rawDispatched = await withTimeout(
        host.dispatchRawHttp({
          method,
          route,
          req: req as unknown as ApplicationExtensionRawRequest,
          res: res as unknown as ApplicationExtensionRawResponse,
          context: dispatchContext
        }),
        budget.deadlineMs,
        controller
      );
      if (!rawDispatched) {
        await withTimeout(
          host.dispatchHttp({
            method,
            route,
            req: buildHttpRequest(req, url, auth, controller.signal),
            res: buildHttpResponse(res, controller.signal),
            context: dispatchContext
          }),
          budget.deadlineMs,
          controller
        );
      }
    } finally {
      stopHeartbeat();
      clearTimeout(deadlineTimer);
    }
    return true;
  } catch (error) {
    const accessStatus = statusForAccessError(error);
    if (accessStatus === 401) {
      sendError(res, 401, "unauthorized", "认证等级不足");
      return true;
    }
    if (accessStatus === 403) {
      sendError(res, 403, "forbidden", "缺少所需站点权限");
      return true;
    }
    if (accessStatus === 503) {
      sendError(res, 503, "unavailable", "授权提供者不可用");
      return true;
    }
    const code = (error as { code?: string }).code;
    if (code === "unauthorized") {
      sendError(res, 401, "unauthorized", "认证等级不足");
      return true;
    }
    log({ event: "extension-http-handler-failed", status: 500, extensionId: mapping.extensionId, route, message: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) sendError(res, 500, "storage-failed", "插件 handler 执行失败");
    else if (!res.writableEnded) res.end();
    return true;
  } finally {
    req.off("close", onClose);
  }
}

/** 读取某公开映射 (extensionId, method, route) 声明的具名 action（无则 undefined）。 */
function publicRouteActions(
  deps: ApplicationExtensionApiDependencies,
  extensionId: string,
  route: string,
  method: ApplicationExtensionHttpMethod
): readonly AccessAction[] | undefined {
  const snapshot = deps.host?.snapshot() ?? [];
  for (const entry of snapshot) {
    if (entry.extensionId !== extensionId) continue;
    for (const http of entry.httpHandlers) {
      if (http.method !== method) continue;
      if (http.route === route || http.route.endsWith("/*")) return http.requiredActions;
    }
  }
  return undefined;
}

/** 读取某 (extensionId, method, route) 声明的最窄流预算（任务 2.5）。 */
function resolveStreamBudget(
  deps: ApplicationExtensionApiDependencies,
  extensionId: string,
  route: string,
  method: ApplicationExtensionHttpMethod
): Partial<import("@woohaa3/contracts").ApplicationExtensionStreamBudget> {
  const snapshot = deps.host?.snapshot() ?? [];
  for (const entry of snapshot) {
    if (entry.extensionId !== extensionId) continue;
    for (const http of entry.httpHandlers) {
      if (http.method === method && (http.route === route || http.route.endsWith("/*")) && http.streamBudget) {
        return http.streamBudget;
      }
    }
  }
  return {};
}

/** 是否声明为流式（SSE）路由（任务 2.5）。 */
function isStreamRoute(
  deps: ApplicationExtensionApiDependencies,
  extensionId: string,
  route: string,
  method: ApplicationExtensionHttpMethod
): boolean {
  const snapshot = deps.host?.snapshot() ?? [];
  for (const entry of snapshot) {
    if (entry.extensionId !== extensionId) continue;
    for (const http of entry.httpHandlers) {
      if (http.method === method && (http.route === route || http.route.endsWith("/*"))) return http.stream === true;
    }
  }
  return false;
}

/** 流式心跳：定期写 SSE 注释行，直到 deadline/关闭/结束（任务 2.5）。 */
function startHeartbeat(res: ServerResponse, budget: { heartbeatMs: number; deadlineMs: number; maxEvents: number }, controller: AbortController): () => void {
  let count = 0;
  const interval = setInterval(() => {
    if (res.writableEnded || controller.signal.aborted) return;
    count += 1;
    if (count > budget.maxEvents) {
      controller.abort();
      if (!res.writableEnded) res.end();
      return;
    }
    try {
      res.write(": heartbeat\n\n");
    } catch {
      /* 连接已断 */
    }
  }, budget.heartbeatMs);
  return () => clearInterval(interval);
}

/** 该公开请求对应的 registration 用途（用于 draining 准入判断）。 */
function purposeForPublicRoute(
  extensionId: string,
  route: string,
  method: ApplicationExtensionHttpMethod,
  deps: ApplicationExtensionApiDependencies
): ApplicationExtensionHandlerPurpose {
  const snapshot = deps.host?.snapshot() ?? [];
  const matches: ApplicationExtensionHandlerPurpose[] = [];
  for (const entry of snapshot) {
    if (entry.extensionId !== extensionId) continue;
    for (const http of entry.httpHandlers) {
      if (http.method !== method) continue;
      if (http.route === route) return http.purpose;
      if (http.route.endsWith("/*")) matches.push(http.purpose);
    }
  }
  return matches[0] ?? "read";
}

function buildHttpRequest(
  req: IncomingMessage,
  url: URL,
  auth: { principal?: PrincipalContext; sessionId?: string; actor?: string; accessControl?: boolean; dataScope?: DataScope },
  signal: AbortSignal
): ApplicationExtensionHttpRequest {
  return {
    method: (req.method ?? "GET").toUpperCase() as ApplicationExtensionHttpMethod,
    url: `${url.pathname}${url.search}`,
    headers: req.headers as Record<string, string | string[] | undefined>,
    readBody: (maxBytes) => readRawBody(req, maxBytes),
    signal,
    ...(auth.principal ? { principal: auth.principal } : {}),
    ...(auth.accessControl !== undefined ? { accessControl: auth.accessControl } : {}),
    ...(auth.dataScope ? { dataScope: auth.dataScope } : {}),
    ...(auth.sessionId ? { sessionId: auth.sessionId } : {}),
    ...(auth.actor ? { auditActor: auth.actor } : {})
  };
}

function buildHttpResponse(res: ServerResponse, signal: AbortSignal): ApplicationExtensionHttpResponse {
  return {
    setHeader: (name, value) => res.setHeader(name, value as never),
    writeHead: (status) => { res.statusCode = status; },
    write: (chunk) => { if (!res.writableEnded) res.write(chunk as never); },
    end: (chunk) => { if (!res.writableEnded) res.end(chunk as never); },
    get writableEnded() { return res.writableEnded || signal.aborted; },
    onClose: (listener) => { signal.addEventListener("abort", listener, { once: true }); }
  };
}

