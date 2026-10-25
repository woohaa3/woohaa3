import { createSdkServiceSource, withServiceSources } from "./service-source.js";
import { homedir } from "node:os";
import path from "node:path";
import { createFixedEngineRuntime } from "./fixed-engine-runtime.js";
/**
 * sdk-agent 后端入口
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 3.1/3.3/5.1/7.1 / design D1/D3/D9）。
 *
 * 经统一后端宿主注册：
 * - 连接发现 capability `agent-connection-provider:sdk-agent`（owner-scoped 公开视图）；
 * - 会话 adapter capability（每个 adapterId 一个）；
 * - 受控 HTTP handler `/api/sdk-agent/*`（连接 CRUD、Key 保存/清除、探测与测试生成）；
 * - 可回收资源（dispose 释放缓存客户端；不删除凭据/历史）。
 *
 * **扫描加载本模块不启动任何子进程/网络连接**：只有显式连接与执行才创建资源（design D1）。
 * 四个固定引擎的传输只在 adapter 真正运行时按需构造（此处不 import 真实 SDK），
 * 且缺 CLI/Key 时返回 `runtime-missing`/`credential-missing`，不影响基础健康。
 */
import type {
  ApplicationBackendExtensionDefinition,
  ApplicationExtensionRequestContext,
  ApplicationExtensionRawRequest,
  ApplicationExtensionRawResponse,
  ApplicationUserDelegation,
  AgentConnectionProvider
} from "@woohaa3/contracts";
import { agentConnectionProviderCapabilityId, agentConversationAdapterCapabilityId, filmSetConversionCapabilityId } from "@woohaa3/contracts";
import { createConnectionService, createConnectionProvider, createAssistantFilmSetConversionProvider, redactEvent } from "@woohaa3/agent-connections";
import { SDK_AGENT_PLUGIN_ID, readAllowedHostsFromEnv, readAllowHttpFromEnv } from "../shared.js";
import { createSdkAgentDescriptors, createSdkAgentConversationAdapter } from "./sdk-agent-connections.js";
import { createSdkAgentHandler } from "./handler.js";
import { SDK_AGENT_ADAPTERS, sdkEngineForAdapter } from "../shared.js";

export type SdkAgentExtensionOptions = {
  /** 部署 env（缺省读 process.env；宿主组合注入自身生效 env）。 */
  env?: Record<string, string | undefined>;
  /** 部署允许的自定义 endpoint host 覆盖（缺省读 env）。 */
  allowedHosts?: readonly string[];
  allowHttp?: boolean;
  /** Agent SDK 隔离目录（缺省由部署 env 决定）。 */
  agentSdkDirs?: { workspaceDir: string; configDir: string };
  /** 受控 MCP 工具 endpoint。 */
  mcpServerUrl?: string;
  /** 测试注入。 */
  fetchImpl?: typeof globalThis.fetch;
};

/**
 * 解析部署配置（缺省读 env）。
 *
 * - `WOOHAA3_SDK_AGENT_ALLOWED_HOSTS`：允许的自定义 host（逗号分隔）。
 * - `WOOHAA3_SDK_AGENT_ALLOW_HTTP`：是否允许回环明文。
 * - `WOOHAA3_SDK_AGENT_WORKSPACE_DIR` / `WOOHAA3_SDK_AGENT_CONFIG_DIR`：Agent SDK 隔离目录。
 * - `WOOHAA3_SDK_AGENT_MCP_URL`：受控工具 endpoint（缺省同源 `/mcp/model-canvas`）。
 */
export function resolveSdkAgentDeployment(env: Record<string, string | undefined>): {
  allowedHosts: readonly string[] | undefined;
  allowHttp: boolean;
  agentSdkDirs: { workspaceDir: string; configDir: string } | undefined;
  mcpServerUrl: string;
} {
  const workspaceDir = (env.WOOHAA3_SDK_AGENT_WORKSPACE_DIR ?? "").trim();
  const configDir = (env.WOOHAA3_SDK_AGENT_CONFIG_DIR ?? "").trim();
  const port = (env.BACKEND_PORT ?? env.PORT ?? "5180").trim();
  return {
    allowedHosts: readAllowedHostsFromEnv(env),
    allowHttp: readAllowHttpFromEnv(env),
    agentSdkDirs: { workspaceDir: workspaceDir || path.join(homedir(), ".woohaa3", "agent-runtimes", "work"), configDir: configDir || path.join(homedir(), ".woohaa3", "agent-runtimes", "config") },
    mcpServerUrl: (env.WOOHAA3_SDK_AGENT_MCP_URL ?? "").trim() || `http://127.0.0.1:${port}/mcp/model-canvas`
  };
}

export function createSdkAgentExtension(options: SdkAgentExtensionOptions = {}): ApplicationBackendExtensionDefinition {
  return {
    extensionId: SDK_AGENT_PLUGIN_ID,
    capabilities: [
      { id: agentConnectionProviderCapabilityId(SDK_AGENT_PLUGIN_ID), kind: "capability", description: "SDK Agent 来源连接发现" },
      ...SDK_AGENT_ADAPTERS.map(adapter => ({ id: filmSetConversionCapabilityId(adapter.adapterId), kind: "capability" as const, description: `${adapter.label} film-set candidate generation` })),
      ...SDK_AGENT_ADAPTERS.map((adapter) => ({ id: agentConversationAdapterCapabilityId(adapter.adapterId), kind: "capability" as const, description: `${adapter.label} 会话适配器` }))
    ],
    activate: (host) => {
      const deployment = resolveSdkAgentDeployment(options.env ?? (process.env as Record<string, string | undefined>));
      const allowedHosts = options.allowedHosts !== undefined ? options.allowedHosts : deployment.allowedHosts;
      const allowHttp = options.allowHttp ?? deployment.allowHttp;
      const agentSdkDirs = options.agentSdkDirs ?? deployment.agentSdkDirs;
      const documents = host.services.documents;
      if (!documents) {
        host.logger({ event: "sdk-agent-disabled", reason: "宿主未配置 documents 存储" });
        return;
      }
      const service = createConnectionService({
        documents,
        runtimeVersionFor: (adapterId) => { const engine = sdkEngineForAdapter(adapterId); return engine ? `${engine.engine}@${engine.version}:1` : undefined; },
        ...(host.services.secrets ? { secrets: host.services.secrets } : {})
      });

      const releaseConsumer = host.services.serviceConnections?.registerConsumer({ protocols: ["responses", "messages", "chat-completions", "gemini"], purposes: ["discussion", "target-execution"] });
      const releaseSource = host.services.serviceConnections?.registerSource(createSdkServiceSource(service));
      const executionService = host.services.serviceConnections ? withServiceSources(service, host.services.serviceConnections) : service;

      // 停用后拒绝新回合（dispose 期间置 false）；已接受回合由宿主结算。
      let admitted = true;
      const shutdown = new AbortController();

      const mcpServerUrlOf = () => options.mcpServerUrl ?? resolveSdkAgentDeployment(options.env ?? (process.env as Record<string, string | undefined>)).mcpServerUrl;
      const runtime = agentSdkDirs ? createFixedEngineRuntime(agentSdkDirs) : undefined;
      const inFlight = new Set<Promise<unknown>>();
      const runtimeOptions = {
        ...(runtime ? { runtime } : {}),
        ...(host.services.authoring?.authoring ? { authoring: host.services.authoring.authoring } : {}),
        service: executionService,
        ...(host.services.serviceConnections ? { serviceConnections: host.services.serviceConnections } : {}),
        // 停用/排空门禁：dispose 后拒绝新回合（宿主 draining 结算已接受回合）。
        admission: () => admitted,
        shutdownSignal: shutdown.signal,
        inFlight,
        allowedHosts,
        allowHttp,
        get mcpServerUrl() {
          return mcpServerUrlOf();
        },
        ...(agentSdkDirs ? { agentSdkDirs } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(host.services.authoring?.tools ? { tools: host.services.authoring.tools } : {}),
        logger: (event: Record<string, unknown>) => host.logger(redactEvent(event))
      };

      const descriptors = createSdkAgentDescriptors({ allowedHosts, allowHttp });
      const provider: AgentConnectionProvider = createConnectionProvider({
        id: SDK_AGENT_PLUGIN_ID,
        extensionId: SDK_AGENT_PLUGIN_ID,
        service: executionService,
        descriptors
      });
      provider.migrateConnection = async ({ owner, connectionId, beforeMigration }) => {
        const record = await service.get(owner, connectionId);
        const engine = record && sdkEngineForAdapter(record.adapterId);
        if (!engine || !service.migrateRuntime) throw new Error("连接执行版本不可用");
        const result = await service.migrateRuntime(owner, connectionId, `${engine.engine}@${engine.version}:1`, beforeMigration);
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      };
      host.registerCapability({ id: agentConnectionProviderCapabilityId(SDK_AGENT_PLUGIN_ID), value: provider });

      for (const adapter of SDK_AGENT_ADAPTERS) {
        const instance = createSdkAgentConversationAdapter(adapter, runtimeOptions);
        host.registerCapability({ id: filmSetConversionCapabilityId(adapter.adapterId), value: createAssistantFilmSetConversionProvider(instance) });
        host.registerCapability({
          id: agentConversationAdapterCapabilityId(adapter.adapterId),
          value: instance
        });
      }

      const handler = createSdkAgentHandler({
        service,
        runtimeOptions,
        deployment: { allowedHosts, allowHttp, ...(agentSdkDirs ? { agentSdkDirs } : {}), get mcpServerUrl() { return mcpServerUrlOf(); }, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
        ...(host.services.authoring?.tools ? { tools: host.services.authoring.tools } : {})
      });

      const register = (route: string, method: "GET" | "POST" | "DELETE", purpose: "read" | "new-work" | "work-control" | "auth-transaction") => {
        host.registerRawHttpHandler?.({
          route,
          method,
          auth: "public",
          purpose,
          handle: async (req: ApplicationExtensionRawRequest, res: ApplicationExtensionRawResponse, context: ApplicationExtensionRequestContext) => {
            await handler.handle(req, res, context);
          }
        });
      };
      register("sdk-agent/configure", "POST", "auth-transaction");
      register("sdk-agent/connections", "GET", "read");
      register("sdk-agent/connections", "POST", "auth-transaction");
      register("sdk-agent/connections/*", "POST", "auth-transaction");
      register("sdk-agent/check", "POST", "read");
      register("sdk-agent/test-generation", "POST", "new-work");

      host.logger({ event: "sdk-agent-activated", adapters: SDK_AGENT_ADAPTERS.length, hasSecrets: Boolean(host.services.secrets) });

      return {
        dispose: async () => {
          // 停用只释放本扩展资源；保留连接配置、凭据与宿主历史（design D9）。
          admitted = false;
          releaseSource?.();
          releaseConsumer?.();
          shutdown.abort();
          await Promise.allSettled([...inFlight]);
          host.logger({ event: "sdk-agent-disposed" });
        }
      };
    }
  };
}

export type { ApplicationUserDelegation };
