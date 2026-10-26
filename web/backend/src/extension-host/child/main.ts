/**
 * Extension Host 子进程入口（change: 2026-10-21-isolate-extension-host-process，D2/D4）。
 *
 * 构建产物 `web/backend/dist/extension-host-child.js`；宿主 `fork` 时在环境里放
 * `WOOHAA3_EXTENSION_HOST_CHILD=1`，只有带该标记时本模块才自启（被测试 import 时不启动）。
 *
 * 启动顺序（任何一步失败都上报 `ctx.ready { ok: false }`，然后等宿主 `host.stop`，不自行退出）：
 * 1. `$/hello { protocol, sdkAbi, pid }` → 宿主回 `ExtensionHostStartParams`；
 * 2. 安装出网守卫（`capabilities.network`，`lockdown` 同时锁定 child_process / worker_threads / cluster）；
 * 3. `import(entry)`，按 `factory` 构造插件，校验 name；
 * 4. 在最小 Cordis Context 上 `ctx.plugin(plugin, values)`，完成后 `ctx.ready { ok: true }`；
 * 5. 健康：每 10 s 与每次 gateway 请求结束时上报 `ctx.health`（变化才发）并同步 Provider 快照。
 *
 * 入口 MUST NOT import 宿主业务代码：只依赖 contracts、RPC 运行时与出网守卫。
 */
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { Fiber } from "@deepseek-ai/cordis";
import {
  EXTENSION_HOST_LIMITS,
  EXTENSION_HOST_METHODS,
  EXTENSION_HOST_PROTOCOL_VERSION,
  EXTENSION_SDK_ABI_VERSION,
  type AnyHostExtensionPlugin,
  type ExtensionHostHealthSnapshot,
  type ExtensionHostStartParams
} from "@woohaa3/contracts";
import { connectIpc, toWireError, type IpcChannel, type RpcEndpoint } from "../rpc/index.js";
import { createChildRuntime, type ChildRuntime } from "./ctx.js";
import type { GatewayRequestParams } from "./gateway.js";
import { installNetworkGuard } from "./network-guard.js";
import { installProviderDispatch } from "./provider-dispatch.js";

export const EXTENSION_HOST_CHILD_ENV = "WOOHAA3_EXTENSION_HOST_CHILD";

export type ChildHostOptions = {
  channel: IpcChannel;
  /** 测试注入：缺省安装真实出网守卫与进程 API 锁定。 */
  installGuards?: (params: ExtensionHostStartParams, endpoint: RpcEndpoint) => void;
  /** 测试注入：缺省 `import(pathToFileURL(entry))`。 */
  importEntry?: (entry: string) => Promise<Record<string, unknown>>;
  /** 宿主停止后的退出动作；缺省 `process.exit(0)`。 */
  exit?: (code: number) => void;
  healthIntervalMs?: number;
};

export type ChildHost = {
  endpoint: RpcEndpoint;
  /** 启动流程（hello → apply → ready）完成。 */
  started: Promise<void>;
  runtime(): ChildRuntime | null;
};

function defaultGuards(params: ExtensionHostStartParams, endpoint: RpcEndpoint): void {
  installNetworkGuard({
    allowedHosts: params.capabilities.network,
    lockdown: true,
    onViolation: (violation) => {
      try {
        endpoint.notify(EXTENSION_HOST_METHODS.ctxDiagnostic, {
          code: "EXTENSION_NETWORK_DENIED",
          message: `出网被拒绝：${violation.host}`,
          host: violation.host,
          via: violation.via,
          reason: violation.reason
        });
      } catch {
        // 端点关闭。
      }
    }
  });
  // `lockdown: true` 已把 child_process / worker_threads / cluster 换成抛错桩（network-guard.ts）。
}

export function startChildHost(options: ChildHostOptions): ChildHost {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let runtime: ChildRuntime | null = null;
  let fiber: (Fiber & PromiseLike<Fiber>) | null = null;
  let plugin: AnyHostExtensionPlugin | null = null;
  let values: Record<string, string | number | boolean | undefined> = {};
  let lastHealth = "null";
  let healthTimer: ReturnType<typeof setInterval> | null = null;

  const endpoint = connectIpc(options.channel, {
    // 宿主帧异常：子进程无法自证清白，交给宿主心跳 / exit 判定；这里只尽力报告。
    onProtocolError: (error) => {
      try {
        endpoint.notify(EXTENSION_HOST_METHODS.ctxDiagnostic, { code: error.code, message: error.message });
      } catch {
        // 端点关闭。
      }
    }
  });

  endpoint.handle(EXTENSION_HOST_METHODS.ping, () => "pong");

  const reportHealth = () => {
    if (!plugin?.health || !fiber) return;
    let snapshot: ExtensionHostHealthSnapshot = null;
    try {
      const value = plugin.health(values);
      snapshot = value ? { state: "degraded", diagnostics: value.diagnostics.map((item) => ({ code: item.code, message: item.message })) } : null;
    } catch (error) {
      snapshot = { state: "degraded", diagnostics: [{ code: "health-failed", message: error instanceof Error ? error.message : String(error) }] };
    }
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastHealth) return;
    lastHealth = serialized;
    try {
      endpoint.notify(EXTENSION_HOST_METHODS.ctxHealth, snapshot);
    } catch {
      // 端点关闭。
    }
  };

  const tick = () => {
    reportHealth();
    runtime?.generation.sync();
  };

  endpoint.handle(EXTENSION_HOST_METHODS.gatewayRequest, (params, { signal }) => {
    if (!runtime) throw Object.assign(new Error("扩展尚未就绪"), { code: "extension-unavailable" });
    return runtime.gateway.handleRequest(params as GatewayRequestParams, signal);
  });

  endpoint.handle(EXTENSION_HOST_METHODS.hostStop, async () => {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = null;
    const current = fiber;
    fiber = null;
    try {
      await current?.dispose();
    } finally {
      // 先回应再退出：宿主等这条响应才算「主动停止」，不按崩溃处理。
      setTimeout(() => {
        endpoint.close("extension-unavailable", "子进程已停止");
        exit(0);
      }, 10);
    }
    return null;
  });

  const started = (async () => {
    const params = (await endpoint.request(
      EXTENSION_HOST_METHODS.hello,
      { protocol: EXTENSION_HOST_PROTOCOL_VERSION, sdkAbi: EXTENSION_SDK_ABI_VERSION, pid: process.pid },
      { timeoutMs: EXTENSION_HOST_LIMITS.requestTimeoutMs }
    )) as ExtensionHostStartParams;
    try {
      (options.installGuards ?? defaultGuards)(params, endpoint);
      const module = await (options.importEntry ?? ((entry: string) => import(pathToFileURL(entry).href)))(params.entry);
      const factory = module[params.factory];
      if (typeof factory !== "function") {
        throw Object.assign(new Error(`入口没有导出工厂函数：${params.factory}`), { code: "MARKETPLACE_PACKAGE_INVALID" });
      }
      const created = (factory as (options: unknown) => AnyHostExtensionPlugin)({});
      if (!created || typeof created.apply !== "function" || created.name !== params.capabilities.extensionId) {
        throw Object.assign(new Error(`工厂返回值不是扩展插件，或 name 与 extensionId 不一致`), { code: "MARKETPLACE_PACKAGE_INVALID" });
      }
      plugin = created;
      values = (params.values ?? {}) as typeof values;
      runtime = createChildRuntime(endpoint, params.capabilities);
      installProviderDispatch(endpoint, (providerId) => runtime?.generation.resolve(providerId));
      runtime.gateway.onRequestSettled(() => runtime?.generation.sync());
      fiber = runtime.ctx.plugin(created as never, values as never) as Fiber & PromiseLike<Fiber>;
      await fiber;
      endpoint.notify(EXTENSION_HOST_METHODS.ctxReady, { ok: true });
      reportHealth();
      // 首帧健康总要发一次，宿主据此结束「首次健康」检查（蓝绿切换的前提）。
      if (lastHealth === "null") endpoint.notify(EXTENSION_HOST_METHODS.ctxHealth, null);
      healthTimer = setInterval(tick, options.healthIntervalMs ?? EXTENSION_HOST_LIMITS.healthReportIntervalMs);
      (healthTimer as { unref?: () => void }).unref?.();
    } catch (error) {
      try {
        endpoint.notify(EXTENSION_HOST_METHODS.ctxReady, { ok: false, error: toWireError(error) });
      } catch {
        // 端点关闭。
      }
    }
  })();

  return { endpoint, started, runtime: () => runtime };
}

if (process.env[EXTENSION_HOST_CHILD_ENV] === "1" && typeof process.send === "function") {
  // 读完即删：扩展入口在之后才被 import，它看不到任何 WOOHAA3_* 环境变量。
  delete process.env[EXTENSION_HOST_CHILD_ENV];
  startChildHost({ channel: process as unknown as IpcChannel });
}
