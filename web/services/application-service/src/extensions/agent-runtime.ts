/**
 * Agent 会话装配：共用宿主认证，恢复未结算回合，保留原有画布授权。
 *
 * change: 2026-10-16-add-agent-appserver-and-sdk-connections（任务 2.1/2.3）：同时装配来源连接
 * 发现注册表；连接来自各已激活扩展的 owner-scoped provider，核心不 import 厂商实现。
 */
import type { ApplicationExtensionCanvasAccessFacade, AgentConnectionView, McpBuiltinDiscoveryView } from "@woohaa3/contracts";
import type { ApplicationRequestAuthenticator } from "../auth/adapter.js";
import type { AgentConversationStore } from "../repository/agent-conversation-repository.js";
import type { ApplicationExtensionHost } from "./host.js";
import { createAgentAdapterRegistry } from "./agent-adapter-registry.js";
import { createAgentConnectionRegistry } from "./agent-connection-registry.js";
import { createAgentConversationService } from "./agent-conversation-service.js";
import { createAgentConversationApiHandler } from "../api/agent-conversation-api.js";

export function createAgentRuntime(options: {
  basePath?: string;
  host: ApplicationExtensionHost;
  store: AgentConversationStore;
  authenticator: ApplicationRequestAuthenticator;
  canvasAccess?: ApplicationExtensionCanvasAccessFacade;
  mcpDiscovery?: () => Promise<McpBuiltinDiscoveryView>;
  /** 兼容默认连接解析（旧数据/未显式选连接时）；缺省不伪造连接身份。 */
  defaultConnectionFor?: (input: { owner: string; adapterId: string }) => Promise<AgentConnectionView | null> | AgentConnectionView | null;
  now: () => Date;
  logger: (event: Record<string, unknown>) => void;
}) {
  const registry = createAgentAdapterRegistry({
    hasCapability: id => options.host.hasCapability(id),
    resolveCapability: id => options.host.resolveCapability(id),
    resolveCapabilityOwner: id => options.host.resolveCapabilityOwner(id),
    snapshot: () => options.host.snapshot()
  });
  const connections = createAgentConnectionRegistry({
    hasCapability: id => options.host.hasCapability(id),
    resolveCapability: id => options.host.resolveCapability(id),
    resolveCapabilityOwner: id => options.host.resolveCapabilityOwner(id),
    snapshot: () => options.host.snapshot()
  });
  const service = createAgentConversationService({
    store: options.store,
    registry,
    connections,
    ...(options.defaultConnectionFor ? { defaultConnectionFor: options.defaultConnectionFor } : {}),
    logger: options.logger,
    now: () => options.now().toISOString()
  });
  const api = createAgentConversationApiHandler({
    basePath: options.basePath, service, authenticator: options.authenticator, canvasAccess: options.canvasAccess,
    connections, mcpDiscovery: options.mcpDiscovery, logger: options.logger
  });
  void service.reconcileUnknown().catch(error => {
    options.logger({ event: "agent-conversation-reconcile-failed", message: error instanceof Error ? error.message : String(error) });
  });
  return { service, api, connections };
}
