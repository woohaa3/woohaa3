/**
 * Canvas Agent 内部协议 v2 client（change: add-agent-canvas-authoring-mcp，任务 3.5 / 5.2）。
 *
 * MCP Service 访问 Agent 画布能力面的**唯一**通道：所有权限、校验与持久化都在 Canvas 侧。
 * 本 client 只做版本化、受认证的 HTTP 调用与稳定错误映射，不持有画布权威、不缓存 snapshot。
 *
 * delegated principal 由受认证上下文注入，随每次调用作为受信任请求头发送；调用方无法从
 * 工具参数自报。
 */
import {
  AGENT_INTERNAL_PATHS,
  AGENT_INTERNAL_PROTOCOL_HEADER,
  AGENT_INTERNAL_PROTOCOL_VERSION,
  SERVICE_TOKEN_HEADER,
  type AgentCanvasDelta,
  type AgentCanvasGraph,
  type CanvasCommand
} from "@woohaa3/contracts";

export const AGENT_PRINCIPAL_HEADER = "x-woohaa3-agent-principal" as const;

export type AgentCanvasClientOptions = {
  baseUrl: string;
  serviceToken?: string;
  principalId: string;
  timeoutMs?: number;
  logger?: (event: { event: string; status: number; code?: string }) => void;
  fetchImpl?: typeof fetch;
};

export type AgentListResult =
  | { ok: true; canvases: Array<{ canvasId: string; title: string; revision: number; updatedAt: string; nodeCount: number }>; nextCursor?: string }
  | { ok: false; code: string; message: string };

export type AgentGraphClientResult =
  | { ok: true; graph: AgentCanvasGraph }
  | { ok: false; code: string; message: string; currentRevision?: number };

export type AgentChangesClientResult =
  | { ok: true; delta: AgentCanvasDelta }
  | { ok: false; code: string; message: string; currentRevision?: number };

export type AgentApplyClientResult =
  | {
      ok: true;
      canvasId: string;
      requestId: string;
      revision: number;
      duplicate: boolean;
      noop: boolean;
      nodes: unknown[];
      edges: unknown[];
    }
  | { ok: false; code: string; message: string; retryable?: boolean; currentRevision?: number; preconditionIndex?: number };

export type AgentApplyClientInput = {
  canvasId?: string;
  requestId: string;
  commandId: string;
  payloadHash: string;
  baseRevision: number;
  commands: CanvasCommand[];
  preconditions?: unknown[];
};

export type AgentCanvasClient = {
  listCanvases(input: { canvasId?: string; cursor?: string; limit?: number }): Promise<AgentListResult>;
  getGraph(input: {
    canvasId?: string;
    nodeIds?: string[];
    aroundNodeId?: string;
    depth?: number;
    includePrompt?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<AgentGraphClientResult>;
  getChanges(input: { canvasId?: string; sinceRevision: number; limit?: number }): Promise<AgentChangesClientResult>;
  applyPlan(input: AgentApplyClientInput): Promise<AgentApplyClientResult>;
  runNode?(input: AgentRunClientInput): Promise<AgentRunClientResult>;
  getRun?(input: { canvasId?: string; nodeId: string; runId: string; waitMs?: number }): Promise<AgentRunStatusClientResult>;
  cancelRun?(input: { canvasId?: string; nodeId: string; runId: string }): Promise<AgentRunCancelClientResult>;
  getOutput?(input: { canvasId?: string; nodeId: string; runId: string }): Promise<AgentOutputClientResult>;
  scriptCapability?(input: { canvasId?: string }): Promise<AgentScriptCapabilityClientResult>;
  validateScript?(input: AgentScriptClientInput): Promise<AgentScriptValidateClientResult>;
  submitScript?(input: AgentScriptClientInput): Promise<AgentScriptSubmitClientResult>;
};

export type AgentRunClientInput = {
  assistant?: import("@woohaa3/contracts").AssistantTextSelection;
  modelKey?: string;
  canvasId?: string;
  requestId: string;
  nodeId: string;
  modelId?: string;
  prompt?: string;
  parameters?: Record<string, unknown>;
};

export type AgentRunClientResult =
  | { ok: true; canvasId: string; nodeId: string; runId: string; jobId: string; state: "accepted"; execution?: import("@woohaa3/contracts").AssistantExecutionRef }
  | { ok: false; code: string; message: string; retryable?: boolean };

export type AgentRunStatusClientResult =
  | { ok: true; view: import("@woohaa3/contracts").AgentRunView }
  | { ok: false; code: string; message: string; retryable?: boolean };

export type AgentRunCancelClientResult =
  | { ok: true; canvasId: string; nodeId: string; runId: string; state: "cancel-requested" | "already-terminal" | "stale-run" }
  | { ok: false; code: string; message: string; retryable?: boolean };

export type AgentOutputClientResult =
  | { ok: true; canvasId: string; nodeId: string; runId: string; view: import("@woohaa3/contracts").AgentNodeOutputView }
  | { ok: false; code: string; message: string; retryable?: boolean };

/** 脚本能力投影结果（change: 2026-10-13-add-canvas-script-authoring，任务 4.3）。 */
export type AgentScriptCapabilityClientResult =
  | {
      ok: true;
      available: true;
      descriptor: Record<string, unknown>;
      nodeKinds: Array<Record<string, unknown>>;
      models?: AgentModelCapabilityClient;
    }
  | { ok: true; available: false; reason: string; models?: AgentModelCapabilityClient }
  | { ok: false; code: string; message: string };

/** 任务模型能力（不含凭据）；Agent 在创建媒体节点前用它判断是否可用。 */
export type AgentModelCapabilityClient = {
  available: boolean;
  reason?: string;
  items: Array<{ modelKey: string; modelType: string; title: string; default: boolean }>;
};

export type AgentScriptValidateClientResult =
  | { ok: true; receipt: import("@woohaa3/contracts").CanvasScriptValidateReceipt }
  | { ok: false; error: import("@woohaa3/contracts").CanvasScriptError };

export type AgentScriptSubmitClientResult =
  | { ok: true; receipt: import("@woohaa3/contracts").CanvasScriptSubmitReceipt }
  | { ok: false; error: import("@woohaa3/contracts").CanvasScriptError };

export type AgentScriptClientInput = {
  canvasId?: string;
  requestId: string;
  version: string;
  source: string;
  expectedRevision?: number;
};

export function createAgentCanvasClient(options: AgentCanvasClientOptions): AgentCanvasClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const log = options.logger ?? (() => undefined);

  async function call<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [AGENT_INTERNAL_PROTOCOL_HEADER]: String(AGENT_INTERNAL_PROTOCOL_VERSION),
          [AGENT_PRINCIPAL_HEADER]: options.principalId,
          ...(options.serviceToken ? { [SERVICE_TOKEN_HEADER]: options.serviceToken } : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      const parsed = text.trim() === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
      if (!response.ok) {
        log({ event: "agent-canvas-client-error", status: response.status, code: String(parsed.code ?? "") });
        return {
          ok: false,
          code: typeof parsed.code === "string" ? parsed.code : "unavailable",
          message: typeof parsed.error === "string" ? parsed.error : `Canvas 返回 ${response.status}`,
          ...(typeof parsed.currentRevision === "number" ? { currentRevision: parsed.currentRevision } : {}),
          ...(typeof parsed.preconditionIndex === "number" ? { preconditionIndex: parsed.preconditionIndex } : {}),
          ...(typeof parsed.retryable === "boolean" ? { retryable: parsed.retryable } : {})
        } as unknown as T;
      }
      return parsed as T;
    } catch (error) {
      log({ event: "agent-canvas-client-failure", status: 0, code: error instanceof Error ? error.name : "unknown" });
      return {
        ok: false,
        code: error instanceof Error && error.name === "AbortError" ? "timeout" : "unavailable",
        message: error instanceof Error ? error.message : "Canvas 内部协议调用失败",
        retryable: true
      } as unknown as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    listCanvases: (input) => call<AgentListResult>(AGENT_INTERNAL_PATHS.list, input),
    async getGraph(input) {
      const response = await call<Record<string, unknown> & { ok: boolean; code?: string; message?: string }>(
        AGENT_INTERNAL_PATHS.graph,
        input
      );
      if (!response.ok) return response as unknown as AgentGraphClientResult;
      // 保留 graph 自身的领域 `protocolVersion`：它属于规范 DTO，不能与 envelope 的 `ok` 一起剥离
      // （change: 2026-10-06-fix-model-media-references-and-animation-preview，D3）。
      const { ok: _ok, ...graph } = response;
      return { ok: true, graph: graph as unknown as AgentCanvasGraph };
    },
    async getChanges(input) {
      const response = await call<Record<string, unknown> & { ok: boolean; code?: string; message?: string }>(
        AGENT_INTERNAL_PATHS.changes,
        input
      );
      if (!response.ok) return response as unknown as AgentChangesClientResult;
      // 保留 delta 自身的领域 `protocolVersion`（D3）。
      const { ok: _ok, ...delta } = response;
      return { ok: true, delta: delta as unknown as AgentCanvasDelta };
    },
    applyPlan: (input) => call<AgentApplyClientResult>(AGENT_INTERNAL_PATHS.apply, input),
    runNode(input) {
      const { canvasId, ...rest } = input;
      return call<AgentRunClientResult>(AGENT_INTERNAL_PATHS.run, { canvasId, ...rest });
    },
    async getRun(input) {
      const response = await call<Record<string, unknown> & { ok: boolean; code?: string; message?: string }>(
        AGENT_INTERNAL_PATHS.runStatus,
        input
      );
      if (!response.ok) return response as unknown as AgentRunStatusClientResult;
      // 保留 view 自身的领域 `protocolVersion`（D3）。
      const { ok: _ok, ...view } = response;
      return { ok: true, view: view as unknown as import("@woohaa3/contracts").AgentRunView };
    },
    cancelRun: (input) => call<AgentRunCancelClientResult>(AGENT_INTERNAL_PATHS.runCancel, input),
    getOutput: (input) => call<AgentOutputClientResult>(AGENT_INTERNAL_PATHS.output, input)
  };
}
