import { isBoundedId, isJsonObject } from "../validation.js";
import type { AgentConversationDecodeResult, ConversationTurnStatus } from "./conversation.js";

/** Public identity only. Owner, credentials, grants and runner selection remain host facts. */
export type AssistantTarget = { canvasId: string; nodeId: string } & (
  | { purpose: "text" }
  | { purpose: "model3d"; expectedContentHash?: string }
  | { purpose: "film-set"; clipId: string; itemId?: string; expectedContentHash?: string }
  | { purpose: "camera"; cameraId?: string; clipId?: string; expectedContentHash?: string }
  | { purpose: "canvas-group"; scopeEpoch: number }
  | { purpose: "conversion"; sourceNodeId: string; sourceKind: "image" | "video" }
);

export type AssistantExecutionRef = {
  canvasId: string;
  targetNodeId: string;
  conversationId: string;
  turnRequestId: string;
  domainRequestId?: string;
  attemptId?: string;
};

/** Stable links between a domain request, a parent turn, child calls and durable commit. */
export type AssistantExecutionAssociation = AssistantExecutionRef & {
  attemptId: string;
  childRequestIds: readonly string[];
  commandId?: string;
};

export type AssistantSubmissionResult =
  | { kind: "rejected"; code: string; message: string }
  | { kind: "accepted"; execution: AssistantExecutionRef; reused: boolean }
  | { kind: "unknown"; requestId: string; message: string };

export type AssistantExecutionState = {
  execution: AssistantExecutionRef;
  status: ConversationTurnStatus;
  stage?: string;
  error?: string;
};

/** Decode against the authenticated canvas; owner is deliberately never accepted in this DTO. */
export function decodeAssistantExecutionRef(value: unknown, canvasId: string): AgentConversationDecodeResult<AssistantExecutionRef> {
  if (!isJsonObject(value)) return { ok: false, code: "malformed-request", message: "执行引用必须是对象" };
  const required = ["canvasId", "targetNodeId", "conversationId", "turnRequestId"] as const;
  const optional = ["domainRequestId", "attemptId"] as const;
  if (Object.keys(value).some(key => ![...required, ...optional].includes(key as never)) ||
      required.some(key => !isBoundedId(value[key])) || optional.some(key => value[key] !== undefined && !isBoundedId(value[key]))) {
    return { ok: false, code: "malformed-request", message: "执行引用包含非法身份或私有字段" };
  }
  if (value.canvasId !== canvasId) return { ok: false, code: "canvas-mismatch", message: "执行不属于当前画布" };
  return { ok: true, value: value as AssistantExecutionRef };
}

export function assistantExecutionKey(ref: AssistantExecutionRef): string {
  return JSON.stringify([ref.canvasId, ref.targetNodeId, ref.conversationId, ref.turnRequestId, ref.domainRequestId ?? null, ref.attemptId ?? null]);
}
