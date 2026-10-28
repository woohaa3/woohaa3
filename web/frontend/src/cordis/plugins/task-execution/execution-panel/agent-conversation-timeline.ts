import type { ConversationEvent, ConversationMessage, ConversationSnapshot, ConversationToolActivity, ConversationTurn } from "@woohaa3/contracts";

export type ConversationTimelineItem =
  | { kind: "message"; key: string; message: ConversationMessage }
  | { kind: "tool"; key: string; tool: ConversationToolActivity; turnStatus: ConversationTurn["status"] }
  | { kind: "result"; key: string; turn: ConversationTurn };

/** 消息 sequence 与事件 sequence 属于不同序列，不能直接混排。以事件定位消息与工具。 */
export function buildConversationTimeline(detail: ConversationSnapshot): ConversationTimelineItem[] {
  const result: ConversationTimelineItem[] = [];
  const seen = new Set<string>();
  for (const turn of detail.turns) {
    const messages = detail.messages.filter((message) => message.turnId === turn.turnId).sort((a, b) => a.sequence - b.sequence);
    const events = detail.events.filter((event) => event.turnId === turn.turnId);
    const unmatched = events.filter((event) => event.type === "tool-started" || event.type === "tool-completed");
    // 事件窗口可能截在调用开始后。补入持久工具投影的缺失部分，再统一配对开始/完成。
    turn.tools.forEach((tool, i) => {
      const match = unmatched.findIndex((event) => {
        const payload = event.payload as Record<string, unknown> | null;
        return payload?.tool === tool.tool && (event.type === "tool-started" ? "started" : payload.ok === true ? "completed" : "failed") === tool.status;
      });
      if (match >= 0) { unmatched.splice(match, 1); return; }
      const event: ConversationEvent = {
        conversationId: turn.conversationId, turnId: turn.turnId, requestId: turn.requestId,
        sequence: (tool.afterSequence ?? i) + 0.5, createdAt: tool.createdAt ?? turn.createdAt,
        type: tool.status === "started" ? "tool-started" : "tool-completed",
        payload: { tool: tool.tool, ok: tool.status === "completed", summary: tool.summary }
      };
      events.push(event);
    });
    events.sort((a, b) => a.sequence - b.sequence);
    const rows: Array<{ item: ConversationTimelineItem; time: string; order: number }> = [];
    const pending: Array<{ callId?: string; row: Extract<ConversationTimelineItem, { kind: "tool" }> }> = [];
    // 一条消息的流式分片只对应一行：`message-delta` 首次出现时定位该消息，
    // `message-completed` 只结算同一行，不重复插入。
    const pushMessage = (message: ConversationMessage, event: ConversationEvent): void => {
      if (seen.has(message.messageId)) return;
      seen.add(message.messageId);
      rows.push({ item: { kind: "message", key: message.messageId, message }, time: event.createdAt, order: event.sequence });
    };
    const findStreamedMessage = (value: Record<string, unknown>): ConversationMessage | undefined => {
      const messageId = typeof value.messageId === "string" ? value.messageId : undefined;
      if (messageId) return messages.find((entry) => entry.messageId === messageId);
      const role = value.role;
      const content = value.content;
      if (typeof role !== "string") return undefined;
      // 旧数据没有 messageId：优先按正文匹配，其次取同角色尚未展示的最后一条（流式消息正文会增长）。
      const exact = typeof content === "string"
        ? messages.find((entry) => !seen.has(entry.messageId) && entry.role === role && entry.content === content)
        : undefined;
      return exact ?? [...messages].reverse().find((entry) => !seen.has(entry.messageId) && entry.role === role);
    };
    for (const event of events) {
      const payload = event.payload;
      if (typeof payload !== "object" || payload === null) continue;
      const value = payload as Record<string, unknown>;
      if (event.type === "message-delta" || event.type === "message-completed") {
        const message = findStreamedMessage(value);
        if (!message) continue;
        // 分片期间消息正文可能仍是空串：先把占位行放对位置，正文随后由快照刷新。
        pushMessage(message, event);
      } else if ((event.type === "tool-started" || event.type === "tool-completed") && typeof value.tool === "string") {
        const callId = typeof value.callId === "string" ? value.callId : undefined;
        const summary = typeof value.summary === "string" ? value.summary : undefined;
        const status = event.type === "tool-started" ? "started" : value.ok === true ? "completed" : "failed";
        let match = event.type === "tool-completed" ? pending.findIndex((entry) => callId ? entry.callId === callId : entry.row.tool.tool === value.tool) : -1;
        if (event.type === "tool-completed" && match < 0 && callId) {
          match = pending.findIndex((entry) => entry.callId === undefined && entry.row.tool.tool === value.tool);
        }
        if (match >= 0) {
          const entry = pending.splice(match, 1)[0]!;
          entry.row.tool = { ...entry.row.tool, status, ...(summary ? { summary } : {}) };
        } else {
          const row: Extract<ConversationTimelineItem, { kind: "tool" }> = {
            kind: "tool", key: `${turn.turnId}-tool-${event.sequence}`, tool: { tool: value.tool, status, ...(summary ? { summary } : {}) }, turnStatus: turn.status
          };
          rows.push({ item: row, time: event.createdAt, order: event.sequence });
          if (status === "started") pending.push({ callId, row });
        }
      }
    }
    // 保留事件窗口外的持久消息；不将消息编号误当事件编号。
    for (const message of messages) {
      if (seen.has(message.messageId)) continue;
      seen.add(message.messageId);
      rows.push({ item: { kind: "message", key: message.messageId, message }, time: message.createdAt, order: message.role === "user" ? -1 : Number.MAX_SAFE_INTEGER });
    }
    rows.sort((a, b) => a.time.localeCompare(b.time) || a.order - b.order);
    result.push(...rows.map((row) => row.item));
    if (turn.receipt !== undefined || turn.error || turn.status === "failed") result.push({ kind: "result", key: `${turn.turnId}-result`, turn });
  }
  // 容忍有界回合窗口外仍可读的历史消息。
  const older: ConversationTimelineItem[] = detail.messages.filter((message) => !seen.has(message.messageId))
    .sort((a, b) => a.sequence - b.sequence).map((message) => ({ kind: "message", key: message.messageId, message }));
  return [...older, ...result];
}
