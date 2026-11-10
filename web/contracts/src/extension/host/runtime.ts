/**
 * 应用插件后端宿主的**装配契约**：宿主注入什么、插件怎样登记贡献、健康与依赖如何声明。
 * （change: 2026-10-05-extract-application-plugin-host，任务 1.2 / design D2/D3）。
 *
 * 与 `../services/` 的分工：那里是扩展**可见的服务面**（`ctx.log` / `ctx.generation` / …），
 * 服务契约在那边定义、宿主实现；这里只声明宿主装载插件时用的装配面（host / config / work /
 * activation）。所以本模块 import 服务契约，**不**反向被服务契约 import。
 *
 * 本模块不包含 HTTP client、Node driver 或 SDK，也不含秘密。
 */
import type {
  ApplicationExtensionAuthLevel,
  ApplicationExtensionHostIdentity
} from "./manifest.js";
import type { ApplicationBackendDiagnostics } from "../services/host/diagnostics.js";
import type { ApplicationExtensionServices } from "../services/host/facades.js";
import type { GenerationProvider } from "../services/host/generation.js";
import type { MarketplaceSource } from "../services/host/marketplace.js";
import type { MediaFormatValidator } from "../services/host/media-formats.js";
import type { StorageExposer } from "../services/host/exposer.js";
import type { StorageBackend } from "../services/host/storage.js";
import type { TelemetryExport } from "../services/host/telemetry.js";
import type {
  ApplicationBackendHandlerRegistration,
  ApplicationBackendHttpHandlerRegistration,
  ApplicationBackendRawHttpHandlerRegistration
} from "../services/host/web-server.js";

/**
 * 认证等级强弱：插件不能弱化宿主要求（design D2）。
 *
 * change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 3.3：删除 `admin`
 * 等级。旧 `auth: admin` 迁移为 `authenticated` + 具名 `requiredActions`；核心 MUST NOT
 * 依赖管理员等级放行。
 */
export const AUTH_LEVEL_RANK: Readonly<Record<ApplicationExtensionAuthLevel, number>> = {
  public: 0,
  authenticated: 1
};

export function isAuthLevelAtLeast(
  actual: ApplicationExtensionAuthLevel,
  required: ApplicationExtensionAuthLevel
): boolean {
  return AUTH_LEVEL_RANK[actual] >= AUTH_LEVEL_RANK[required];
}

/** 插件注册的 typed capability（供同宿主其它模块按 id 解析）。 */
export type ApplicationBackendCapabilityRegistration = {
  id: string;
  /** capability 实现；具体形状由 capability owner 约定。 */
  value: unknown;
};

/** 后台资源：拥有 start/stop 生命周期，disposer 必须幂等（design D2）。 */
export type ApplicationBackendResource = {
  id: string;
  start?: () => Promise<void> | void;
  /** 幂等停止；activation 回滚与停用都调用它。 */
  stop: () => Promise<void> | void;
};

/** 宿主提供的配置读写 facade（只读已提交配置；不暴露秘密）。 */
export type ApplicationBackendConfigFacade = {
  /** 当前插件已提交的配置版本；未配置时为 null。 */
  configVersion: () => number | null;
  /** 当前插件非秘密配置值快照。 */
  values: () => Record<string, unknown>;
  /** 秘密引用列表（无秘密值）。 */
  secretRefs: () => readonly string[];
  /** 目标是否启用（真实工作中以它为准）。 */
  desiredEnabled: () => boolean;
};

/** 一条已受理工作的 handle（版本化；draining 期间仍可恢复/终态化）。 */
export type ApplicationBackendWorkHandle = {
  workId: string;
  configVersion: number;
  markRunning: () => void;
  settle: (state: "succeeded" | "failed" | "cancelled") => void;
};

export type ApplicationBackendWorkAdmission =
  | { ok: true; workId: string; configVersion: number }
  | { ok: false; reason: "disabled" | "not-ready" | "version-mismatch" };

export type ApplicationBackendWorkFacade = {
  admit: () => ApplicationBackendWorkAdmission;
  resume: (workId: string) => ApplicationBackendWorkHandle | null;
  activeWorkCount: () => number;
};

/**
 * 插件收到的**可信 delegated principal 与能力范围**（design D3）。
 *
 * 这是宿主注入的不可伪造身份：下游服务据此检查插件身份与操作权限。插件不能改写它，
 * 也不获得原始服务令牌。
 */
export type ApplicationExtensionPrincipal = {
  /** 可信插件 identity（由宿主配置，不接受调用者自报）。 */
  extensionId: string;
  /** 不可变配置版本（工作准入时绑定）。 */
  configVersion: number;
  /** 委托主体（管理员/系统）；用于下游审计，不用于无限授权。 */
  delegatedActor?: string;
  /** 声明能力范围（例如 "tasks:submit"）；facade 在越权时拒绝。 */
  capabilities: readonly string[];
};

/**
 * 基础提供者注册面（change: 2026-10-13-...，任务 0.3/1.1）。
 *
 * 扩展通过它登记类型化 identity/site/resource/lifecycle provider；宿主在开放受保护入口前
 * 按可信 profile 校验「每个 slot 恰有一个 owner」。这不是无类型字符串 capability。
 */
export type ApplicationBackendProviderHost = {
  registerIdentityProvider(provider: import("./access.js").IdentityProvider): void;
  registerSiteAccessPolicy(policy: import("./access.js").SiteAccessPolicy): void;
  registerResourceAccessPolicy(policy: import("./access.js").ResourceAccessPolicy): void;
  registerResourceLifecyclePolicy(policy: import("./access.js").ResourceLifecyclePolicy): void;
  /** 可选：资源发现目录（Access）；缺失时不进入必需 profile，消费方 fail closed。 */
  registerResourceDirectory(directory: import("./access.js").ResourceDirectory): void;
};

/** 宿主注入给插件的运行时接口。 */
export type ApplicationBackendHost = {
  extensionId: string;
  /** 宿主 identity：站点插件生产宿主为 application。 */
  host: ApplicationExtensionHostIdentity;
  /**
   * 只读部署上下文（change: 2026-10-15-support-configurable-app-base-path，design D6）。
   * 插件据此把应用逻辑路径解析为公开 URL（如第三方扩展入口/CSP 作用域），
   * 不在插件内自持可变的部署配置。
   */
  deployment?: { basePath: string };
  config: ApplicationBackendConfigFacade;
  /** 受控在途工作 facade（admission / 恢复）；停用后 admit 立即被拒绝。 */
  work: ApplicationBackendWorkFacade;
  /** 受限服务 facade（按声明能力裁剪）。 */
  services: ApplicationExtensionServices;
  /** 注册一个 typed capability；重复 id 抛错。 */
  registerCapability: (registration: ApplicationBackendCapabilityRegistration) => void;
  /** 注册一个受控 handler；重复 route 抛错。 */
  registerHandler: (registration: ApplicationBackendHandlerRegistration) => void;
  /** 注册一个受控 HTTP handler（server-only；design D4）；重复 (method, route) 抛错。 */
  registerHttpHandler?: (registration: ApplicationBackendHttpHandlerRegistration) => void;
  /** 注册一个受控**原始** HTTP handler（server-only；design D4）；重复 (method, route) 抛错。 */
  registerRawHttpHandler?: (registration: ApplicationBackendRawHttpHandlerRegistration) => void;
  /** 注册后台资源；activation 回滚时按反序 stop。 */
  registerResource: (resource: ApplicationBackendResource) => void;
  /**
   * 注册一个生成 Provider（change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 1.2）。
   * 只有后端生成能力宿主提供；重复 providerId 抛错。
   */
  registerGeneration?: (provider: GenerationProvider) => void;
  /**
   * 注销一个生成 Provider（change: 2026-10-06-add-runninghub-api-models-and-provider-credentials，任务 2.4）。
   * 凭据变更后插件失效/重激活时用于释放旧注册。
   */
  unregisterGeneration?: (providerId: string) => void;
  /**
   * 注册一个存储后端（`ctx.storage` 的扩展点，与 `registerGeneration` 同形）。
   *
   * **只有宿主提供存储扩展点时才有**（本机宿主由 core 层的 `storagePlugin` 提供）；没有这条接缝时
   * 插件必须记日志跳过，不得把「宿主没这个能力」当成激活失败。
   *
   * 为什么要有这条接缝：存储后端是**运行期能力**——它带着会话、连接与在途请求，不是一条可以
   * 写进设置面的静态值。谁注册谁收回，才能保证停用/卸载扩展时 `ctx.storage` 里不残留一个指向
   * 已释放资源的后端（那种残留会让主存储路由到死实现，表现为莫名其妙的字节读写失败）。
   */
  /** Register a custom media validator; activation cleanup always releases its registration. */
  registerMediaFormat?: (format: MediaFormatValidator) => void;
  /**
   * 注册一个 Agent 角色实现（change: 2026-11-07-add-pluggable-agent-roles）。
   *
   * 归属由宿主按本次 activation 的 extensionId 记账，插件不能自报其他扩展身份；停用/回滚时
   * 宿主自动注销，重复完整角色 id 会让本次激活失败并回滚。
   */
  registerAgentRole?: (implementation: import("../assistant/agent-role.js").AgentRoleImplementation) => () => void;
  registerStorage?: (backend: StorageBackend) => void;
  /**
   * 注销一个存储后端（按 `backendId`）。
   *
   * 扩展卸载/停用必须注销（宿主也会替它按反序调用）。实现须**幂等**：重复注销同一 id 不算错误，
   * 因为「现在没有这个后端」正是调用方想要的终态。
   */
  unregisterStorage?: (backendId: string) => void;
  /**
   * 注册一个对外地址提供者（可选能力）。
   *
   * 与 `registerStorage` 同形：谁注册谁收回，宿主按 owner 记 id 并在停用/回滚时反序注销。
   * 与存储分成两个接缝的原因见 `HostExposerService`：地址能力可以独立于字节驻留存在
   * （例如 CDN 回源签名），缺少它不该让存储注册失败，反之亦然。
   */
  registerExposer?: (exposer: StorageExposer) => void;
  /** 注销一个地址提供者（按 `exposerId`）。实现须幂等。 */
  unregisterExposer?: (exposerId: string) => void;
  /**
   * 注册一个遥测出口（可选能力；change: 2026-10-20-add-local-client-telemetry，tasks 7.x）。
   *
   * 与 `registerStorage` 同形：谁注册谁收回，宿主按 owner 记 id 并在停用/回滚时反序注销。
   *
   * 为什么必须有这条接缝：「发到哪、用什么凭据」是出口自己的能力（部署地址、会话、令牌），
   * core 只回答"发不发"。core 若能自己枚举目的地，就等于要知道具体扩展身份，还会造出一个
   * "配了 id 却没人读"的死设置——所以出口只能由扩展在运行期注册进来。
   *
   * 缺失表示宿主没有遥测能力（纯本地宿主/旧版本）：扩展必须记日志跳过，
   * 不得把「宿主没这个能力」当成激活失败。
   */
  registerTelemetryExport?: (provider: TelemetryExport) => void;
  /** 注销一个遥测出口（按 `exportId`；实现须幂等）。 */
  unregisterTelemetryExport?: (exportId: string) => void;
  /**
   * 注册一个扩展市场来源（`ctx.marketplace` 扩展点；change: 2026-10-21-add-server-extension-marketplace，D6）。
   *
   * 与 `registerStorage` 同形：谁注册谁收回，宿主按 owner 记 `sourceId` 并在停用 / 回滚时反序注销。
   * 宿主按本扩展的扫描来源（内置根 / 可写根 / 受管根）断言：**只有内置根扩展可以注册来源**，其余抛
   * `EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT`。来源只交付字节，签名信任仍由本机信任根决定。
   *
   * 缺失表示宿主没有市场扩展点：扩展必须记日志跳过，不得把它当成激活失败。
   */
  registerMarketplaceSource?: (source: MarketplaceSource) => void;
  /** 注销一个市场来源（按 `sourceId`；实现须幂等）。 */
  unregisterMarketplaceSource?: (sourceId: string) => void;
  /**
   * 基础提供者注册面（change: 2026-10-13-...，任务 0.3/1.1）。只有后端宿主提供；
   * 同一 slot 的重复 owner 在开放入口前拒绝。
   */
  providers?: ApplicationBackendProviderHost;
  /**
   * 只读诊断缓冲（可选）：宿主把已脱敏的服务端接入/同步事件投影给可信扩展。
   *
   * 缺失表示该宿主没有诊断能力（纯本地宿主/旧版本），扩展必须把调试窗口显示为
   * 「不可用」，而不是伪造一份空日志。
   */
  diagnostics?: ApplicationBackendDiagnostics;
  logger: (event: Record<string, unknown>) => void;
};

/**
 * 插件激活返回的可回收贡献。
 *
 * 首版不强制插件使用 Cordis；`dispose` 让宿主统一按 owner 反序释放；资源也可通过
 * `host.registerResource` 登记（二者都会被幂等释放）。
 */
export type ApplicationBackendActivation = {
  dispose?: () => Promise<void> | void;
};

/**
 * 后端插件自报的健康状态：**已装载**但能力没就绪。
 *
 * activation 成功只说明插件进程内装载完成（fiber 起来了、贡献注册了），不代表它的能力当下可用：
 * 生成 Provider 缺凭据时仍要注册（否则管理面看不到它、也无法预填配置），但模型进不了 catalog。
 * 这种「装着但用不了」的稳态用 `degraded` 表达，避免把它混成 activation 失败，也避免伪称「运行中」。
 *
 * 健康状态必须**按需重读**（`health()`）而不是 activation 时快照：管理员补上凭据后，插件本身不用
 * 重启，状态应随之回到 `active`。
 */
export type ApplicationBackendExtensionHealth = {
  state: "degraded";
  /** 公开安全诊断（不得包含秘密）。degraded 时不得为空。 */
  diagnostics: readonly import("./state.js").ApplicationExtensionSafeDiagnostic[];
};

/** 扩展自有 MCP 工具声明；宿主负责认证、schema 与 handler 分派。 */
export type ApplicationExtensionMcpTool = {
  name: string;
  description: string;
  route: string;
  permission: "read" | "write";
  newWork?: boolean;
  parameters?: Record<string, { type: "string" | "strings" | "object"; optional?: boolean; maxLength?: number; description?: string }>;
};

/** 后端插件定义（构建时静态登记；宿主 activation 前解析依赖）。 */
export type ApplicationBackendExtensionDefinition = {
  extensionId: string;
  /** Trusted module paths resolved from extension.json by the extension loader. */
  executors?: readonly import("../services/host/executor.js").ExtensionExecutorModule[];
  publicRoutes?: readonly import("./http.js").ApplicationExtensionPublicRouteMapping[];
  mcpTools?: readonly ApplicationExtensionMcpTool[];
  /** 必需依赖的 capability/service id；缺失时不得产生部分可用贡献。 */
  requiredDependencies?: readonly string[];
  /**
   * 当前健康状态：`undefined` 表示健康（状态投影为 `active`）。
   *
   * 只在插件已装载时返回 degraded；未装载（配置中/已停用）由状态投影自己判断，本钩子不参与。
   * 宿主必须容忍它抛错（按健康处理并记日志），因为它会被状态查询同步调用。
   */
  health?: () => ApplicationBackendExtensionHealth | undefined;
  activate: (
    host: ApplicationBackendHost
  ) => ApplicationBackendActivation | void | Promise<ApplicationBackendActivation | void>;
};
