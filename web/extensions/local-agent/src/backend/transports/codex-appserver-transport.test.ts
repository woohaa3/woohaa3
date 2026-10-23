/**
 * Codex App Server stdio 传输测试（本地协议模拟；不启动真实进程）
 *
 * 覆盖当前公开协议的关键形状：`thread/start` 返回嵌套 `thread.id`、模型目录来自
 * `model/list`、同一专用进程只 initialize 一次、未返回 threadId 时拒绝 `turn/start`。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StdioConnection } from "../process-manager.js";
import { createCodexAppServerTransport } from "./codex-appserver-transport.js";
import type { LocalAgentTransportInput } from "./transport.js";

type Request = { id?: number; method: string; params?: Record<string, unknown> };

function concurrentStdio() {
  const listeners = new Set<(line: string) => void>();
  const requests: Request[] = [];
  let thread = 0;
  const emit = (message: Record<string, unknown>) => {
    for (const listener of [...listeners]) listener(JSON.stringify(message));
  };
  const connection: StdioConnection = {
    send(line) {
      const req = JSON.parse(line) as Request;
      requests.push(req);
      const result = req.method === "account/read" ? { account: { type: "chatgpt" } }
        : req.method === "thread/start" ? { thread: { id: `thread-${++thread}` } }
        : req.method === "turn/start" ? { turn: { id: `turn-${req.params?.threadId}` } } : {};
      // A real pipe delivers responses later, while other callers already have requests in flight.
      queueMicrotask(() => emit({ id: req.id, result }));
    },
    onLine(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() {}
  };
  const input = (prompt: string, signal = new AbortController().signal): LocalAgentTransportInput => ({
    configDir: "/tmp/config", workDir: "/tmp/work", loopbackUrl: null, stdio: connection,
    model: "gpt-test", prompt, allowedTools: [], toolToken: null, mcpEndpoint: null,
    resumeNativeId: null, signal, onEvent: () => undefined
  });
  const started = async () => {
    for (let n = 0; n < 40 && requests.filter(r => r.method === "turn/start").length < 2; n++) await Promise.resolve();
    expect(requests.filter(r => r.method === "turn/start")).toHaveLength(2);
  };
  return { connection, requests, emit, input, started };
}

describe("concurrent canvas creation threads", () => {
  it("allows a native turn past ten minutes and still accepts its real completion", async () => {
    const fake = concurrentStdio();
    vi.useFakeTimers();
    try {
      const run = createCodexAppServerTransport({ protocolVersion: "2025-06-18", clientVersion: "test" }).run(fake.input("long"));
      for (let n = 0; n < 40; n++) await Promise.resolve();
      expect(fake.requests.some(request => request.method === "turn/start")).toBe(true);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      fake.emit({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-thread-1", delta: "complete scene" } });
      fake.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-thread-1", status: "completed" } } });
      expect(await run).toMatchObject({ ok: true, outcome: { assistantText: "complete scene" } });
    } finally { vi.useRealTimers(); }
  });

  it("isolates RPC responses, messages and failure on a shared App Server connection", async () => {
    const fake = concurrentStdio();
    const events: unknown[] = [];
    const a = transport().run({ ...fake.input("A"), onEvent: event => events.push(event) });
    const b = transport().run(fake.input("B"));
    const catalog = transport().models!(fake.input("catalog"));
    await fake.started();
    const ids = fake.requests.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    fake.emit({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-thread-1", delta: "only A" } });
    fake.emit({ method: "error", params: { threadId: "thread-2", turnId: "turn-thread-2", willRetry: false, error: { message: "only B failed" } } });
    fake.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-thread-1", status: "completed" } } });
    expect(await a).toMatchObject({ ok: true, nativeId: "thread-1", outcome: { assistantText: "only A" } });
    expect(await b).toMatchObject({ ok: false, nativeId: "thread-2", message: "only B failed" });
    expect(events).not.toContainEqual(expect.objectContaining({ content: "only B failed" }));
    await catalog;
  });

  it("interrupts only the cancelled thread and leaves the other group running", async () => {
    const fake = concurrentStdio();
    const abort = new AbortController();
    const a = transport().run(fake.input("A", abort.signal));
    const b = transport().run(fake.input("B"));
    await fake.started();
    // Let turn/start responses bind their turn identities.
    await Promise.resolve(); await Promise.resolve();
    abort.abort();
    expect(await a).toMatchObject({ ok: false, code: "cancelled" });
    expect(fake.requests.filter(r => r.method === "turn/interrupt")).toEqual([
      expect.objectContaining({ params: { threadId: "thread-1", turnId: "turn-thread-1" } })
    ]);
    fake.emit({ method: "turn/completed", params: { threadId: "thread-2", turn: { id: "turn-thread-2", status: "completed" } } });
    expect(await b).toMatchObject({ ok: true, nativeId: "thread-2" });
  });
});

function fakeStdio(options: {
  threadId?: string | null;
  account?: Record<string, unknown>;
  mcpStatus?: "ready" | "failed" | "unknown";
  mcpShape?: "legacy" | "v2";
  mcpTools?: readonly string[];
} = {}): {
  connection: StdioConnection;
  requests: Request[];
  initializeCount: () => number;
} {
  const listeners = new Set<(line: string) => void>();
  const requests: Request[] = [];
  const emit = (message: Record<string, unknown>) => {
    const line = JSON.stringify(message);
    for (const listener of listeners) listener(line);
  };
  const respond = (id: number | undefined, result: Record<string, unknown>) => {
    if (id !== undefined) emit({ jsonrpc: "2.0", id, result });
  };
  const connection: StdioConnection = {
    send(line) {
      const request = JSON.parse(line) as Request;
      requests.push(request);
      switch (request.method) {
        case "initialize":
          respond(request.id, { userAgent: "fake", codexHome: "/tmp/fake" });
          return;
        case "account/read":
          respond(request.id, options.account ?? { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true });
          return;
        case "model/list":
          respond(request.id, {
            data: [
              { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }, { reasoningEffort: "invalid" }] },
              { id: "gpt-hidden", displayName: "Hidden", hidden: true }
            ],
            nextCursor: null
          });
          return;
        case "thread/start":
          respond(request.id, options.threadId === null ? { thread: {} } : { thread: { id: options.threadId ?? "th_1" } });
          return;
        case "thread/resume":
          respond(request.id, { thread: { id: request.params?.threadId ?? options.threadId ?? "th_1" } });
          return;
        case "thread/unsubscribe":
          respond(request.id, {});
          return;
        case "mcpServerStatus/list": {
          const tools = options.mcpTools ?? ["get_model_node", "submit_model_script"];
          const toolMap = options.mcpStatus === "failed" ? {} : Object.fromEntries(tools.map((name) => [name, { name, inputSchema: { type: "object" } }]));
          const runtimeStatus = options.mcpStatus === "failed" ? "failed" : options.mcpStatus === "unknown" ? "unknown" : "connected";
          const entry = options.mcpShape === "v2"
            ? {
              serverInfo: { name: "woohaa3-model-canvas" },
              authStatus: "bearerToken",
              tools: toolMap,
              resources: [],
              resourceTemplates: []
            }
            : {
              name: "woohaa",
              authStatus: "bearerToken",
              runtimeStatus,
              tools: toolMap,
              toolsError: options.mcpStatus === "failed" ? "HTTP 404" : null,
              resources: [],
              resourceTemplates: []
            };
          respond(request.id, { data: [entry] });
          return;
        }
        case "turn/start":
          respond(request.id, { turn: { id: "turn_1" } });
          queueMicrotask(() => {
            emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: request.params?.threadId, delta: "ok" } });
            emit({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: request.params?.threadId, turn: { id: "turn_1" } } });
          });
          return;
        default:
          respond(request.id, {});
      }
    },
    onLine(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStderr() {
      return () => undefined;
    },
    close() {
      listeners.clear();
    }
  };
  return {
    connection,
    requests,
    initializeCount: () => requests.filter((request) => request.method === "initialize").length
  };
}

function transport() {
  return createCodexAppServerTransport({ protocolVersion: "2025-06-18", clientVersion: "test" });
}

describe("Codex App Server 传输（当前协议）", () => {
  it("从嵌套 thread.id 取得 threadId，未选模型时不向 thread/start 发送空 model", async () => {
    const fake = fakeStdio();
    const result = await transport().run({
      configDir: "/tmp/config",
      workDir: "/tmp/work",
      loopbackUrl: null,
      stdio: fake.connection,
      model: "",
      prompt: "hi",
      reasoningEffort: "high",
      images: [{ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" }],
      allowedTools: [],
      toolToken: null,
      mcpEndpoint: null,
      resumeNativeId: null,
      signal: new AbortController().signal,
      onEvent: () => undefined
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nativeId).toBe("th_1");
    expect(result.outcome.status).toBe("succeeded");
    expect(result.outcome.assistantText).toBe("ok");

    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    expect(threadStart?.params).not.toHaveProperty("model");
    const turnStart = fake.requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params?.threadId).toBe("th_1");
    expect(turnStart?.params?.effort).toBe("high");
    expect(turnStart?.params?.input).toEqual([{ type: "text", text: "hi" }, { type: "image", url: "data:image/png;base64,AQID" }]);
  });

  it("自定义 provider 的 requiresOpenaiAuth:false 不按未登录拒绝", async () => {
    const fake = fakeStdio({ account: { account: null, requiresOpenaiAuth: false } });
    const evidence: Array<Record<string, unknown>> = [];
    const result = await transport().run({
      configDir: "/tmp/config",
      workDir: "/tmp/work",
      loopbackUrl: null,
      stdio: fake.connection,
      model: "gpt-6.1-sol",
      prompt: "hi",
      allowedTools: [],
      toolToken: null,
      mcpEndpoint: null,
      resumeNativeId: null,
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onEvidence: (event) => evidence.push(event),
    });
    expect(result.ok).toBe(true);
    expect(fake.requests.some((request) => request.method === "turn/start")).toBe(true);
    expect(evidence).toContainEqual({ transport: "ready", credential: "ready" });
  });

  it("同一专用进程多轮只 initialize 一次；续轮使用 resume 的 threadId", async () => {
    const fake = fakeStdio();
    const first = await transport().run({
      configDir: "/tmp/config",
      workDir: "/tmp/work",
      loopbackUrl: null,
      stdio: fake.connection,
      model: "gpt-6.1-sol",
      prompt: "first",
      allowedTools: ["get_model_node", "submit_model_script"],
      toolToken: "grant-1",
      mcpEndpoint: { name: "woohaa", url: "http://127.0.0.1:1234/mcp" },
      resumeNativeId: null,
      signal: new AbortController().signal,
      onEvent: () => undefined
    });
    expect(first.ok).toBe(true);
    const second = await transport().run({
      configDir: "/tmp/config",
      workDir: "/tmp/work",
      loopbackUrl: null,
      stdio: fake.connection,
      model: "gpt-6.1-sol",
      prompt: "second",
      allowedTools: ["get_model_node", "submit_model_script"],
      toolToken: "grant-1",
      mcpEndpoint: { name: "woohaa", url: "http://127.0.0.1:1234/mcp" },
      resumeNativeId: "th_1",
      signal: new AbortController().signal,
      onEvent: () => undefined
    });
    expect(second.ok).toBe(true);
    expect(fake.initializeCount()).toBe(1);
    expect(fake.requests.filter((request) => request.method === "thread/resume")).toHaveLength(1);
    expect(fake.requests.filter((request) => request.method === "mcpServerStatus/list")).toHaveLength(2);

    const firstStart = fake.requests.find((request) => request.method === "thread/start");
    expect(firstStart?.params?.model).toBe("gpt-6.1-sol");
    // 当前协议通过 config.mcp_servers 注入受控工具面，而不是顶层 mcpServers。
    expect(firstStart?.params?.config).toMatchObject({
      mcp_servers: {
        woohaa: {
          url: "http://127.0.0.1:1234/mcp",
          http_headers: { Authorization: "Bearer grant-1" },
          default_tools_approval_mode: "approve",
          enabled_tools: ["get_model_node", "submit_model_script"]
        }
      },
      "features.shell_tool": false,
      "features.js_repl": false,
      "features.apps": false,
      "features.skills": false,
      web_search: "disabled"
    });
  });

  it("受控 MCP 已暴露所需工具时即使 runtimeStatus 为 unknown 也发送 turn/start", async () => {
    const fake = fakeStdio({ mcpStatus: "unknown" });
    const result = await transport().run({
      configDir: "/tmp/config",
      workDir: "/tmp/work",
      loopbackUrl: null,
      stdio: fake.connection,
      model: "gpt-6.1-sol",
      prompt: "根据这个图生成一下3d模型给我",
      allowedTools: ["get_model_node", "submit_model_script"],
      toolToken: "grant-1",
      mcpEndpoint: { name: "woohaa", url: "http://127.0.0.1:1234/mcp" },
      resumeNativeId: null,
      signal: new AbortController().signal,
      onEvent: () => undefined
    });
    expect(result.ok).toBe(true);
    expect(fake.requests.filter((request) => request.method === "mcpServerStatus/list")).toHaveLength(1);
    expect(fake.requests.some((request) => request.method === "turn/start")).toBe(true);
  });

  it("Codex v2 用 serverInfo.name 且无 runtimeStatus 时仍按工具目录放行", async () => {
    const fake = fakeStdio({ mcpShape: "v2" });
    const result = await transport().run({
      configDir: "/tmp/config",
      workDir: "/tmp/work",
      loopbackUrl: null,
      stdio: fake.connection,
      model: "gpt-6.1-sol",
      prompt: "根据这个图生成一下3d模型给我",
      allowedTools: ["get_model_node", "submit_model_script"],
      toolToken: "grant-1",
      mcpEndpoint: { name: "woohaa", url: "http://127.0.0.1:1234/mcp" },
      resumeNativeId: null,
      signal: new AbortController().signal,
      onEvent: () => undefined
    });
    expect(result.ok).toBe(true);
    expect(fake.requests.some((request) => request.method === "turn/start")).toBe(true);
  });

  it("受控 MCP 未就绪时拒绝发送 turn/start，不把“没有工具”当成成功回合", async () => {
    const fake = fakeStdio({ mcpStatus: "failed" });
    const result = await transport().run({
      configDir: "/tmp/config",
      workDir: "/tmp/work",
      loopbackUrl: null,
      stdio: fake.connection,
      model: "gpt-6.1-sol",
      prompt: "把建筑改成两层楼",
      allowedTools: ["get_model_node", "submit_model_script"],
      toolToken: "grant-1",
      mcpEndpoint: { name: "woohaa", url: "http://127.0.0.1:1234/dev/app/mcp/model-canvas" },
      resumeNativeId: null,
      signal: new AbortController().signal,
      onEvent: () => undefined
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("tools-unavailable");
    expect(result.message).toContain("HTTP 404");
    expect(fake.requests.some((request) => request.method === "mcpServerStatus/list")).toBe(true);
    expect(fake.requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  it("未返回 threadId 时拒绝发送 turn/start，不产生缺字段请求", async () => {
    const fake = fakeStdio({ threadId: null });
    const result = await transport().run({
      configDir: "/tmp/config",
      workDir: "/tmp/work",
      loopbackUrl: null,
      stdio: fake.connection,
      model: "",
      prompt: "hi",
      allowedTools: [],
      toolToken: null,
      mcpEndpoint: null,
      resumeNativeId: null,
      signal: new AbortController().signal,
      onEvent: () => undefined
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("protocol-mismatch");
    expect(fake.requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  it("显式维护检查仅初始化和核对账号，不读取模型或发送 turn", async () => {
    const { connection, requests } = fakeStdio();
    expect(await transport().check!({ configDir: "/tmp/config", workDir: "/tmp/work", loopbackUrl: null, stdio: connection })).toMatchObject({ transport: { state: "ready" }, credential: { state: "ready" }, modelAccess: { state: "unknown" }, tools: { state: "unknown" } });
    expect(requests.map((request) => request.method)).toContain("account/read");
    expect(requests.some((request) => ["model/list", "thread/start", "turn/start"].includes(request.method))).toBe(false);
  });

  it("model/list 读取真实目录（过滤 hidden），不发送 prompt", async () => {
    const fake = fakeStdio();
    const snapshot = await transport().models!({
      configDir: "/tmp/config",
      workDir: "/tmp/work",
      loopbackUrl: null,
      stdio: fake.connection
    });
    expect(snapshot.models).toEqual([{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol", reasoningEfforts: ["low", "high"] }]);
    expect(fake.requests.some((request) => request.method === "turn/start")).toBe(false);

    await transport().models!({
      configDir: "/tmp/config",
      workDir: "/tmp/work",
      loopbackUrl: null,
      stdio: fake.connection
    });
    expect(fake.initializeCount()).toBe(1);
  });

  it("复用 Codex home 时显式禁用继承的 MCP，只保留本轮受控工具", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "woohaa-codex-transport-"));
    try {
      mkdirSync(path.join(configDir, ".codex"), { recursive: true });
      writeFileSync(
        path.join(configDir, ".codex", "config.toml"),
        [
          "[mcp_servers.model-canvas]",
          'url = "http://localhost:5320"',
          "[mcp_servers.other]",
          'url = "http://localhost:1"',
          '[plugins."browser@openai-bundled"]',
          "enabled = true",
        ].join("\n"),
      );
      const fake = fakeStdio();
      const result = await transport().run({
        configDir,
        workDir: "/tmp/work",
        loopbackUrl: null,
        stdio: fake.connection,
        model: "gpt-6.1-sol",
        prompt: "hi",
        allowedTools: ["get_model_node", "submit_model_script"],
        toolToken: "grant-1",
        mcpEndpoint: { name: "woohaa", url: "http://127.0.0.1:1234/mcp" },
        resumeNativeId: null,
        signal: new AbortController().signal,
        onEvent: () => undefined,
      });
      expect(result.ok).toBe(true);
      const threadStart = fake.requests.find((request) => request.method === "thread/start");
      expect(threadStart?.params?.config).toMatchObject({
        mcp_servers: {
          "model-canvas": { enabled: false },
          other: { enabled: false },
          woohaa: {
            url: "http://127.0.0.1:1234/mcp",
            http_headers: { Authorization: "Bearer grant-1" },
            default_tools_approval_mode: "approve",
            enabled_tools: ["get_model_node", "submit_model_script"],
          },
        },
        plugins: {
          "browser@openai-bundled": { enabled: false },
        },
      });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("讨论轮无 grant 时也不把继承的 MCP 暴露给模型", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "woohaa-codex-transport-"));
    try {
      mkdirSync(path.join(configDir, ".codex"), { recursive: true });
      writeFileSync(
        path.join(configDir, ".codex", "config.toml"),
        '[mcp_servers.model-canvas]\nurl = "http://localhost:5320"\n',
      );
      const fake = fakeStdio();
      const result = await transport().run({
        configDir,
        workDir: "/tmp/work",
        loopbackUrl: null,
        stdio: fake.connection,
        model: "gpt-6.1-sol",
        prompt: "hi",
        allowedTools: [],
        toolToken: null,
        mcpEndpoint: null,
        resumeNativeId: null,
        signal: new AbortController().signal,
        onEvent: () => undefined,
      });
      expect(result.ok).toBe(true);
      const threadStart = fake.requests.find((request) => request.method === "thread/start");
      expect(threadStart?.params?.config).toMatchObject({
        mcp_servers: { "model-canvas": { enabled: false } },
      });
      expect(threadStart?.params?.config).not.toHaveProperty("mcp_servers.woohaa");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});


it("sends real image bytes and candidate schema through native turn/start", async () => {
  const fake = fakeStdio();
  expect(await transport().run({ configDir: "/tmp/config", workDir: "/tmp/work", loopbackUrl: null, stdio: fake.connection,
    model: "vision", prompt: "scene", allowedTools: [], toolToken: null, mcpEndpoint: null, resumeNativeId: null,
    images: [{ bytes: new Uint8Array([1,2,3]), contentType: "image/jpeg" }], outputSchema: { type: "object" },
    signal: new AbortController().signal, onEvent: () => undefined })).toMatchObject({ ok: true });
  expect(fake.requests.find(request => request.method === "turn/start")!.params).toMatchObject({ summary: "concise", input: [{ type: "text", text: "scene" }, { type: "image", url: "data:image/jpeg;base64,AQID" }], outputSchema: { type: "object" } });
});
