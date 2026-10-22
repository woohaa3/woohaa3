/**
 * 回合内助手文本的流式聚合
 * （修复：3D 模型节点生成面板打开的详情把流式回复拆成了多条消息）。
 *
 * adapter 的 `message` 事件是「一次逻辑消息的文本投递」，不是「一条已完成消息」：
 * - `delivery=append`：content 是新增分片（token/片段增量）；
 * - `delivery=replace`：content 是该逻辑消息的累计完整正文（原生协议给快照时）；
 * - `streamId`：逻辑消息身份，变化即下一条消息；缺省沿用当前打开的消息。
 *
 * 同一 streamId 的分片合并成**一行**消息（首片插入，后续原地更新）；阶段与工具事件先
 * 结算当前消息，因此「说明 → 工具 → 结论」仍是三条独立消息。事件窗口只记消息开始时的
 * `message-delta`（payload 仅 messageId/role）与结束时的 `message-completed`，不按 token 膨胀。
 *
 * 本模块只做编排决策，不直接接触 store：写入由调用方提供的回调完成。
 */
import type { AgentConversationAdapterEvent } from "@woohaa3/contracts";
import { mergeMessageChunk, type MessageStreamBuffer } from "./agent-conversation-projection.js";

export type MessageTextEvent = Extract<AgentConversationAdapterEvent, { type: "message" }>;

export type StreamAccumulatorPorts = {
  /** 单条消息正文预算（超出即截断并标记 truncated）。 */
  maxMessageChars: number;
  /** 新消息 id（首片时取一次）。 */
  nextMessageId: () => string;
  /** 新增一条消息行（返回下一次可用的 sequence 由调用方负责）。 */
  appendMessage: (message: { messageId: string; role: "assistant" | "system"; content: string; truncated: boolean }) => void;
  /** 原地更新已有消息的正文。 */
  updateMessage: (messageId: string, patch: { content: string; truncated: boolean }) => void;
  /** 追加 `message-delta` / `message-completed` 事件。 */
  appendEvent: (type: "message-delta" | "message-completed", payload: Record<string, unknown>) => void;
  /** 结算一条完整助手正文（用于与回合汇总比对，避免重复追加）。 */
  recordAssistantText?: (text: string) => void;
};

export type StreamAccumulator = {
  /** 接受一个 `message` 投递；同一逻辑消息的分片只更新一行。 */
  push: (event: MessageTextEvent) => void;
  /** 结算当前打开的消息（阶段/工具/回合结束时调用）。 */
  flush: () => void;
};

export function createStreamAccumulator(ports: StreamAccumulatorPorts): StreamAccumulator {
  let buffer: MessageStreamBuffer | null = null;
  let chunkCount = 0;
  // 已落库的逻辑消息：结算后同一消息的累计更新仍要回到原行，而不是新增一条。
  const rowIds = new Map<string, string>();
  // 已计入摘要的消息：同一条消息被结算多次时不能重复累计（否则汇总比对会失配）。
  const digested = new Set<string>();

  const push = (event: MessageTextEvent): void => {
    const streamKey = event.streamId ?? "assistant";
    const known = rowIds.get(streamKey);
    // 结算后继续收到同一消息的 replace（累计快照）：回到原行更新，不新增一条。
    const current: MessageStreamBuffer | null = buffer ?? (
      known && event.delivery === "replace"
        ? { messageId: known, role: event.role, streamKey, content: "", truncated: false, raw: "" }
        : null
    );
    const merged = mergeMessageChunk({
      current,
      messageId: ports.nextMessageId(),
      role: event.role,
      streamKey,
      content: event.content,
      ...(event.delivery ? { delivery: event.delivery } : {}),
      maxMessageChars: ports.maxMessageChars
    });
    buffer = merged.next;
    // 重复的累计快照（正文未变）不写库。
    if (!merged.changed) return;
    chunkCount += 1;
    if (merged.started) {
      rowIds.set(streamKey, merged.next.messageId);
      ports.appendMessage({
        messageId: merged.next.messageId,
        role: merged.next.role,
        content: merged.next.content,
        truncated: merged.next.truncated
      });
      ports.appendEvent("message-delta", { messageId: merged.next.messageId, role: merged.next.role });
      return;
    }
    ports.updateMessage(merged.next.messageId, { content: merged.next.content, truncated: merged.next.truncated });
  };

  const flush = (): void => {
    const finished = buffer;
    if (!finished) return;
    buffer = null;
    // 汇总比对用未截断正文：长回复被单条消息预算截断后，不应在结算时再追加一次。
    if (finished.role === "assistant" && !digested.has(finished.messageId)) {
      digested.add(finished.messageId);
      ports.recordAssistantText?.(finished.raw);
    }
    ports.appendEvent("message-completed", {
      messageId: finished.messageId,
      role: finished.role,
      content: finished.content,
      truncated: finished.truncated,
      chunks: chunkCount
    });
    chunkCount = 0;
  };

  return { push, flush };
}
