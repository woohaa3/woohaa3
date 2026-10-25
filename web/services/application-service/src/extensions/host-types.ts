/**
 * Application 后端插件宿主：类型、错误、facade 与 owner 状态
 * （自 `host.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R16）。
 */
import type {
  ApplicationBackendConfigFacade,
  ApplicationBackendExtensionDefinition,
  ApplicationBackendHttpHandlerRegistration,
  ApplicationBackendHandlerRegistration,
  ApplicationBackendRawHttpHandlerRegistration,
  ApplicationBackendResource,
  ApplicationBackendWorkFacade,
  ApplicationBackendActivation,
  ApplicationExtensionHandlerPurpose,
  ApplicationExtensionRequestContext,
  ApplicationExtensionServices
} from "./contract.js";
import type { ApplicationExtensionAuthLevel, ApplicationExtensionHostIdentity } from "@woohaa3/contracts";

export type ExtensionHostErrorCode =
  | "duplicate-capability"
  | "duplicate-handler"
  | "duplicate-resource"
  | "unauthorized"
  | "handler-not-found"
  | "activation-failed";

export class ExtensionHostError extends Error {
  readonly code: ExtensionHostErrorCode;
  constructor(code: ExtensionHostErrorCode, message: string) {
    super(message);
    this.name = "ExtensionHostError";
    this.code = code;
  }
}

/** 一次 activation 的 owner-scoped 注册摘要（诊断/状态展示用；不含实现）。 */
export type ExtensionRegistrationSummary = {
  capabilities: string[];
  handlers: Array<{ route: string; auth: ApplicationExtensionAuthLevel; requiredActions?: readonly import("@woohaa3/contracts").AccessAction[]; purpose?: ApplicationExtensionHandlerPurpose }>;
  httpHandlers: Array<{ route: string; method: string; auth: ApplicationExtensionAuthLevel; requiredActions?: readonly import("@woohaa3/contracts").AccessAction[]; purpose: ApplicationExtensionHandlerPurpose; stream: boolean; streamBudget?: Partial<import("@woohaa3/contracts").ApplicationExtensionStreamBudget> }>;
  resources: string[];
};

export type ExtensionActivationHandle = {
  extensionId: string;
  /** 幂等释放本 activation 的全部贡献（反序）。 */
  dispose: () => Promise<void>;
  summary: () => ExtensionRegistrationSummary;
};

export type ExtensionActivationResult =
  | { ok: true; handle: ExtensionActivationHandle }
  | { ok: false; code: ExtensionHostErrorCode; message: string; missingDependencies?: string[] };

/** 宿主 dispatch 时由认证层注入的调用者上下文（不含插件自报身份）。 */
export type ExtensionDispatchContext = Pick<ApplicationExtensionRequestContext, "authLevel" | "actor" | "correlationId" | "principal" | "sessionId" | "signal" | "accessControl" | "dataScope">;

export type ApplicationExtensionHostOptions = {
  logger?: (event: Record<string, unknown>) => void;
  hostIdentity?: ApplicationExtensionHostIdentity;
  /** 只读部署上下文（change: 2026-10-15-...）：向插件暴露当前公开挂载路径。 */
  deployment?: { basePath: string };
  configFacadeFor?: (extensionId: string) => ApplicationBackendConfigFacade;
  workFacadeFor?: (extensionId: string) => ApplicationBackendWorkFacade;
  servicesFor?: (extensionId: string, configVersion?: number) => ApplicationExtensionServices;
  /**
   * 只读诊断缓冲（可选）：宿主把已脱敏的服务端接入/同步事件投影给可信扩展。
   *
   * 缺失时插件拿不到 `host.diagnostics`，调试窗口必须显示「不可用」而不是伪造空日志
   * （旧宿主或独立入口本来就没有这个能力）。
   */
  diagnostics?: import("@woohaa3/contracts").ApplicationBackendDiagnostics;
  registerMediaFormatFor?: (extensionId: string) => ((format: import("@woohaa3/contracts").MediaFormatValidator) => () => void) | undefined;
  registerGenerationFor?: (extensionId: string) => ((provider: import("@woohaa3/contracts").GenerationProvider) => void) | undefined;
  releaseGenerationFor?: (extensionId: string) => ((providerId: string) => void) | undefined;
  /**
   * 存储后端注册面：站点插件在 activation 里向 `ctx.storage` 注册后端。
   *
   * 与 `registerGenerationFor` 同形：宿主自己**不持有**后端实现，只把注册转发给 core 的存储
   * 注册表，并记下 owner 以便回滚时收回。缺失时插件拿不到 `host.registerStorage`，
   * 必须记日志跳过（不伪造一个假的存储注册表）。
   */
  registerStorageFor?: (extensionId: string) => ((backend: import("@woohaa3/contracts").StorageBackend) => void) | undefined;
  /** 注销存储后端的宿主钩子（按 backendId；须幂等）。 */
  releaseStorageFor?: (extensionId: string) => ((backendId: string) => void) | undefined;
  /**
   * 遥测出口注册面：站点插件在 activation 里把出口注册进 `ctx.telemetry`。
   *
   * 与存储后端同形但语义不同：core 不按 id 挑选目的地，注册即参与投递（开关另在
   * `telemetry.export.enabled`）。缺失时插件拿不到 `host.registerTelemetryExport`，
   * 必须记日志跳过。
   */
  registerTelemetryExportFor?: (
    extensionId: string
  ) => ((provider: import("@woohaa3/contracts").TelemetryExport) => void) | undefined;
  /** 注销遥测出口的宿主钩子（按 exportId；须幂等）。 */
  releaseTelemetryExportFor?: (extensionId: string) => ((exportId: string) => void) | undefined;
  /**
   * 基础提供者注册面（change: 2026-10-13-...，任务 1.1）：宿主把登记转发给 registry；
   * 缺失时插件得不到 `host.providers`（不伪造内存提供者）。
   */
  registerProviderFor?: (extensionId: string) => import("./provider-registry.js").ProviderRegistry | undefined;
};

export const EMPTY_CONFIG_FACADE: ApplicationBackendConfigFacade = {
  configVersion: () => null,
  values: () => ({}),
  secretRefs: () => [],
  desiredEnabled: () => false
};

export const REJECTING_WORK_FACADE: ApplicationBackendWorkFacade = {
  admit: () => ({ ok: false, reason: "not-ready" }),
  resume: () => null,
  activeWorkCount: () => 0
};

/** 缺省受限服务 facade：无下游客户端时全部拒绝（不作为内存回退）。 */
export const REJECTING_SERVICES: ApplicationExtensionServices = {
  tasks: {
    submit: async () => ({ ok: false, code: "unavailable", message: "Task 服务未配置" }),
    status: async () => null,
    cancel: async () => null
  },
  media: {
    stat: async () => ({ exists: false })
  },
  canvas: {
    requestNodeRun: async () => ({ ok: false, code: "unavailable", message: "Canvas 服务未配置" }),
    requestNodeCancel: async () => ({ ok: false, code: "unavailable", message: "Canvas 服务未配置" })
  }
};

export type OwnerState = {
  extensionId: string;
  /** 版本化实例的不可变配置版本；非版本化 activation 为 0。 */
  configVersion: number;
  /** public 实例是当前新工作入口；recovery 实例只保留内部恢复贡献。 */
  mode: "public" | "recovery";
  capabilities: Map<string, unknown>;
  handlers: Map<string, ApplicationBackendHandlerRegistration>;
  httpHandlers: Map<string, ApplicationBackendHttpHandlerRegistration>;
  rawHttpHandlers: Map<string, ApplicationBackendRawHttpHandlerRegistration>;
  resources: Map<string, ApplicationBackendResource>;
  startedResources: ApplicationBackendResource[];
  /** 本 activation 登记的生成 Provider（rollback 时释放）。 */
  generationProviderIds: string[];
  /** 释放生成 Provider 的宿主钩子（与 options 同源）。 */
  releaseGeneration?: (providerId: string) => void;
  /**
   * 本 activation 注册的存储后端 id（rollback 时按反序注销）。
   *
   * 存 id 而不是构造后端时记下的 disposer：core 的 `ctx.storage.unregister(backendId)` 才是
   * 唯一的注销入口，重复调用它天然幂等；两套释放路径（disposer + unregister）会互相打架。
   */
  storageBackendIds: string[];
  /** 注销存储后端的宿主钩子（与 options 同源）。 */
  releaseStorage?: (backendId: string) => void;
  /** 本 activation 注册过的遥测出口 id（停用/回滚时按反序注销）。 */
  telemetryExportIds: string[];
  /** 注销遥测出口的宿主钩子（与 options 同源）。 */
  releaseTelemetryExport?: (exportId: string) => void;
  /** 释放本 activation 登记的基础提供者（rollback 时调用）。 */
  releaseProviders?: () => void;
  activation?: ApplicationBackendActivation;
  order: number;
};

export const DEFAULT_HANDLER_STATUS = 200;

/** HTTP handler 全局键：`${mode}:${method} ${route}`。 */
export function httpHandlerKey(method: string, route: string): string {
  return `${method} ${route}`;
}

export function toSummary(owner: OwnerState): ExtensionRegistrationSummary {
  return {
    capabilities: [...owner.capabilities.keys()].sort(),
    handlers: [...owner.handlers.values()]
      .map((registration) => ({
        route: registration.route,
        auth: registration.auth,
        ...(registration.requiredActions ? { requiredActions: registration.requiredActions } : {}),
        ...(registration.purpose ? { purpose: registration.purpose } : {})
      }))
      .sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0)),
    httpHandlers: [...owner.httpHandlers.entries()]
      .map(([, registration]) => ({
        route: registration.route,
        method: registration.method,
        auth: registration.auth,
        ...(registration.requiredActions ? { requiredActions: registration.requiredActions } : {}),
        purpose: registration.purpose,
        stream: registration.stream === true,
        ...(registration.streamBudget ? { streamBudget: registration.streamBudget } : {})
      }))
      .concat(
        [...owner.rawHttpHandlers.entries()].map(([, registration]) => ({
          route: registration.route,
          method: registration.method,
          auth: registration.auth,
          ...(registration.requiredActions ? { requiredActions: registration.requiredActions } : {}),
          purpose: registration.purpose,
          stream: registration.stream === true,
          ...(registration.streamBudget ? { streamBudget: registration.streamBudget } : {})
        }))
      )
      .sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0)),
    resources: [...owner.resources.keys()].sort()
  };
}

export type { ApplicationBackendExtensionDefinition };
