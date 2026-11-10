/**
 * 工具失败原因投影（协议层共享）
 *
 * 会话里的工具过程是**有界、脱敏**的投影：这里只把可行动原因（结构化 `code`/`message`
 * 或可读文本）提取出来，不搬运完整上游 payload。供 MCP 结果解码与各本机传输复用。
 */

const TOOL_DETAIL_LIMIT = 400;

function boundedToolDetail(text: string): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > TOOL_DETAIL_LIMIT ? `${flat.slice(0, TOOL_DETAIL_LIMIT)}…` : flat;
}

/**
 * 工具失败的可行动原因：优先结构化回执的 `code`/`message`，其次协议错误与可读文本。
 * 仅用于失败投影；成功回执不调用。
 */
export function toolResultDetail(value: unknown, depth = 0): string | undefined {
  if (value === null || value === undefined || depth > 3) return undefined;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    if (text.startsWith("{") || text.startsWith("[")) {
      try { return toolResultDetail(JSON.parse(text), depth + 1) ?? boundedToolDetail(text); } catch { return boundedToolDetail(text); }
    }
    return boundedToolDetail(text);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const detail = toolResultDetail(item, depth + 1);
      if (detail) return detail;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const structured = record.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const fields = structured as Record<string, unknown>;
    const message = typeof fields.message === "string" ? fields.message : undefined;
    if (message) return boundedToolDetail(typeof fields.code === "string" ? `[${fields.code}] ${message}` : message);
  }
  const error = record.error;
  if (typeof error === "string") return boundedToolDetail(error);
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return boundedToolDetail(message);
  }
  if (typeof record.message === "string") return boundedToolDetail(record.message);
  if (typeof record.text === "string") return boundedToolDetail(record.text);
  return toolResultDetail(record.content, depth + 1);
}
