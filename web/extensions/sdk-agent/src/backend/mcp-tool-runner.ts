/**
 * Woohaa 受控 MCP 工具执行器（HTTP 适配器与 App Server 共用）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 5.2/4.2/6.4 / design D4/D6）。
 *
 * 纯 HTTP SDK 不内置工具执行，工具调用必须走**同一受控 Woohaa 工具入口**：以本轮 grant
 * 令牌作 Bearer，向回环 MCP endpoint 发起 Streamable HTTP JSON-RPC `tools/call`。
 * - grant 只发给受控工具 endpoint，绝不进入模型 headers 或 prompt；
 * - 每次调用都经宿主 grant 校验（`authorize` 在 run 循环里已逐次执行），端点再校验一次；
 * - 结果保留结构化内容与 callId；4xx/协议错误映射为工具失败，不伪造成功。
 */
import { createEndpointPolicy, guardedFetch } from "@woohaa3/agent-connections";

export type McpToolRunnerOptions = {
  /** MCP Streamable HTTP endpoint（回环）。 */
  serverUrl: string;
  fetchImpl?: typeof globalThis.fetch;
  /** 单次工具调用超时（毫秒；默认 60s）。 */
  timeoutMs?: number;
};

export type McpToolCallResult = { content: string; isError?: boolean };

export function createMcpToolRunner(options: McpToolRunnerOptions) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const policy = createEndpointPolicy({ allowedHosts: ["127.0.0.1", "localhost", "::1", "[::1]"], allowHttp: true });
  let requestId = 0;

  const call = async (input: { token: string; tool: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<McpToolCallResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    if (input.signal) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    requestId += 1;
    const body = {
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name: input.tool, arguments: input.args }
    };
    try {
      const result = await guardedFetch(
        options.serverUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${input.token}` },
          body: JSON.stringify(body),
          signal: controller.signal
        },
        policy,
        options.fetchImpl ?? globalThis.fetch
      );
      if (!result.ok) return { content: `工具入口不可达：${result.message}`, isError: true };
      const response = result.response;
      const text = await response.text();
      if (response.status < 200 || response.status >= 300) return { content: `工具入口返回 ${response.status}`, isError: true };
      const payload = parseMcpPayload(text);
      if (!payload) return { content: "工具入口响应无法解析", isError: true };
      if (payload.error) return { content: payload.error.message ?? "工具调用失败", isError: true };
      const content = Array.isArray(payload.result?.content) ? payload.result.content.map((part) => (typeof part.text === "string" ? part.text : "")).join("") : JSON.stringify(payload.result ?? {});
      return { content, isError: payload.result?.isError === true };
    } finally {
      clearTimeout(timer);
    }
  };

  return { call };
}

type McpPayload = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } };

/** 解析 MCP 响应：兼容纯 JSON 与 SSE 包装。 */
export function parseMcpPayload(text: string): McpPayload | null {
  const trimmed = text.trim();
  const candidates = trimmed.startsWith("{") ? [trimmed] : trimmed.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trim());
  for (const candidate of candidates) {
    if (candidate === "" || candidate === "[DONE]") continue;
    try {
      const parsed = JSON.parse(candidate) as McpPayload;
      if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

export type McpToolRunner = ReturnType<typeof createMcpToolRunner>;
