import { describe, expect, it, vi } from "vitest";
import { codeBuddyTool, createCodeBuddyTransport } from "./codebuddy-transport.js";
import { createOpenCodeTransport } from "./opencode-transport.js";
import type { LocalAgentTransportInput } from "./transport.js";
import { defaultArgs } from "../index.js";
import { toolResultFailed } from "./loopback-http.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (...messages: unknown[]) => new Response(messages.map(message => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
function input(overrides: Partial<LocalAgentTransportInput> = {}): LocalAgentTransportInput {
  return { configDir: "/config", workDir: "/work", loopbackUrl: "http://127.0.0.1:42000", stdio: null, model: "", prompt: "create a tree", allowedTools: ["get_model_api", "submit_model_script"], toolToken: "turn-1", mcpEndpoint: { name: "woohaa", url: "http://127.0.0.1:5180/dev/test/mcp/model-canvas" }, resumeNativeId: null, signal: new AbortController().signal, onEvent: vi.fn(), ...overrides };
}

function codebuddyMock(permissionCalls: Record<string, unknown>[] = []) {
  const requests: Array<{ method: string; params: any }> = [];
  const connections = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let session = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("x-codebuddy-request")).toBe("true");
    if (init?.method === "DELETE") {
      for (const connection of connections) connection.close();
      connections.clear();
      return new Response(null, { status: 204 });
    }
    if (!init?.method || init.method === "GET") {
      const body = new ReadableStream<Uint8Array>({ start(controller) { connections.add(controller); }, cancel() { connections.clear(); } });
      return new Response(body, { headers: { "content-type": "text/event-stream", "Acp-Connection-Id": "connection-1" } });
    }
    expect(headers.get("Acp-Connection-Id")).toBe("connection-1");
    const rpc = JSON.parse(String(init?.body));
    requests.push(rpc);
    const result = rpc.method === "initialize" ? { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true }, mcpCapabilities: { http: true } } }
      : rpc.method === "session/new" ? { sessionId: `session-${++session}` }
      : rpc.method === "session/load" ? {}
      : rpc.method === "session/prompt" ? { stopReason: "end_turn" } : {};
    if (rpc.method === "session/prompt") return sse(
      ...permissionCalls.map((toolCall, index) => ({ jsonrpc: "2.0", id: 1000 + index, method: "session/request_permission", params: { sessionId: rpc.params.sessionId, toolCall, options: [{ kind: "allow_once", optionId: "once" }] } })),
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "other-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrong" } } } },
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: rpc.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } },
      { jsonrpc: "2.0", id: rpc.id, result });
    return sse({ jsonrpc: "2.0", id: rpc.id, result });
  });
  return { fetchImpl, requests };
}

describe("CodeBuddy 2.x HTTP ACP", () => {
  it("allows discovery and scoped deferred MCP execution but denies deferred shell and other-session RPCs", async () => {
    const mock = codebuddyMock([
      { title: "ToolSearch" },
      { title: "Deferred tool", _meta: { "codebuddy.ai": { toolName: "DeferExecuteTool", effectiveToolName: "mcp__woohaa__get_model_api" } } },
      { title: "Deferred tool", _meta: { "codebuddy.ai": { toolMetaData: { toolName: "DeferExecuteTool", effectiveToolName: "mcp__woohaa__submit_model_script" } } } },
      { title: "DeferExecuteTool", _meta: { "codebuddy.ai": { toolName: "DeferExecuteTool", effectiveToolName: "Bash" } } },
      { title: "DeferExecuteTool", rawInput: { toolName: "mcp__woohaa__submit_model_script", params: {} } },
      { title: "DeferExecuteTool", rawInput: { toolName: "Bash", params: {} } },
      { title: "DeferExecuteTool" }
    ]);
    expect(await createCodeBuddyTransport(mock).run(input())).toMatchObject({ ok: true });
    const replies = mock.requests.filter((request: any) => request.id >= 1000) as any[];
    expect(replies.map(reply => reply.result.outcome)).toEqual([
      { outcome: "selected", optionId: "once" }, { outcome: "selected", optionId: "once" }, { outcome: "selected", optionId: "once" },
      { outcome: "cancelled" }, { outcome: "selected", optionId: "once" }, { outcome: "cancelled" }, { outcome: "cancelled" }
    ]);
  });
  it("unwraps deferred targets without granting arbitrary builtins", () => {
    expect(codeBuddyTool({ title: "DeferExecuteTool", rawInput: { toolName: "mcp__woohaa__submit_model_script", params: {} } }, input().allowedTools)).toBe("submit_model_script");
    expect(codeBuddyTool({ title: "DeferExecuteTool", rawInput: JSON.stringify({ toolName: "Bash", params: {} }) }, input().allowedTools)).toBe("Bash");
    expect(codeBuddyTool({ title: "DeferExecuteTool", rawInput: "{" }, input().allowedTools)).toBe("DeferExecuteTool");
  });
  it("uses supported CLI arguments, session MCP config and a fresh grant when loading history", async () => {
    expect(defaultArgs("codebuddy-server")).toEqual(["--serve", "--host", "127.0.0.1", "--auth", "none", "--strict-mcp-config"]);
    const mock = codebuddyMock();
    const transport = createCodeBuddyTransport(mock);
    expect(await transport.run(input())).toMatchObject({ ok: true, nativeId: "session-1", outcome: { assistantText: "done" } });
    expect(await transport.run(input({ toolToken: "turn-2", resumeNativeId: "session-1" }))).toMatchObject({ ok: true });
    const first = mock.requests.find(request => request.method === "session/new")!;
    const second = mock.requests.find(request => request.method === "session/load")!;
    expect(first.params.mcpServers).toEqual([{ type: "http", name: "woohaa", url: input().mcpEndpoint!.url, headers: [{ name: "Authorization", value: "Bearer turn-1" }] }]);
    expect(second.params).toMatchObject({ sessionId: "session-1", mcpServers: [{ headers: [{ value: "Bearer turn-2" }] }] });
    expect(mock.requests.filter(request => request.method === "session/prompt").every(request => !JSON.stringify(request.params).includes("Bearer"))).toBe(true);
    expect(mock.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
  });
  it("does not provide MCP credentials in discussion sessions", async () => {
    const mock = codebuddyMock();
    expect(await createCodeBuddyTransport(mock).run(input({ allowedTools: [], toolToken: null, mcpEndpoint: null, images: [{ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" }] }))).toMatchObject({ ok: true });
    expect(mock.requests.find(request => request.method === "session/new")!.params.mcpServers).toEqual([]);
    expect(mock.requests.find(request => request.method === "session/prompt")!.params.prompt).toContainEqual({ type: "image", data: "AQID", mimeType: "image/png" });
  });
  it("refuses targets without a grant before opening an ACP connection", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await createCodeBuddyTransport({ fetchImpl }).run(input({ toolToken: null }))).toMatchObject({ ok: false, code: "tools-unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("checks HTTP errors rather than parsing an unauthorized page as an ACP response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({}, 403));
    expect(await createCodeBuddyTransport({ fetchImpl }).run(input())).toMatchObject({ ok: false, message: expect.stringContaining("HTTP 403") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function openCodeMock(mcpStatus = "connected", catalog: unknown[] = []) {
  const requests: Array<{ path: string; search: string; method: string; body?: any; authorization: string | null }> = [];
  let session = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    const method = init?.method ?? "GET";
    requests.push({ path, search: parsed.search, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, authorization: new Headers(init?.headers).get("Authorization") });
    if (path === "/api/info") return json({ version: "2.0.32" });
    if (path === "/api/model") return json({ data: catalog });
    if (path.startsWith("/api/experimental/mcp/")) return new Response(null, { status: 204 });
    if (path === "/api/mcp") return json({ data: [{ name: "woohaa", status: { status: mcpStatus } }] });
    if (path === "/api/session" && method === "POST") return json({ data: { id: `session-${++session}` } });
    if (path.endsWith("/prompt")) return json({ data: { id: "prompt-1" } });
    if (path.endsWith("/wait")) return new Response(null, { status: 204 });
    if (path.endsWith("/message")) return json({ data: [{ id: "message-1", type: "assistant", content: [{ type: "text", text: "done" }, { type: "tool", id: "call-1", name: "woohaa_submit_model_script", state: { status: "completed" } }] }] });
    if (/\/api\/session\/session-\d+$/.test(path)) return json({ data: { outcome: "succeeded" } });
    throw new Error(`Unexpected route ${path}`);
  });
  return { fetchImpl, requests };
}

describe("OpenCode v2 model catalog", () => {
  const catalog = [
    { id: "gpt-6", modelID: "gpt-6", providerID: "openai", name: "GPT-6", enabled: true, variants: [{ id: "low" }, { id: "high" }, { id: "fast" }] },
    { id: "gpt-6", modelID: "gpt-6", providerID: "custom", name: "GPT-6", enabled: true },
    { id: "solo", modelID: "solo", providerID: "solo-provider", name: "Solo", enabled: true },
    { id: "legacy", modelID: "legacy", providerID: "openai", name: "Legacy", enabled: false }
  ];
  const directory = { configDir: "/config", workDir: "/work", loopbackUrl: "http://127.0.0.1:42000", httpHeaders: { Authorization: "Basic process-auth" }, stdio: null };

  it("按 location 读取真实目录，身份用 providerID/modelID，Variant 只保留宿主认识的取值", async () => {
    const mock = openCodeMock("connected", catalog);
    const result = await createOpenCodeTransport(mock).models!(directory);
    expect(result).toEqual({ models: [
      { id: "openai/gpt-6", label: "GPT-6 (openai)", reasoningEfforts: ["low", "high"] },
      { id: "custom/gpt-6", label: "GPT-6 (custom)" },
      { id: "solo-provider/solo", label: "Solo (solo-provider)" }
    ] });
    const request = mock.requests.find(entry => entry.path === "/api/model")!;
    expect(request.search).toBe("?location%5Bdirectory%5D=%2Fwork");
    expect(request.authorization).toBe("Basic process-auth");
  });
  it("空目录给出登录/配置提示，不静默返回空下拉", async () => {
    const mock = openCodeMock("connected");
    const result = await createOpenCodeTransport({ ...mock, modelCatalogRetryMs: 0 }).models!(directory);
    expect(result).toEqual({ models: [], error: expect.stringContaining("未返回可用模型") });
    // 进程刚启动或回合进行中目录可能短暂为空：读取按间隔重试整个窗口，而不是第一次空响应就放弃。
    expect(mock.requests.filter(entry => entry.path === "/api/model")).toHaveLength(8);
  });
  it("首次空响应后重试拿到真实目录", async () => {
    let calls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async url => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/info") return json({ version: "2.0.20" });
      if (path === "/api/model") return json({ data: calls++ === 0 ? [] : [{ modelID: "m", providerID: "p", name: "M" }] });
      throw new Error(`Unexpected route ${path}`);
    });
    expect(await createOpenCodeTransport({ fetchImpl, modelCatalogRetryMs: 0 }).models!(directory)).toEqual({ models: [{ id: "p/m", label: "M (p)" }] });
    expect(calls).toBe(2);
  });
  it("目录读取失败如实返回原因，且 4xx 不重试", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({}, 403));
    const result = await createOpenCodeTransport({ fetchImpl, modelCatalogRetryMs: 0 }).models!(directory);
    expect(result).toEqual({ models: [], error: expect.stringContaining("HTTP 403") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("缺少专用进程时不发起请求", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await createOpenCodeTransport({ fetchImpl }).models!({ ...directory, loopbackUrl: null })).toEqual({ models: [], error: "OpenCode 专用进程未启动" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("OpenCode v2 remote MCP", () => {
  it("讨论通过原生 files 输入图片，工具面保持为空", async () => {
    const mock = openCodeMock();
    expect(await createOpenCodeTransport(mock).run(input({ allowedTools: [], toolToken: null, mcpEndpoint: null, images: [{ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" }] }))).toMatchObject({ ok: true });
    expect(mock.requests.find(request => request.path.endsWith("/prompt"))!.body.files).toEqual([{ uri: "data:image/png;base64,AQID", name: expect.any(String) }]);
    expect(mock.requests.some(request => request.method === "PUT")).toBe(false);
  });
  it("recognizes rejected MCP writes even if the native RPC completed", () => {
    expect(toolResultFailed([{ type: "text", text: JSON.stringify({ ok: false, errors: [{ message: "invalid script" }] }) }])).toBe(true);
    expect(toolResultFailed({ isError: true })).toBe(true);
    expect(toolResultFailed([{ type: "text", text: JSON.stringify({ ok: true, revision: 2 }) }])).toBe(false);
  });
  it("configures the current URL/grant, checks MCP status, projects durable messages, then removes runtime config", async () => {
    const mock = openCodeMock();
    const request = input({ httpHeaders: { Authorization: "Basic process-auth" }, model: "provider/model" });
    const result = await createOpenCodeTransport({ ...mock, catalogSettleMs: 0 }).run(request);
    expect(result).toMatchObject({ ok: true, outcome: { assistantText: "done" } });
    const config = mock.requests.find(request => request.method === "PUT")!;
    expect(config.body.config).toMatchObject({ type: "remote", url: input().mcpEndpoint!.url, headers: { Authorization: "Bearer turn-1" }, oauth: false });
    expect(mock.requests.every(request => request.authorization === "Basic process-auth")).toBe(true);
    expect(mock.requests.find(request => request.path === "/api/session")!.body).toMatchObject({ model: { providerID: "provider", id: "model" }, location: { directory: "/work" } });
    expect(mock.requests.find(request => request.path === "/api/session")!.body.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "woohaa_get_model_api", resource: "*", effect: "allow" },
      { action: "woohaa_submit_model_script", resource: "*", effect: "allow" }
    ]);
    expect(request.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "tool-completed", tool: "submit_model_script", ok: true }));
    expect(mock.requests.at(-1)?.method).toBe("DELETE");
  });
  it("does not start inference when MCP connection fails and still removes the token", async () => {
    const mock = openCodeMock("failed");
    expect(await createOpenCodeTransport({ ...mock, catalogSettleMs: 0 }).run(input())).toMatchObject({ ok: false, code: "tools-unavailable" });
    expect(mock.requests.some(request => request.path.endsWith("/prompt"))).toBe(false);
    expect(mock.requests.at(-1)?.method).toBe("DELETE");
  });
  it("serializes shared-location turns and rotates the bearer before the next prompt", async () => {
    const mock = openCodeMock();
    const transport = createOpenCodeTransport({ ...mock, catalogSettleMs: 0 });
    const results = await Promise.all([transport.run(input()), transport.run(input({ toolToken: "turn-2" }))]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(mock.requests.filter(request => request.method === "PUT" || request.method === "DELETE").map(request => [request.method, request.body?.config?.headers?.Authorization])).toEqual([
      ["PUT", "Bearer turn-1"], ["DELETE", undefined], ["PUT", "Bearer turn-2"], ["DELETE", undefined]
    ]);
  });
  it("cancels a queued turn immediately without letting the next turn bypass the active location", async () => {
    const mock = openCodeMock();
    const original = mock.fetchImpl.getMockImplementation()!;
    let release!: () => void;
    let waiting = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    mock.fetchImpl.mockImplementation(async (url, init) => {
      if (String(url).includes("session-1/wait")) { waiting = true; await gate; }
      return original(url, init);
    });
    const transport = createOpenCodeTransport({ ...mock, catalogSettleMs: 0 });
    const first = transport.run(input());
    await vi.waitFor(() => expect(waiting).toBe(true));
    const abort = new AbortController();
    const second = transport.run(input({ signal: abort.signal, toolToken: "turn-2" }));
    abort.abort();
    expect(await second).toMatchObject({ ok: false, code: "cancelled" });
    const third = transport.run(input({ toolToken: "turn-3" }));
    expect(mock.requests.filter(request => request.method === "PUT")).toHaveLength(1);
    release();
    expect((await Promise.all([first, third])).every(result => result.ok)).toBe(true);
    expect(mock.requests.filter(request => request.method === "PUT").map(request => request.body.config.headers.Authorization)).toEqual(["Bearer turn-1", "Bearer turn-3"]);
  });

  it("把本回合的 Variant 写进会话模型引用，续轮重新提交以覆盖上一次的档位", async () => {
    const mock = openCodeMock();
    const transport = createOpenCodeTransport({ ...mock, catalogSettleMs: 0 });
    // 新建会话：Variant 与模型同一次提交，避免先建默认档位再切换造成一回合跑在错误档位。
    expect(await transport.run(input({ model: "anthropic/claude-sonnet", reasoningEffort: "high" }))).toMatchObject({ ok: true });
    expect(mock.requests.find(request => request.path === "/api/session")!.body.model).toEqual({ providerID: "anthropic", id: "claude-sonnet", variant: "high" });
    // 未显式指定档位时不传 variant：上游沿用模型默认，不覆盖用户配置。
    expect(await transport.run(input({ toolToken: "turn-2", model: "anthropic/claude-sonnet" }))).toMatchObject({ ok: true });
    const created = mock.requests.filter(request => request.path === "/api/session");
    expect(created[1]!.body.model).toEqual({ providerID: "anthropic", id: "claude-sonnet" });
    expect(created[1]!.body.model).not.toHaveProperty("variant");
  });

  it("续轮把冻结的模型与 Variant 重新写回会话", async () => {
    const mock = openCodeMock();
    const original = mock.fetchImpl.getMockImplementation()!;
    mock.fetchImpl.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/model")) return new Response(null, { status: 204 });
      if (path === "/api/session/session-1" && init?.method === "GET") return json({ data: { id: "session-1", outcome: "succeeded" } });
      return original(url, init);
    });
    expect(await createOpenCodeTransport({ ...mock, catalogSettleMs: 0 }).run(input({ resumeNativeId: "session-1", model: "anthropic/claude-sonnet", reasoningEffort: "xhigh" }))).toMatchObject({ ok: true });
    const sessionModel = mock.fetchImpl.mock.calls.find(([url]) => new URL(String(url)).pathname === "/api/session/session-1/model")!;
    expect(JSON.parse(String(sessionModel[1]!.body))).toEqual({ model: { providerID: "anthropic", id: "claude-sonnet", variant: "xhigh" } });
  });

  it("updates resumed session permissions and excludes earlier assistant failures from this turn", async () => {
    const mock = openCodeMock();
    const original = mock.fetchImpl.getMockImplementation()!;
    let prompted = false;
    const old = { id: "old", error: { type: "old-error", message: "old failed turn" }, content: [] };
    mock.fetchImpl.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "PATCH" || path.endsWith("/model")) return new Response(null, { status: 204 });
      if (path.endsWith("/prompt")) prompted = true;
      if (path.endsWith("/message") && !prompted) return json({ data: [old] });
      if (path.endsWith("/message")) return json({ data: [{ id: "new", content: [{ type: "text", text: "new reply" }] }, old] });
      if (path === "/api/session/session-1" && init?.method === "GET") return json({ data: { id: "session-1", outcome: "succeeded" } });
      return original(url, init);
    });
    expect(await createOpenCodeTransport({ ...mock, catalogSettleMs: 0 }).run(input({ resumeNativeId: "session-1" }))).toMatchObject({ ok: true, outcome: { assistantText: "new reply" } });
    expect(mock.fetchImpl.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true);
  });
});


it("sends native image blocks to CodeBuddy without tools", async () => {
  const mock = codebuddyMock();
  expect(await createCodeBuddyTransport(mock).run(input({ allowedTools: [], toolToken: null, mcpEndpoint: null, images: [{ bytes: new Uint8Array([1,2,3]), contentType: "image/png" }] }))).toMatchObject({ ok: true });
  expect(mock.requests.find(request => request.method === "session/prompt")!.params.prompt).toEqual([{ type: "text", text: "create a tree" }, { type: "image", mimeType: "image/png", data: "AQID" }]);
  expect(mock.requests.find(request => request.method === "session/new")!.params.mcpServers).toEqual([]);
});
it("sends OpenCode v2 files as data URIs and denies all tools", async () => {
  const mock = openCodeMock();
  expect(await createOpenCodeTransport(mock).run(input({ allowedTools: [], toolToken: null, mcpEndpoint: null, model: "provider/model", images: [{ bytes: new Uint8Array([1,2,3]), contentType: "image/png" }] }))).toMatchObject({ ok: true });
  expect(mock.requests.find(request => request.path.endsWith("/prompt"))!.body.files).toEqual([{ uri: "data:image/png;base64,AQID", name: expect.any(String) }]);
  expect(mock.requests.find(request => request.path === "/api/session")!.body.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
  expect(mock.requests.some(request => request.method === "PUT")).toBe(false);
});
