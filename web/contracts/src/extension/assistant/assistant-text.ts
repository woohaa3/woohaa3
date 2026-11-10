import { isBoundedId, isJsonObject } from "../../validation.js";
import { decodeAcceptTurnRequest } from "./conversation-codec.js";
import type {
  AgentConnectionBinding,
  AgentConversationDecodeResult,
  AgentEntryIntent,
  AgentReasoningEffort,
  AssistantTextCapabilities,
} from "./conversation.js";
import type { AssistantExecutionRef } from "./assistant-execution.js";
import type { CanvasTaskInput, StoredAsset } from "../../index.js";

export type AssistantTextRequest = {
  roleId: string;
  requestId: string;
  canvasId: string;
  nodeId: string;
  conversationId: string;
  connection: AgentConnectionBinding;
  model: string;
  reasoningEffort?: AgentReasoningEffort;
  prompt: string;
};
/** Frozen by Canvas; callers cannot supply this object through the public API. */
export type PreparedAssistantText = {
  canvasId: string;
  nodeId: string;
  authoredPrompt: string;
  prompt: string;
  capabilities: AssistantTextCapabilities;
  baseline: string;
  inputHash: string;
  inputs: CanvasTaskInput[];
  assets: StoredAsset[];
};
export type AssistantTextRun = AssistantExecutionRef & {
  runId: string;
  jobId: string;
  commandId: string;
  beginCommandId: string;
};
export type AssistantTextReceipt = {
  kind: "text-generation";
  runId: string;
  jobId: string;
  commandId: string;
  revision: number;
  assetId?: string;
  current: boolean;
};
export type AssistantTextPort = {
  prepare(input: {
    owner: string;
    entry: AgentEntryIntent;
    capabilities: AssistantTextCapabilities;
  }): Promise<PreparedAssistantText>;
  begin(input: {
    owner: string;
    prepared: PreparedAssistantText;
    run: AssistantTextRun;
  }): Promise<void>;
  commit(input: {
    owner: string;
    prepared: PreparedAssistantText;
    run: AssistantTextRun;
    text: string;
  }): Promise<AssistantTextReceipt>;
  settle(input: {
    owner: string;
    prepared: PreparedAssistantText;
    run: AssistantTextRun;
    /** 无法确认的结算已按 failed 处理，不再有独立待核对状态。 */
    status: "failed" | "cancelled";
    message: string;
  }): Promise<void>;
  lookup(input: {
    owner: string;
    run: AssistantTextRun;
  }): Promise<AssistantTextReceipt | null>;
  readImages(input: {
    owner: string;
    prepared: PreparedAssistantText;
  }): Promise<readonly { bytes: Uint8Array; contentType: string }[]>;
};
export function decodeAssistantTextRequest(
  value: unknown,
): AgentConversationDecodeResult<AssistantTextRequest> {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          "roleId",
          "requestId",
          "canvasId",
          "nodeId",
          "conversationId",
          "connection",
          "model",
          "reasoningEffort",
          "prompt",
        ].includes(k),
    ) ||
    !isBoundedId(value.conversationId) ||
    !isBoundedId(value.nodeId) ||
    !isBoundedId(value.model)
  )
    return {
      ok: false,
      code: "malformed-request",
      message: "文本生成请求身份非法",
    };
  const decoded = decodeAcceptTurnRequest({
    requestId: value.requestId,
    entry: {
      roleId: value.roleId,
      action: "generate",
      mode: "text",
      canvasId: value.canvasId,
      nodeId: value.nodeId,
      connection: value.connection,
      model: value.model,
      reasoningEffort: value.reasoningEffort,
      prompt: value.prompt,
    },
  });
  if (!decoded.ok) return decoded;
  if (!decoded.value.entry.connection)
    return {
      ok: false,
      code: "assistant-required",
      message: "请连接助手并选择模型",
    };
  return { ok: true, value: value as AssistantTextRequest };
}
/** Only the structured result is artwork. Preserve whitespace and Markdown verbatim. */
export function decodeAssistantTextCandidate(
  value: unknown,
): AgentConversationDecodeResult<{ text: string }> {
  if (
    !isJsonObject(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.text !== "string" ||
    !value.text.trim()
  )
    return {
      ok: false,
      code: "candidate-invalid",
      message: "助手未返回有效文本正文",
    };
  return { ok: true, value: { text: value.text } };
}
export const assistantTextCandidateSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
} as const;

/** Host-authenticated gateway used by Canvas/MCP; no adapter or task worker identity. */
export type AssistantTextSelection = {
  connection: AgentConnectionBinding;
  model: string;
  reasoningEffort?: AgentReasoningEffort;
};
export type AssistantTextRunGateway = {
  run(input: {
    owner: string;
    canvasId: string;
    nodeId: string;
    requestId: string;
    prompt: string;
    assistant?: AssistantTextSelection;
  }): Promise<
    | {
        ok: true;
        canvasId: string;
        nodeId: string;
        runId: string;
        jobId: string;
        state: "accepted";
        execution: AssistantExecutionRef;
      }
    | { ok: false; code: string; message: string }
  >;
  status(input: {
    owner: string;
    canvasId: string;
    nodeId: string;
    runId: string;
  }): Promise<
    | { ok: true; view: import("../../canvas/agent-canvas-run.js").AgentRunView }
    | { ok: false; code: string; message: string }
  >;
  cancel(input: {
    owner: string;
    canvasId: string;
    nodeId: string;
    runId: string;
  }): Promise<
    | {
        ok: true;
        canvasId: string;
        nodeId: string;
        runId: string;
        state: "cancel-requested" | "already-terminal" | "stale-run";
      }
    | { ok: false; code: string; message: string }
  >;
};
