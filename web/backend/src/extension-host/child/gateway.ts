/**
 * 子进程侧的 `ctx.gateway` / `ctx.access`（D4/D6）。
 *
 * 扩展用 `ctx.gateway.route(order, handler)` 登记**处理器**（没有前缀信息）。子进程把宿主授予的
 * `capabilities.routePrefixes` 逐条上报（`ctx.gateway.route { routeId, prefix }`），宿主只把命中这些前缀的
 * 请求转发进来。扩展也可以传第三参 `{ prefix, methods }` 显式声明前缀；不在授予范围内的前缀直接
 * `permission-denied`。
 *
 * `gateway.request` 到达时按 order 依次调处理器，第一个返回 true 的生效；全部 false → `{ handled: false }`
 * （宿主交给下游）。处理器内 `ctx.access.authenticator(req)` 返回宿主下发的 principal 摘要，
 * `accessEnforcer.assertAction` 经 `ctx.access.assertAction` 让宿主按该请求的真实身份授权。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { EXTENSION_HOST_METHODS, type ExtensionHostCapabilities } from "@woohaa3/contracts";
import { RpcError, type RpcEndpoint } from "../rpc/index.js";
import { createIncomingMessage, createServerResponse } from "./http-adapter.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;

export type GatewayRequestParams = {
  requestId: string;
  routeId: string;
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  principal?: unknown;
  bodyStreamId?: string;
};

export type ChildGateway = {
  service: {
    route(order: number, handler: Handler, declaration?: { prefix: string; methods?: readonly string[] }): () => void;
    upgrade(): () => void;
    readiness(): () => void;
  };
  access: {
    authenticator: (req: IncomingMessage) => Promise<unknown>;
    accessEnforcer: { assertAction: (principal: unknown, action: string) => Promise<void> };
  };
  /** 处理一次 gateway.request（由 main 挂到 RPC 处理器上）。 */
  handleRequest(params: GatewayRequestParams, signal: AbortSignal): Promise<Record<string, unknown>>;
  /** 每次请求结束后的回调（main 用来同步 Provider 快照）。 */
  onRequestSettled(listener: () => void): void;
};

const REQUEST_IDS = new WeakMap<object, { requestId: string; principal: unknown }>();

export function prefixAllowed(prefix: string, allowed: readonly string[]): boolean {
  return allowed.some((granted) => prefix === granted || (granted.endsWith("/") && prefix.startsWith(granted)));
}

export function createChildGateway(endpoint: RpcEndpoint, capabilities: ExtensionHostCapabilities): ChildGateway {
  const handlers: Array<{ order: number; seq: number; handler: Handler }> = [];
  const declared = new Set<string>();
  let seq = 0;
  let announced = false;
  const settledListeners: Array<() => void> = [];

  const announce = (prefix: string, methods?: readonly string[]) => {
    if (declared.has(prefix)) return;
    declared.add(prefix);
    endpoint.notify(EXTENSION_HOST_METHODS.ctxGatewayRoute, { routeId: prefix, prefix, ...(methods ? { methods: [...methods] } : {}) });
  };

  const service: ChildGateway["service"] = {
    route(order, handler, declaration) {
      if (declaration) {
        if (!prefixAllowed(declaration.prefix, capabilities.routePrefixes)) {
          throw new RpcError("permission-denied", `路由前缀未获授权：${declaration.prefix}`);
        }
        announce(declaration.prefix, declaration.methods);
      } else if (!announced) {
        announced = true;
        for (const prefix of capabilities.routePrefixes) announce(prefix);
      }
      const entry = { order, seq: seq++, handler };
      handlers.push(entry);
      handlers.sort((a, b) => a.order - b.order || a.seq - b.seq);
      return () => {
        const index = handlers.indexOf(entry);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    upgrade() {
      throw new RpcError("permission-denied", "受管扩展不能注册 WebSocket upgrade");
    },
    readiness() {
      throw new RpcError("permission-denied", "受管扩展不能注册宿主就绪检查");
    }
  };

  const access: ChildGateway["access"] = {
    authenticator: async (req) => REQUEST_IDS.get(req as object)?.principal ?? null,
    accessEnforcer: {
      assertAction: async (principal, action) => {
        // 只有宿主转发进来的请求才能授权：用请求 id 让宿主按真实 principal 判定，不信任子进程传来的 principal。
        const entry = [...activeRequests.values()].find((candidate) => candidate.principal === principal);
        if (!entry) throw new RpcError("permission-denied", "不在 gateway 请求上下文内，无法授权");
        await endpoint.request(EXTENSION_HOST_METHODS.ctxAccessAssert, { requestId: entry.requestId, action });
      }
    }
  };

  const activeRequests = new Map<string, { requestId: string; principal: unknown }>();

  const handleRequest: ChildGateway["handleRequest"] = async (params, signal) => {
    const body = params.bodyStreamId ? endpoint.streams.take(params.bodyStreamId).toReadable() : (await import("node:stream")).Readable.from([]);
    const req = createIncomingMessage({ method: params.method, url: params.url, headers: params.headers, body });
    // principal 用对象身份做键：扩展把 authenticator 的结果原样交回 assertAction。
    const principal = params.principal !== undefined && params.principal !== null ? { ...(params.principal as object) } : null;
    const context = { requestId: params.requestId, principal };
    REQUEST_IDS.set(req as object, context);
    if (principal) activeRequests.set(params.requestId, context);

    let head: { status: number; headers: Record<string, string | string[]> } | null = null;
    let resolveHead!: () => void;
    const headReady = new Promise<void>((resolve) => {
      resolveHead = resolve;
    });
    const responseStream = endpoint.streams.open("gateway.response", { requestId: params.requestId });
    const res = createServerResponse({
      onHead: (value) => {
        head = value;
        resolveHead();
      },
      write: (bytes) => responseStream.write(bytes),
      end: () => responseStream.end()
    });
    signal.addEventListener("abort", () => responseStream.abort("rpc-cancelled"), { once: true });

    try {
      let handled = false;
      for (const { handler } of [...handlers]) {
        if (await handler(req, res)) {
          handled = true;
          break;
        }
      }
      if (!handled) {
        responseStream.abort("not-handled");
        for (const listener of settledListeners) listener();
        return { handled: false };
      }
      // 处理器返回 true 但尚未输出：等它输出头（异步写入的处理器）。
      if (!head && !res.writableEnded) await headReady;
      if (!head) {
        res.end();
        await headReady;
      }
      const finalHead = head as unknown as { status: number; headers: Record<string, string | string[]> };
      return { handled: true, status: finalHead.status, headers: finalHead.headers, bodyStreamId: responseStream.streamId };
    } catch (error) {
      responseStream.abort("handler-error");
      throw error;
    } finally {
      activeRequests.delete(params.requestId);
      void (res as unknown as { finished: Promise<void> }).finished.then(() => {
        for (const listener of settledListeners) listener();
      });
    }
  };

  return {
    service,
    access,
    handleRequest,
    onRequestSettled: (listener) => settledListeners.push(listener)
  };
}
