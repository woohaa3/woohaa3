import { CanvasCreationStore } from "./repository/canvas-creation-store.js";
import { CanvasCreationService } from "./extensions/canvas-creation-service.js";
/**
 * Application Service composition root
 * （change: 2026-10-05-extract-application-plugin-host，任务 2.1–2.3 / 3.2 / design D1；
 *  change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.1–1.5 / 3.5）。
 *
 * 独立运行单元：在同一服务端进程组合**统一身份认证**、独立 store、公共 Context（受限服务 facade）、
 * 插件宿主、站点控制面与本地 API。生产站点 HTTP 入口由 ingress 提供：`/api/extensions*`
 * 由本进程处理，其它领域路径代理到独立服务。**不** import 领域服务 composition root，
 * 也不访问其数据库。
 *
 * 企业访问变化要点：类型化基础提供者 registry（identity/site-access/resource-access/
 * resource-lifecycle）；统一执行边界（认证一次 + 具名 action/资源检查）；删除
 * adminToken/shared-secret/本地会话注入。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  normalizeAppBasePath,
  type ApplicationExtensionMetadata,
  type MediaMetadata,
  type RequiredProviderProfiles
} from "@woohaa3/contracts";
import { createApplicationBackendExtensionManifest } from "./extensions/manifest.js";
import { createApplicationExtensionHost, type ApplicationExtensionHost } from "./extensions/host.js";
import { createSiteExtensionControlPlane, type SiteExtensionControlPlane } from "./extensions/control-plane.js";
import { createSqliteSiteExtensionConfigStore } from "./extensions/config-store.js";
import { createSqliteExtensionWorkRepository } from "./repository/extension-work-repository.js";
import { openInstanceDataScope, verifiedLegacyInstanceMigration } from "./repository/instance-data-scope.js";
import { createApplicationExtensionApiHandler, type ApplicationExtensionApiHandler } from "./api/extension-api.js";
import { createProviderRequestAuthenticator, type ApplicationRequestAuthenticator } from "./auth/adapter.js";
import { createAccessEnforcer, type AccessEnforcer } from "./extensions/access-enforcement.js";
import {
  createProviderRegistry,
  validateRequiredProviderBootstrap,
  type ProviderRegistry
} from "./extensions/provider-registry.js";
import {
  createApplicationCanvasFacade,
  createApplicationMediaFacade,
  createApplicationTaskFacade
} from "./clients/domain-clients.js";
import {
  resolveApplicationServiceConfig,
  type ApplicationServiceConfig
} from "./config/env.js";
import { createExtensionTaskIntentRepository } from "./repository/extension-task-intent-repository.js";
import { createExtensionTaskRecovery } from "./extensions/task-recovery.js";
import { createSqliteAgentConversationStore } from "./repository/agent-conversation-repository.js";
import { createAgentAdapterRegistry } from "./extensions/agent-adapter-registry.js";
import { candidateAssistantDirectory } from "./extensions/agent-candidate-directory.js";
import { createAgentConnectionRegistry, type AgentConnectionRegistry } from "./extensions/agent-connection-registry.js";
import { createAgentConversationService, type AgentConversationService } from "./extensions/agent-conversation-service.js";
import { createAgentConversationApiHandler, type AgentConversationApiHandler } from "./api/agent-conversation-api.js";
import type {
  ApplicationBackendExtensionDefinition,
  ApplicationExtensionPrincipal,
  ApplicationExtensionServices
} from "./extensions/contract.js";

export type ApplicationServiceOptions = {
  candidateAssistantProviders?: () => readonly import("@woohaa3/contracts").FilmSetConversionProvider[];
  env?: Record<string, string | undefined>;
  storePath?: string;
  serviceToken?: string;
  /**
   * 统一宿主（`web/backend`）已完成验证/初始化的基础实现（change: 2026-10-13-...，任务 1.1）。
   *
   * 生命周期归 bootstrap 所有者；本服务只登记进自己的 registry 以服务控制面与插件宿主。
   */
  foundation?: {
    providers: import("@woohaa3/contracts").AssembledFoundationProviders;
    owners: Partial<Record<import("@woohaa3/contracts").FoundationSlot, string>> & { storage: string };
  };
  /**
   * 启动扫描固定的访问装配结果（change: 2026-10-13-...，任务 1.1）。
   *
   * 缺省按是否声明必需提供者/认证器推导：声明了即 `enabled: true`；否则保持旧实例空间
   * （`enabled: false`，用于升级前数据）。
   */
  accessRuntime?: import("@woohaa3/contracts").AccessRuntime;
  /**
   * 可信请求认证器（change: 2026-10-13-...，任务 1.3）。生产由 Identity 提供者
   * 支撑；缺省时从必需 identity provider 惰性解析。测试可注入 fake。
   */
  authenticator?: ApplicationRequestAuthenticator;
  /**
   * 统一宿主的执行边界面（与 `authenticator` 同源）；缺省按本服务 registry 自建。
   *
   * 注入时使用同一实例，避免同一进程出现两套 site-access 决策。
   */
  accessEnforcer?: AccessEnforcer;
  /**
   * 可信部署 profile：必需基础提供者按 slot 引用 extensionId（change: 2026-10-13-...，任务 1.1）。
   */
  requiredProviders?: RequiredProviderProfiles;
  /**
   * 显式注入的基础提供者（测试/受控部署）。生产由可信扩展在 activation 中登记；这里只允许
   * 显式 fake/等价实现，不引入隐式回退（change: 2026-10-13-...，design D1「测试可注入明确 fake provider」）。
   */
  seedProviders?: {
    identity?: import("@woohaa3/contracts").IdentityProvider;
    siteAccess?: import("@woohaa3/contracts").SiteAccessPolicy;
    resourceAccess?: import("@woohaa3/contracts").ResourceAccessPolicy;
    resourceLifecycle?: import("@woohaa3/contracts").ResourceLifecyclePolicy;
    resourceDirectory?: import("@woohaa3/contracts").ResourceDirectory;
  };
  taskServiceUrl?: string;
  mediaServiceUrl?: string;
  canvasServiceUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  /** 应用插件可信元数据（缺省取共享生产清单；测试可注入 fixture）。 */
  applicationExtensionMetadata?: readonly ApplicationExtensionMetadata[];
  /** 应用插件可信后端入口（缺省取生产清单；测试可注入 fixture）。 */
  applicationBackendExtensions?: readonly ApplicationBackendExtensionDefinition[];
  /**
   * 外部提供的单一生产插件宿主（change: 2026-10-08-unlock-...，任务 2.1）。
   *
   * 统一后端可先创建 Backend runtime host 并在此注入，使控制面/dispatcher 与生成注册使用同一实例；
   * 缺省时本服务自建宿主（保持既有行为）。
   */
  host?: ApplicationExtensionHost;
  /**
   * 统一的生成扩展点（design D4/2.1）：本服务创建的宿主据此提供 `registerGeneration`，
   * 使 Provider 插件在**同一宿主**内注册执行能力。缺省时不提供生成注册（只做能力拒绝）。
   */
  generation?: { register: (provider: import("@woohaa3/contracts").GenerationProvider) => void; unregister: (providerId: string) => void };
  /**
   * 统一的存储扩展点（与 `generation` 并列）：本服务创建的宿主据此提供 `registerStorage`，
   * 使站点插件在 activation 里注册的后端**直接进 core 的 `ctx.storage`**（同一份注册表，
   * media/task 通过 `bucket(namespace)` 走它）。
   *
   * 缺省时不提供存储注册：站点插件记日志跳过自己的存储能力，而不是被当成激活失败——
   * 纯本地宿主没有远端时本来就没有这个后端。
   */
  storage?: { register: (backend: import("@woohaa3/contracts").StorageBackend) => void; unregister: (backendId: string) => void };
  /**
   * 遥测出口注册面（可选）。缺省时不提供：站点插件拿不到 `host.registerTelemetryExport`，
   * 记日志跳过自己的上报能力。core 只持有注册表与总开关，不持有任何目的地配置。
   */
  telemetry?: { register: (provider: import("@woohaa3/contracts").TelemetryExport) => void; unregister: (exportId: string) => void };
  /** 受限服务 facade 覆盖（统一后端注入进程内 authoring/秘密仓库）。缺省用网络客户端 facade。 */
  servicesFor?: (extensionId: string, configVersion?: number) => ApplicationExtensionServices;
  /**
   * 只读诊断缓冲（可选）：统一后端把已脱敏的服务端接入/同步事件投影给可信扩展。
   * 缺省时不提供，插件拿不到 `host.diagnostics`（独立入口/测试保持旧行为）。
   */
  diagnostics?: import("@woohaa3/contracts").ApplicationBackendDiagnostics;
  /** 可信清单声明的固定公开路径映射（如 `/api/chatgpt/*`；design D4）。 */
  publicRoutes?: readonly import("@woohaa3/contracts").ApplicationExtensionPublicRouteMapping[];
  /**
   * 当前公开挂载路径（change: 2026-10-15-support-configurable-app-base-path）。
   * 用于派生对浏览器可见的绝对/公开 URL（外部 MCP 指引、插件 CSP 作用域）。
   */
  basePath?: string;
  /** 额外受控 handler 基路径别名（如 `/api/plugins`）；与 canonical 共用同一分派。 */
  alternateHandlerBasePaths?: readonly string[];
  /**
   * Agent 会话 API 的受控画布授权 facade（owner+canvas 隔离）
   * （change: 2026-10-12-add-agent-conversation-panel，任务 1.3）。缺省时会话 API 全部拒绝。
   */
  groupEffects?: import("./extensions/agent-conversation-service.js").AgentConversationServiceOptions["groupEffects"];
  canvasCreation?: import("@woohaa3/contracts").CanvasCreationPort;
  conversationCanvasAccess?: import("@woohaa3/contracts").ApplicationExtensionCanvasAccessFacade;
  /**
   * 内置 MCP 真实发现（change: 2026-10-12-add-agent-conversation-panel，任务 3.1）。
   *
   * 由统一后端注入 mcp-service 的 executed initialize/tools/list；缺省时 `/mcp` 返回
   * not-configured（不伪造 ready）。
   */
  mcpDiscovery?: () => Promise<import("@woohaa3/contracts").McpBuiltinDiscoveryView>;
  /**
   * 兼容默认连接解析（change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.2）。
   *
   * 旧 ChatGPT 历史/未显式选连接的请求映射为该 owner 的兼容默认连接；缺省不伪造连接身份
   * （旧历史仍按 adapter 解析，可读）。
   */
  defaultConnectionFor?: (input: { owner: string; adapterId: string }) => Promise<import("@woohaa3/contracts").AgentConnectionView | null> | import("@woohaa3/contracts").AgentConnectionView | null;
  now?: () => Date;
  logger?: (event: Record<string, unknown>) => void;
};

export type ApplicationService = {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  readiness: () => Promise<{ ready: boolean; reason?: string }>;
  close: () => Promise<void>;
  plugins: () => SiteExtensionControlPlane;
  /** 启动时的那次 reconcile 完成（站点插件已按保存的启停状态激活或停用）。 */
  ready: () => Promise<void>;
  host: () => ApplicationExtensionHost;
  config: () => ApplicationServiceConfig;
  /** 宿主 Agent 会话/回合服务（change: 2026-10-12-add-agent-conversation-panel）。 */
  agentConversations: () => AgentConversationService;
  /** 来源连接发现注册表（change: 2026-10-16-add-agent-appserver-and-sdk-connections）。 */
  agentConnections: () => AgentConnectionRegistry;
  /** 类型化基础提供者 registry（身份/站点授权/资源策略）。 */
  providers: () => ProviderRegistry;
  /** 统一执行边界（认证后的 action/资源检查）。 */
  accessEnforcer: () => AccessEnforcer;
};

export function createApplicationService(options: ApplicationServiceOptions = {}): ApplicationService {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const configResult = resolveApplicationServiceConfig({
    ...env,
    ...(options.storePath ? { WOOHAA3_APPLICATION_STORE_PATH: options.storePath } : {}),
    ...(options.serviceToken ? { WOOHAA3_APPLICATION_SERVICE_TOKEN: options.serviceToken } : {}),
    ...(options.taskServiceUrl ? { WOOHAA3_TASK_SERVICE_URL: options.taskServiceUrl } : {}),
    ...(options.mediaServiceUrl ? { WOOHAA3_MEDIA_SERVICE_URL: options.mediaServiceUrl } : {}),
    ...(options.canvasServiceUrl ? { WOOHAA3_CANVAS_SERVICE_URL: options.canvasServiceUrl } : {})
  });
  if (!configResult.ok) throw new Error(configResult.reason);
  const config = configResult.config;
  const log = options.logger ?? (() => undefined);
  // 公开挂载路径（规范化；非法在启动边界已拒绝，这里只做只读派生）。
  const deploymentBasePath = (() => {
    const result = normalizeAppBasePath(options.basePath ?? env.WOOHAA3_BASE_PATH);
    return result.ok ? result.basePath : "/";
  })();
  const now = options.now ?? (() => new Date());

  // 类型化基础提供者 registry：由可信扩展在 activation 中登记（任务 1.1）。
  const providers = createProviderRegistry();
  const requiredProviders: RequiredProviderProfiles = options.requiredProviders ?? [];
  const accessRuntime = options.accessRuntime ?? (options.foundation?.providers.identity || options.authenticator || options.seedProviders || requiredProviders.length
    ? Object.freeze({ enabled: true as const })
    : Object.freeze({ enabled: false as const, instance: openInstanceDataScope(config.storePath, verifiedLegacyInstanceMigration(config.storePath)) }));
  // 显式注入的 fake/受控提供者（测试/受控部署）；不构成隐式放行。
  if (options.seedProviders?.identity) providers.register({ slot: "identity", extensionId: "injected", providerId: options.seedProviders.identity.providerId, value: options.seedProviders.identity });
  if (options.seedProviders?.siteAccess) providers.register({ slot: "site-access", extensionId: "injected", providerId: options.seedProviders.siteAccess.policyId, value: options.seedProviders.siteAccess });
  if (options.seedProviders?.resourceAccess) providers.register({ slot: "resource-access", extensionId: "injected", providerId: options.seedProviders.resourceAccess.policyId, value: options.seedProviders.resourceAccess });
  if (options.seedProviders?.resourceLifecycle) providers.register({ slot: "resource-lifecycle", extensionId: "injected", providerId: options.seedProviders.resourceLifecycle.policyId, value: options.seedProviders.resourceLifecycle });
  if (options.seedProviders?.resourceDirectory) providers.register({ slot: "resource-directory", extensionId: "injected", providerId: options.seedProviders.resourceDirectory.directoryId, value: options.seedProviders.resourceDirectory });

  if (options.foundation?.providers.identity && options.foundation.providers.access) {
    const { providers: foundation, owners } = options.foundation;
    providers.register({ slot: "identity", extensionId: owners.identity!, providerId: foundation.identity.providerId, value: foundation.identity, bootstrap: true });
    for (const [slot, value] of [["site-access", foundation.access.site], ["resource-access", foundation.access.resource], ["resource-lifecycle", foundation.access.lifecycle]] as const) {
      providers.register({ slot, extensionId: owners.access!, providerId: value.policyId, value, bootstrap: true });
    }
    if (foundation.access.directory) {
      providers.register({ slot: "resource-directory", extensionId: owners.access!, providerId: foundation.access.directory.directoryId, value: foundation.access.directory, bootstrap: true });
    }
  }

  const metadata = options.applicationExtensionMetadata ?? [];
  // 测试可覆盖；生产直接消费可信后端清单。
  const definitions = options.applicationBackendExtensions ?? createApplicationBackendExtensionManifest().definitions;

  const extensionConfigStore = createSqliteSiteExtensionConfigStore({ path: config.storePath });
  const extensionWorkStore = createSqliteExtensionWorkRepository({ path: config.storePath });
  const taskIntentStore = createExtensionTaskIntentRepository({ path: config.storePath });
  // 宿主 Agent 会话独立存储（不写 Y.Doc，不复制 Task 事实源；design D1/D7）。
  const conversationStore = createSqliteAgentConversationStore({ path: config.storePath });

  // 统一执行边界：site-access 与 resource-access 提供者（惰性，activation 后才登记）。
  const accessEnforcer = options.accessEnforcer ?? createAccessEnforcer({
    runtime: accessRuntime,
    siteAccessPolicy: () => providers.siteAccessPolicy(),
    resourceAccessPolicy: () => providers.resourceAccessPolicy()
  });

  // 认证：注入优先；否则从必需 identity provider 惰性解析（缺失时未认证，不下沉放行）。
  const authenticator: ApplicationRequestAuthenticator =
    !accessRuntime.enabled ? async () => null : options.authenticator ??
    createProviderRequestAuthenticator(() => {
      const provider = providers.identityProvider();
      if (!provider) {
        const error = new Error("身份提供者不可用") as Error & { code?: string };
        error.code = "access-provider-unavailable";
        throw error;
      }
      return provider;
    });

  // 公共 Context 的受限服务 facade：按插件 principal 裁剪；插件拿不到服务令牌。
  // 统一后端可注入进程内 facade（servicesFor）；缺省用网络客户端 facade（保持既有行为）。
  const servicesFor = options.servicesFor ?? ((extensionId: string, configVersion?: number): ApplicationExtensionServices => {
    const committedVersion = configVersion ?? extensionConfigStore.get(extensionId)?.configVersion ?? 0;
    const principal: ApplicationExtensionPrincipal = {
      extensionId,
      configVersion: committedVersion,
      capabilities: ["tasks:submit-own", "tasks:read-own", "media:stat", "media:read", "media:write", "canvas:run"]
    };
    return {
      tasks: config.taskServiceUrl
        ? createApplicationTaskFacade(
            { baseUrl: config.taskServiceUrl, ...(config.serviceToken ? { serviceToken: config.serviceToken } : {}), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
            principal
          )
        : {
            submit: async () => ({ ok: false, code: "unavailable", message: "Task 服务未配置" }),
            status: async () => null,
            cancel: async () => null
          },
      media: config.mediaServiceUrl
        ? createApplicationMediaFacade({
            baseUrl: config.mediaServiceUrl,
            ...(config.serviceToken ? { serviceToken: config.serviceToken } : {}),
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
          }, principal)
        : { stat: async () => ({ exists: false }) },
      canvas: config.canvasServiceUrl
        ? createApplicationCanvasFacade({
            baseUrl: config.canvasServiceUrl,
            ...(config.serviceToken ? { serviceToken: config.serviceToken } : {}),
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
          })
        : {
            requestNodeRun: async () => ({ ok: false, code: "unavailable", message: "Canvas 服务未配置" }),
            requestNodeCancel: async () => ({ ok: false, code: "unavailable", message: "Canvas 服务未配置" })
          }
    };
  });

  const extensionHost = options.host ?? createApplicationExtensionHost({
    logger: options.logger,
    hostIdentity: "application",
    deployment: { basePath: deploymentBasePath },
    configFacadeFor: (extensionId) => extensionControlPlane.configFacade(extensionId),
    workFacadeFor: (extensionId) => extensionControlPlane.workFacade(extensionId),
    servicesFor,
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    registerProviderFor: () => accessRuntime.enabled ? providers : undefined,
    ...(options.generation
      ? {
          registerGenerationFor: (extensionId: string) => (provider: import("@woohaa3/contracts").GenerationProvider) => {
            if (provider.extensionId !== extensionId) {
              throw new Error(`生成 Provider extensionId 不一致：${provider.extensionId} != ${extensionId}`);
            }
            options.generation!.register(provider);
          },
          releaseGenerationFor: (_extensionId: string) => (providerId: string) => {
            options.generation!.unregister(providerId);
          }
        }
      : {}),
    ...(options.storage
      ? {
          // 存储后端直接进 core 的注册表：站点插件注册的就是 `storage.primary` / `storage.expose`
          // 能选中的那个后端，中间不做转发层（那样会出现两份「有哪些后端」的真相）。
          registerStorageFor: (_extensionId: string) => (backend: import("@woohaa3/contracts").StorageBackend) => {
            options.storage!.register(backend);
          },
          releaseStorageFor: (_extensionId: string) => (backendId: string) => {
            options.storage!.unregister(backendId);
          }
        }
      : {}),
    ...(options.telemetry
      ? {
          // 遥测出口同样直接进 core 的注册表：core 不挑选目的地，注册即参与投递
          // （总开关是 `telemetry.export.enabled`）。中间不做转发层，避免两份"有哪些出口"的真相。
          registerTelemetryExportFor: (
            _extensionId: string
          ) => (provider: import("@woohaa3/contracts").TelemetryExport) => {
            options.telemetry!.register(provider);
          },
          releaseTelemetryExportFor: (_extensionId: string) => (exportId: string) => {
            options.telemetry!.unregister(exportId);
          }
        }
      : {})
  });

  const extensionControlPlane = createSiteExtensionControlPlane({
    host: extensionHost,
    store: extensionConfigStore,
    workStore: extensionWorkStore,
    metadata: {
      list: () => metadata,
      get: (extensionId) => metadata.find((entry) => entry.extensionId === extensionId)
    },
    definitions,
    // 必需基础提供者 profile（任务 1.5）：控制面据此拒绝在线停用必需 provider。
    requiredProviders,
    ...(options.logger ? { logger: options.logger } : {}),
    now
  });

  // 宿主 Agent 会话：adapter 注册表（版本绑定）+ 会话服务（accept-before-dispatch、去重、恢复）。
  const assistantRegistryHost = candidateAssistantDirectory({
    hasCapability: (id) => extensionHost.hasCapability(id),
    resolveCapability: (id) => extensionHost.resolveCapability(id),
    resolveCapabilityOwner: (id) => extensionHost.resolveCapabilityOwner(id),
    snapshot: () => extensionHost.snapshot()
  }, options.candidateAssistantProviders ?? (() => []));
  const agentAdapterRegistry = createAgentAdapterRegistry(assistantRegistryHost);
  // 来源连接发现注册表（change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.1）：
  // 连接来自已激活扩展的 owner-scoped provider；核心不 import 厂商实现。
  const agentConnections = createAgentConnectionRegistry(assistantRegistryHost);
  const agentConversations = createAgentConversationService({
    store: conversationStore,
    groupEffects: options.groupEffects,
    groupScopeEpoch: (canvasId, rootGroupId) => canvasCreationStore.epoch(canvasId, rootGroupId),
    registry: agentAdapterRegistry,
    connections: agentConnections,
    ...(options.defaultConnectionFor ? { defaultConnectionFor: options.defaultConnectionFor } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    now: () => now().toISOString()
  });
  /**
   * 宿主会话身份统一走注入的 Identity provider（任务 1.3 / design D2）。
   *
   * 不再支持插件自报的本地会话端口：认证只经 `authenticator` 一次解析，插件不能另建 owner。
   */
  const canvasCreationStore = new CanvasCreationStore(config.storePath);
  const unbindCreationEpochs = options.canvasCreation?.bindScopeEpochStore?.({ read: (canvasId, rootGroupId) => canvasCreationStore.epoch(canvasId, rootGroupId), advance: (canvasId, rootGroupId) => canvasCreationStore.invalidate(canvasId, rootGroupId) });
  const canvasCreations = new CanvasCreationService({ store: canvasCreationStore, conversations: agentConversations, connections: agentConnections, canvas: options.canvasCreation,
    discoverTools: options.mcpDiscovery,
    preflight: async (owner, canvasId) => (await options.conversationCanvasAccess?.authorize({ subject: owner, canvasId, permission: "write" }))?.ok === true });
  const agentConversationApi: AgentConversationApiHandler = createAgentConversationApiHandler({
    service: agentConversations,
    canvasCreations,
    connections: agentConnections,
    authenticator,
    accessRuntime,
    basePath: deploymentBasePath,
    ...(options.conversationCanvasAccess ? { canvasAccess: options.conversationCanvasAccess } : {}),
    ...(options.mcpDiscovery ? { mcpDiscovery: options.mcpDiscovery } : {}),
    ...(options.logger ? { logger: options.logger } : {})
  });
  // 重启恢复：未结算回合标记 unknown 并核对 adapter 回执（不自动重推理；design D2/D7）。
  void agentConversations.reconcileUnknown().catch((error) => {
    log({ event: "agent-conversation-reconcile-failed", message: error instanceof Error ? error.message : String(error) });
  });

  // 跨进程提交意图（design D5）：在本地事务记录意图后再调用 Task；由恢复循环收尾。
  const taskRecovery = createExtensionTaskRecovery({
    intents: taskIntentStore,
    controlPlane: extensionControlPlane,
    servicesFor,
    logger: options.logger
  });

  const extensionApi: ApplicationExtensionApiHandler = createApplicationExtensionApiHandler({
    controlPlane: extensionControlPlane,
    host: extensionHost,
    authenticator,
    accessRuntime,
    accessEnforcer,
    ...(options.publicRoutes ? { publicRoutes: options.publicRoutes } : {}),
    ...(options.alternateHandlerBasePaths ? { alternateBasePaths: options.alternateHandlerBasePaths } : {}),
    ...(config.serviceToken ? { serviceToken: config.serviceToken } : {}),
    ...(options.logger ? { logger: options.logger } : {})
  });

  const healthHandler = createHealthHandler(
    () => readiness(),
    options.logger
  );

  // 启动 reconciliation（design D4/D6：commit 后崩溃由启动 reconcile 完成）。
  const initialReconcile = extensionControlPlane.reconcile().catch((error) => {
    log({ event: "application-plugin-reconcile-failed", message: error instanceof Error ? error.message : String(error) });
  });
  // 跨进程提交意图恢复循环（Task 事件只降延迟；持久化查询是最终依据）。
  const recoveryTimer = setInterval(() => void taskRecovery.sweep(), 30_000);
  recoveryTimer.unref?.();
  void taskRecovery.sweep();

  const readiness = async (): Promise<{ ready: boolean; reason?: string }> => {
    // 基础提供者 bootstrap 校验：每个必需 slot 恰有一个 owner（任务 1.2/1.5）。
    const bootstrap = validateRequiredProviderBootstrap(providers, requiredProviders, [
      ...definitions.map((definition) => definition.extensionId),
      ...Object.values(options.foundation?.owners ?? {}).filter((owner): owner is string => typeof owner === "string")
    ]);
    if (!bootstrap.ok) return { ready: false, reason: `基础提供者未就绪：${bootstrap.code}` };
    try {
      const checks = [providers.identityProvider(), providers.siteAccessPolicy(), providers.resourceAccessPolicy(), providers.resourceLifecyclePolicy(), providers.resourceDirectory()];
      if (accessRuntime.enabled && checks.some(check => !check)) return { ready: false, reason: "受控基础提供者缺失" };
      for (const check of checks) {
        if (check?.ready && !check.ready()) return { ready: false, reason: "基础提供者运行时未就绪" };
      }
    } catch { return { ready: false, reason: "基础提供者运行时故障" }; }
    return { ready: true };
  };

  return {
    handle: async (req, res) => {
      if (await agentConversationApi(req, res)) return true;
      if (await extensionApi(req, res)) return true;
      if (await healthHandler(req, res)) return true;
      return false;
    },
    readiness,
    plugins: () => extensionControlPlane,
    ready: () => initialReconcile,
    host: () => extensionHost,
    config: () => config,
    agentConversations: () => agentConversations,
    agentConnections: () => agentConnections,
    providers: () => providers,
    accessEnforcer: () => accessEnforcer,
    close: async () => {
      clearInterval(recoveryTimer);
      await extensionControlPlane.dispose();
      // 外部注入的宿主由提供方（统一后端）负责释放；本服务只释放自建宿主。
      if (!options.host) await extensionHost.dispose();
      taskIntentStore.close();
      extensionConfigStore.close();
      extensionWorkStore.close();
      unbindCreationEpochs?.();
      canvasCreationStore.close();
      conversationStore.close();
    }
  };
}

/** Application liveness/readiness（只含状态与安全原因）。 */
function createHealthHandler(
  readiness: () => Promise<{ ready: boolean; reason?: string }>,
  logger?: (event: Record<string, unknown>) => void
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/application/health/live" && req.method === "GET") {
      sendJson(res, 200, { status: "ok" });
      return true;
    }
    if (pathname === "/api/application/health/ready" && req.method === "GET") {
      const result = await readiness();
      logger?.({ event: "application-ready", status: result.ready ? 200 : 503 });
      sendJson(res, result.ready ? 200 : 503, result.ready ? { status: "ready" } : { status: "not-ready", reason: result.reason });
      return true;
    }
    return false;
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

export function extensionDocumentStorePath(storePath: string): string {
  // storePath 可能是 sqlite 文件或目录；与生成模型 store 一致地放在同目录下。
  const path = storePath.endsWith(".sqlite") || storePath.endsWith(".db")
    ? storePath.replace(/[^/\\]+$/, "extension-documents.sqlite")
    : `${storePath.replace(/[/\\]$/, "")}/extension-documents.sqlite`;
  return path;
}

export type { ApplicationServiceConfig };
export type { MediaMetadata };
