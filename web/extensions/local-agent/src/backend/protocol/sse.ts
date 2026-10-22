/**
 * Server-Sent Events 流解析（纯函数；两个 HTTP 协议共用）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 5.1/6.1 / design D6/D7）。
 *
 * 只暴露**公开过程**：增量文本、工具调用与终态；不保存或投影隐式推理。用于把
 * OpenAI Responses / Anthropic Messages / 兼容 Chat Completions / OpenCode 的流式事件
 * 增量喂给各自的编解码器。
 */

export type SseEvent = { event: string; data: string };

/**
 * 把「结构化事件」或「原始 SSE 文本」统一为事件列表。
 *
 * 调用方可能直接给出 `{ event, data: '<json>' }`（已在协议层解析出事件），也可能给出含
 * `data:` 行的原始分片。两种情况都不能把 JSON 当 SSE 行再包一层。
 */
export function coerceSseEvents(
  raw: { event: string; data: string },
  parser: ReturnType<typeof createSseParser>
): SseEvent[] {
  const trimmed = raw.data.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return [{ event: raw.event, data: raw.data }];
  return parser.push(raw.data.endsWith("\n") ? raw.data : `${raw.data}\n`);
}

/**
 * 增量 SSE 解析器：可多次 `push` 网络分片，按空行切分事件，跨分片保留未完成缓冲。
 */
export function createSseParser(): {
  push: (chunk: string) => SseEvent[];
  flush: () => SseEvent[];
} {
  let buffer = "";
  const parseBlock = (block: string): SseEvent | null => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join("\n") };
  };
  return {
    push(chunk) {
      buffer += chunk;
      const events: SseEvent[] = [];
      let index = buffer.indexOf("\n\n");
      // 兼容 \r\n\r\n。
      let crlfIndex = buffer.indexOf("\r\n\r\n");
      if (crlfIndex !== -1 && (index === -1 || crlfIndex < index)) index = crlfIndex + 1;
      while (index !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer[index] === "\r" ? 3 : 2));
        const parsed = parseBlock(block.trimEnd());
        if (parsed) events.push(parsed);
        index = buffer.indexOf("\n\n");
        crlfIndex = buffer.indexOf("\r\n\r\n");
        if (crlfIndex !== -1 && (index === -1 || crlfIndex < index)) index = crlfIndex + 1;
      }
      return events;
    },
    flush() {
      const remaining = buffer.trim();
      buffer = "";
      if (remaining === "") return [];
      const parsed = parseBlock(remaining);
      return parsed ? [parsed] : [];
    }
  };
}

/** 追加有界文本缓冲：超出上限即截断并标记（不静默放大）。 */
export function createBoundedTextBuffer(maxBytes: number): {
  append: (text: string) => { accepted: boolean; overflowed: boolean };
  text: () => string;
  overflowed: () => boolean;
} {
  let total = 0;
  let overflow = false;
  const chunks: string[] = [];
  return {
    append(text) {
      if (overflow) return { accepted: false, overflowed: true };
      const bytes = new TextEncoder().encode(text).length;
      total += bytes;
      if (total > maxBytes) {
        overflow = true;
        return { accepted: false, overflowed: true };
      }
      chunks.push(text);
      return { accepted: true, overflowed: false };
    },
    text: () => chunks.join(""),
    overflowed: () => overflow
  };
}
