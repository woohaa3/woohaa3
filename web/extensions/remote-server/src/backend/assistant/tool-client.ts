/**
 * 一次回合内的 MCP 工具客户端（JSON-RPC over HTTP）。
 *
 * 为什么不复用 `sdk-agent` 的 `createMcpTurnGateway`：那个模块给「自己实现 MCP 客户端」
 * 的 agent SDK 起一个本地代理服务，把宿主的授权网关再包一层。我们的 adapter 本身就是
 * HTTP 客户端，直接说 JSON-RPC 更少一层转发——多一层代理只会多一个出错的地方。
 *
 * 职责边界：
 * - 本模块**只执行工具**，不决定该调什么（那是模型的事），也不组装提示词；
 * - 授权来自宿主签发的 grant（`authorization: Bearer <grant>`），本模块不持有凭据；
 * - 拒绝原因要**如实回给模型**，否则模型无法自我修正，只会重复同一次错误调用。
 */
import { randomUUID } from "node:crypto";

/** 工具声明（给模型看的形状，与 OpenAI function 一致）。 */
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** 一次工具执行结果。 */
export type ToolCallOutcome = {
  ok: boolean;
  /** 回给模型的正文（成功是结果，失败是可行动的原因）。 */
  content: string;
};

export type McpToolClient = {
  /** 列出本轮允许的工具（已按宿主准备的角色工具集过滤）。 */
  listTools(): Promise<ToolDefinition[]>;
  /** 执行一次工具调用。 */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
  /** 释放内部状态（无需关闭网络连接：每次请求独立）。 */
  dispose(): void;
};

export type McpToolClientOptions = {
  /** MCP 端点（宿主本机回环）。 */
  endpoint: string;
  /** 宿主签发的工具 grant。 */
  grant: string;
  /** 本轮允许的工具名；不在此列的调用一律拒绝。 */
  allowedTools: readonly string[];
  fetchImpl: typeof globalThis.fetch;
};

/** JSON-RPC 响应里能读出 result / error 的最小形状。 */
type JsonRpcReply = {
  result?: Record<string, unknown>;
  error?: { code?: unknown; message?: unknown };
};

/** 解析 MCP 响应：同时接受裸 JSON 与 SSE 两种编码。 */
function decodeReply(text: string): JsonRpcReply {
  const trimmed = text.trim();
  const chunks = trimmed.startsWith("{")
    ? [trimmed]
    : trimmed
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
  for (const chunk of chunks) {
    try {
      const value = JSON.parse(chunk) as JsonRpcReply;
      if (value.result !== undefined || value.error !== undefined) return value;
    } catch {
      // 跳过无法解析的片段。
    }
  }
  throw new Error("MCP 协议响应无法解析");
}

/**
 * 把工具失败原因压成一句可读文本。
 *
 * 优先取结构化回执的 `code` + `message`：那是宿主明确给出的原因。取不到才退回
 * content 里的文本。**有界截断**：模型看到 400 字符足够修正，再多只是浪费上下文。
 */
function failureText(result: Record<string, unknown> | undefined): string {
  const structured = result?.structuredContent as Record<string, unknown> | undefined;
  if (typeof structured?.message === "string" && structured.message.trim() !== "") {
    const code = typeof structured.code === "string" ? `[${structured.code}] ` : "";
    return `${code}${structured.message}`.slice(0, 400);
  }
  const content = result?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is { type: string; text: string } => {
        const entry = part as { type?: unknown; text?: unknown };
        return entry?.type === "text" && typeof entry.text === "string";
      })
      .map((part) => part.text)
      .join("\n");
    if (text.trim() !== "") return text.slice(0, 400);
  }
  return "工具执行失败，宿主没有返回原因";
}

/** 成功结果的正文：同样优先结构化，其次文本块。 */
function successText(result: Record<string, unknown> | undefined): string {
  const structured = result?.structuredContent;
  if (structured !== undefined) return JSON.stringify(structured).slice(0, 8000);
  const content = result?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is { type: string; text: string } => {
        const entry = part as { type?: unknown; text?: unknown };
        return entry?.type === "text" && typeof entry.text === "string";
      })
      .map((part) => part.text)
      .join("\n");
    if (text.trim() !== "") return text.slice(0, 8000);
  }
  return "（工具已执行，无返回内容）";
}

export function createMcpToolClient(options: McpToolClientOptions): McpToolClient {
  let sequence = 0;
  let disposed = false;

  const request = async (method: string, params?: unknown): Promise<JsonRpcReply> => {
    if (disposed) throw new Error("工具通道已释放");
    const response = await options.fetchImpl(options.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${options.grant}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, ...(params ? { params } : {}) }),
    });
    if (!response.ok) throw new Error(`工具通道不可用（HTTP ${response.status}）`);
    return decodeReply(await response.text());
  };

  return {
    async listTools() {
      const reply = await request("tools/list");
      const list = reply.result?.tools;
      if (!Array.isArray(list)) throw new Error("工具发现失败");
      const tools: ToolDefinition[] = [];
      for (const entry of list) {
        if (entry === null || typeof entry !== "object") continue;
        const tool = entry as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof tool.name !== "string") continue;
        // 只保留宿主为本轮开放的工具：多列出来的工具模型会去调，然后被拒。
        if (!options.allowedTools.includes(tool.name)) continue;
        tools.push({
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : tool.name,
          parameters:
            tool.inputSchema !== null && typeof tool.inputSchema === "object"
              ? (tool.inputSchema as Record<string, unknown>)
              : { type: "object" },
        });
      }
      return tools;
    },

    async callTool(name, args) {
      if (!options.allowedTools.includes(name)) {
        // 如实说明"本轮没有开放这个工具"，让模型改选而不是重试同一个名字。
        return { ok: false, content: `[tool-not-allowed] 本轮没有向助手开放工具 ${name}` };
      }
      let reply: JsonRpcReply;
      try {
        reply = await request("tools/call", { name, arguments: args });
      } catch (error) {
        const message = error instanceof Error ? error.message : "工具通道不可用";
        return { ok: false, content: `[transport] ${message}` };
      }
      if (reply.error) {
        const detail = typeof reply.error.message === "string" ? reply.error.message : "工具请求被拒绝";
        return { ok: false, content: `[rejected] ${detail}`.slice(0, 400) };
      }
      const result = reply.result;
      // `isError` 是 MCP 的显式失败标记；structuredContent.ok === false 是宿主的业务失败。
      const structured = result?.structuredContent as Record<string, unknown> | undefined;
      const ok = result?.isError !== true && structured?.ok !== false;
      return { ok, content: ok ? successText(result) : failureText(result) };
    },

    dispose() {
      disposed = true;
    },
  };
}

/** 生成一个稳定的调用 id（回填 tool 消息时用于配对）。 */
export function newToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
