import { createSiteProviderSource } from "./service-connection-sources.js";
import { createAssistantTextPort } from "../../ports/assistant-text.js";
import { deriveRunIdentity } from "@woohaa3/canvas-service";
/**
 * 核心层 · application：站点插件宿主（控制面、站点配置 facade、工作 lease、公开路由分派）。
 *
 * 宿主上激活的是 ChatGPT 与站点目录里的可信后端插件；它们注册的生成 Provider 也进 `ctx.generation`。
 * 每个插件拿到的受限服务 facade（authoring / 节点 / 任务 / 媒体 / 隔离秘密仓库）在这里组装。
 */
import type {
  ApplicationBackendExtensionDefinition,
  ApplicationExtensionMetadata,
  ApplicationExtensionSecretStore,
  ApplicationExtensionServices
} from "@woohaa3/contracts";
import { TASKS_INSPECT_ACTION } from "@woohaa3/contracts";
import {
  createApplicationService,
  createCanvasSourceRegistry
} from "@woohaa3/application-service";
import type { ChatGptServiceOptions } from "@woohaa3/extension-oauth-agent/backend";
import { createBackendExtensionManifest, type LoadedExtensionHost } from "../../extensions/manifest.js";
import { resolveHostSecretStore } from "../../composition/config.js";
import { projectMcpDiscovery } from "../../mcp-discovery.js";
import { createInProcessAuthoringServices } from "../../ports/authoring-adapters.js";
import { createExtensionCanvasAccessFacade, createExtensionNodeFacade } from "../../ports/extension-nodes.js";
import { createBackendRuntime } from "../../runtime/backend-runtime.js";
import { createSiteGate } from "./site-gate.js";
import { DEFAULT_ACTIVATION_TIMEOUT_MS, boundedTimeout } from "../extensions/deadline.js";
import { internalModelMcpEndpoint } from "./model-mcp-url.js";
import type { ApplicationModule, HostContext, HostPlugin } from "../context.js";
import { ROUTE_ORDER } from "../order.js";

export type ApplicationPluginConfig = {
  env: Record<string, string | undefined>;
  /** 公开挂载路径（已规范化）。 */
  basePath: string;
  applicationExtensionMetadata?: readonly ApplicationExtensionMetadata[];
  applicationBackendExtensions?: readonly ApplicationBackendExtensionDefinition[];
  chatgptServiceOptions?: ChatGptServiceOptions;
  /** 启动期扩展宿主：扩展元数据、公开路由与扩展层插件的唯一来源。 */
  extensionHost?: LoadedExtensionHost;
  /** 扩展层插件名；其中有站点元数据的由插件管理里的开关启停。 */
  treeExtensions?: readonly string[];
  /** 本次启动的安全模式（D7）；缺省表示正常启动。 */
  safeMode?: import("@woohaa3/contracts").HostSafeModeView;
};

/**
 * 隔离秘密仓库：部署配置提供目录与主密钥（change: 2026-10-16-...，任务 1.2 / design D4）。
 *
 * 通用配置 `WOOHAA3_PLUGIN_SECRET_DIR` + `WOOHAA3_PLUGIN_SECRET_MASTER_KEY` 优先；缺失时兼容
 * 旧 ChatGPT 配置。两侧都配置且不一致时拒绝凭据操作（绝不静默换密钥）；未配置返回 null，
 * 插件按能力拒绝，不静默回退到内存。
 */
function resolveSecretStore(
  env: Record<string, string | undefined>,
  log: (event: Record<string, unknown>) => void
): {
  forExtension: (extensionId: string) => ApplicationExtensionSecretStore;
} | null {
  const resolved = resolveHostSecretStore(env);
  if (!resolved.ok) {
    if (resolved.code === "conflict") log({ event: "plugin-secret-config-conflict", message: resolved.message });
    return null;
  }
  return resolved.store;
}

function createServicesFactory(
  ctx: HostContext,
  env: Record<string, string | undefined>,
  foundationStorage: import("@woohaa3/contracts").StorageProvider | null
) {
  const secrets = resolveSecretStore(env, ctx.log.scope("application"));
  const { canvas, task, media, toolGrants } = ctx;
  const accessEnforcer = ctx.access.accessEnforcer;
  return (extensionId: string, configVersion = 0): ApplicationExtensionServices => ({
    // storage 槽位的 owner-scoped 文档存储：宿主注册的基础实现按 extensionId 隔离，
    // 缺失时插件 fail closed（不伪造内存实现）。
    ...(foundationStorage?.documents.forExtension(extensionId) ? { documents: foundationStorage.documents.forExtension(extensionId)! } : {}),
    extensionNodes: createExtensionNodeFacade(canvas, extensionId),
    canvasAccess: createExtensionCanvasAccessFacade(canvas),
    // 受限任务监控 facade（显式请求监控能力的可信扩展消费）：查询前用站点策略重查 `tasks.inspect`
    // （恢复自迁移前的统一后端装配）。
    taskInspection: task.taskInspection((principal) => accessEnforcer.assertAction(principal, TASKS_INSPECT_ACTION)),
    tasks: task.port().extensionTasks?.(extensionId, configVersion) ?? {
      submit: async () => ({ ok: false, code: "unavailable" as const, message: "缺少扩展任务端口" }),
      status: async () => null,
      cancel: async () => null
    },
    media: {
      resources: media.port().resources,
      stat: async (storageKey: string) => {
        const result = await media.port().verify(storageKey);
        return { exists: result.exists, ...(result.metadata?.contentType ? { contentType: result.metadata.contentType } : {}) };
      },
      verify: async (storageKey: string, canvasId?: string) => {
        const result = await media.port().verify(storageKey, undefined, canvasId ? { canvasId } : undefined);
        return result.exists && result.metadata ? { exists: true, metadata: result.metadata } : { exists: false };
      }
    },
    canvas: {
      requestNodeRun: async () => ({ ok: false as const, code: "unavailable", message: "统一后端暂不提供插件 Canvas run facade" }),
      requestNodeCancel: async () => ({ ok: false as const, code: "unavailable", message: "统一后端暂不提供插件 Canvas run facade" }),
      // 登录/登出远端后，插件用它把「同步上游」重新解析到新会话（宿主不轮询扩展状态）。
      refreshSyncUpstream: () => canvas.refreshUpstream(),
      // 「同步远端」显式动作：文档链路建立后，立刻对账并补传画布媒体（进度由目录徽标表达）。
      syncCanvasMedia: (canvasId: string) => canvas.syncCanvasMedia(canvasId)
    },
    authoring: createInProcessAuthoringServices({
      canvas,
      mediaSign: async (storageKey, expiresSeconds) => {
        try {
          return { ok: true as const, url: await media.port().sign(storageKey, expiresSeconds) };
        } catch (error) {
          return { ok: false as const, message: error instanceof Error ? error.message : "签名失败" };
        }
      },
      toolGrantRegistry: toolGrants,
      logger: (event) => ctx.log.scope("authoring")({ extensionId, ...event })
    }),
    ...(secrets ? { secrets: secrets.forExtension(extensionId) } : {})
  });
}

export const applicationPlugin: HostPlugin<ApplicationPluginConfig> = {
  name: "application",
  // `storage` 也在 inject 里：站点插件可以把它注册的存储后端交给 core 的 `ctx.storage`
  // （core 层先装载 storagePlugin，因此这里一定拿得到注册表）。
  // 诊断缓冲**不**进 inject：它来自基础层，但 application 在独立入口/测试里可能只装配核心层。
  // 用 `ctx.get` 懒取，缺失时照常工作（扩展拿不到 host.diagnostics），不让整个 application 卡住。
  inject: ["log", "config", "gateway", "access", "canvas", "task", "media", "mcp", "toolGrants", "generation", "storage", "telemetry"],
  async apply(ctx, config) {
    const { env } = config;
    // 用 get 而不是属性访问：诊断是可选能力，独立入口/测试可能没有装载它；
    // 缺失时 application 服务照常工作，扩展拿不到 `host.diagnostics`。
    const diagnostics = ctx.get("diagnostics");
    // 企业访问接缝：认证器、具名 action 执行边界与基础提供者槽位（任务 1.1–1.5）。
    const { runtime: accessRuntime, authenticator, accessEnforcer, seedProviders, requiredProviders, foundationStorage } = ctx.access;
    // Agent 来源扩展由启动期目录扫描提供；宿主只注入部署 env 与受控 MCP 工具 endpoint。
    // 回环直连本进程，但仍受应用挂载前缀约束：子路径部署必须带上 `config.basePath`，
    // 否则 MCP 404，本机 Agent 会表现为“没有画布工具”。
    const mcpEndpoint = internalModelMcpEndpoint(env, config.basePath);
    const manifest = createBackendExtensionManifest([], config.extensionHost);
    const definitions = config.applicationBackendExtensions ?? (config.extensionHost
      ? await config.extensionHost.createDefinitions({
          // 目录扫描按 extensionId 传 options；本地开发也始终给可信 owner 主体。
          'oauth-agent': { authConfigured: true, serviceOptions: { ...config.chatgptServiceOptions, deploymentBasePath: config.basePath } },
          'sdk-agent': { env, get mcpServerUrl() { return mcpEndpoint.url; } },
          'local-agent': { env, mcpEndpoint }
        }, { excludeHostPlugins: true })
      : manifest.definitions);
    const metadata = config.applicationExtensionMetadata ?? manifest.metadata;
    /**
     * 由控制面启停的扩展集合（去重；同一 extensionId 可能同时来自 provider metadata 与站点目录）。
     *
     * 只有**声明了后端入口**的扩展需要控制面激活/停用；`hostPlugin`（Provider / 存储后端）自带
     * `Config` schema 与装配入口，启停跟着配置段走，不再绕进控制面
     * （概念对齐：扩展不按 site/host 分家，但「有没有可激活的后端实例」仍是客观差异）。
     */
    const siteIds = selectControlPlaneExtensionIds({
      metadataIds: metadata.map((entry) => entry.extensionId),
      definitionIds: definitions.map((definition) => definition.extensionId),
      pluginIds: config.treeExtensions ?? [],
      declaresSiteIds: config.extensionHost?.siteExtensionIds ?? []
    });
    // 启停由控制面管理：只登记本次装配里**有后端入口**的扩展；开关即 acquire/release，运行中生效。
    const siteGate = createSiteGate((config.treeExtensions ?? []).filter((name) => siteIds.has(name)));
    const servicesFor = createServicesFactory(ctx, env, foundationStorage);
    const { generation, mcp, storage } = ctx;

    const sourceSecrets = resolveSecretStore(env, ctx.log.scope("service-connections"));
    /**
     * Skill 媒体续接的宿主接线
     * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 3.1 / 4.1）。
     *
     * Canvas 保持 run/cancel/status/output 的任务权威；Application Service 只保存步骤尝试
     * ledger。两者都在本进程，经 `ctx.canvas.mcpServices().agent.runAdapter` 直连，不引入
     * 服务间 import 或第二套 Provider 调用。
     */
    const canvasAgent = () => ctx.canvas.mcpServices().agent;
    const skillMedia = {
      deriveRunId: (input: { canvasId: string; nodeId: string; requestId: string }) =>
        deriveRunIdentity(input.canvasId, input.nodeId, input.requestId).runId,
      authorize: async (input: {
        owner: string;
        canvasId: string;
        permission: "read" | "write";
        nodeId?: string;
      }) => {
        const agent = canvasAgent();
        const decision = await agent?.authorizeCanvas({ principalId: input.owner, canvasId: input.canvasId, permission: input.permission });
        if (decision && !decision.ok) return { ok: false as const, code: decision.code, message: decision.message };
        return { ok: true as const };
      },
      canvas: {
        run: async (input: {
          owner: string;
          canvasId: string;
          nodeId: string;
          requestId: string;
          runId: string;
          skill: import("@woohaa3/contracts").SkillMediaRunRef;
          modelKey?: string;
          prompt?: string;
          parameters?: Record<string, unknown>;
        }) => {
          const adapter = canvasAgent()?.runAdapter;
          if (!adapter) return { ok: false as const, code: "run-unavailable", message: "本部署未启用节点执行" };
          return adapter.run({
            owner: input.owner,
            canvasId: input.canvasId,
            nodeId: input.nodeId,
            requestId: input.requestId,
            runId: input.runId,
            skill: input.skill,
            ...(input.modelKey !== undefined ? { modelKey: input.modelKey } : {}),
            ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
            ...(input.parameters !== undefined ? { parameters: input.parameters } : {})
          });
        },
        cancel: async (input: { owner: string; canvasId: string; nodeId: string; runId: string }) => {
          const adapter = canvasAgent()?.runAdapter;
          if (!adapter) return { ok: false as const, code: "run-unavailable", message: "本部署未启用节点执行" };
          return adapter.cancel({ owner: input.owner, canvasId: input.canvasId, nodeId: input.nodeId, runId: input.runId });
        },
        status: async (input: {
          owner: string;
          canvasId: string;
          nodeId: string;
          runId: string;
          waitMs?: number;
          skill?: import("@woohaa3/contracts").SkillMediaRunRef;
        }) => {
          const adapter = canvasAgent()?.runAdapter;
          if (!adapter) return { ok: false as const, code: "run-unavailable", message: "本部署未启用节点执行" };
          return adapter.status({
            owner: input.owner,
            canvasId: input.canvasId,
            nodeId: input.nodeId,
            runId: input.runId,
            ...(input.waitMs !== undefined ? { waitMs: input.waitMs } : {}),
            ...(input.skill !== undefined ? { skill: input.skill } : {})
          });
        },
        output: async (input: { owner: string; canvasId: string; nodeId: string; runId: string }) => {
          const adapter = canvasAgent()?.runAdapter;
          if (!adapter) return { ok: false as const, code: "run-unavailable", message: "本部署未启用节点执行" };
          return adapter.output({ canvasId: input.canvasId, nodeId: input.nodeId, runId: input.runId });
        }
      }
    };
    const allowedSourceHosts = new Set([
      "api.openai.com", "api.anthropic.com", "api.deepseek.com", "generativelanguage.googleapis.com",
      ...(env.WOOHAA3_SDK_AGENT_ALLOWED_HOSTS ?? "").split(",").map(host => host.trim()).filter(Boolean),
    ]);
    const service = createApplicationService({
      // The Agent Runtime Supervisor outlives this watched backend.  Preserve
      // unresolved turns while the backend reconnects instead of converting a
      // lost in-process receipt into a terminal failure.
      ...(env.WOOHAA3_AGENT_RUNTIME_SOCKET ? { preserveUnreconciledOnRestart: true } : {}),
      serviceConnectionProviders: () => generation.list(),
      serviceConnectionSources: {
        ...(sourceSecrets ? { secrets: sourceSecrets.forExtension("@service-connections") } : {}),
        checkEndpoint: (raw) => {
          try {
            const url = new URL(raw);
            const configuredHosts = env.WOOHAA3_SDK_AGENT_ALLOWED_HOSTS?.trim();
            const protocolAllowed = url.protocol === "https:" || env.WOOHAA3_SDK_AGENT_ALLOW_HTTP === "1" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
            return protocolAllowed && !url.username && !url.password && !url.search && !url.hash && (!configuredHosts || configuredHosts === "*" || [...allowedSourceHosts].some(host => host === url.hostname || host.startsWith("*.") && url.hostname.endsWith(host.slice(1)) && url.hostname !== host.slice(2)));
          } catch { return false; }
        },
        hasUnresolvedWork: (_owner, bindings) => bindings.some(binding => binding.consumer === "provider") && ctx.task.history().listUnsettled(1).length > 0,
        // Source consumers must explicitly register evidence before any credential use.
        // No installed global Provider implicitly acquires access to personal sources.
        validateBinding: () => false,
      },

      mediaFormats: ctx.media.formats,
      skillMedia,
      env,
      accessRuntime,
      authenticator,
      accessEnforcer,
      seedProviders,
      requiredProviders,
      ...(ctx.access.foundation ? { foundation: ctx.access.foundation } : {}),
      // 控制面的 catalog 只含「有后端入口」的扩展：provider/存储后端自带 Config 与装配入口，
      // 启停跟着配置段走；把它们列进控制面却没有定义可激活，只会被投影成 failed。
      applicationExtensionMetadata: metadata.filter((entry) => siteIds.has(entry.extensionId)),
      applicationBackendExtensions: [...definitions, ...siteGate.definitions],
      // 版本激活时限（D4）：按调用现取宿主设置，热更新生效；取值有界。
      extensionActivationTimeoutMs: () =>
        boundedTimeout(ctx.get("config")?.get("extensions.activationTimeoutMs" as never), DEFAULT_ACTIVATION_TIMEOUT_MS),
      // 启停的事实来源是配置文件（`extensions.<id>.enabled`）：控制面读它、写它也走它，
      // 配置文件变化经 settings 热重载后再 reconcile。SQLite 只保留版本快照（任务恢复用）。
      extensionToggles: {
        all: () => ctx.get("config")?.extensionToggles() ?? {},
        async set(extensionId, enabled) {
          const settings = ctx.get("config");
          if (!settings) return { ok: false as const, message: "配置服务不可用" };
          const outcome = await settings.setExtensionToggle(extensionId, enabled);
          return outcome.ok ? { ok: true as const } : { ok: false as const, message: "配置写入失败" };
        },
        // 配置文件变化（含手工编辑）热重载后通知控制面重新协调。
        subscribe(listener) {
          const settings = ctx.get("config");
          if (!settings) return () => undefined;
          return settings.subscribe(["extensions"], () => listener());
        },
        // 扩展自己的配置值：`extensions.<id>.*` 去掉启停键，由扩展的 Config 解释。
        values(extensionId) {
          const section = ctx.get("config")?.section(`extensions.${extensionId}`) ?? {};
          const { enabled: _enabled, ...rest } = section as Record<string, unknown>;
          return rest;
        }
      },
      // 安全模式（D7）：扫描期已跳过装配的扩展，控制面把它们投影为 suspended，不改写 desiredEnabled。
      ...(config.safeMode || config.extensionHost?.safeMode
        ? { suspendedExtensions: new Set([...(config.safeMode?.suspended ?? []), ...(config.extensionHost?.safeMode?.suspended ?? [])]) }
        : {}),
      publicRoutes: manifest.publicRoutes,
      // 发布目录指针随状态快照/增量返回（change: 2026-10-21-add-extension-marketplace-point，6.2）。
      ...(config.extensionHost?.browserRelease
        ? {
            extensionRelease: () => {
              const release = config.extensionHost?.browserRelease;
              return release ? { releaseId: release.releaseId, href: release.href } : null;
            }
          }
        : {}),
      generation: {
        register: (provider) => {
          generation.register(provider);
        },
        unregister: (providerId) => generation.unregister(providerId)
      },
      // 存储扩展点：站点插件注册的后端直接进 core 的注册表。`unregister` 本身幂等，
      // 所以宿主回滚与插件显式注销可以走同一条路，不必在两边各记一份状态。
      storage: {
        register: (backend) => {
          storage.register(backend);
        },
        unregister: (backendId) => storage.unregister(backendId)
      },
      // 对外地址提供者：独立的注册面，站点插件可以只提供地址（例如 CDN 回源签名）而不提供后端。
      exposer: {
        register: (item) => {
          ctx.exposer.register(item);
        },
        unregister: (exposerId) => ctx.exposer.unregister(exposerId)
      },
      // 遥测出口：与存储同形，但语义是"注册即参与投递"。core 不知道目的地，
      // 只按 `telemetry.export.enabled` 决定发不发（见 design D8）。
      telemetry: {
        register: (provider) => {
          ctx.telemetry.registerExport(provider);
        },
        unregister: (exportId) => ctx.telemetry.unregisterExport(exportId)
      },
      // 市场来源（change: 2026-10-21-add-server-extension-marketplace，D6）：按扩展的扫描来源取
      // `ctx.marketplace.scoped(origin)`，非内置根 / 无来源记录的站点扩展注册即被拒。
      ...(ctx.get("marketplace")
        ? {
            marketplace: {
              register: (extensionId: string, source: import("@woohaa3/contracts").MarketplaceSource) => {
                ctx.get("marketplace")!.scoped(siteExtensionOrigin(config.extensionHost, extensionId)).register(source);
              },
              unregister: (sourceId: string) => ctx.get("marketplace")?.unregister(sourceId)
            }
          }
        : {}),
      servicesFor,
      // 诊断缓冲只读投影：remote-server 扩展用它在调试窗口里展示接入过程。
      ...(diagnostics ? { diagnostics } : {}),
      // 宿主 Agent 会话的受控画布授权（owner + canvas 隔离）。
      assistantText: createAssistantTextPort(ctx.canvas, { verify: ctx.media.port().verify, read: async (storageKey, canvasId) => {
        const result = await ctx.media.port().resources!.read!(storageKey, canvasId);
        return result;
      } }),
      conversationCanvasAccess: createExtensionCanvasAccessFacade(ctx.canvas),
      // 内置 MCP 的真实发现结果；缺工具/不可达/协议错误分别带原因，不伪造 ready。
      mcpDiscovery: async () => projectMcpDiscovery(await mcp.discoverTools()),
      logger: ctx.log.scope("application")
    });
    ctx.effect(() => () => service.close());

    const host = service.host();
    const sourceRegistry = createCanvasSourceRegistry({
      hasCapability: (id) => host.hasCapability(id),
      resolveCapability: (id) => host.resolveCapability(id),
      resolveCapabilityOwner: (id) => host.resolveCapabilityOwner(id),
      snapshot: () => host.snapshot()
    });
    const runtime = createBackendRuntime({
      // 站点目录里的插件由控制面按版本启停，runtime 只激活其余的可信后端插件。
      definitions: definitions.filter((definition) => !siteIds.has(definition.extensionId)),
      generation,
      host,
      logger: ctx.log.scope("cordis")
    });
    const module: ApplicationModule = { service, runtime, definitions, sourceRegistry, siteGate, safeMode: config.safeMode ?? null };
    ctx.provide("application", module);
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.application, (req, res) => service.handle(req, res)));
    await runtime.activate();
    const releases: Array<() => void> = [];
    // Provider settings are registered by the extension layer after this core plugin starts.
    // Wait for all layers, then keep adapters reading the current settings/provider instances.
    ctx.on("host/ready", () => {
      for (const plugin of ctx.config.plugins()) {
        if (!plugin.configPrefix?.startsWith("providers.")) continue;
        const providerId = plugin.configPrefix.slice("providers.".length);
        const extensionId = generation.resolve(providerId)?.extensionId ?? plugin.id;
        const release = service.serviceConnections()?.forExtension(extensionId).registerSource(createSiteProviderSource({
          providerId, extensionId, label: plugin.label, prefix: plugin.configPrefix, settings: ctx.config,
          provider: () => generation.resolve(providerId),
        }));
        if (release) releases.push(release);
        const provider = generation.resolve(providerId);
        if (provider?.serviceConnectionFactory) {
          const releaseConsumer = service.serviceConnections()?.forExtension(extensionId).registerConsumer({
            protocols: [`provider:${provider.providerId}`, ...provider.serviceConnectionFactory.protocols], purposes: ["text", "image", "video", "audio"],
          });
          if (releaseConsumer) releases.push(releaseConsumer);
        }
      }
    });
    ctx.effect(() => () => { for (const release of releases) release(); });
  }
};

/**
 * 谁能进控制面 catalog（`siteIds`）。
 *
 * 判据是**可激活**，不是「有 metadata」：
 * - 有后端定义 → 能按定义激活（`oauth-agent` 这类没有 `site` 段也算）；
 * - 只有 `hostPlugin` → 必须**同时**声明 `site`（`remote-server` 这类），才是受开关管理的站点扩展。
 *
 * 两个反例必须挡住，否则面板会出现不该有的行：
 * - Provider 也导出 metadata（模型目录），只靠 metadata 会把它误判成受管扩展；
 * - 纯前端扩展（如市场示例插件）没有可激活的入口，进了 catalog 只会永远停在 `configuring`，
 *   面板显示成「正在应用…」。
 */
export function selectControlPlaneExtensionIds(input: {
  metadataIds: readonly string[];
  definitionIds: readonly string[];
  pluginIds: readonly string[];
  declaresSiteIds: readonly string[];
}): Set<string> {
  const definitionIds = new Set(input.definitionIds);
  const pluginIds = new Set(input.pluginIds);
  const declaresSiteIds = new Set(input.declaresSiteIds);
  return new Set(
    input.metadataIds.filter(
      (id) => definitionIds.has(id) || (pluginIds.has(id) && declaresSiteIds.has(id))
    )
  );
}

/**
 * 站点扩展的扫描来源（D6）：取扩展宿主 registrations 里同 id 记录的 `managed` / `rootWritable`。
 * 找不到记录（测试注入的定义、未经扫描的扩展）返回 undefined，由 `scoped` 按「缺少来源」拒绝。
 */
export function siteExtensionOrigin(
  host: { registrations?: readonly { extensionId: string; managed?: boolean; rootWritable?: boolean }[] } | undefined,
  extensionId: string
): import("./marketplace.js").HostPluginOrigin | undefined {
  const record = host?.registrations?.find((entry) => entry.extensionId === extensionId);
  return record ? { managed: record.managed === true, rootWritable: record.rootWritable === true } : undefined;
}
