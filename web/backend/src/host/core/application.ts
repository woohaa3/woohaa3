import { createCanvasCreationPort } from "../../ports/canvas-creation.js";
import { createGroupEffects } from "../../ports/group-effects.js";
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
import { internalModelMcpUrl } from "./model-mcp-url.js";
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
  inject: ["log", "gateway", "access", "canvas", "task", "media", "mcp", "toolGrants", "generation", "storage", "telemetry"],
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
    const mcpServerUrl = internalModelMcpUrl({
      port: env.BACKEND_PORT ?? env.PORT ?? "5180",
      basePath: config.basePath
    });
    const manifest = createBackendExtensionManifest([], config.extensionHost);
    const definitions = config.applicationBackendExtensions ?? (config.extensionHost
      ? await config.extensionHost.createDefinitions({
          // 目录扫描按 extensionId 传 options；本地开发也始终给可信 owner 主体。
          'oauth-agent': { authConfigured: true, serviceOptions: { ...config.chatgptServiceOptions, deploymentBasePath: config.basePath } },
          'sdk-agent': { env, mcpServerUrl },
          'local-agent': { env, mcpEndpoint: { name: "woohaa", url: mcpServerUrl } }
        }, { excludeHostPlugins: true })
      : manifest.definitions);
    const metadata = config.applicationExtensionMetadata ?? manifest.metadata;
    const siteIds = new Set(metadata.map((entry) => entry.extensionId));
    // 启停由站点控制面管理：本次装配的扩展层 Cordis 插件（站点插件与 hostPlugin Provider/存储）
    // 都在可信清单里，因此统一登记到 gate；开关即 acquire/release，运行中生效。
    const siteGate = createSiteGate((config.treeExtensions ?? []).filter((name) => siteIds.has(name)));
    const servicesFor = createServicesFactory(ctx, env, foundationStorage);
    const { generation, mcp, storage } = ctx;

    const service = createApplicationService({
      env,
      accessRuntime,
      authenticator,
      accessEnforcer,
      seedProviders,
      requiredProviders,
      ...(ctx.access.foundation ? { foundation: ctx.access.foundation } : {}),
      applicationExtensionMetadata: metadata,
      applicationBackendExtensions: [...definitions, ...siteGate.definitions],
      publicRoutes: manifest.publicRoutes,
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
      // 遥测出口：与存储同形，但语义是"注册即参与投递"。core 不知道目的地，
      // 只按 `telemetry.export.enabled` 决定发不发（见 design D8）。
      telemetry: {
        register: (provider) => {
          ctx.telemetry.registerExport(provider);
        },
        unregister: (exportId) => ctx.telemetry.unregisterExport(exportId)
      },
      servicesFor,
      // 诊断缓冲只读投影：remote-server 扩展用它在调试窗口里展示接入过程。
      ...(diagnostics ? { diagnostics } : {}),
      // 宿主 Agent 会话的受控画布授权（owner + canvas 隔离）。
      canvasCreation: createCanvasCreationPort(ctx.canvas),
      candidateAssistantProviders: () => ctx.generation.conversions(),
      groupEffects: createGroupEffects(ctx.canvas, ctx.toolGrants),
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
    const module: ApplicationModule = { service, runtime, definitions, sourceRegistry, siteGate };
    ctx.provide("application", module);
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.application, (req, res) => service.handle(req, res)));
    await runtime.activate();
  }
};
