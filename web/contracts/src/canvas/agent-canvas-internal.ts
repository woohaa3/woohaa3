import { isAgentReasoningEffort } from "../extension/assistant/conversation.js";
/**
 * MCP Service ⇄ Canvas Service 内部 Agent 协议 v2
 * （change: add-agent-canvas-authoring-mcp，任务 1.5 / 3.5 / 4.7）。
 *
 * 在 v1 模型 MCP 内部面（`mcp-internal.ts`）之外，为 Agent authoring 增加**兼容的 v2
 * 能力面**：委派 principal、canvas list/graph/changes、plan apply（含局部前置条件）与
 * canonical 回执。MCP Service 只经此协议访问画布权威；本文件只含稳定 DTO、路径常量、
 * 错误码与无副作用 codec。
 *
 * 关键不变式：
 * - `principalId` / delegated subject 只从受认证上下文产生，**不**从请求体读取；
 * - 计划编译结果仍是既有 `CanvasCommand[]`，不新增第二套命令类型；
 * - apply 请求携带的 `preconditions` 在 Canvas 权威快照上于提交前复核。
 */
import { isBoundedId, isJsonObject, isNonNegativeInteger, isFiniteNumber } from "../validation.js";
import type { CanvasCommand } from "./commands.js";
import type { AgentNodeAffordances, AgentPrecondition } from "./agent-canvas-protocol.js";

/** v2 Agent 内部协议基路径（不经公网 ingress）。 */
export const AGENT_INTERNAL_BASE_PATH = "/internal/v2/agent-canvas" as const;

/** v2 协议版本；任何不兼容结构变化都要提升它。 */
export const AGENT_INTERNAL_PROTOCOL_VERSION = 2 as const;

/** 受信任调用方必须携带的协议版本头（复用 v1 头名，值为 v2）。 */
export const AGENT_INTERNAL_PROTOCOL_HEADER = "x-woohaa3-mcp-protocol-version" as const;

/** Canvas 侧为 Agent 调用派生并写入审计的 actorId。 */
export const AGENT_INTERNAL_ACTOR_ID = "mcp-service" as const;

export const AGENT_INTERNAL_PATHS = {
  list: `${AGENT_INTERNAL_BASE_PATH}/list`,
  graph: `${AGENT_INTERNAL_BASE_PATH}/graph`,
  changes: `${AGENT_INTERNAL_BASE_PATH}/changes`,
  apply: `${AGENT_INTERNAL_BASE_PATH}/apply`,
  run: `${AGENT_INTERNAL_BASE_PATH}/run`,
  runStatus: `${AGENT_INTERNAL_BASE_PATH}/run/status`,
  runCancel: `${AGENT_INTERNAL_BASE_PATH}/run/cancel`,
  output: `${AGENT_INTERNAL_BASE_PATH}/output`
} as const;

type DecodeResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

function ok<T>(value: T): DecodeResult<T> {
  return { ok: true, value };
}

function fail(code: string, message: string): DecodeResult<never> {
  return { ok: false, code, message };
}

function readOptionalId(body: Record<string, unknown>, key: string): string | undefined | { error: string } {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!isBoundedId(value)) return { error: `${key} 必须是非空字符串` };
  return value;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export type AgentListCanvasesRequest = {
  /** 由受认证上下文注入的 principal；请求体不携带。 */
  principalId: string;
  cursor?: string;
  limit?: number;
};

export type AgentCanvasSummary = {
  canvasId: string;
  title: string;
  revision: number;
  updatedAt: string;
  nodeCount: number;
};

export type AgentListCanvasesResponse =
  | { ok: true; protocolVersion: number; canvases: AgentCanvasSummary[]; nextCursor?: string }
  | { ok: false; code: string; message: string };

// ---------------------------------------------------------------------------
// graph
// ---------------------------------------------------------------------------

export type AgentGraphRequest = {
  principalId: string;
  canvasId?: string;
  nodeIds?: string[];
  aroundNodeId?: string;
  depth?: number;
  includePrompt?: boolean;
  limit?: number;
  cursor?: string;
};

export type AgentGraphResponse =
  | {
      ok: true;
      protocolVersion: number;
      canvasId: string;
      title: string;
      revision: number;
      nodes: unknown[];
      edges: unknown[];
      truncated: boolean;
      nextCursor?: string;
    }
  | { ok: false; code: string; message: string; currentRevision?: number };

// ---------------------------------------------------------------------------
// changes
// ---------------------------------------------------------------------------

export type AgentChangesRequest = {
  principalId: string;
  canvasId?: string;
  sinceRevision: number;
  limit?: number;
};

export type AgentChangesResponse =
  | {
      ok: true;
      protocolVersion: number;
      canvasId: string;
      fromRevision: number;
      currentRevision: number;
      nodes: unknown[];
      edges: unknown[];
      deletedNodeIds: string[];
      deletedEdgeIds: string[];
      resetRequired: boolean;
    }
  | { ok: false; code: string; message: string; currentRevision?: number };

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/**
 * 提交一份已编译计划。
 *
 * 局部前置条件在 Canvas 权威 snapshot 上、命令批次提交前复核（design D9）；任一失败整批
 * 拒绝且不写入。`payloadHash` 用于「相同 commandId 不同 payload 稳定拒绝」。
 */
export type AgentApplyRequest = {
  principalId: string;
  canvasId?: string;
  requestId: string;
  /** 稳定的 canvas command identity（由 MCP 从 principal/canvas/scope/requestId 派生）。 */
  commandId: string;
  /** 规范化计划 payload 哈希；command identity 相同但哈希不同即拒绝。 */
  payloadHash: string;
  baseRevision: number;
  commands: CanvasCommand[];
  preconditions?: AgentPrecondition[];
};

export type AgentApplyEntity = {
  nodeId: string;
  canonicalType: string;
  kind: string | null;
  title?: string;
  prompt?: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  affordances: AgentNodeAffordances;
};

export type AgentApplyEdge = {
  edgeId: string;
  source: string;
  target: string;
  label?: string;
};

export type AgentApplyResponse =
  | {
      ok: true;
      protocolVersion: number;
      canvasId: string;
      requestId: string;
      revision: number;
      duplicate: boolean;
      noop: boolean;
      nodes: AgentApplyEntity[];
      edges: AgentApplyEdge[];
    }
  | {
      ok: false;
      code: string;
      message: string;
      retryable?: boolean;
      currentRevision?: number;
      preconditionIndex?: number;
    };

// ---------------------------------------------------------------------------
// codecs
// ---------------------------------------------------------------------------

export function decodeAgentListRequest(body: unknown, principalId: string): DecodeResult<AgentListCanvasesRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const cursor = readOptionalId(body, "cursor");
  if (typeof cursor === "object") return fail("malformed-request", cursor.error);
  const request: AgentListCanvasesRequest = { principalId };
  if (cursor !== undefined) request.cursor = cursor;
  if (body.limit !== undefined) {
    if (!isNonNegativeInteger(body.limit) || body.limit === 0) return fail("malformed-request", "limit 必须是正整数");
    request.limit = body.limit;
  }
  return ok(request);
}

export function decodeAgentGraphRequest(body: unknown, principalId: string): DecodeResult<AgentGraphRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readOptionalId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  const aroundNodeId = readOptionalId(body, "aroundNodeId");
  if (typeof aroundNodeId === "object") return fail("malformed-request", aroundNodeId.error);
  const cursor = readOptionalId(body, "cursor");
  if (typeof cursor === "object") return fail("malformed-request", cursor.error);
  const request: AgentGraphRequest = { principalId };
  if (canvasId !== undefined) request.canvasId = canvasId;
  if (aroundNodeId !== undefined) request.aroundNodeId = aroundNodeId;
  if (cursor !== undefined) request.cursor = cursor;
  if (body.nodeIds !== undefined) {
    if (!Array.isArray(body.nodeIds) || body.nodeIds.some((id) => !isBoundedId(id))) {
      return fail("malformed-request", "nodeIds 必须是非空字符串数组");
    }
    request.nodeIds = body.nodeIds as string[];
  }
  if (body.depth !== undefined) {
    if (!isNonNegativeInteger(body.depth)) return fail("malformed-request", "depth 必须是非负整数");
    request.depth = body.depth;
  }
  if (body.includePrompt !== undefined) {
    if (typeof body.includePrompt !== "boolean") return fail("malformed-request", "includePrompt 必须是布尔值");
    request.includePrompt = body.includePrompt;
  }
  if (body.limit !== undefined) {
    if (!isNonNegativeInteger(body.limit) || body.limit === 0) return fail("malformed-request", "limit 必须是正整数");
    request.limit = body.limit;
  }
  return ok(request);
}

export function decodeAgentChangesRequest(body: unknown, principalId: string): DecodeResult<AgentChangesRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readOptionalId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isNonNegativeInteger(body.sinceRevision)) return fail("malformed-request", "sinceRevision 必须是非负整数");
  const request: AgentChangesRequest = { principalId, sinceRevision: body.sinceRevision };
  if (canvasId !== undefined) request.canvasId = canvasId;
  if (body.limit !== undefined) {
    if (!isNonNegativeInteger(body.limit) || body.limit === 0) return fail("malformed-request", "limit 必须是正整数");
    request.limit = body.limit;
  }
  return ok(request);
}

export function decodeAgentApplyRequest(body: unknown, principalId: string): DecodeResult<AgentApplyRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readOptionalId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.requestId)) return fail("malformed-request", "requestId 必须是非空字符串");
  if (!isBoundedId(body.commandId)) return fail("malformed-request", "commandId 必须是非空字符串");
  if (!isBoundedId(body.payloadHash)) return fail("malformed-request", "payloadHash 必须是非空字符串");
  if (!isNonNegativeInteger(body.baseRevision)) return fail("malformed-request", "baseRevision 必须是非负整数");
  if (!Array.isArray(body.commands) || body.commands.length === 0) {
    return fail("malformed-request", "commands 必须是非空数组");
  }
  const request: AgentApplyRequest = {
    principalId,
    requestId: body.requestId,
    commandId: body.commandId,
    payloadHash: body.payloadHash,
    baseRevision: body.baseRevision,
    commands: body.commands as CanvasCommand[]
  };
  if (canvasId !== undefined) request.canvasId = canvasId;
  if (body.preconditions !== undefined) {
    if (!Array.isArray(body.preconditions)) return fail("malformed-request", "preconditions 必须是数组");
    request.preconditions = body.preconditions as AgentPrecondition[];
  }
  return ok(request);
}

// ---------------------------------------------------------------------------
// run / status / cancel / output
// ---------------------------------------------------------------------------

export type AgentRunRequest = {
  assistant?: import("../extension/assistant/assistant-text.js").AssistantTextSelection;
  principalId: string;
  canvasId?: string;
  requestId: string;
  nodeId: string;
  /** 稳定 catalog 身份。 */
  modelKey?: string;
  prompt?: string;
  parameters?: Record<string, unknown>;
};

export type AgentRunResponse =
  | { ok: true; protocolVersion: number; canvasId: string; nodeId: string; runId: string; jobId: string; state: "accepted"; execution?: import("../extension/assistant/assistant-execution.js").AssistantExecutionRef }
  | { ok: false; code: string; message: string; retryable?: boolean };

export type AgentRunStatusRequest = {
  principalId: string;
  canvasId?: string;
  nodeId: string;
  runId: string;
  /** 可选有界 long-poll（毫秒）；服务端钳制上限。 */
  waitMs?: number;
};

export type AgentRunStatusResponse =
  | ({
      ok: true;
      protocolVersion: number;
    } & import("./agent-canvas-run.js").AgentRunView)
  | { ok: false; code: string; message: string; retryable?: boolean };

export type AgentRunCancelRequest = {
  principalId: string;
  canvasId?: string;
  nodeId: string;
  runId: string;
};

export type AgentRunCancelResponse =
  | { ok: true; protocolVersion: number; canvasId: string; nodeId: string; runId: string; state: "cancel-requested" | "already-terminal" | "stale-run" }
  | { ok: false; code: string; message: string; retryable?: boolean };

export type AgentOutputRequest = {
  principalId: string;
  canvasId?: string;
  nodeId: string;
  runId: string;
};

export type AgentOutputResponse =
  | { ok: true; protocolVersion: number; canvasId: string; nodeId: string; runId: string; view: import("./agent-canvas-run.js").AgentNodeOutputView }
  | { ok: false; code: string; message: string; retryable?: boolean };

/** long-poll 上限（毫秒）。 */
export const AGENT_RUN_MAX_WAIT_MS = 30_000;

export function decodeAgentRunRequest(body: unknown, principalId: string): DecodeResult<AgentRunRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readOptionalId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  const modelKey = readOptionalId(body, "modelKey");
  if (typeof modelKey === "object") return fail("malformed-request", modelKey.error);
  if (!isBoundedId(body.requestId)) return fail("malformed-request", "requestId 必须是非空字符串");
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  const request: AgentRunRequest = { principalId, requestId: body.requestId, nodeId: body.nodeId };
  if (body.assistant !== undefined) {
    const assistant = body.assistant;
    if (!isJsonObject(assistant) || Object.keys(assistant).some(key => !["connection", "model", "reasoningEffort"].includes(key)) || !isBoundedId(assistant.model)) return fail("malformed-request", "助手选择非法");
    const binding = assistant.connection;
    if (!isJsonObject(binding) || Object.keys(binding).some(key => !["connectionId", "adapterId", "configRevision", "credentialEpoch"].includes(key)) || !isBoundedId(binding.connectionId) || !isBoundedId(binding.adapterId) || ![binding.configRevision, binding.credentialEpoch].every(n => Number.isSafeInteger(n) && (n as number) >= 0)) return fail("malformed-request", "助手连接身份非法");
    if (assistant.reasoningEffort !== undefined && !isAgentReasoningEffort(assistant.reasoningEffort)) return fail("malformed-request", "助手 Variant 非法");
    request.assistant = assistant as import("../extension/assistant/assistant-text.js").AssistantTextSelection;
  }
  if (canvasId !== undefined) request.canvasId = canvasId;
  if (modelKey !== undefined) request.modelKey = modelKey;
  if (body.prompt !== undefined) {
    if (typeof body.prompt !== "string") return fail("malformed-request", "prompt 必须是字符串");
    request.prompt = body.prompt;
  }
  if (body.parameters !== undefined) {
    if (!isJsonObject(body.parameters)) return fail("malformed-request", "parameters 必须是对象");
    request.parameters = body.parameters;
  }
  return ok(request);
}

export function decodeAgentRunStatusRequest(body: unknown, principalId: string): DecodeResult<AgentRunStatusRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readOptionalId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (!isBoundedId(body.runId)) return fail("malformed-request", "runId 必须是非空字符串");
  const request: AgentRunStatusRequest = { principalId, nodeId: body.nodeId, runId: body.runId };
  if (canvasId !== undefined) request.canvasId = canvasId;
  if (body.waitMs !== undefined) {
    if (!isNonNegativeInteger(body.waitMs)) return fail("malformed-request", "waitMs 必须是非负整数");
    request.waitMs = Math.min(body.waitMs, AGENT_RUN_MAX_WAIT_MS);
  }
  return ok(request);
}

export function decodeAgentRunCancelRequest(body: unknown, principalId: string): DecodeResult<AgentRunCancelRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readOptionalId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (!isBoundedId(body.runId)) return fail("malformed-request", "runId 必须是非空字符串");
  const request: AgentRunCancelRequest = { principalId, nodeId: body.nodeId, runId: body.runId };
  if (canvasId !== undefined) request.canvasId = canvasId;
  return ok(request);
}

export function decodeAgentOutputRequest(body: unknown, principalId: string): DecodeResult<AgentOutputRequest> {
  return decodeAgentRunCancelRequest(body, principalId);
}

/** 校验 precondition 形状（Canvas 侧在权威快照上使用时再求值）。 */
export function isAgentPrecondition(value: unknown): value is AgentPrecondition {
  if (!isJsonObject(value)) return false;
  const type = value.type;
  if (type === "node-exists" || type === "node-missing" || type === "not-processing") {
    return isBoundedId(value.nodeId);
  }
  if (type === "prompt-equals") {
    return isBoundedId(value.nodeId) && typeof value.equals === "string";
  }
  return false;
}

export function isFinitePosition(value: unknown): value is { x: number; y: number } {
  return isJsonObject(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}
