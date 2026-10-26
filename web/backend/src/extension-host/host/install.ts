/**
 * 组合根接线（change: 2026-10-21-isolate-extension-host-process，任务 4.1/4.2）：在核心层之前创建
 * Extension Host 服务并 provide 为 `ctx.extensionHostIsolation`（Extension Manager 在核心层装载时即可取到）；
 * 返回代理插件交给扩展层装载器、gateway 转发处理器的注册函数与关闭函数。
 *
 * 核心层服务（generation / storage / application / extensionManager）在调用时按名现取（后绑定），
 * 所以这里可以早于核心层执行。没有 isolated 描述时什么都不做。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_SDK_ABI_VERSION, type AnyHostExtensionPlugin, type GenerationProvider, type HostGenerationService } from "@woohaa3/contracts";
import type { HostContext } from "../../host/context.js";
import type { IsolatedPluginDescriptor } from "./descriptor.js";
import { createExtensionHostManager } from "./manager.js";
import { createExtensionHostService, type ExtensionHostService } from "./service.js";
import { ROUTE_ORDER } from "../../host/order.js";

const DEFAULT_ACTIVATION_TIMEOUT_MS = 30_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 10_000;

function bounded(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 子进程入口：与宿主产物同目录（dist/ 或 server-dist/ 旁），可用环境变量覆盖。 */
export function resolveChildEntry(env: Record<string, string | undefined>): string {
  if (env.WOOHAA3_EXTENSION_HOST_CHILD_ENTRY) return path.resolve(env.WOOHAA3_EXTENSION_HOST_CHILD_ENTRY);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // 打包产物：dist/index.js 或 server-dist/index.js 旁（与 dist/extension-host-child.js 同包）。
    path.join(here, "extension-host-child.js"),
    path.resolve(here, "../dist/extension-host-child.js"),
    // 源码运行（vitest / tsx）：web/backend/src/extension-host/host/ → web/backend/dist/。
    path.resolve(here, "../../../dist/extension-host-child.js")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

/** 宿主 generation 注册表的后绑定视图（核心层装载后才存在）。 */
function lateGeneration(ctx: HostContext): HostGenerationService {
  const get = () => {
    const generation = ctx.get("generation");
    if (!generation) throw new Error("宿主 generation 扩展点尚未就绪");
    return generation;
  };
  return {
    register: (provider: GenerationProvider) => get().register(provider),
    unregister: (providerId: string) => get().unregister(providerId),
    registerConversion: (provider) => get().registerConversion(provider),
    list: () => get().list(),
    resolve: (providerId: string) => get().resolve(providerId),
    conversions: () => get().conversions()
  };
}

export type InstalledExtensionHost = {
  service: ExtensionHostService;
  plugins: readonly AnyHostExtensionPlugin[];
  /** 把每个扩展的 gateway 转发处理器挂到宿主 gateway（返回撤销函数）。 */
  mountRoutes(): () => void;
  close(): Promise<void>;
};

export function installExtensionHost(
  ctx: HostContext,
  input: {
    descriptors: readonly IsolatedPluginDescriptor[];
    env: Record<string, string | undefined>;
    /** 本次启动是否开启隔离（关闭时不 provide，Extension Manager 走受控重启）。 */
    enabled: boolean;
  }
): InstalledExtensionHost | null {
  // 没有受管后端扩展时也要 provide：首次安装要靠它热装（任务 8.4）。
  if (!input.enabled) return null;
  const log = ctx.log.scope("extension-host");
  const setting = <T>(key: string): T | undefined => ctx.get("config")?.get(key as never) as T | undefined;
  const manager = createExtensionHostManager({
    childEntry: resolveChildEntry(input.env),
    log,
    sdkAbi: EXTENSION_SDK_ABI_VERSION,
    baseEnv: input.env as NodeJS.ProcessEnv,
    settings: () => ({
      maxOldSpaceMb: bounded(setting("extensions.host.maxOldSpaceMb"), 256),
      maxProcesses: bounded(setting("extensions.host.maxProcesses"), 16)
    })
  });
  const service = createExtensionHostService({
    descriptors: input.descriptors,
    manager,
    generation: lateGeneration(ctx),
    get storage() {
      return ctx.get("storage");
    },
    log,
    activationTimeoutMs: () => bounded(setting("extensions.activationTimeoutMs"), DEFAULT_ACTIVATION_TIMEOUT_MS),
    disposeTimeoutMs: () => bounded(setting("extensions.disposeTimeoutMs"), DEFAULT_DISPOSE_TIMEOUT_MS),
    drainTimeoutMs: () => bounded(setting("extensions.host.drainTimeoutMs"), 600_000),
    authenticate: async (req) => {
      const access = ctx.get("access");
      if (!access || access.accessEnforcer.runtime?.enabled === false) return null;
      return (await access.authenticator(req, "http")) ?? null;
    },
    assertAction: async (principal, action) => {
      const access = ctx.get("access");
      if (!access) throw new Error("访问控制不可用");
      await access.accessEnforcer.assertAction(principal, action);
    },
    onObservationCrash: () => {
      const manager = ctx.get("extensionManager") as { handleObservationCrash?: (id: string) => Promise<boolean> } | undefined;
      return manager?.handleObservationCrash ? (extensionId) => manager.handleObservationCrash!(extensionId) : undefined;
    },
    // 转发处理器只认自己的前缀，统一排在 application 宽前缀之前（插件声明的 order 只决定扩展层装载顺序）。
    mountRoute: (entry) => ctx.get("gateway")?.route(ROUTE_ORDER.extensionHostForward, (req, res) => entry.forwarder.handle(req, res)) ?? (() => undefined),
    onQuarantine: (extensionId, diagnostic) => controlPlane(ctx)?.quarantine(extensionId, diagnostic),
    onUnquarantine: (extensionId, actor) => controlPlane(ctx)?.unquarantine(extensionId, actor)
  });
  ctx.provide("extensionHostIsolation", service);
  const entries = service.plugins();
  return {
    service,
    plugins: entries.map((entry) => entry.plugin),
    mountRoutes() {
      const gateway = ctx.get("gateway");
      if (!gateway) return () => undefined;
      const unroutes = entries.map((entry) => gateway.route(ROUTE_ORDER.extensionHostForward, (req, res) => entry.forwarder.handle(req, res)));
      return () => {
        for (const unroute of unroutes) unroute();
      };
    },
    close: () => service.stopAll()
  };
}

/** 站点控制面（application-service 的 `plugins()`）：隔离投影、审计与重新协调都在那里。 */
function controlPlane(ctx: HostContext) {
  return ctx.get("application")?.service.plugins();
}