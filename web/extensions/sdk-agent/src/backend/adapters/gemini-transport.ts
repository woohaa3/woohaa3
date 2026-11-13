/** ADK owns the agent/tool loop. Gemini API transport is connection-bound. */
import { randomUUID } from "node:crypto";
import { Gemini, LlmAgent, Runner, InMemorySessionService, MCPToolset, StreamingMode } from "@google/adk";
import type { AgentSdkTransport } from "./agent-sdk-adapter.js";
import type { ModelToolCall } from "../protocol/model-turn.js";

type GeminiThinkingLevel = NonNullable<NonNullable<NonNullable<ConstructorParameters<typeof LlmAgent>[0]["generateContentConfig"]>["thinkingConfig"]>["thinkingLevel"]>;

export function createGeminiTransport(): AgentSdkTransport {
  return {
    async run(input) {
      if (!input.modelBaseUrl) return { ok: false, code: "runtime-missing", message: "缺少受控 Gemini 模型传输入口" };
      // `baseURL` 自带版本段（`.../v1beta`）时清空 apiVersion，避免拼成 `/v1beta/v1beta/...`；
      // 不带版本段时保留 ADK 缺省的 `v1beta`。
      const versioned = /\/(?:v\d+[a-z0-9.]*)$/i.test(input.modelBaseUrl.replace(/\/$/, ""));
      const baseUrl = input.modelBaseUrl;
      // ADK's supported protected hook configures *all* requests from its GenAI client.
      class ControlledGemini extends Gemini {
        protected override getHttpOptions() {
          return { ...super.getHttpOptions(), baseUrl, ...(versioned ? { apiVersion: "" } : {}) };
        }
      }
      const model = new ControlledGemini({ model: input.model, apiKey: input.apiKey, vertexai: false, useInteractionsApi: false });
      const toolset = input.mcp ? new MCPToolset({
        type: "StreamableHTTPConnectionParams", url: input.mcp.url,
        transportOptions: { requestInit: { headers: { authorization: `Bearer ${input.mcp.bearerToken}` } } }
      }, [...input.restrictions.allowedTools]) : null;
      const sessionService = new InMemorySessionService();
      const appName = "woohaa";
      const userId = input.resourceKey ?? randomUUID();
      let sessionId = randomUUID();
      const existing = await sessionService.getSession({ appName, userId, sessionId });
      if (!existing) {
        sessionId = randomUUID();
        await sessionService.createSession({ appName, userId, sessionId });
      }
      const toolCalls: ModelToolCall[] = [];
      let assistantText = "";
      try {
        const tools = toolset ? await toolset.getTools() : [];
        const actual = tools.map((tool) => tool.name).sort();
        if (actual.some((name) => !input.restrictions.allowedTools.includes(name)) ||
            (input.mcp && input.restrictions.allowedTools.some((name) => !actual.includes(name)))) {
          return { ok: false, code: "capability-unsupported", message: "MCP 工具集合未通过本轮核验" };
        }
        const agent = new LlmAgent({ name: "woohaa_assistant", model, tools, ...(input.reasoningEffort ? { generateContentConfig: { thinkingConfig: { thinkingLevel: input.reasoningEffort === "low" ? "LOW" as GeminiThinkingLevel : "HIGH" as GeminiThinkingLevel } } } : {}) });
        const runner = new Runner({ agent, appName, sessionService });
        for await (const event of runner.runAsync({
          userId, sessionId, newMessage: { role: "user", parts: [{ text: input.prompt }, ...(input.images ?? []).map(image => ({ inlineData: { mimeType: image.contentType, data: Buffer.from(image.bytes).toString("base64") } }))] },
          // change: 2026-10-22-remove-agent-execution-limits，任务 2.4：ADK 2.3.0 的官方语义是
          // `maxLlmCalls <= 0` 时**不施加**LLM 调用数上限；省略会落到内建默认 500，属于隐藏上限。
          // 因此显式传 0（不是猜测的负数，也不是巨大值）。停止仍来自 abortSignal 与 ADK 真实结束/失败。
          runConfig: { streamingMode: StreamingMode.SSE, maxLlmCalls: 0 }, abortSignal: input.signal
        })) {
          if (event.errorCode) return { ok: false, code: "model-access-denied", message: event.errorMessage ?? event.errorCode };
          for (const part of event.content?.parts ?? []) {
            if (part.thought) continue;
            if (typeof part.text === "string" && !event.partial) {
              // ADK 每个非 partial 事件给出该轮新增的完整片段：按增量累积。
              assistantText += part.text;
              input.onEvent({ type: "text-delta", text: part.text, delivery: "append" });
            }
            if (part.functionCall) {
              const call = { id: part.functionCall.id ?? event.id, name: part.functionCall.name ?? "", argumentsJson: JSON.stringify(part.functionCall.args ?? {}) };
              toolCalls.push(call); input.onEvent({ type: "tool-call", call });
            }
          }
        }
        return { ok: true, assistantText, toolCalls, finishReason: "stop", reasoning: input.reasoningEffort ? { requested: input.reasoningEffort, applied: true } : { applied: "provider-default" } };
      } catch {
        return { ok: false, code: input.signal.aborted ? "cancelled" : "transport-unavailable", message: input.signal.aborted ? "回合已停止" : "Gemini ADK 执行失败" };
      } finally {
        try { await toolset?.close(); } finally { await sessionService.deleteSession({ appName, userId, sessionId }); }
      }
    }
  };
}
