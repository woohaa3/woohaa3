/**
 * Application extension activation and owner-scoped contributions.
 * Authentication stays in the host; extensions contribute capabilities and bounded handlers.
 * Failed activation and unload release resources in reverse order.
 */
import { installMediaFormatRegistration } from "./host-media-formats.js";
import type {
  ApplicationBackendActivation,
  ApplicationBackendConfigFacade,
  ApplicationBackendExtensionDefinition,
  ApplicationBackendHost,
  ApplicationBackendWorkFacade
} from "./contract.js";
import type { ApplicationExtensionHostIdentity } from "@woohaa3/contracts";
import {
  EMPTY_CONFIG_FACADE,
  ExtensionHostError,
  REJECTING_SERVICES,
  REJECTING_WORK_FACADE,
  httpHandlerKey,
  toSummary,
  type ApplicationExtensionHostOptions,
  type ExtensionActivationHandle,
  type ExtensionActivationResult,
  type ExtensionDispatchContext,
  type ExtensionRegistrationSummary,
  type OwnerState,
  type PluginRegistrationSurface,
  type ExtensionRecord
} from "./host-types.js";
import {
  dispatchHttp,
  dispatchHandler,
  dispatchRawHttp,
  resolvePublicRoute,
  type HostRegistryContext
} from "./host-dispatch.js";

export { ExtensionHostError } from "./host-types.js";
export type {
  ExtensionHostErrorCode,
  ExtensionRegistrationSummary,
  ExtensionActivationHandle,
  ExtensionActivationResult,
  ExtensionDispatchContext,
  ApplicationExtensionHostOptions
} from "./host-types.js";

export type ApplicationExtensionHost = {
  declaredPublicRoutes?: () => readonly import("@woohaa3/contracts").ApplicationExtensionPublicRouteMapping[];
  activate: (definition: ApplicationBackendExtensionDefinition) => Promise<ExtensionActivationResult>;
  activateVersioned: (
    definition: ApplicationBackendExtensionDefinition,
    configVersion: number,
    mode: "public" | "recovery"
  ) => Promise<ExtensionActivationResult>;
  activateManifest: (
    definitions: readonly ApplicationBackendExtensionDefinition[]
  ) => Promise<Array<{ extensionId: string; result: ExtensionActivationResult }>>;
  /**
   * 按 `id` + `version` 解析能力对象。
   *
   * 版本是能力身份的一部分（change: 2026-11-13-add-extension-capability-abi）：同一 id 的不同
   * 版本并存，调用方拿自己需要的那个；拿不到返回 undefined，由调用方决定降级还是报错。
   */
  resolveCapability: (id: string, version: number) => unknown;
  hasCapability: (id: string, version: number) => boolean;
  /**
   * 解析 capability 的当前 owner（extensionId/configVersion/mode）；不存在返回 null。
   *
   * 供受控来源注册表等宿主级调用方在每次调用时校验 owner 与配置版本，避免裸缓存
   * `resolveCapability()` 绕过停用/升级检查（change: 2026-10-12-add-extension-online-canvas-migration）。
   */
  resolveCapabilityOwner: (id: string, version: number) => { extensionId: string; configVersion: number; mode: "public" | "recovery" } | null;
  dispatch: (
    route: string,
    input: { body: unknown; context: ExtensionDispatchContext; extensionId?: string }
  ) => Promise<import("./contract.js").ApplicationExtensionHandlerResult>;
  dispatchHttp: (input: {
    /** 扩展 identity：注册键按 `<extensionId>/<route>` 命名空间隔离，分派须同源。 */
    extensionId: string;
    method: import("./contract.js").ApplicationExtensionHttpMethod;
    route: string;
    req: import("./contract.js").ApplicationExtensionHttpRequest;
    res: import("./contract.js").ApplicationExtensionHttpResponse;
    context: ExtensionDispatchContext;
  }) => Promise<{ registration: import("./contract.js").ApplicationBackendHttpHandlerRegistration } | undefined>;
  dispatchRawHttp: (input: {
    /** 扩展 identity：同上。 */
    extensionId: string;
    method: import("./contract.js").ApplicationExtensionHttpMethod;
    route: string;
    req: import("./contract.js").ApplicationExtensionRawRequest;
    res: import("./contract.js").ApplicationExtensionRawResponse;
    context: ExtensionDispatchContext;
  }) => Promise<{ registration: import("./contract.js").ApplicationBackendRawHttpHandlerRegistration } | undefined>;
  /** 按扩展 identity 取受控 HTTP 注册面（`ctx.webServer` 的宿主实现）。 */
  pluginContextFor: (extensionId: string) => PluginRegistrationSurface;
  /** 公开挂载路径（`deployment.basePath`）；装载器用它拼 `ctx.deployment`。 */
  basePath: string;
  resolvePublicRoute: (
    extensionId: string,
    route: string,
    method: import("./contract.js").ApplicationExtensionHttpMethod
  ) => { owned: boolean };
  snapshot: () => Array<{ extensionId: string } & ExtensionRegistrationSummary>;
  disposeExtension: (extensionId: string, reason?: import("@woohaa3/contracts").ApplicationDisposeReason) => Promise<void>;
  disposeVersion: (extensionId: string, configVersion: number, reason?: import("@woohaa3/contracts").ApplicationDisposeReason) => Promise<void>;
  activeVersions: (extensionId: string) => number[];
  dispose: () => Promise<void>;
};

export type { PluginRegistrationSurface } from "./host-types.js";

/**
 * 公开命名空间下的 capability 键：`id@version`。
 *
 * 解析侧（`resolveCapability` / `hasCapability` / `resolveCapabilityOwner`）只走公开键，
 * recovery 实例贡献的能力不外泄（与 `activate()` 内 `capabilityKey` 的 public 分支一致）。
 */
function publicCapabilityKey(id: string, version: number): string {
  return `${id}@${version}`;
}

export function createApplicationExtensionHost(options: ApplicationExtensionHostOptions = {}): ApplicationExtensionHost {
  const log = options.logger ?? (() => undefined);
  /**
   * **唯一的注册表**。
   *
   * 键：非版本化装载是 `<extensionId>`，版本化实例是 `<extensionId>::<configVersion>`。
   * backend 激活与 Cordis 装载写入同一张表——「怎么装起来的」不是记录的属性，
   * 记录只回答「这个扩展注册了什么」。
   */
  const records = new Map<string, ExtensionRecord>();
  const publicRouteDeclarations = new Map<string, readonly import("@woohaa3/contracts").ApplicationExtensionPublicRouteMapping[]>();

  /** 新建一条空记录：非版本化装载的生命周期字段全为空，语义是「没挂任何东西」。 */
  const newRecord = (extensionId: string): ExtensionRecord => ({
    extensionId,
    handlers: new Map(),
    httpHandlers: new Map(),
    rawHttpHandlers: new Map(),
    capabilities: new Map(),
    resources: new Map(),
    startedResources: [],
    generationProviderIds: [],
    storageBackendIds: [],
    exposerIds: [],
    telemetryExportIds: [],
    marketplaceSourceIds: [],
    order: 0
  });
  const globalCapabilities = new Map<string, string>();
  const pluginMediaFormats = new Map<string, Set<() => void>>();
  const globalHandlers = new Map<string, string>();
  const globalHttpHandlers = new Map<string, string>();
  const globalRawHttpHandlers = new Map<string, string>();
  let orderCounter = 0;
  let disposed = false;

  const registry: HostRegistryContext = {
    records,
    globalHandlers,
    globalHttpHandlers,
    globalRawHttpHandlers,
    log
  };

  const keyFor = (extensionId: string, configVersion: number): string => `${extensionId}::${configVersion}`;
  const publicKeyFor = (extensionId: string): string | undefined => {
    for (const [key, owner] of records) {
      if (owner.extensionId === extensionId && owner.mode === "public") return key;
    }
    return undefined;
  };

  /** 反序释放一次 activation 的贡献（幂等；容忍重复调用）。 */
  const rollback = async (owner: OwnerState, handle: string, reason: import("@woohaa3/contracts").ApplicationDisposeReason = "disable"): Promise<void> => {
    publicRouteDeclarations.delete(handle);
    for (const providerId of [...owner.generationProviderIds].reverse()) {
      owner.releaseGeneration?.(providerId);
    }
    owner.generationProviderIds = [];
    for (const resource of [...owner.startedResources].reverse()) {
      await Promise.resolve(resource.stop(reason)).catch((error) =>
        log({ event: "extension-resource-stop-failed", extensionId: owner.extensionId, message: String(error) })
      );
    }
    owner.startedResources = [];
    // 存储后端在资源 stop 之后才收回：扩展自己的资源在 stop 时可能还要读写字节，
    // 提前注销会让收尾路径撞上「主存储后端未注册」。注销本身按 backendId 幂等。
    for (const backendId of [...owner.storageBackendIds].reverse()) {
      owner.releaseStorage?.(backendId);
    }
    owner.storageBackendIds = [];
    // 遥测出口紧随其后收回：出口里通常带着自己的队列与在途请求，先让它停、再收回注册，
    // 顺序与存储相反（存储是"资源停完才注销"，出口是"先注销再让资源停"都不出错，
    // 这里跟着存储走同一段收尾，避免两处先后不一致）。
    for (const exportId of [...owner.telemetryExportIds].reverse()) {
      owner.releaseTelemetryExport?.(exportId);
    }
    owner.telemetryExportIds = [];
    // 市场来源同样随 activation 收回：来源带着会话，停用后不能还留在 `ctx.marketplace` 里。
    for (const sourceId of [...owner.marketplaceSourceIds].reverse()) {
      owner.releaseMarketplaceSource?.(sourceId);
    }
    owner.marketplaceSourceIds = [];
    for (const [route] of [...owner.handlers].reverse()) {
      if (globalHandlers.get(route) === handle) globalHandlers.delete(route);
    }
    owner.handlers.clear();
    for (const [key] of [...owner.httpHandlers].reverse()) {
      if (globalHttpHandlers.get(key) === handle) globalHttpHandlers.delete(key);
    }
    owner.httpHandlers.clear();
    for (const [key] of [...owner.rawHttpHandlers].reverse()) {
      if (globalRawHttpHandlers.get(key) === handle) globalRawHttpHandlers.delete(key);
    }
    owner.rawHttpHandlers.clear();
    for (const [id] of [...owner.capabilities].reverse()) {
      if (globalCapabilities.get(id) === handle) globalCapabilities.delete(id);
    }
    owner.capabilities.clear();
    owner.resources.clear();
    const activation = owner.activation;
    owner.activation = undefined;
    if (activation?.dispose) {
      await Promise.resolve(activation.dispose()).catch((error) =>
        log({ event: "extension-activation-dispose-failed", extensionId: owner.extensionId, message: String(error) })
      );
    }
    // 基础提供者随 activation 释放：provider registry 不保留已回滚 owner 的登记。
    owner.releaseProviders?.();
    try {
      options.onExtensionReleased?.(owner.extensionId);
    } catch (error) {
      log({ event: "extension-release-hook-failed", extensionId: owner.extensionId, message: String(error) });
    }
  };

  /**
   * `requiredDependencies` 是**准入**判定（change: 2026-10-12），声明的是「这个 capability id 必须
   * 已被某个扩展提供」，不关心形状版本——版本相容性由 `engines.capabilities`
   * （change: 2026-11-13-add-extension-capability-abi）在装载期判定。
   *
   * 因此这里按「去掉末尾 `@version` 后的 id」比对。不能按裸 id 精确查表——注册键自 capability
   * 带版本后已变成 `id@version`（recovery 模式还带命名空间前缀）。
   */
  const resolveDependencies = (
    definition: ApplicationBackendExtensionDefinition
  ): { ok: true } | { ok: false; missing: string[] } => {
    const missing: string[] = [];
    const registeredIds = new Set<string>();
    for (const key of globalCapabilities.keys()) {
      const at = key.lastIndexOf("@");
      // 只剥末尾版本段；recovery 键形如 `_recovery/<ext>/<ver>/<id>@<version>`，剥完仍是带前缀的 id，
      // 而那些贡献本来就不该满足公开依赖，所以同时要求「剥完的 id 不以 `_recovery/` 开头」。
      const id = at > 0 ? key.slice(0, at) : key;
      if (!id.startsWith("_recovery/")) registeredIds.add(id);
    }
    for (const dependency of definition.requiredDependencies ?? []) {
      if (!registeredIds.has(dependency)) missing.push(dependency);
    }
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
  };

    /**
     * 公开映射的 HTTP / raw HTTP 路由不能自带扩展名前缀。
     *
     * 注册键由宿主拼 `<extensionId>/<route>`，而分派端拿的是 publicPath 之后的**相对**
     * 子路径；自带前缀的注册永远查不到，对外只剩 404（2026-10 回归：local-agent /
     * sdk-agent；另有扩展也有两处）。这里只记诊断、不拒绝：预构建或第三方扩展
     * 可能沿用旧写法，把「一条路由不可达」升级成「整个扩展起不来」不划算——硬门槛放在
     * CI（web/tooling/extension-route-namespace.test.ts）。
     *
     * JSON handler 不走这条规则：它的公开 URL 原样携带声明的 route，前后一致。
     */
    const reportNamespacedRoute = (target: ExtensionRecord, route: string, kind: "http" | "raw-http"): void => {
      const prefix = `${target.extensionId}/`;
      if (!route.startsWith(prefix)) return;
      log({
        event: "extension-route-namespace-mismatch",
        extensionId: target.extensionId,
        kind,
        route,
        message: `路由自带扩展名前缀，分派端按相对 route 查不到；去掉 "${prefix}"`
      });
    };

    /**
     * 按 owner 注册三类 handler。
     *
     * `activate` 与 `webServerFor` 共用同一份实现：通过 `ctx.webServer` 注册的路由
     * 与插件在 `activate` 里注册的完全等价（同一张全局表、同一套冲突检查）。
     */
    const registerInto = (
      target: ExtensionRecord,
      handle: string,
      /** 路由 → 全局键（按 extensionId 命名空间隔离；recovery 实例另加命名空间）。 */
      keyOf: (route: string) => string
    ): import("@woohaa3/contracts").HostWebServerService => ({
      register(registration) {
        if (typeof registration.route !== "string" || registration.route === "" || registration.route.startsWith("/")) {
          throw new ExtensionHostError("duplicate-handler", "handler route 必须是非空相对路由");
        }
        const route = keyOf(registration.route);
        if (globalHandlers.has(route)) {
          throw new ExtensionHostError("duplicate-handler", `handler route 已注册：${registration.route}`);
        }
        globalHandlers.set(route, handle);
        target.handlers.set(route, registration);
      },
      registerHttp(registration) {
        if (typeof registration.route !== "string" || registration.route === "" || registration.route.startsWith("/")) {
          throw new ExtensionHostError("duplicate-handler", "HTTP handler route 必须是非空相对路由");
        }
        reportNamespacedRoute(target, registration.route, "http");
        const route = keyOf(registration.route);
        const key = httpHandlerKey(registration.method, route);
        if (globalHttpHandlers.has(key) || globalRawHttpHandlers.has(key)) {
          throw new ExtensionHostError("duplicate-handler", `HTTP handler 已注册：${registration.method} ${registration.route}`);
        }
        globalHttpHandlers.set(key, handle);
        target.httpHandlers.set(key, registration);
      },
      registerRawHttp(registration) {
        if (typeof registration.route !== "string" || registration.route === "" || registration.route.startsWith("/")) {
          throw new ExtensionHostError("duplicate-handler", "原始 HTTP handler route 必须是非空相对路由");
        }
        reportNamespacedRoute(target, registration.route, "raw-http");
        const route = keyOf(registration.route);
        const key = httpHandlerKey(registration.method, route);
        if (globalHttpHandlers.has(key) || globalRawHttpHandlers.has(key)) {
          throw new ExtensionHostError("duplicate-handler", `HTTP handler 已注册：${registration.method} ${registration.route}`);
        }
        globalRawHttpHandlers.set(key, handle);
        target.rawHttpHandlers.set(key, registration);
      }
    });


  const activateInternal = async (
    definition: ApplicationBackendExtensionDefinition,
    configVersion: number,
    mode: "public" | "recovery",
    options2: { allowExistingPublic: boolean }
  ): Promise<ExtensionActivationResult> => {
    if (disposed) return { ok: false, code: "activation-failed", message: "宿主已释放" };
    const key = keyFor(definition.extensionId, configVersion);
    if (records.has(key)) {
      return { ok: false, code: "activation-failed", message: `插件 ${definition.extensionId}@${configVersion} 已激活` };
    }
    if (mode === "public") {
      const existingPublic = publicKeyFor(definition.extensionId);
      if (existingPublic && !options2.allowExistingPublic) {
        return { ok: false, code: "activation-failed", message: `插件 ${definition.extensionId} 已有活动的公共实例` };
      }
      if (existingPublic) {
        const existingOwner = records.get(existingPublic)!;
        await rollback(existingOwner, existingPublic);
        records.delete(existingPublic);
      }
    }
    const dependencies = resolveDependencies(definition);
    if (!dependencies.ok) {
      log({ event: "extension-activation-missing-deps", extensionId: definition.extensionId, missing: dependencies.missing });
      return {
        ok: false,
        code: "activation-failed",
        message: `缺少必需依赖：${dependencies.missing.join("、")}`,
        missingDependencies: dependencies.missing
      };
    }

    const owner: OwnerState = {
      extensionId: definition.extensionId,
      configVersion,
      mode,
      capabilities: new Map(),
      handlers: new Map(),
      httpHandlers: new Map(),
      rawHttpHandlers: new Map(),
      resources: new Map(),
      startedResources: [],
      generationProviderIds: [],
      storageBackendIds: [],
      exposerIds: [],
      telemetryExportIds: [],
      marketplaceSourceIds: [],
      order: ++orderCounter
    };
    records.set(key, owner);
    const handle = key;

    // recovery 实例贡献隔离到恢复命名空间：不能成为公共新工作入口（design D6）。
    const capabilityKey = (id: string, version: number) =>
      `${mode === "public" ? id : `_recovery/${definition.extensionId}/${configVersion}/${id}`}@${version}`;
    /**
     * 所有 handler 路由都按 extensionId 命名空间隔离（JSON / HTTP / raw HTTP 统一）。
     *
     * 公开 URL 形如 `/api/extensions/<extensionId>/handlers/<route>`（JSON）与
     * `/api/extensions/<extensionId>/http/<route>`（HTTP/raw）；扩展只声明相对 route，
     * 前缀由宿主添加，插件无法绕过——否则任意扩展都能占用根路径（如 `login`）。
     */
    const handlerKey = (route: string) =>
      mode === "public" ? `${definition.extensionId}/${route}` : `_recovery/${definition.extensionId}/${configVersion}/${route}`;

    const configFacade: ApplicationBackendConfigFacade = options.configFacadeFor?.(definition.extensionId) ?? EMPTY_CONFIG_FACADE;
    const workFacade: ApplicationBackendWorkFacade = options.workFacadeFor?.(definition.extensionId) ?? REJECTING_WORK_FACADE;
    const services = options.servicesFor?.(definition.extensionId, configVersion) ?? REJECTING_SERVICES;
    const hostIdentity: ApplicationExtensionHostIdentity = options.hostIdentity ?? "application";

    const fail = async (error: ExtensionHostError): Promise<ExtensionActivationResult> => {
      await rollback(owner, handle);
      records.delete(key);
      log({ event: "extension-activation-rolled-back", extensionId: definition.extensionId, code: error.code });
      return { ok: false, code: error.code, message: error.message };
    };

    const host: ApplicationBackendHost = {
      extensionId: definition.extensionId,
      host: hostIdentity,
      ...(options.deployment ? { deployment: options.deployment } : {}),
      ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
      config: configFacade,
      work: workFacade,
      services,
      logger: (event: Record<string, unknown>) => log({ extensionId: definition.extensionId, ...event }),
      registerCapability: (registration) => {
        if (typeof registration.id !== "string" || registration.id === "") {
          throw new ExtensionHostError("duplicate-capability", "capability id 必须是非空字符串");
        }
        if (!Number.isInteger(registration.version) || registration.version < 1) {
          throw new ExtensionHostError("duplicate-capability", `capability version 必须是正整数：${String(registration.version)}`);
        }
        // 键含版本：同 id 的不同版本并存，提供一个新形状不会静默顶掉旧的。
        const id = capabilityKey(registration.id, registration.version);
        if (globalCapabilities.has(id)) {
          throw new ExtensionHostError("duplicate-capability", `capability 已注册：${registration.id}@${registration.version}`);
        }
        globalCapabilities.set(id, handle);
        owner.capabilities.set(id, registration.value);
      },
      // 三类 handler 的注册实现与 webServerFor 共用（见 registerInto）。
      registerHandler: (registration) => registerInto(owner, handle, handlerKey).register(registration),
      registerHttpHandler: (registration) => registerInto(owner, handle, handlerKey).registerHttp(registration),
      registerRawHttpHandler: (registration) => registerInto(owner, handle, handlerKey).registerRawHttp(registration),
      registerResource: (resource) => {
        if (typeof resource.id !== "string" || resource.id === "") {
          throw new ExtensionHostError("duplicate-resource", "resource id 必须是非空字符串");
        }
        if (owner.resources.has(resource.id)) {
          throw new ExtensionHostError("duplicate-resource", `resource 已注册：${resource.id}`);
        }
        owner.resources.set(resource.id, resource);
      }
    };

    installMediaFormatRegistration(host, owner, options.registerMediaFormatFor?.(definition.extensionId));
    const registerAgentRole = options.registerAgentRoleFor?.(definition.extensionId);
    if (registerAgentRole) {
      host.registerAgentRole = (implementation) => {
        const dispose = registerAgentRole.register(implementation);
        owner.startedResources.push({ id: `agent-role:${implementation.definition.id}`, stop: dispose });
        return dispose;
      };
    }
    const registerMarketplaceSource = options.registerMarketplaceSourceFor?.(definition.extensionId);
    if (registerMarketplaceSource) {
      host.registerMarketplaceSource = (source) => {
        registerMarketplaceSource(source);
        owner.marketplaceSourceIds.push(source.sourceId);
      };
    }
    const releaseMarketplaceSource = options.releaseMarketplaceSourceFor?.(definition.extensionId);
    if (releaseMarketplaceSource) {
      owner.releaseMarketplaceSource = releaseMarketplaceSource;
      host.unregisterMarketplaceSource = (sourceId: string) => {
        const index = owner.marketplaceSourceIds.lastIndexOf(sourceId);
        if (index >= 0) owner.marketplaceSourceIds.splice(index, 1);
        releaseMarketplaceSource(sourceId);
      };
    }
    const registerGeneration = options.registerGenerationFor?.(definition.extensionId);
    if (registerGeneration) {
      host.registerGeneration = (provider) => {
        registerGeneration(provider);
        owner.generationProviderIds.push(provider.providerId);
      };
    }
    const releaseGeneration = options.releaseGenerationFor?.(definition.extensionId);
    if (releaseGeneration) {
      owner.releaseGeneration = releaseGeneration;
      host.unregisterGeneration = releaseGeneration;
    }

    // 存储后端注册面（与 registerGeneration 同形）：站点插件在 activation 里把存储后端注册进
    // `ctx.storage`，宿主只记 owner 与 id，停用/卸载时按反序注销。两侧都缺失时不伪造注册表，
    // 插件拿不到 `host.registerStorage`，自己记日志跳过。
    const registerStorage = options.registerStorageFor?.(definition.extensionId);
    if (registerStorage) {
      host.registerStorage = (backend) => {
        registerStorage(backend);
        owner.storageBackendIds.push(backend.backendId);
      };
    }
    // 遥测出口注册面（与 registerStorage 同形）：出口自带部署地址/会话与在途批次，
    // 因此谁注册谁收回，停用后 `ctx.telemetry` 里不留一个指向已释放资源的出口。
    const registerTelemetryExport = options.registerTelemetryExportFor?.(definition.extensionId);
    if (registerTelemetryExport) {
      host.registerTelemetryExport = (provider) => {
        registerTelemetryExport(provider);
        owner.telemetryExportIds.push(provider.exportId);
      };
    }
    const releaseTelemetryExport = options.releaseTelemetryExportFor?.(definition.extensionId);
    if (releaseTelemetryExport) {
      owner.releaseTelemetryExport = releaseTelemetryExport;
      host.unregisterTelemetryExport = (exportId) => {
        const index = owner.telemetryExportIds.lastIndexOf(exportId);
        if (index >= 0) owner.telemetryExportIds.splice(index, 1);
        releaseTelemetryExport(exportId);
      };
    }
    const releaseStorage = options.releaseStorageFor?.(definition.extensionId);
    if (releaseStorage) {
      // 释放走同一份 owner 记录：显式 `unregisterStorage` 也只注销本 activation 注册过的 id，
      // 避免扩展误把别的 owner 的后端注销掉。重复注销直接交给 core（幂等）。
      owner.releaseStorage = releaseStorage;
      host.unregisterStorage = (backendId) => {
        const index = owner.storageBackendIds.lastIndexOf(backendId);
        if (index >= 0) owner.storageBackendIds.splice(index, 1);
        releaseStorage(backendId);
      };
    }

    // 基础提供者注册面（change: 2026-10-13-...，任务 1.1）：插件在 activation 中登记类型化
    // identity/site/resource/lifecycle provider；registry 在开放入口前按 profile 校验唯一 owner。
    const providerRegistry = options.registerProviderFor?.(definition.extensionId);
    if (providerRegistry) {
      owner.releaseProviders = () => providerRegistry.releaseExtension(definition.extensionId);
      host.providers = {
        registerIdentityProvider: (provider) =>
          providerRegistry.register({ slot: "identity", extensionId: definition.extensionId, providerId: provider.providerId, value: provider }),
        registerSiteAccessPolicy: (policy) =>
          providerRegistry.register({ slot: "site-access", extensionId: definition.extensionId, providerId: policy.policyId, value: policy }),
        registerResourceAccessPolicy: (policy) =>
          providerRegistry.register({ slot: "resource-access", extensionId: definition.extensionId, providerId: policy.policyId, value: policy }),
        registerResourceLifecyclePolicy: (policy) =>
          providerRegistry.register({ slot: "resource-lifecycle", extensionId: definition.extensionId, providerId: policy.policyId, value: policy }),
        registerResourceDirectory: (directory) =>
          providerRegistry.register({ slot: "resource-directory", extensionId: definition.extensionId, providerId: directory.directoryId, value: directory })
      };
    }

    try {
      for (const route of definition.publicRoutes ?? []) {
        if (route.extensionId !== definition.extensionId) throw new Error("Public route owner mismatch");
        if (mode === "public" && [...publicRouteDeclarations.values()].flat().some(existing => existing.publicPath === route.publicPath && existing.extensionId !== route.extensionId)) throw new Error("Duplicate extension public route");
      }
      const executors = await options.activateExecutors?.(definition, configVersion);
      if (executors) {
        host.services = { ...host.services, executor: executors.service };
        owner.startedResources.push({ id: "extension-executors", stop: executors.dispose });
      }
      const activation: ApplicationBackendActivation | void = await definition.activate(host);
      owner.activation = activation ?? {};
      for (const resource of owner.resources.values()) {
        if (resource.start) {
          await resource.start();
          owner.startedResources.push(resource);
        }
      }
    } catch (error) {
      const hostError = error instanceof ExtensionHostError
        ? error
        : new ExtensionHostError("activation-failed", error instanceof Error ? error.message : String(error));
      return fail(hostError);
    }

    if (mode === "public") publicRouteDeclarations.set(handle, definition.publicRoutes ?? []);
    log({ event: "extension-activated", extensionId: definition.extensionId, configVersion, mode });
    const activationHandle: ExtensionActivationHandle = {
      extensionId: definition.extensionId,
      summary: () => toSummary(owner),
      dispose: async (reason = "disable") => {
        const current = records.get(key);
        if (!current) return;
        await rollback(current, handle, reason);
        records.delete(key);
        log({ event: "extension-disposed", extensionId: definition.extensionId, configVersion, mode });
      }
    };
    return { ok: true, handle: activationHandle };
  };

  const activate = (definition: ApplicationBackendExtensionDefinition): Promise<ExtensionActivationResult> =>
    activateInternal(definition, 0, "public", { allowExistingPublic: false });

  const activateVersioned: ApplicationExtensionHost["activateVersioned"] = (definition, configVersion, mode) =>
    activateInternal(definition, configVersion, mode, { allowExistingPublic: true });

  const activateManifest: ApplicationExtensionHost["activateManifest"] = async (definitions) => {
    const results: Array<{ extensionId: string; result: ExtensionActivationResult }> = [];
    for (const definition of definitions) {
      results.push({ extensionId: definition.extensionId, result: await activate(definition) });
    }
    return results;
  };

  const disposeVersion = async (extensionId: string, configVersion: number, reason: import("@woohaa3/contracts").ApplicationDisposeReason = "disable"): Promise<void> => {
    const key = keyFor(extensionId, configVersion);
    const owner = records.get(key);
    if (!owner) return;
    await rollback(owner, key, reason);
    records.delete(key);
  };

  /**
   * 按扩展 identity 绑定的受控 HTTP 注册面（`ctx.webServer` 的宿主实现）。
   *
   * 注册键仍是 `<extensionId>/<相对 route>`，与 `activate` 内部走同一张注册表——
   * 所以通过 `ctx.webServer` 注册的路由与插件在 `activate` 里注册的完全等价。
   * 扩展未激活/已释放时返回 undefined，调用方据此给出稳定错误。
   */
  /**
   * 某个扩展的完整注册面：HTTP 路由、能力、领域服务与诊断缓冲。
   *
   * 有 backend 激活时用它的记账（回滚语义不变）；没有（走 Cordis 装载）时用独立记账，
   * 由调用方在插件停用时 `release()`。这样「注册」不再隐含「发生过一次 backend 激活」。
   */
  const pluginContextFor = (extensionId: string): PluginRegistrationSurface => {
    // 公共实例的路由键命名空间：`<extensionId>/<route>`。
    const namespace = (route: string) => `${extensionId}/${route}`;
    const found = [...records.entries()].find(([, entry]) => entry.extensionId === extensionId && entry.mode === "public");
    let webServer: import("@woohaa3/contracts").HostWebServerService | undefined;
    let release: () => void = () => undefined;
    if (found) {
      webServer = registerInto(found[1], found[0], namespace);
      // 已有 owner：注销由 rollback 负责，这里不需要额外记账。
    } else {
      // 没有 backend 激活：用独立记账。先清掉上一次装载留下的路由，
      // 否则反复启停会因为 `duplicate-handler` 直接失败。
      releaseRegistrations(extensionId);
      const scope = newRecord(extensionId);
      records.set(extensionId, scope);
      // handle 必须等于记录键：分派用 global 表里存的 handle 去 `records` 查记录。
      webServer = registerInto(scope, extensionId, namespace);
      release = () => releaseRegistrations(extensionId);
    }
    const services = options.servicesFor?.(extensionId, 0);
    const registerMediaFormat = options.registerMediaFormatFor?.(extensionId);    const mediaFormats: import("@woohaa3/contracts").HostMediaFormatService | undefined = registerMediaFormat
      ? {
          register: (format: import("@woohaa3/contracts").MediaFormatValidator) => {
            const dispose = registerMediaFormat(format);
            if (found) {
              // 已有 backend owner：登记成资源，停用/回滚时由 rollback 反序 stop。
              found[1].startedResources.push({ id: `media-format:${format.contentType}`, stop: dispose });
            } else {
              let set = pluginMediaFormats.get(extensionId);
              if (!set) {
                set = new Set();
                pluginMediaFormats.set(extensionId, set);
              }
              set.add(dispose);
            }
            return () => {
              if (!found) pluginMediaFormats.get(extensionId)?.delete(dispose);
              dispose();
            };
          }
        }
      : undefined;
    const registerAgentRole = options.registerAgentRoleFor?.(extensionId);
    const agentRoles: import("@woohaa3/contracts").HostAgentRoleService | undefined = registerAgentRole
      ? {
          register: (implementation) => {
            const dispose = registerAgentRole.register(implementation);
            if (found) {
              // 已有 backend owner：登记成资源，停用/回滚时按反序释放本次 activation 的角色。
              found[1].startedResources.push({ id: `agent-role:${implementation.definition.id}`, stop: dispose });
            }
            return dispose;
          },
          list: () => registerAgentRole.list(),
          availability: (namespacedId) => registerAgentRole.availability(namespacedId)
        }
      : undefined;
    const authoringTools = services?.authoringTools;
    return {
      ...(webServer ? { webServer } : {}),
      ...(mediaFormats ? { mediaFormats } : {}),
      ...(agentRoles ? { agentRoles } : {}),
      ...(authoringTools ? { authoringTools } : {}),
      capabilities: {
        register: (registration: { id: string; version: number; value: unknown }) => {
          if (typeof registration.id !== "string" || registration.id === "") {
            throw new ExtensionHostError("duplicate-capability", "capability id 必须是非空字符串");
          }
          if (!Number.isInteger(registration.version) || registration.version < 1) {
            throw new ExtensionHostError("duplicate-capability", `capability version 必须是正整数：${String(registration.version)}`);
          }
          const handle = found ? found[0] : extensionId;
          const key = publicCapabilityKey(registration.id, registration.version);
          if (globalCapabilities.has(key)) {
            throw new ExtensionHostError("duplicate-capability", `capability 已注册：${registration.id}@${registration.version}`);
          }
          globalCapabilities.set(key, handle);
          found?.[1].capabilities.set(key, registration.value);
          return () => { if (globalCapabilities.get(key) === handle) globalCapabilities.delete(key); };
        }
      },
      ...(services ? { services } : {}),

      ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
      release
    };
  };

  /**
   * 撤销某个 extensionId 的独立注册记账（幂等）。
   *
   * 装载器在插件停用时调用：路由与能力不能留在全局表里，否则停用的扩展还能被调。
   */
  const releaseRegistrations = (extensionId: string): void => {
    const scope = records.get(extensionId);
    if (!scope) return;
    for (const route of scope.handlers.keys()) {
      if (globalHandlers.get(route) === extensionId) globalHandlers.delete(route);
    }
    for (const key of scope.httpHandlers.keys()) {
      if (globalHttpHandlers.get(key) === extensionId) globalHttpHandlers.delete(key);
    }
    for (const key of scope.rawHttpHandlers.keys()) {
      if (globalRawHttpHandlers.get(key) === extensionId) globalRawHttpHandlers.delete(key);
    }
    const formats = pluginMediaFormats.get(extensionId);
    if (formats) {
      for (const dispose of formats) {
        try {
          dispose();
        } catch {
          // 注销失败不应阻断其余注册的释放。
        }
      }
      pluginMediaFormats.delete(extensionId);
    }
    try {
      options.onExtensionReleased?.(extensionId);
    } catch (error) {
      log({ event: "extension-release-hook-failed", extensionId, message: String(error) });
    }
    records.delete(extensionId);
  };

  return {
    activate,
    activateVersioned,
    activateManifest,
    declaredPublicRoutes: () => [...publicRouteDeclarations.values()].flat(),
    pluginContextFor,
    basePath: options.deployment?.basePath ?? "",
    // 解析只走公开命名空间：recovery 实例的能力不外泄（与 `capabilityKey` 的 mode 分支一致）。
    resolveCapability: (id, version) => {
      const key = publicCapabilityKey(id, version);
      const handle = globalCapabilities.get(key);
      return handle !== undefined ? records.get(handle)?.capabilities.get(key) : undefined;
    },
    hasCapability: (id, version) => globalCapabilities.has(publicCapabilityKey(id, version)),
    resolveCapabilityOwner: (id, version) => {
      const handle = globalCapabilities.get(publicCapabilityKey(id, version));
      if (handle === undefined) return null;
      const owner = records.get(handle);
      if (!owner) return null;
      return { extensionId: owner.extensionId, configVersion: owner.configVersion ?? 0, mode: owner.mode ?? "public" };
    },
    dispatch: (route, input) => dispatchHandler(registry, route, input),
    dispatchHttp: (input) => dispatchHttp(registry, input),
    dispatchRawHttp: (input) => dispatchRawHttp(registry, input),
    resolvePublicRoute: (extensionId, route, method) => resolvePublicRoute(registry, extensionId, route, method),
    snapshot: () =>
      [...records.values()]
        .sort((a, b) => a.order - b.order)
        .map((owner) => ({ extensionId: owner.extensionId, ...toSummary(owner) })),
    disposeExtension: async (extensionId, reason = "disable") => {
      for (const [key, owner] of [...records]) {
        if (owner.extensionId === extensionId) {
          await rollback(owner, key, reason);
          records.delete(key);
        }
      }
    },
    disposeVersion,
    activeVersions: (extensionId) =>
      [...records.values()]
        .filter((owner) => owner.extensionId === extensionId)
        .map((owner) => owner.configVersion ?? 0)
        .sort((a, b) => a - b),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      const all = [...records.entries()].sort(([, a], [, b]) => b.order - a.order);
      for (const [key, owner] of all) await rollback(owner, key, "shutdown");
      records.clear();
      globalCapabilities.clear();
      globalHandlers.clear();
      globalHttpHandlers.clear();
      globalRawHttpHandlers.clear();
    }
  };
}
