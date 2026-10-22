/**
 * 统一「模型回合」请求/事件/结果形状（纯类型 + 编解码无关）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 5.1/5.2 / design D6）。
 *
 * 三家 HTTP 协议（OpenAI Responses、Anthropic Messages、兼容 Chat Completions）各自编解码
 * 到本形状，再由同一 run 循环执行：工具调用经宿主 grant 逐次校验，输出与循环有界。
 * 这里**不含**任何厂商类型，便于独立协议模拟测试。
 */

export type ModelToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema 形状（来自宿主允许面）。 */
  parameters: Record<string, unknown>;
};

export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: readonly ModelImageInput[] }
  | { role: "assistant"; content: string; toolCalls?: readonly ModelToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export type ModelImageInput = {
  /** 受限媒体 URL（媒体引用 facade 解析；绝不内联 COS 凭据）。 */
  url: string;
  mediaType?: string;
};

export type ModelToolCall = {
  /** 稳定调用 id（去重/审计）。 */
  id: string;
  name: string;
  /** 原始参数 JSON 字符串（协议原样）。 */
  argumentsJson: string;
};

export type ModelTurnRequest = {
  model: string;
  messages: readonly ModelMessage[];
  tools?: readonly ModelToolDefinition[];
  /** 温度等显式参数（未设置则用服务端缺省）。 */
  temperature?: number;
  maxOutputTokens?: number;
};

/** 流式增量事件（统一形状）：只含公开过程。 */
export type ModelStreamEvent =
  /**
   * 公开文本投递。`delivery` 缺省 `append`（增量分片）；`replace` 表示 `text` 是该逻辑消息的
   * 完整正文（原生协议给累计快照时使用），宿主据此收敛而不是再追加一条消息。
   */
  | { type: "text-delta"; text: string; delivery?: "append" | "replace"; streamId?: string }
  | { type: "tool-call"; call: ModelToolCall }
  | { type: "reasoning-summary"; text: string }
  | { type: "done"; finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "unknown" }
  | { type: "error"; code: string; message: string };

export type ModelTurnOutcome = {
  assistantText: string;
  toolCalls: readonly ModelToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "unknown";
};
