import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import nonStreamFixture from "./fixtures/llm-nonstream.json";
import { chatBody, chatMessages, createRunningHubLanguageModel } from "../src/provider/language.js";

const streamFixture = readFileSync(new URL("./fixtures/llm-stream.sse", import.meta.url), "utf8");

const baseOptions = {
  prompt: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: [{ type: "text", text: "Hi" }] }
  ]
} as unknown as LanguageModelV4CallOptions;

describe("RunningHub 文字协议", () => {
  it("Chat Completions 请求体保留消息、工具与工具选择", () => {
    const body = chatBody("glm/glm-5.2", {
      ...baseOptions,
      maxOutputTokens: 2048,
      temperature: 1,
      topP: 1,
      tools: [{ type: "function", name: "draw", description: "Draw", inputSchema: { type: "object" } }],
      toolChoice: { type: "tool", toolName: "draw" },
      reasoning: "high"
    }, false);
    expect(body).toMatchObject({
      model: "glm/glm-5.2",
      stream: false,
      max_tokens: 2048,
      temperature: 1,
      top_p: 1,
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" }
      ],
      tools: [{ type: "function", function: { name: "draw", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "draw" } }
    });
  });

  it("工具调用与工具结果在上下文中往返", () => {
    const messages = chatMessages([
      { role: "assistant", content: [
        { type: "text", text: "calling" },
        { type: "tool-call", toolCallId: "t1", toolName: "draw", input: { prompt: "a cat" } }
      ] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "draw", output: { type: "text", value: "ok" } }] }
    ] as never);
    expect(messages).toEqual([
      { role: "assistant", content: "calling", tool_calls: [{ id: "t1", type: "function", function: { name: "draw", arguments: "{\"prompt\":\"a cat\"}" } }] },
      { role: "tool", tool_call_id: "t1", content: "ok" }
    ]);
  });

  it("同步响应映射文本、工具调用与用量；401 报权限原因", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const model = createRunningHubLanguageModel("glm/glm-5.2", {
      apiKey: "key",
      baseURL: "https://llm.example/v1",
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return new Response(JSON.stringify(nonStreamFixture), { status: 200 });
      }) as unknown as typeof globalThis.fetch
    });
    const result = await model.doGenerate!(baseOptions);
    expect(requests[0]!.url).toBe("https://llm.example/v1/chat/completions");
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer key");
    expect(result.content).toEqual([
      { type: "text", text: "hello" },
      { type: "tool-call", toolCallId: "call_fixture_1", toolName: "draw", input: "{\"prompt\":\"a cat\"}" }
    ]);
    expect(result.finishReason).toMatchObject({ unified: "tool-calls", raw: "tool_calls" });
    expect(result.usage.inputTokens.total).toBe(10);
    expect(result.usage.outputTokens.total).toBe(5);

    const denied = createRunningHubLanguageModel("glm/glm-5.2", {
      apiKey: "key", baseURL: "https://llm.example/v1",
      fetch: (async () => new Response(JSON.stringify({ error: { message: "forbidden" } }), { status: 403 })) as unknown as typeof globalThis.fetch
    });
    await expect(denied.doGenerate!(baseOptions)).rejects.toThrow(/Enterprise-Shared/);
  });

  it("流式解析标准 SSE，结束前发出文本增量与完成原因", async () => {
    const model = createRunningHubLanguageModel("glm/glm-5.2", {
      apiKey: "key", baseURL: "https://llm.example/v1",
      fetch: (async () => new Response(streamFixture, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof globalThis.fetch
    });
    const result = await model.doStream!(baseOptions);
    const reader = result.stream.getReader();
    const parts: Array<Record<string, unknown>> = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value as unknown as Record<string, unknown>);
    }
    expect(parts.filter(part => part.type === "text-delta").map(part => part.delta)).toEqual(["he", "llo"]);
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop", raw: "stop" } });
  });
});
