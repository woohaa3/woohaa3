/**
 * 子进程里的 ctx（change: 2026-10-21-isolate-extension-host-process，D4）。
 *
 * 一个最小 Cordis `Context`：插件的 `ctx.effect` / `ctx.on` / `ctx.plugin` 语义保持；宿主服务按能力清单注入：
 *
 * | 面 | 注入 | 说明 |
 * | --- | --- | --- |
 * | log | 总是 | `ctx.log` 通知帧，宿主补 extension 字段 |
 * | generation | 总是（kind=provider） | register 上报可序列化部分，函数成员留在本地供 `provider.*` 回调 |
 * | gateway | 总是 | route 只登记处理器；宿主按 `capabilities.routePrefixes` 转发 |
 * | access | 总是 | gateway 请求内按真实 principal 让宿主做具名授权 |
 * | storage | 声明了 storageNamespaces 才注入 | bucket(ns) 限声明的 ns，register 一律拒绝 |
 * | marketplace / canvas / documents / mcp / 其他 | 不注入 | `ctx.get` 返回 undefined 并记诊断；访问属性 `permission-denied` |
 */
import { Context } from "@deepseek-ai/cordis";
import { EXTENSION_HOST_METHODS, type ExtensionHostCapabilities } from "@woohaa3/contracts";
import type { RpcEndpoint } from "../rpc/index.js";
import { RpcError } from "../rpc/index.js";
import { createChildGateway, type ChildGateway } from "./gateway.js";
import { createChildGeneration, type ChildGeneration } from "./generation.js";
import { createChildStorage } from "./storage.js";

/** 子进程从不提供的宿主服务：访问即 permission-denied。 */
const DENIED_SERVICES = ["marketplace", "canvas", "documents", "mcp", "task", "media", "application", "config", "telemetry", "toolGrants"] as const;

export type ChildRuntime = {
  ctx: Context;
  generation: ChildGeneration;
  gateway: ChildGateway;
};

export function permissionDenied(surface: string): RpcError {
  return new RpcError("permission-denied", `受管扩展未获授权使用 ${surface}`);
}

export function createChildRuntime(endpoint: RpcEndpoint, capabilities: ExtensionHostCapabilities): ChildRuntime {
  const ctx = new Context();
  const diagnostic = (code: string, message: string, extra: Record<string, unknown> = {}) => {
    try {
      endpoint.notify(EXTENSION_HOST_METHODS.ctxDiagnostic, { code, message, ...extra });
    } catch {
      // 端点关闭：子进程即将退出。
    }
  };

  ctx.provide("log", {
    scope: (module: string) => (event: Record<string, unknown>) => {
      try {
        endpoint.notify(EXTENSION_HOST_METHODS.ctxLog, { module, event });
      } catch {
        // 日志不能让插件崩溃。
      }
    }
  });

  const generation = createChildGeneration(endpoint);
  ctx.provide("generation", generation.service);

  const gateway = createChildGateway(endpoint, capabilities);
  ctx.provide("gateway", gateway.service);
  ctx.provide("access", gateway.access);

  if (capabilities.storageNamespaces.length > 0) {
    ctx.provide("storage", createChildStorage(endpoint, capabilities.storageNamespaces));
  }

  for (const name of DENIED_SERVICES) {
    Object.defineProperty(ctx, name, {
      configurable: true,
      get() {
        diagnostic("permission-denied", `访问未授权的宿主服务：${name}`, { service: name });
        throw permissionDenied(`ctx.${name}`);
      }
    });
  }

  // `ctx.get(name)` 对未注入服务返回 undefined（Cordis 原语义），额外记一次诊断便于作者排查。
  const reported = new Set<string>();
  const originalGet = ctx.get.bind(ctx);
  (ctx as unknown as { get: (name: string) => unknown }).get = (name: string) => {
    const value = originalGet(name as never);
    if (value === undefined && !reported.has(name)) {
      reported.add(name);
      diagnostic("service-unavailable", `受管扩展的子进程不提供宿主服务：${name}`, { service: name });
    }
    return value;
  };

  return { ctx, generation, gateway };
}
