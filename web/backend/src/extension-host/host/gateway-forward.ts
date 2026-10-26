/**
 * Gateway 转发（change: 2026-10-21-isolate-extension-host-process，D6，任务 4.4）。
 *
 * 代理插件向宿主 gateway 注册**一个**处理器。请求路径命中子进程登记的前缀（且方法允许）时：
 * 1. 去掉 `cookie` / `authorization` 等凭据头，附上宿主解析出的 principal 摘要；
 * 2. 请求体以流帧（`gateway.body`）发给子进程，响应头与响应体（`gateway.response`）流回；
 * 3. 子进程回 `{ handled: false }` 时交还下游（与进程内处理器返回 false 等价）。
 *
 * 实例不可用（启动中、崩溃、隔离）时：命中的请求返回 `503 { code: "extension-unavailable", extensionId }`，
 * 未命中原样交给下游。子进程里的 `ctx.access.assertAction` 通过 requestId 回到这里，用**真实** principal 鉴权。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  EXTENSION_HOST_METHODS,
  type AccessAction,
  type ExtensionHostRouteRegistration,
  type PrincipalContext
} from "@woohaa3/contracts";
import { RpcError, type RpcEndpoint } from "../rpc/index.js";

/** 不转发给子进程的请求头（凭据与逐跳头）。 */
const STRIPPED_REQUEST_HEADERS = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
  "x-woohaa3-trusted-ingress",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade"
]);
/** 子进程不得设置的响应头。 */
const STRIPPED_RESPONSE_HEADERS = new Set(["set-cookie", "connection", "transfer-encoding", "keep-alive"]);

export type PrincipalSummary = { subject: string; displayName?: string; identityProvider: string } | null;

export type GatewayForwardOptions = {
  extensionId: string;
  /** 当前服务该扩展的实例（蓝绿切换原子替换；不可用为 null）。 */
  target: () => RpcEndpoint | null;
  /** 宿主认证（与 settings/admin API 同一入口）；缺省不认证（principal 为 null）。 */
  authenticate?: (req: IncomingMessage) => Promise<PrincipalContext | null>;
  /** 宿主授权执行边界。 */
  assertAction?: (principal: PrincipalContext | null, action: AccessAction) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
  /**
   * 保底前缀（宿主授予的路由前缀）：没有活跃实例（启动中 / 崩溃 / 隔离 / 停用）时，命中这些前缀
   * 返回 503 而不是落到下游，调用方能区分「扩展暂不可用」与「路径不存在」。
   */
  reservedPrefixes?: readonly string[];
};

export type GatewayForwarder = {
  /** 注册到宿主 gateway 的处理器。 */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** 子进程登记 / 撤销路由。 */
  addRoute(route: ExtensionHostRouteRegistration): void;
  removeRoute(routeId: string): void;
  /** 实例换代（崩溃 / 蓝绿）时把路由表重置为保底前缀，由新实例重新登记。 */
  clearRoutes(): void;
  routes(): readonly ExtensionHostRouteRegistration[];
  /** 子进程 `ctx.access.assertAction` 的宿主处理器（按 requestId 找到真实 principal）。 */
  assertForRequest(params: unknown): Promise<null>;
};

function matches(route: ExtensionHostRouteRegistration, pathname: string, method: string): boolean {
  const prefix = route.prefix.replace(/\/+$/, "");
  const hit = pathname === prefix || pathname.startsWith(`${prefix}/`) || (route.prefix.endsWith("/") && pathname.startsWith(route.prefix));
  if (!hit) return false;
  return !route.methods || route.methods.length === 0 || route.methods.includes(method);
}

function summarize(principal: PrincipalContext | null): PrincipalSummary {
  if (!principal) return null;
  return {
    subject: principal.subject,
    identityProvider: principal.identityProvider,
    ...(principal.displayName ? { displayName: principal.displayName } : {})
  };
}

function filterRequestHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

function sendUnavailable(res: ServerResponse, extensionId: string): void {
  const body = JSON.stringify({ code: "extension-unavailable", extensionId, message: "扩展当前不可用，请稍后重试" });
  res.statusCode = 503;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(Buffer.byteLength(body)));
  res.end(body);
}

export function createGatewayForwarder(options: GatewayForwardOptions): GatewayForwarder {
  const log = options.log ?? (() => undefined);
  const table = new Map<string, ExtensionHostRouteRegistration>();
  const reserved = (options.reservedPrefixes ?? []).map((prefix) => ({ routeId: `reserved:${prefix}`, prefix }));
  /** 在途请求：requestId → principal（供子进程回调鉴权）。 */
  const inflight = new Map<string, PrincipalContext | null>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = (req.method ?? "GET").toUpperCase();
    const route = [...table.values()].find((candidate) => matches(candidate, url.pathname, method));
    const endpoint = options.target();
    if (!endpoint || endpoint.closed) {
      // 实例不可用：子进程登记过的或宿主授予的前缀都回 503。
      if (route || reserved.some((candidate) => matches(candidate, url.pathname, method))) {
        sendUnavailable(res, options.extensionId);
        return true;
      }
      return false;
    }
    if (!route) return false;
    const principal = options.authenticate ? await options.authenticate(req).catch(() => null) : null;
    const requestId = randomUUID();
    inflight.set(requestId, principal);
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.once("close", onClose);
    try {
      const hasBody = method !== "GET" && method !== "HEAD";
      const body = hasBody ? endpoint.streams.open("gateway.body", { requestId }) : null;
      const pending = endpoint.request<{
        handled: boolean;
        status?: number;
        headers?: Record<string, string | string[]>;
        bodyStreamId?: string;
      }>(
        EXTENSION_HOST_METHODS.gatewayRequest,
        {
          requestId,
          routeId: route.routeId,
          method,
          url: `${url.pathname}${url.search}`,
          headers: filterRequestHeaders(req.headers),
          principal: summarize(principal),
          ...(body ? { bodyStreamId: body.streamId } : {})
        },
        { signal: abort.signal, timeoutMs: 0 }
      );
      if (body) void body.pipeFrom(req as AsyncIterable<Uint8Array>).catch(() => undefined);
      const reply = await pending;
      if (!reply.handled) return false;
      res.statusCode = reply.status ?? 200;
      for (const [name, value] of Object.entries(reply.headers ?? {})) {
        if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) res.setHeader(name, value);
      }
      if (reply.bodyStreamId) {
        const incoming = endpoint.streams.take(reply.bodyStreamId);
        try {
          for await (const chunk of incoming) {
            if (!res.write(chunk)) await new Promise<void>((resolve) => res.once("drain", resolve));
          }
        } catch (error) {
          // 响应已开始：只能断开连接，不能再改状态码。
          log({ event: "extension-gateway-stream-failed", extension: options.extensionId, message: error instanceof Error ? error.message : String(error) });
          res.destroy();
          return true;
        }
      }
      res.end();
      return true;
    } catch (error) {
      const code = error instanceof RpcError ? error.code : "internal-error";
      log({ event: "extension-gateway-forward-failed", extension: options.extensionId, code, message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        if (code === "extension-crashed" || code === "extension-unavailable" || code === "extension-replaced") sendUnavailable(res, options.extensionId);
        else {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ code: "extension-gateway-failed", extensionId: options.extensionId }));
        }
      } else {
        res.destroy();
      }
      return true;
    } finally {
      res.off("close", onClose);
      inflight.delete(requestId);
    }
  };

  return {
    handle,
    addRoute(route) {
      table.set(route.routeId, route);
    },
    removeRoute(routeId) {
      table.delete(routeId);
    },
    clearRoutes() {
      table.clear();
    },
    routes: () => [...table.values()],
    async assertForRequest(params) {
      const { requestId, action } = (params ?? {}) as { requestId?: unknown; action?: unknown };
      if (typeof requestId !== "string" || !inflight.has(requestId)) {
        throw new RpcError("permission-denied", "鉴权请求不属于在途的 gateway 请求");
      }
      if (typeof action !== "string") throw new RpcError("permission-denied", "缺少 action");
      if (!options.assertAction) throw new RpcError("permission-denied", "宿主未提供授权执行边界");
      try {
        await options.assertAction(inflight.get(requestId) ?? null, action as AccessAction);
      } catch (error) {
        throw new RpcError("permission-denied", error instanceof Error ? error.message : "无权限");
      }
      return null;
    }
  };
}
