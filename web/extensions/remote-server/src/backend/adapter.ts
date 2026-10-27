/**
 * 过渡适配：把统一形态的插件接到当前的 backend 装载口上。
 *
 * **这是迁移脚手架，不是设计**：`backend` 类插件最终会消失（只剩一种 extension plugin），
 * 到那时这个文件整体删除，`extension.json` 直接声明统一形态的工厂。
 *
 * 之所以放在宿主侧而不是插件内部：插件已经按 `apply(ctx, config)` 写完了，
 * 这里只做「把 host 包装成 ctx」的一次性翻译，插件代码不出现任何 host 概念。
 */
import type {
  ApplicationBackendExtensionDefinition,
  ApplicationBackendHost,
  HostExtensionContext
} from "@woohaa3/contracts";
import { REMOTE_SERVER_EXTENSION_ID, REMOTE_SERVER_METADATA } from "../shared.js";
import { createRemoteServerPlugin, type RemoteServerExtensionOptions } from "./index.js";

/** 把 backend 宿主适配成扩展看到的 ctx。 */
function contextOf(host: ApplicationBackendHost): HostExtensionContext {
  const noop = () => undefined;
  let effectSeq = 0;
  const ctx = {
    log: { scope: () => (event: Record<string, unknown>) => host.logger(event) },
    capabilities: {
      register: (id: string, value: unknown) => {
        host.registerCapability({ id, value } as never);
        return noop;
      }
    },
    generation: {
      register: (provider: never) => {
        host.registerGeneration?.(provider);
        return noop;
      },
      unregister: (providerId: string) => host.unregisterGeneration?.(providerId),
      list: () => [],
      resolve: () => undefined,
      conversions: () => [],
      registerConversion: () => noop
    },
    storage: {
      register: (backend: never) => {
        host.registerStorage?.(backend);
        return noop;
      },
      unregister: (backendId: string) => host.unregisterStorage?.(backendId)
    },
    marketplace: {
      register: (source: never) => {
        host.registerMarketplaceSource?.(source);
        return noop;
      },
      unregister: (sourceId: string) => host.unregisterMarketplaceSource?.(sourceId),
      list: () => [],
      resolve: () => undefined
    },
    services: host.services,
    webServer: {
      register: (registration: never) => host.registerHandler(registration),
      registerHttp: (registration: never) => host.registerHttpHandler?.(registration),
      registerRawHttp: (registration: never) => host.registerRawHttpHandler?.(registration)
    },
    ...(host.diagnostics ? { diagnostics: host.diagnostics } : {}),
    ...(host.deployment ? { deployment: host.deployment } : {}),
    // `ctx.effect` 的语义（装载即生效、卸载即撤销）由宿主资源生命周期承接：
    // 注册成一条 resource，start 时执行、stop 时撤销，定时器一类的东西不会在停用后泄漏。
    effect: (run: () => (() => void) | void) => {
      let undo: (() => void) | undefined;
      host.registerResource({
        id: `${REMOTE_SERVER_EXTENSION_ID}.effect-${effectSeq++}`,
        start() {
          const result = run();
          if (typeof result === "function") undo = result;
        },
        async stop() {
          undo?.();
          undo = undefined;
        }
      } as never);
    }
  };
  if (host.registerTelemetryExport) {
    (ctx as Record<string, unknown>).telemetryExport = {
      register: (exported: never) => {
        host.registerTelemetryExport?.(exported);
        return noop;
      }
    };
  }
  return ctx as never;
}

/**
 * 当前 `extension.json` 声明的工厂名（`backend.factory`）。
 *
 * 返回的 definition 只是统一插件的薄壳：`activate` 时构造 ctx 并调用 `apply`。
 */
export function createRemoteServerExtension(
  options: RemoteServerExtensionOptions = {}
): ApplicationBackendExtensionDefinition {
  return {
    extensionId: REMOTE_SERVER_EXTENSION_ID,
    capabilities: REMOTE_SERVER_METADATA.capabilities,
    async activate(host) {
      const plugin = createRemoteServerPlugin(options);
      await plugin.apply(contextOf(host), host.config.values() as never);
    }
  };
}
