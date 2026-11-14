/**
 * Model Canvas MCP HTTP：工具服务端口、选项与依赖类型
 * （自 `mcp-http.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R11）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/server";
import type {
  CanvasCommand,
  McpApplyCommandsResult,
  McpGetNodeResult,
  McpListNodesResult,
  McpModelStatisticsResult,
  McpRenderPreviewResult,
  McpSubmitScriptResult,
  SupportedModelScriptVersion
} from "@woohaa3/contracts";
import type { AgentAuthoringToolDeps } from "../agent-authoring/tools.js";

export const MODEL_MCP_HTTP_PATH = "/mcp/model-canvas";

/**
 * MCP 工具依赖的能力面。由 `mcp-service` 的下游 client（调用 Canvas 内部协议）实现；
 * 测试可注入最小替身。工具本身**不**持有任何画布权威。
 */
export type ModelMcpToolService = {
  getModelNodes?: (input: import("@woohaa3/contracts").GetModelNodesInput) => Promise<import("@woohaa3/contracts").ModelNodesOutcome>;
  validateScripts?: (input: import("@woohaa3/contracts").ModelScriptBatchRequest) => Promise<import("@woohaa3/contracts").ModelScriptBatchOutcome>;
  submitScripts?: (input: import("@woohaa3/contracts").ModelScriptBatchRequest) => Promise<import("@woohaa3/contracts").ModelScriptBatchOutcome>;

  getModelNode: (input: { canvasId: string; nodeId: string; includeStatistics?: boolean }) => Promise<McpGetNodeResult>;
  /** 当前或候选脚本的模型规模（与聚焦信息面板同源）。 */
  getModelStatistics?: (input: { canvasId: string; nodeId: string; source?: string }) => Promise<McpModelStatisticsResult>;
  submitScript: (input: {
    canvasId: string;
    nodeId: string;
    source: string;
    version?: SupportedModelScriptVersion;
    requestId: string;
    expectedModelContentHash?: string;
  }) => Promise<McpSubmitScriptResult>;
  listModelNodes?: (input: { canvasId?: string }) => Promise<McpListNodesResult>;
  renderPreview?: (input: {
    canvasId: string;
    nodeId: string;
    width?: number;
    height?: number;
    background?: string;
    timeSeconds?: number;
    clipId?: string;
  }) => Promise<McpRenderPreviewResult>;
  applyCommands?: (input: {
    canvasId: string;
    commandId: string;
    baseRevision: number;
    commands: CanvasCommand[];
  }) => Promise<McpApplyCommandsResult>;

};

export type ModelMcpHttpHandler = {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  close: () => Promise<void>;
  /**
   * 执行**真实** MCP `initialize` + `tools/list` 发现（change: 2026-10-12-add-agent-conversation-panel，
   * 任务 3.1）。经同一 handler 的原生 `fetch`，不另建客户端、不复用缓存；返回注册工具清单与
   * 只读/可写分类，不表示任何 owner 已获写授权。
   */
  discover: () => Promise<ModelMcpDiscoveryResult>;
};

/** 工具发现的只读/可写分类（写工具经 grant 门禁，仍标记为 write）。 */
export type McpToolAccess = "read" | "write";

export type McpToolDescriptor = {
  name: string;
  access: McpToolAccess;
  title?: string;
  description?: string;
};

/**
 * 内置 MCP 就绪结果（真实信号，不伪造）。
 *
 * `ready=true` 仅表示**本服务可达且成功列出注册工具**；是否可执行写动作仍由逐回合 grant 在工具
 * 入口判定。失败时 `code` 区分不可达、无工具与协议错误，并给出可读原因。
 */
export type ModelMcpDiscoveryResult =
  | { ready: true; serverName: string; tools: McpToolDescriptor[]; checkedAt: string }
  | { ready: false; code: "unreachable" | "no-tools" | "protocol-error"; reason: string; tools: McpToolDescriptor[]; checkedAt: string };

export type ModelMcpHttpOptions = {
  extensionTools?: {
    list: () => readonly import("@woohaa3/contracts").ApplicationExtensionMcpTool[];
    call: (input: { name: string; args: Record<string, unknown>; bearerToken: string | null; loopback: boolean }) => Promise<Record<string, unknown>>;
  };
  /** Host tool registration; the per-request grant is host-owned and never from the model. */
  registerTools?: (server: McpServer, context: { bearerToken: string | null; grant: import("@woohaa3/contracts").ApplicationToolGrant | null }) => void;
  service?: ModelMcpToolService;
  path?: string;
  logger?: (event: { event: string; status: number; code?: string }) => void;
  agentAuthoring?: AgentAuthoringToolDeps;
  authoringTools?: import("../agent-authoring/contributions.js").AgentAuthoringToolRegistry;
  authoringContext?: (grant: import("@woohaa3/contracts").ApplicationToolGrant | null) => import("@woohaa3/contracts").McpToolRegistrationContext;
  toolGrant?: {
    allowedTools?: (token: string) => readonly string[] | undefined;
    /** Host-owned grant lookup used by world tools; absent means those tools stay unavailable. */
    resolve?: (token: string) => import("@woohaa3/contracts").ApplicationToolGrant | null;
    authorize: (input: { token: string; tool: string; canvasId?: string; nodeId?: string; nodeIds?: string[]; cameraId?: string; clipId?: string; itemId?: string }) => { ok: true } | { ok: false; reason: string };
  };
};

/** `registerToolWithGrant` 依赖的能力面（server + 写工具白名单 + grant 校验）。 */
export type ToolRegistration = {
  server: McpServer;
  /** 需经 grant 校验的写工具集合。 */
  grantedTools: ReadonlySet<string>;
  /** 用 bearer/toolGrant 校验写工具；返回拒绝原因或 null。 */
  grantDenied: (tool: string, args: { canvasId?: unknown; nodeId?: unknown; nodeIds?: unknown; cameraId?: unknown }) => string | null;
};
