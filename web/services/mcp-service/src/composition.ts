/**
 * MCP Service composition root（change: split-model-mcp-into-mcp-service）。
 *
 * 唯一职责：装配 MCP Streamable HTTP 传输面，并把工具调用代理到 Canvas 的受认证内部协议。
 * 它是**无状态**运行单元：不持有画布 / 任务 / 媒体权威，不访问数据库、Y.Doc、COS 或 provider，
 * 也不 import 任何其它服务的实现（design D3）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createModelMcpHttpHandler, listModelMcpToolNames, MODEL_MCP_HTTP_PATH, type ModelMcpHttpHandler, type ModelMcpHttpOptions, type ModelMcpDiscoveryResult } from "./model-mcp/mcp-http.js";
import { createCanvasMcpClient, type CanvasMcpClient } from "./downstream/canvas-client.js";
import { createAgentCanvasClient, type AgentCanvasClient } from "./downstream/agent-canvas-client.js";
import type { SkillStepClient } from "./downstream/skill-step-client.js";
import { createAgentAuthoringToolRegistry, type AgentAuthoringToolRegistry } from "./agent-authoring/contributions.js";

export { MODEL_MCP_HTTP_PATH };

/** Canvas 内部协议基地址。 */
export const MCP_CANVAS_URL_ENV = "WOOHAA3_CANVAS_SERVICE_URL";
/** MCP Service 调用 Canvas 内部协议时使用的服务身份令牌。 */
export const MCP_CANVAS_SERVICE_TOKEN_ENV = "WOOHAA3_MCP_TO_CANVAS_TOKEN";
/** Canvas 内部协议超时（毫秒）；预览可能较慢。 */
export const MCP_CANVAS_TIMEOUT_ENV = "WOOHAA3_MCP_CANVAS_TIMEOUT_MS";

/**
 * loopback 开发模式下使用的显式 principal（change: add-agent-canvas-authoring-mcp，任务 2.1）。
 *
 * 生产 MCP transport 必须认证外部 principal 并由认证中间件注入；本变量只在未配置生产
 * 认证时用于本地单用户开发，绝不用作多用户请求的静默默认。
 */
export const MCP_DEVELOPMENT_PRINCIPAL_ENV = "WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL";

/** 环境变量：显式声明 loopback 开发模式（允许默认画布/开发 principal 兜底）。 */
export const MCP_AGENT_LOOPBACK_MODE_ENV = "WOOHAA3_AGENT_LOOPBACK_MODE";

export type McpAgentProfile =
  | { ok: true; loopbackDevelopment: boolean }
  | { ok: false; reason: string };

/**
 * 生产启动配置校验（change: add-agent-canvas-authoring-mcp，任务 2.4）。
 *
 * 只有显式声明 loopback 开发模式时，才允许 development principal + 默认画布兜底。
 */
export function resolveMcpAgentProfile(
  env: Record<string, string | undefined>,
  developmentPrincipalId: string | undefined
): McpAgentProfile {
  const loopback = env[MCP_AGENT_LOOPBACK_MODE_ENV] === "1" || env[MCP_AGENT_LOOPBACK_MODE_ENV] === "true";
  if (loopback) return { ok: true, loopbackDevelopment: true };
  if (developmentPrincipalId) {
    return {
      ok: false,
      reason: `生产模式不得配置 ${MCP_DEVELOPMENT_PRINCIPAL_ENV}；请显式设置 ${MCP_AGENT_LOOPBACK_MODE_ENV}=1`
    };
  }
  return { ok: true, loopbackDevelopment: false };
}

export type McpServiceOptions = {
  /** Trusted plugin tool registration; request identities remain host-owned. */
  registerTools?: ModelMcpHttpOptions["registerTools"];
  extensionTools?: ModelMcpHttpOptions["extensionTools"];
  env?: Record<string, string | undefined>;
  /** 测试注入：替换下游 client。 */
  canvasClient?: CanvasMcpClient;
  /** 测试注入：替换 Agent Canvas v2 client。 */
  agentClient?: AgentCanvasClient;
  /**
   * Skill 媒体步骤续接 client（change: 2026-10-28-add-agent-skill-media-regeneration）。
   *
   * 宿主注入；缺失时不注册续接工具，能力发现声明 `continuation.available=false`。
   */
  skillClient?: SkillStepClient;
  skillAvailability?: { available: boolean; reason?: string };
  /** T11a host world-authority client; absent leaves scoped world tools unregistered. */
  assistantWorld?: import("./agent-authoring/world-tools.js").AssistantWorldToolClient;
  authoringContext?: (grant: import("@woohaa3/contracts").ApplicationToolGrant | null) => import("@woohaa3/contracts").McpToolRegistrationContext;
  enableModelMcp?: boolean;
  /**
   * MCP 工具授权校验（任务 3.6 / design D8）：请求携带 bearer 时校验工具允许集合/目标范围/预算。
   * 由统一后端注入 ChatGPT 插件使用的同一 grant registry。
   */
  toolGrant?: ModelMcpHttpOptions["toolGrant"];
  logger?: (event: Record<string, unknown>) => void;
};

export type McpService = {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  readiness: () => Promise<{ ready: boolean; reason?: string }>;
  /**
   * 内置 MCP 真实发现（change: 2026-10-12-add-agent-conversation-panel，任务 3.1）。
   *
   * `null` 表示本部署未启用模型 MCP 面（无 handler）；否则返回真实 initialize/tools/list 结果。
   * ready 只表示服务可达且注册了工具，不代表任何 owner 已有写授权。
   */
  discoverTools: () => Promise<ModelMcpDiscoveryResult | null>;
  /** 当前实际注册的 MCP 工具名（角色工具求交用；不签发授权）。 */
  toolCatalog: () => readonly string[];
  close: () => Promise<void>;
  canvasClient: CanvasMcpClient | null;
  authoringTools: AgentAuthoringToolRegistry;
};

export function createMcpService(options: McpServiceOptions = {}): McpService {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const log = options.logger ?? (() => undefined);

  const canvasClient =
    options.canvasClient ??
    (env[MCP_CANVAS_URL_ENV]
      ? createCanvasMcpClient({
          baseUrl: env[MCP_CANVAS_URL_ENV],
          ...(env[MCP_CANVAS_SERVICE_TOKEN_ENV] ? { serviceToken: env[MCP_CANVAS_SERVICE_TOKEN_ENV] } : {}),
          ...(env[MCP_CANVAS_TIMEOUT_ENV] ? { timeoutMs: Number(env[MCP_CANVAS_TIMEOUT_ENV]) } : {}),
          logger: (event) => log(event)
        })
      : null);

  const modelMcpEnabled = options.enableModelMcp ?? true;
  const developmentPrincipalId = env[MCP_DEVELOPMENT_PRINCIPAL_ENV];
  const agentClient =
    options.agentClient ??
    (canvasClient && developmentPrincipalId
      ? createAgentCanvasClient({
          baseUrl: env[MCP_CANVAS_URL_ENV] ?? "",
          principalId: developmentPrincipalId,
          ...(env[MCP_CANVAS_SERVICE_TOKEN_ENV] ? { serviceToken: env[MCP_CANVAS_SERVICE_TOKEN_ENV] } : {}),
          ...(env[MCP_CANVAS_TIMEOUT_ENV] ? { timeoutMs: Number(env[MCP_CANVAS_TIMEOUT_ENV]) } : {}),
          logger: (event) => log(event)
        })
      : null);
  // 生产启动配置校验（任务 2.4）：非显式 loopback 时不得用 development principal 兜底。
  const agentProfile = resolveMcpAgentProfile(env, developmentPrincipalId);
  // change: 2026-10-22-remove-agent-execution-limits，任务 3.4：这里的进程内固定窗口限流
  // （read 120 / write 30 / run 60 每分钟）已删除；合法 Agent 工作不再因调用频率被应用拒绝。
  const modelMcpOptions: ModelMcpHttpOptions = {
          service: canvasClient!,
          authoringTools: createAgentAuthoringToolRegistry(),
          registerTools: options.registerTools,
          extensionTools: options.extensionTools,
          ...(options.toolGrant ? { toolGrant: options.toolGrant } : {}),
          logger: (event) => log({ event: event.event, status: event.status, ...(event.code ? { code: event.code } : {}) }),
          ...(agentClient
            ? {
                agentAuthoring: {
                  client: agentClient,
                  ...(options.assistantWorld ? { world: options.assistantWorld } : {}),
                  runAvailability: { available: true },
                  ...(options.skillClient ? { skillClient: options.skillClient } : {}),
                  ...(options.skillAvailability ? { skillAvailability: options.skillAvailability } : {}),
                  ...(developmentPrincipalId ? { principalId: developmentPrincipalId } : {}),
                  audit: (event) =>
                    log({
                      event: event.event,
                      tool: event.tool,
                      ...(event.principalId ? { principalId: event.principalId } : {}),
                      ...(event.canvasId ? { canvasId: event.canvasId } : {}),
                      ...(event.requestId ? { requestId: event.requestId } : {}),
                      ...(event.code ? { code: event.code } : {}),
                      ...(event.revision !== undefined ? { revision: event.revision } : {}),
                      latencyMs: event.latencyMs,
                      ...(event.nodeCount !== undefined ? { nodeCount: event.nodeCount } : {}),
                      ...(event.edgeCount !== undefined ? { edgeCount: event.edgeCount } : {})
                    })
                }
              }
            : {})
  };
  const authoringTools = modelMcpOptions.authoringTools!;
  modelMcpOptions.authoringContext = options.authoringContext;
  const modelMcpHandler: ModelMcpHttpHandler | null =
    modelMcpEnabled && canvasClient ? createModelMcpHttpHandler(modelMcpOptions) : null;
  // 角色工具目录：与真实注册同路径，首次读取后缓存（注册无 I/O）。
  const toolCatalog = (): readonly string[] => {
    return modelMcpHandler ? listModelMcpToolNames(modelMcpOptions) : [];
  };

  const handle: McpService["handle"] = async (req, res) => {
    if (modelMcpHandler && (await modelMcpHandler.handle(req, res))) return true;
    return false;
  };

  return {
    handle,
    canvasClient,
    authoringTools,
    toolCatalog,
    readiness: async () => {
      if (!agentProfile.ok) return { ready: false, reason: agentProfile.reason };
      if (!canvasClient) return { ready: false, reason: "未配置 Canvas 内部协议地址（WOOHAA3_CANVAS_SERVICE_URL）" };
      return canvasClient.ready();
    },
    discoverTools: async () => {
      if (!agentProfile.ok) {
        return { ready: false, code: "unreachable", reason: agentProfile.reason, tools: [], checkedAt: new Date().toISOString() };
      }
      if (!modelMcpHandler) {
        return { ready: false, code: "unreachable", reason: "模型 MCP 面未启用", tools: [], checkedAt: new Date().toISOString() };
      }
      return modelMcpHandler.discover();
    },
    close: async () => {
      await modelMcpHandler?.close().catch(() => undefined);
    }
  };
}
