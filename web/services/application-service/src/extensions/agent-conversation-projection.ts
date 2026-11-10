/**
 * Agent 会话读模型投影与纯工具
 * （change: 2026-10-12-add-agent-conversation-panel，任务 1.1/1.6 / design D1/D7）。
 *
 * 从 `agent-conversation-service.ts` 拆出（业务源码规模门禁）：把存储记录投影为公开 DTO、
 * 规范输入 hash 与有界序列化等**纯函数**集中于此。不含 store 写语义：编排仍由
 * `agent-conversation-service.ts` 持有。
 */
import { createHash } from "node:crypto";
import type {
  AgentConnectionBinding,
  AgentEntryIntent,
  AgentRoleRef,
  AgentTargetSnapshot,
  ConversationEventType,
  ConversationMessage,
  ConversationSnapshot,
  ConversationSummary,
  ConversationToolActivity,
  ConversationTurn,
  ConversationTurnStatus,
} from "@woohaa3/contracts";
import {
  normalizeConversationStatus,
  normalizeConversationTurnStatus,
  UNCONFIRMED_RESULT_ERROR_CODE,
  UNCONFIRMED_RESULT_MESSAGE
} from "@woohaa3/contracts";
import type {
  AgentConversationStore,
  ConversationAdapterBinding,
  ConversationMessageRecord,
  ConversationTurnRecord
} from "../repository/agent-conversation-repository.js";
import { isTerminalTurnStatus } from "../repository/agent-conversation-repository.js";

export function toSummary(binding: ConversationAdapterBinding): ConversationSummary {
  return {
    conversationId: binding.conversationId,
    ...(binding.contextKey ? { contextKey: binding.contextKey } : {}),
    canvasId: binding.canvasId,
    adapterId: binding.adapterId,
    ...(binding.connectionId ? { connectionId: binding.connectionId } : {}),
    title: binding.title,
    status: normalizeConversationStatus(binding.status) ?? "failed",
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    ...(binding.latestRequestId ? { latestRequestId: binding.latestRequestId } : {}),
    ...(binding.nodeId ? { nodeId: binding.nodeId } : {}),
    turnCount: binding.turnCount
  };
}

function turnRoleBinding(record: ConversationTurnRecord): AgentRoleRef | undefined {
  if (!record.roleRefJson) return undefined;
  try { return JSON.parse(record.roleRefJson) as AgentRoleRef; } catch { return undefined; }
}

function turnConnectionBinding(record: ConversationTurnRecord): ConversationTurn["connection"] | undefined {
  if (!record.connectionId || !record.connectionAdapterId) return undefined;
  return {
    connectionId: record.connectionId,
    adapterId: record.connectionAdapterId,
    configRevision: record.connectionConfigRevision ?? 0,
    credentialEpoch: record.connectionCredentialEpoch ?? 0
  };
}

export function toTurn(store: AgentConversationStore, record: ConversationTurnRecord): ConversationTurn {
  const tools = store.listTools(record.conversationId, 500).filter((tool) => tool.turnId === record.turnId);
  const connection = turnConnectionBinding(record);
  const normalized = normalizeConversationTurnStatus(record.status);
  const status: ConversationTurnStatus = normalized ?? "failed";
  const legacyUnconfirmed = status === "failed" && record.errorCode === null && record.status !== "failed";
  return {
    turnId: record.turnId,
    conversationId: record.conversationId,
    requestId: record.requestId,
    action: record.action as ConversationTurn["action"],
    status,
    stage: record.stage === "unknown" ? "failed" : record.stage,
    target: JSON.parse(record.targetJson) as AgentTargetSnapshot,
    ...(record.assistantText !== null ? { assistantText: record.assistantText } : {}),
    tools: tools.map((tool): ConversationToolActivity => ({
      tool: tool.tool,
      status: tool.status as ConversationToolActivity["status"],
      afterSequence: tool.sequence,
      createdAt: tool.createdAt,
      ...(tool.summary !== null ? { summary: tool.summary } : {})
    })),
    ...(record.runId !== null ? { runId: record.runId } : {}),
    ...(record.taskId !== null ? { taskId: record.taskId } : {}),
    ...(record.receiptJson !== null ? { receipt: JSON.parse(record.receiptJson) } : {}),
    ...(connection ? { connection } : {}),
    ...(turnRoleBinding(record) ? { role: turnRoleBinding(record)! } : {}),
    ...(record.executorCursor !== null ? { executorCursor: record.executorCursor } : {}),
    ...(record.errorCode !== null ? { error: { code: record.errorCode, message: record.errorMessage ?? "" } }
      : legacyUnconfirmed ? { error: { code: UNCONFIRMED_RESULT_ERROR_CODE, message: UNCONFIRMED_RESULT_MESSAGE } } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export function toMessage(record: ConversationMessageRecord): ConversationMessage {
  return {
    messageId: record.messageId,
    conversationId: record.conversationId,
    turnId: record.turnId,
    requestId: record.requestId,
    role: record.role as ConversationMessage["role"],
    content: record.content,
    truncated: record.truncated === 1,
    sequence: record.sequence,
    createdAt: record.createdAt
  };
}

/** 由最近回合派生会话整体状态（宿主投影，不是第二事实源）。 */
export function conversationStatusFor(latest: ConversationTurnRecord | undefined): ConversationSummary["status"] {
  if (!latest) return "idle";
  if (!isTerminalTurnStatus(latest.status)) return "active";
  switch (normalizeConversationTurnStatus(latest.status) ?? "failed") {
    case "succeeded": return "succeeded";
    case "partial": return "partial";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    default: return "active";
  }
}

/** 构建权威会话快照（消息/回合/事件 + cursor 与 resync 判定）。 */
export function buildSnapshot(
  store: AgentConversationStore,
  binding: ConversationAdapterBinding,
  cursor: number,
  limits: { maxMessages: number; maxEvents: number; beforeMessageSequence?: number | null; turnOffset?: number }
): ConversationSnapshot {
  const before = limits.beforeMessageSequence ?? null;
  const messages = store.listMessagesBefore(binding.conversationId, before, limits.maxMessages).map(toMessage);
  const turnOffset = limits.turnOffset ?? 0;
  // 回合页多取一条以判断是否还有更早历史可继续读取。
  const turnPage = store.listTurnsPage(binding.conversationId, turnOffset, 200 + 1);
  const turns = turnPage.slice(0, 200).map((turn) => toTurn(store, turn));
  const events = store.listEvents(binding.conversationId, cursor, limits.maxEvents);
  const maxSequence = store.maxEventSequence(binding.conversationId);
  const earliest = events.length > 0 ? events[0]!.sequence : maxSequence + 1;
  // cursor 早于保留窗口起点：要求 resync（宿主当前保留全部事件，故仅在删除/压缩后发生）。
  const resyncRequired = cursor > 0 && cursor < earliest - 1;
  // 分页游标（任务 4.1）：还有更早合法历史时给出继续读取位置，不退化成总量截断。
  const nextMessageCursor =
    messages.length > 0 && store.listMessagesBefore(binding.conversationId, messages[0]!.sequence, 1).length > 0
      ? messages[0]!.sequence
      : undefined;
  const nextTurnCursor = turnPage.length > 200 ? turnOffset + 200 : undefined;
  return {
    conversation: toSummary(binding),
    turns,
    messages,
    events: events.map((event) => ({
      sequence: event.sequence,
      conversationId: event.conversationId,
      turnId: event.turnId,
      requestId: event.requestId,
      type: event.type as ConversationEventType,
      payload: safeJsonParse(event.payloadJson),
      createdAt: event.createdAt
    })),
    cursor: maxSequence,
    resyncRequired,
    ...(nextMessageCursor !== undefined ? { nextMessageCursor } : {}),
    ...(nextTurnCursor !== undefined ? { nextTurnCursor } : {})
  };
}

export function defaultId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `${prefix}-${random}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * 在预算截断前按消息身份记录最新正文的长度与摘要，不缓存文本。
 *
 * 原生消息在工具事件结算后仍可能更新累计快照；更新同一身份但保留消息顺序。
 * 汇总只允许在消息边界直接拼接、加单换行或空行，消息内部的换行保持原样，避免误吞新正文。
 */
export function createAssistantMessageDigest() {
  const messages = new Map<string, { length: number; digest: string }>();
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    record(messageId: string, content: string) {
      messages.set(messageId, { length: content.length, digest: digest(content) });
    },
    matches(summary: string) {
      if (messages.size === 0) return false;
      return ["", "\n", "\n\n"].some(separator => {
        let offset = 0;
        let first = true;
        for (const message of messages.values()) {
          if (!first) {
            if (summary.slice(offset, offset + separator.length) !== separator) return false;
            offset += separator.length;
          }
          const end = offset + message.length;
          if (end > summary.length || digest(summary.slice(offset, end)) !== message.digest) return false;
          offset = end;
          first = false;
        }
        return offset === summary.length;
      });
    }
  };
}

/** 正在累积的一条助手/系统消息（流式分片按此就地合并，不新增消息行）。 */
export type MessageStreamBuffer = {
  messageId: string;
  role: "assistant" | "system";
  /** 同一逻辑消息的分片共用；变化即视为下一条消息。 */
  streamKey: string;
  /** 落库正文（按单条消息预算截断）。 */
  content: string;
  truncated: boolean;
  /** 未截断的完整正文：只用于与回合汇总比对，不落库。 */
  raw: string;
};

/**
 * 把 adapter 的文本投递合并进当前打开的消息
 * （流式聚合：同一条消息的 N 个分片只产生 1 条消息，而不是 N 条）。
 *
 * `delivery=replace` 表示 content 是原生协议给的累计快照；`streamKey` 变化表示进入下一条
 * 逻辑消息。返回 `changed=false` 时调用方不必写库（重复的累计快照）。
 */
export function mergeMessageChunk(input: {
  current: MessageStreamBuffer | null;
  messageId: string;
  role: "assistant" | "system";
  streamKey: string;
  content: string;
  delivery?: "append" | "replace";
  maxMessageChars: number;
}): { next: MessageStreamBuffer; started: boolean; changed: boolean } {
  const current = input.current;
  const started = current === null || current.streamKey !== input.streamKey || current.role !== input.role;
  const raw = started
    ? input.content
    : input.delivery === "replace"
      ? input.content
      : current.raw + input.content;
  const truncated = raw.length > input.maxMessageChars;
  const content = clamp(raw, input.maxMessageChars);
  const next: MessageStreamBuffer = {
    messageId: started ? input.messageId : current.messageId,
    role: input.role,
    streamKey: input.streamKey,
    content,
    truncated,
    raw
  };
  return { next, started, changed: started || content !== current.content || truncated !== current.truncated };
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * 规范输入 hash：requestId 去重身份，绑定 action/canvas/target/prompt/references 与连接身份。
 *
 * 连接身份包含 `connectionId` / `adapterId` / `configRevision` / `credentialEpoch`
 * （change: 2026-10-16-...，任务 2.2 / design D7）：同一 requestId 改变连接、配置或凭据版本时，
 * hash 不同即拒绝为原请求执行，不切换凭据、不重新推理。旧请求（无连接）缺省为全 null，保持兼容。
 */
export function hashIntent(entry: AgentEntryIntent, connection?: AgentConnectionBinding | null): string {
  const binding = connection ?? entry.connectionId ?? null;
  const normalized = {
    action: entry.action,
    canvasId: entry.canvasId,
    nodeId: entry.nodeId ?? null,
    mode: entry.mode ?? null,
    cameraId: entry.cameraId ?? null,
    clipId: entry.clipId ?? null,
    itemId: entry.itemId ?? null,
    model: entry.model ?? null,
    connectionId: typeof binding === "string" ? binding : binding?.connectionId ?? null,
    connectionAdapterId: typeof binding === "string" ? null : binding?.adapterId ?? null,
    connectionConfigRevision: typeof binding === "string" ? null : binding?.configRevision ?? null,
    connectionCredentialEpoch: typeof binding === "string" ? null : binding?.credentialEpoch ?? null,
    roleId: entry.roleId ?? null,
    expectedContentHash: entry.expectedContentHash ?? null,
    prompt: entry.prompt,
    references: (entry.references ?? []).map((reference) => ({ kind: reference.kind, storageKey: reference.storageKey ?? null, nodeId: reference.nodeId ?? null, role: reference.role ?? null }))
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** 由持久化回合记录恢复 entry intent（重启/重放；intentJson 缺失时退化为 target 快照）。 */
export function entryFromTurn(record: ConversationTurnRecord): AgentEntryIntent {
  const parsed = safeJsonParse(record.intentJson);
  if (parsed && typeof parsed === "object" && (parsed as { prompt?: unknown }).prompt !== undefined) {
    return parsed as AgentEntryIntent;
  }
  const target = safeJsonParse(record.targetJson) as AgentTargetSnapshot;
  return {
    action: record.action as AgentEntryIntent["action"],
    canvasId: record.canvasId,
    ...(target.nodeId !== undefined ? { nodeId: target.nodeId } : {}),
    ...(target.mode !== undefined ? { mode: target.mode } : {}),
    ...(target.cameraId !== undefined ? { cameraId: target.cameraId } : {}),
    ...(target.clipId !== undefined ? { clipId: target.clipId } : {}),
    ...(target.itemId !== undefined ? { itemId: target.itemId } : {}),
    ...(target.expectedContentHash !== undefined ? { expectedContentHash: target.expectedContentHash } : {}),
    ...(target.role ? { roleId: target.role.namespacedId } : {}),
    prompt: ""
  };
}
