import { createOAuthConnectionProvider } from "./connection-provider.js";
import { agentConnectionProviderCapabilityId } from "@woohaa3/contracts";
/**
 * ChatGPT 应用插件后端入口
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 5.1/5.2/5.3/5.4 / design D1/D2/D4）。
 *
 * 通过统一后端宿主的**受控原始 HTTP registration** 暴露 `/api/oauth-agent/*` 公开映射；宿主在进入前
 * 完成认证、Origin/CSRF 与预算校验，并把可信 dispatch 上下文（principal/sessionId）注入。实现复用
 * 既有 OAuth/凭据/Codex 编排模块；画布写入经宿主 `services.authoring` 端口（受用户委托约束），
 * 插件不直接触及 Y.Doc。
 *
 * owner 选择：优先用宿主注入的 `context.principal.subject`（生产可信用户）；无认证时的本地开发姿态
 * 由插件内 owner resolver 处理（HttpOnly 会话 cookie）。
 */
import type {
  ApplicationBackendExtensionDefinition,
  ApplicationBackendHost,
  ApplicationExtensionRequestContext,
  ApplicationExtensionRawRequest,
  ApplicationExtensionRawResponse,
  FilmSetConversionMediaReader,
  FilmSetConversionModelCandidate,
  FilmSetConversionProvider
} from "@woohaa3/contracts";
import { filmSetConversionCapabilityId } from "@woohaa3/contracts";
import { AGENT_CONVERSATION_IDENTITY_CAPABILITY_ID, agentConversationAdapterCapabilityId } from "@woohaa3/contracts";
import { AsyncLocalStorage } from "node:async_hooks";
import { OAUTH_AGENT_PLUGIN_ID, OAUTH_AGENT_PROVIDERS, type OAuthAgentProvider } from "../shared.js";
import { CHATGPT_PROVIDER_ID } from "./config.js";
import { createChatGptService, type ChatGptService, type ChatGptServiceOptions } from "./service.js";
import { CHATGPT_CONVERSION_CAPABILITIES } from "./conversion.js";
import { CHATGPT_ALLOWED_MODEL_IDS } from "./models.js";
import { createChatGptConversationAdapter, CHATGPT_CONVERSATION_ADAPTER_ID } from "./conversation-adapter.js";
import type { ChatGptCanvasPorts } from "./ports.js";

export type OAuthAgentExtensionOptions = {
  /** 服务选项覆盖（测试注入 fake SDK/fetch/端口）。 */
  serviceOptions?: Partial<ChatGptServiceOptions>;
  /** 部署是否配置了可信应用认证适配器（决定 owner 是否走本地会话 fallback）。缺省 false（本地开发）。 */
  authConfigured?: boolean;
  /** 宿主会话 owner → ChatGPT 凭据 owner 映射（缺省保留 `local:`/`principal:` 前缀，裸 subject 加 `principal:`）。 */
  conversationOwnerIdFor?: (hostOwner: string) => string;
};

/**
 * 缺省宿主会话 owner → ChatGPT 凭据 owner 映射（design D2）。
 *
 * - `local:<id>`（宿主复用本插件本地 HttpOnly 会话）原样保留，与凭据 owner 命名空间一致；
 * - `principal:<subject>` 原样保留；
 * - 裸 `subject`（历史/生产直传）映射为 `principal:<subject>`，与 adapter 缺省规则一致。
 */
export function defaultConversationOwnerIdFor(hostOwner: string): string {
  return /^(?:local|principal):/.test(hostOwner) ? hostOwner : `principal:${hostOwner}`;
}

export function createOAuthAgentExtension(options: OAuthAgentExtensionOptions = {}): ApplicationBackendExtensionDefinition {
  return {
    extensionId: OAUTH_AGENT_PLUGIN_ID,
    activate: (host) => {
      const canvasPorts = createChatGptAuthoringPorts(host);
      // 请求作用域（并发安全）：原始 HTTP 是并发的，宿主注入的 principal 只对当前请求有效；
      // 用 AsyncLocalStorage 而非模块级可变变量，避免 await 间串号（生产 owner 解析依赖它）。
      const requestContext = new AsyncLocalStorage<ApplicationExtensionRequestContext>();
      const service = createChatGptService({
        canvasPorts,
        // 部署可信认证状态：true 时 owner 只取 principal.subject；本地开发 false 时回退 HttpOnly 会话。
        authConfigured: options.authConfigured ?? false,
        // 生产可信用户来自宿主注入的 principal.subject（按请求作用域读取，不跨请求泄漏）。
        resolvePrincipalSubject: () => requestContext.getStore()?.principal?.subject ?? null,
        // 工具授权门（任务 3.6）：工具模式回合签发受控 grant，工具入口据此强制校验。
        ...(host.services.authoring?.tools ? { toolGrants: host.services.authoring.tools } : {}),
        ...options.serviceOptions
      });

      // 宿主 Agent 会话 adapter（change: 2026-10-12-add-agent-conversation-panel，任务 2.1）：
      // 复用本服务真实授权/目录/生成；注册为受控 capability，宿主 registry 按 owner/版本解析。
      // owner 映射（design D2）：宿主 `local:<id>`（本插件复用自身 HttpOnly 会话）保留原样，
      // 生产裸 principal.subject 映射为 `principal:<subject>`，与凭据 owner 命名空间一致。
      const conversationOwnerIdFor = options.conversationOwnerIdFor ?? defaultConversationOwnerIdFor;
      const conversationAdapter = createChatGptConversationAdapter({ service, ownerIdFor: conversationOwnerIdFor });
      host.registerCapability({ id: agentConversationAdapterCapabilityId(CHATGPT_CONVERSATION_ADAPTER_ID), value: conversationAdapter });
      const connectionProvider = createOAuthConnectionProvider({ service, adapter: conversationAdapter, ownerIdFor: conversationOwnerIdFor });
      host.registerCapability({ id: agentConnectionProviderCapabilityId(OAUTH_AGENT_PLUGIN_ID), value: connectionProvider });
      // Only project a model directory actually returned for this owner and authorization epoch.
      const observedModels = new Map<string, { epoch: number; models: readonly import("@woohaa3/contracts").AgentModelView[] }>();
      const readModels = conversationAdapter.models;
      conversationAdapter.models = async input => {
        const before = await connectionProvider.listConnections({ owner: input.owner });
        const result = await readModels(input);
        const after = await connectionProvider.listConnections({ owner: input.owner });
        if (!result.error && before[0] && after[0]?.credentialEpoch === before[0].credentialEpoch && after[0].status.credential.state === "ready") observedModels.set(input.owner, { epoch: after[0].credentialEpoch, models: result.models });
        return result;
      };
      const oauthSnapshot = async (owner: string) => {
        const connections = await connectionProvider.listConnections({ owner });
        return connections.map(connection => ({ legacyId: connection.connectionId, scope: "personal" as const, kind: "oauth" as const,
          name: connection.name, endpoints: [], capabilities: (observedModels.get(owner)?.epoch === connection.credentialEpoch ? observedModels.get(owner)!.models : []).flatMap(model => [
            { purpose: "discussion" as const, protocol: "provider:chatgpt-oauth" as const, modelId: model.id, imageInput: false, evidence: "adapter" as const },
            ...(connection.capabilities.tools ? [{ purpose: "target-execution" as const, protocol: "provider:chatgpt-oauth" as const, modelId: model.id, imageInput: false, evidence: "adapter" as const }] : []),
          ]),
          bindings: [{ bindingId: `oauth:${connection.connectionId}`, extensionId: OAUTH_AGENT_PLUGIN_ID, consumer: "oauth" as const,
            consumerId: connection.connectionId, purposes: ["discussion" as const, "target-execution" as const], modelKeys: (observedModels.get(owner)?.epoch === connection.credentialEpoch ? observedModels.get(owner)!.models : []).map(model => model.id) }],
          enabled: connection.status.credential.state === "ready", removed: false, locked: false,
          credentialConfigured: connection.credentialConfigured ?? false, configRevision: connection.configRevision, credentialEpoch: connection.credentialEpoch }));
      };
      const releaseSource = host.services.serviceConnections?.registerSource({ id: "chatgpt", scope: "personal", list: oauthSnapshot,
        get: async (owner, id) => (await oauthSnapshot(owner)).find(source => source.legacyId === id) ?? null });

      // 显式宿主 identity port（任务 1.3 / design D2）：把本插件自身可信的本地 HttpOnly 会话
      // 复用为宿主会话 owner，避免宿主另造浏览器 ID。生产 principal 模式返回 null。
      host.registerCapability({
        id: AGENT_CONVERSATION_IDENTITY_CAPABILITY_ID,
        value: { resolveLocalSession: (req: unknown) => service.localSessionIdentity(req as Parameters<ChatGptService["localSessionIdentity"]>[0]) }
      });

      const handleRaw = async (
        req: ApplicationExtensionRawRequest,
        res: ApplicationExtensionRawResponse,
        context: ApplicationExtensionRequestContext
      ): Promise<void> => {
        // 宿主已验证并注入可信上下文；在请求作用域内执行，owner 由 handler 的 owner resolver 统一
        // 解析（生产 principal.subject 或受控本地会话）。生成层把该 owner 携带给 Canvas 委托。
        await requestContext.run(context, () => service.handle(req as never, res as never));
      };

      // 声明式注册各公开路由的用途（design D4/D6）：draining 只拒绝 `new-work`（生成）；
      // 只读、在途控制与授权事务仍可访问。ChatGPT 属后端清单无条件激活插件，无站点配置版本，
      // 因此不接入站点级 work lease（避免未配置被误判为 disabled）。
      const register = (
        route: string,
        method: "GET" | "POST",
        purpose: "read" | "new-work" | "work-control" | "auth-transaction",
        streamBudget?: { heartbeatMs?: number; deadlineMs?: number; maxEvents?: number; maxBytes?: number }
      ) => {
        host.registerRawHttpHandler?.({
          route,
          method,
          auth: "public",
          purpose,
          stream: true,
          ...(streamBudget ? { streamBudget } : {}),
          handle: handleRaw
        });
      };
      // 公开路由按 provider 列表注册（任务 9.6 / design D11）：新增 provider 时其路由随
      // `routePrefix` 一并生成；服务/适配器仍是各 provider 自己的实现（ChatGPT 目前唯一）。
      for (const provider of OAUTH_AGENT_PROVIDERS) {
        for (const entry of oauthProviderRouteRegistrations(provider)) {
          register(entry.route, entry.method, entry.purpose, entry.streamBudget);
        }
      }

      // 「转为片场」转换提供方（change: 2026-10-13-add-node-to-film-set-shortcut，任务 2.1）：
      // 通过公共 capability 暴露本插件的视觉模型与生成端口（用宿主注入的媒体读取构造），
      // 由统一后端按 capability 组合；本插件不 import film-set，也不写画布。
      if (service.enabled) {
        host.registerCapability({
          id: filmSetConversionCapabilityId(CHATGPT_PROVIDER_ID),
          value: createChatGptConversionProvider(service)
        });
      }

      return {
        dispose: async () => {
          releaseSource?.();
          await service.close();
        }
      };
    }
  };
}

/** provider 的公开路由声明（`routePrefix` 驱动；新增 provider 自动获得同构路由）。 */
export type OAuthProviderRouteRegistration = {
  route: string;
  method: "GET" | "POST";
  purpose: "read" | "new-work" | "work-control" | "auth-transaction";
  streamBudget?: { heartbeatMs?: number; deadlineMs?: number; maxEvents?: number; maxBytes?: number };
};

export function oauthProviderRouteRegistrations(provider: OAuthAgentProvider): OAuthProviderRouteRegistration[] {
  const prefix = provider.routePrefix;
  return [
    { route: prefix, method: "GET", purpose: "read" },
    { route: `${prefix}/*`, method: "GET", purpose: "read" },
    // 生成不设总时长／输出上限；心跳维持连接，断连和显式取消仍会中止。
    { route: `${prefix}/generate`, method: "POST", purpose: "new-work", streamBudget: { heartbeatMs: 15_000, deadlineMs: 0, maxEvents: Number.POSITIVE_INFINITY, maxBytes: Number.POSITIVE_INFINITY } },
    { route: `${prefix}/cancel`, method: "POST", purpose: "work-control" },
    { route: `${prefix}/authorize/cancel`, method: "POST", purpose: "auth-transaction" },
    { route: `${prefix}/authorize/start`, method: "POST", purpose: "auth-transaction" },
    { route: `${prefix}/authorize/complete`, method: "POST", purpose: "auth-transaction" },
    { route: `${prefix}/disconnect`, method: "POST", purpose: "auth-transaction" },
    { route: `${prefix}/*`, method: "POST", purpose: "work-control" }
  ];
}

/**
 * 构造 ChatGPT 的转换提供方 capability：把已授权服务暴露为「转为片场」生成端口（媒体读取由
 * 宿主注入）。只声明 allowlist 内的视觉模型；未启用服务时不提供候选（失败不静默换 Provider）。
 */
function createChatGptConversionProvider(service: ChatGptService): FilmSetConversionProvider {
  const models: FilmSetConversionModelCandidate[] = CHATGPT_ALLOWED_MODEL_IDS.map((id) => ({
    modelKey: `${CHATGPT_PROVIDER_ID}:${id}`,
    assistant: { adapterId: CHATGPT_CONVERSATION_ADAPTER_ID, model: id },
    label: id,
    capabilities: CHATGPT_CONVERSION_CAPABILITIES,
    supports: ["image", "video"]
  }));
  return {
    providerId: CHATGPT_PROVIDER_ID,
    assistantAdapterId: CHATGPT_CONVERSATION_ADAPTER_ID,
    listModels: () => models,
    resolveCapabilities: ({ modelKey, sourceKind }) => {
      const match = modelKey ? models.find((model) => model.modelKey === modelKey) : models[0];
      if (!match || !match.supports.includes(sourceKind)) return null;
      return { modelKey: match.modelKey, capabilities: match.capabilities };
    },
    createGenerator: ({ media }: { media: FilmSetConversionMediaReader }) =>
      service.filmSetConversionGenerator(media),
    /**
     * 在宿主 HTTP 边界解析转换 owner（与 `/api/oauth-agent/*` 同源）：生产 `principal:<subject>`，
     * 本地开发受控本地会话 `local:<id>`（可能需下发新会话 cookie），公网缺认证返回 `null`。
     */
    resolveOwner: (input) => service.resolveConversionOwner(input)
  };
}

/** 把宿主 authoring 端口适配成生成层需要的 Canvas 端口（每次写入携带可信用户委托）。 */
export function createChatGptAuthoringPorts(host: ApplicationBackendHost): ChatGptCanvasPorts {
  const authoring = host.services.authoring;
  // 委托 subject = 后端可信 owner（`principal:<subject>` 或本地会话 `local:<id>`），由生成层随每次
  // 端口调用携带。这样本地开发（无宿主 principal）也能写入，且并发请求互不影响。
  const delegateFor = (ownerId: string) => {
    if (!ownerId || ownerId.trim() === "") {
      throw Object.assign(new Error("缺少可信用户委托"), { code: "unauthorized" });
    }
    return { subject: ownerId, authLevel: "authenticated" as const };
  };
  return {
    readNode: async (input) => {
      if (!input.ownerId || input.ownerId.trim() === "") {
        return { ok: false, code: "unauthorized", message: "缺少可信用户委托" };
      }
      return authoring!.authoring.readNode({ delegation: delegateFor(input.ownerId), canvasId: input.canvasId, nodeId: input.nodeId });
    },
    submitModel: async (input) => {
      const result = await authoring!.authoring.submitModel({
        delegation: delegateFor(input.ownerId),
        operationId: input.requestId,
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        source: input.source,
        ...(input.expectedModelContentHash ? { expectedModelContentHash: input.expectedModelContentHash } : {})
      });
      return result;
    },
    commitAnimation: async (input) => {
      return authoring!.authoring.commitAnimation({
        delegation: delegateFor(input.ownerId),
        operationId: input.requestId,
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        animation: input.animation,
        ...(input.clipId ? { clipId: input.clipId } : {}),
        ...(input.expectedClipHash ? { expectedClipHash: input.expectedClipHash } : {}),
        ...(input.expectedSnapshotHash ? { expectedSnapshotHash: input.expectedSnapshotHash } : {})
      });
    },
    mutateCamerasBatch: async (input) => {
      return authoring!.authoring.mutateCamerasBatch({
        delegation: delegateFor(input.ownerId),
        operationId: input.requestId,
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        mutations: input.mutations
      });
    }
  };
}

export type { ChatGptService };

// 复用既有公共导出（测试与内部模块按原路径引用）。
export * from "./public-api.js";

