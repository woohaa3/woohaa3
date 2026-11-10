import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEndpointPolicy, createModelTransport } from "@woohaa3/agent-connections";
import { createMcpTurnGateway } from "../mcp-turn-gateway.js";
import type { AgentAdapterRunInput } from "@woohaa3/contracts";
import { createFixedEngineRuntime } from "../fixed-engine-runtime.js";
import { buildAgentSdkRestrictions } from "./agent-sdk-adapter.js";
import type { AgentEngineId, AgentApiType } from "@woohaa3/contracts";
import { buildTestPreparedTurn } from "@woohaa3/test-fixtures-agent-role-turns";

// Poison inherited provider selection and credentials; explicit connection wiring must win.
beforeAll(() => {
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GOOGLE_API_KEY", "GEMINI_API_KEY"]) vi.stubEnv(name, "forbidden-global-key");
  for (const name of ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "GOOGLE_GEMINI_BASE_URL"]) vi.stubEnv(name, "http://127.0.0.1:1");
  vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "true");
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/nonexistent/woohaa-forbidden-adc.json");
});
afterAll(() => vi.unstubAllEnvs());

function responseFor(api: AgentApiType) {
  if (api === "gemini") return JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "controlled-ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
  if (api === "anthropic") return JSON.stringify({ id: "msg_controlled", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "controlled-ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  return "";
}
const cases: Array<[AgentEngineId, AgentApiType, string]> = [
  ["codex-agent-sdk", "openai", "gpt-5"], ["claude-agent-sdk", "anthropic", "claude-sonnet-4-6"],
  ["dsh-agent-sdk", "chat-completions", "controlled-model"], ["gemini-agent-adk", "gemini", "gemini-3-flash-preview"]
];
describe("锁定框架经真实运行时访问可控上游（无真实 Key/计费）", () => {
  it.each(cases.flatMap((entry) => [([...entry, false] as const), ([...entry, true] as const)]))("%s (%s / %s) 工具回合=%s", async (engine, apiType, model, withTools) => {
    const root = await mkdtemp(path.join(tmpdir(), "woohaa-sdk-contract-"));
    const requests: Array<{ url: string; body: Record<string, any>; key?: string }> = [];
    let toolSent = false;
    const server = createServer(async (req, res) => {
      let text = ""; for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : {};
      requests.push({ url: req.url ?? "", body, key: String(req.headers.authorization ?? req.headers["x-api-key"] ?? req.headers["x-goog-api-key"]) });
      if (req.url?.includes("count_tokens")) { res.setHeader("content-type", "application/json"); res.end('{"input_tokens":1}'); return; }
      const event = (name: string, value: unknown) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
      const names = (body.tools ?? []).flatMap((tool: any) => tool.type === "namespace" ? (tool.tools ?? []).map((item: any) => `${tool.name}__${item.name}`) : tool.name ? [tool.name] : tool.function?.name ? [tool.function.name] : tool.functionDeclarations?.map((item: any) => item.name) ?? []);
      if (withTools && !toolSent && names.length) {
        toolSent = true;
        const name = names.find((name: string) => name.includes("submit_model_script"));
        res.setHeader("content-type", "text/event-stream");
        if (apiType === "openai") {
          const item = { id: "fc_1", type: "function_call", call_id: "call_1", name: "submit_model_script", namespace: "mcp__woohaa", arguments: "{}", status: "completed" };
          res.end(event("response.created", { type: "response.created", response: { id: "resp_tool", status: "in_progress", output: [] } }) + event("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } }) + event("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: "{}" }) + event("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }) + event("response.completed", { type: "response.completed", response: { id: "resp_tool", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
        } else if (apiType === "anthropic") {
          res.end(event("message_start", { type: "message_start", message: { ...JSON.parse(responseFor(apiType)), content: [], stop_reason: null } }) + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name, input: {} } }) + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }) + event("content_block_stop", { type: "content_block_stop", index: 0 }) + event("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }) + event("message_stop", { type: "message_stop" }));
        } else if (apiType === "gemini") {
          res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args: {} } }] }, finishReason: "STOP" }] })}\n\n`);
        } else {
          res.end(`data: ${JSON.stringify({ id: "chat_tool", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: "{}" } }] }, finish_reason: null }] })}\n\n` + `data: ${JSON.stringify({ id: "chat_tool", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        }
        return;
      }
      if (apiType === "openai") {
        res.setHeader("content-type", "text/event-stream");
        const item = { id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "controlled-ok", annotations: [] }] };
        res.end(event("response.created", { type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } }) +
          event("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }) +
          event("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "controlled-ok" }) +
          event("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }) +
          event("response.completed", { type: "response.completed", response: { id: "resp_test", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }));
      } else if (apiType === "chat-completions") {
        res.setHeader("content-type", "text/event-stream");
        res.end(`data: ${JSON.stringify({ id: "chat_test", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "controlled-ok" }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: "chat_test", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
      } else if (apiType === "anthropic" && body.stream) {
        res.setHeader("content-type", "text/event-stream");
        res.end(event("message_start", { type: "message_start", message: { ...JSON.parse(responseFor(apiType)), content: [], stop_reason: null } }) +
          event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
          event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "controlled-ok" } }) +
          event("content_block_stop", { type: "content_block_stop", index: 0 }) +
          event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) + event("message_stop", { type: "message_stop" }));
      } else if (apiType === "gemini" && req.url?.includes("streamGenerateContent")) {
        res.setHeader("content-type", "text/event-stream"); res.end(`data: ${responseFor(apiType)}\n\n`);
      } else { res.setHeader("content-type", "application/json"); res.end(responseFor(apiType)); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const relay = await createModelTransport({ apiType, apiKey: "real-test-key", upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, policy: createEndpointPolicy({ allowedHosts: ["127.0.0.1"], allowHttp: true }), valid: () => true });
    let toolCalls = 0;
    const mcp = createServer(async (req, res) => {
      let text = ""; for await (const chunk of req) text += chunk;
      const message = JSON.parse(text);
      const result = message.method === "tools/list" ? { tools: [{ name: "submit_model_script", description: "Update current model", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } : { content: [{ type: "text", text: "updated" }], structuredContent: { ok: true, canvasId: "canvas", nodeId: "node", commandId: "cmd-1" } };
      if (message.method === "tools/call") toolCalls++;
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
    const gateway = withTools ? await createMcpTurnGateway({ input: { requestId: "req", canvasId: "canvas", intent: { mode: "model3d", nodeId: "node" }, prepared: buildTestPreparedTurn({ requestId: "req", target: { canvasId: "canvas", nodeId: "node", mode: "model3d" }, prompt: "edit", tools: ["get_model_node", "submit_model_script"] }), signal: AbortSignal.timeout(40000), emit: () => undefined } as unknown as AgentAdapterRunInput, upstream: `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`, grant: "grant", valid: () => true, validateTarget: async () => true }) : null;
    try {
      const runtime = createFixedEngineRuntime({ configDir: path.join(root, "config"), workspaceDir: path.join(root, "work") });
      const transport = await runtime.resolve(engine);
      const result = await transport.run({ kind: engine, apiKey: relay.token, modelBaseUrl: relay.baseUrl, resourceKey: "isolated-context", model, ...(apiType !== "chat-completions" ? { reasoningEffort: "high" as const } : {}), prompt: "Say controlled-ok", imagePaths: [], ...(!withTools ? { images: [{ bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8AARGDiPwMAHfAD/aAzCYkAAAAASUVORK5CYII=", "base64"), contentType: "image/png" }] } : {}),
        restrictions: buildAgentSdkRestrictions({ kind: engine, workspaceDir: root, allowedTools: withTools ? ["submit_model_script"] : [] }), mcp: gateway ? { name: "woohaa", url: gateway.url, bearerToken: gateway.token } : null, signal: AbortSignal.timeout(40000), onEvent: () => undefined, onNativeId: () => undefined });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, assistantText: "controlled-ok" });
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.key).toContain("real-test-key");
        if (!request.url.includes("count_tokens")) {
          if (apiType === "openai") expect(request.body.reasoning?.effort).toBe("high");
          if (apiType === "anthropic") expect(request.body.output_config?.effort).toBe("high");
          if (apiType === "gemini") expect(request.body.generationConfig?.thinkingConfig?.thinkingLevel).toBe("HIGH");
        }
        const names = (request.body.tools ?? []).flatMap((tool: any) => tool.type === "namespace" ? (tool.tools ?? []).map((item: any) => `${tool.name}__${item.name}`) : tool.name ? [tool.name] : tool.function?.name ? [tool.function.name] : tool.functionDeclarations?.map((item: any) => item.name) ?? []);
        if (withTools) expect(names, JSON.stringify(names)).toSatisfy((names: string[]) => names.every((name: string) => name.includes("submit_model_script") || ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(name)));
        else expect(names).toEqual([]);
      }
      if (!withTools) {
        const bodies = requests.filter(request => !request.url.includes("count_tokens")).map(request => request.body);
        expect(bodies.some(body => {
          if (apiType === "openai") return body.input?.some((message: any) => message.content?.some((part: any) => part.type === "input_image" && part.image_url?.startsWith("data:image/png;base64,")));
          if (apiType === "gemini") return body.contents?.some((message: any) => message.parts?.some((part: any) => part.inlineData?.mimeType === "image/png" && part.inlineData.data));
          return body.messages?.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => apiType === "anthropic" ? part.type === "image" && part.source?.media_type === "image/png" && part.source.data : part.type === "image_url" && part.image_url?.url?.startsWith("data:image/png;base64,")));
        })).toBe(true);
      }
      if (withTools) {
        expect(toolSent).toBe(true);
        expect(toolCalls).toBe(1);
        expect(gateway?.receipts).toMatchObject([{ commandId: "cmd-1" }]);
      }
    } finally { await gateway?.close(); mcp.closeAllConnections(); await new Promise<void>((resolve) => mcp.close(() => resolve())); await relay.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  }, 60000);
  it.each(cases)("%s 在模型流未完成时真实中断并回收", async (engine, apiType, model) => {
    const root = await mkdtemp(path.join(tmpdir(), "woohaa-sdk-abort-"));
    let started!: () => void;
    const requested = new Promise<void>((resolve) => { started = resolve; });
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain body without retaining credentials */ }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      started();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    const relay = await createModelTransport({ apiType, apiKey: "fixture-key", upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, policy: createEndpointPolicy({ allowedHosts: ["127.0.0.1"], allowHttp: true }), valid: () => !controller.signal.aborted, signal: controller.signal });
    let running: Promise<unknown> | undefined;
    try {
      const runtime = createFixedEngineRuntime({ configDir: path.join(root, "config"), workspaceDir: path.join(root, "work") });
      const transport = await runtime.resolve(engine);
      running = transport.run({ kind: engine, apiKey: relay.token, modelBaseUrl: relay.baseUrl, resourceKey: "abort-context", model, prompt: "Wait for controlled response", imagePaths: [], restrictions: buildAgentSdkRestrictions({ kind: engine, workspaceDir: root, allowedTools: [] }), mcp: null, signal: controller.signal, onEvent: () => undefined, onNativeId: () => undefined }).catch(() => ({ ok: false }));
      await requested;
      controller.abort();
      const result = await running;
      expect(result).not.toMatchObject({ ok: true });
    } finally {
      controller.abort();
      await running;
      await relay.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);

  it("DeepSeek Harness 不同上下文并发隔离，同上下文拒绝重入，结束删除私有目录", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "woohaa-dsh-concurrent-"));
    const keys: string[] = [];
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume */ }
      keys.push(String(req.headers.authorization));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ id: "chat", object: "chat.completion.chunk", model: "controlled-model", choices: [{ index: 0, delta: { role: "assistant", content: "isolated" }, finish_reason: null }] })}\n\n` + `data: ${JSON.stringify({ id: "chat", object: "chat.completion.chunk", model: "controlled-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const relays = await Promise.all(["a", "b"].map((key) => createModelTransport({ apiType: "chat-completions", apiKey: key, upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, policy: createEndpointPolicy({ allowedHosts: ["127.0.0.1"], allowHttp: true }), valid: () => true })));
    try {
      const transport = await createFixedEngineRuntime({ configDir: path.join(root, "config"), workspaceDir: path.join(root, "work") }).resolve("dsh-agent-sdk");
      const input = (index: number) => ({ kind: "dsh-agent-sdk" as const, apiKey: relays[index]!.token, modelBaseUrl: relays[index]!.baseUrl, resourceKey: `context-${index}`, model: "controlled-model", prompt: "reply", imagePaths: [], restrictions: buildAgentSdkRestrictions({ kind: "dsh-agent-sdk", workspaceDir: root, allowedTools: [] }), mcp: null, signal: AbortSignal.timeout(30000), onEvent: () => undefined, onNativeId: () => undefined });
      const first = transport.run(input(0));
      const second = transport.run(input(1));
      expect(await transport.run(input(0))).toMatchObject({ ok: false });
      expect(await Promise.all([first, second])).toMatchObject([{ ok: true, assistantText: "isolated" }, { ok: true, assistantText: "isolated" }]);
      expect(keys.sort()).toEqual(["Bearer a", "Bearer b"]);
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(path.join(root, "config"))).toEqual([]);
      expect(await readdir(path.join(root, "work"))).toEqual([]);
    } finally {
      await Promise.all(relays.map((relay) => relay.close()));
      server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 40000);

  it("dsh 输出额度写满时透出 length，而不是伪装成正常结束", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "woohaa-dsh-truncated-"));
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume */ }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ id: "chat_len", object: "chat.completion.chunk", model: "controlled-model", choices: [{ index: 0, delta: { role: "assistant", content: "我先读一下上下文" }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "chat_len", object: "chat.completion.chunk", model: "controlled-model", choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const relay = await createModelTransport({ apiType: "chat-completions", apiKey: "truncated-key", upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, policy: createEndpointPolicy({ allowedHosts: ["127.0.0.1"], allowHttp: true }), valid: () => true });
    try {
      const transport = await createFixedEngineRuntime({ configDir: path.join(root, "config"), workspaceDir: path.join(root, "work") }).resolve("dsh-agent-sdk");
      const result = await transport.run({ kind: "dsh-agent-sdk", apiKey: relay.token, modelBaseUrl: relay.baseUrl, resourceKey: "truncated-context", model: "controlled-model", prompt: "生成一座宫殿", imagePaths: [], restrictions: buildAgentSdkRestrictions({ kind: "dsh-agent-sdk", workspaceDir: root, allowedTools: [] }), mcp: null, signal: AbortSignal.timeout(30000), onEvent: () => undefined, onNativeId: () => undefined });
      // 宿主据此报 output-truncated，而不是「作品更新未确认」。
      expect(result).toMatchObject({ ok: true, finishReason: "length" });
    } finally {
      await relay.close();
      server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 40000);

});
