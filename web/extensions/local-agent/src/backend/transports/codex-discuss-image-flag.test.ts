/**
 * 讨论回合关闭内建生图（change: 2026-11-03-add-codex-image-import，D3）。
 *
 * 讨论回合只读对话，不得产生画布外文件；目标回合保留 Codex 默认（开启）。
 */
import { describe, expect, it } from "vitest";
import type { StdioConnection } from "../process-manager.js";
import { createCodexAppServerTransport } from "./codex-appserver-transport.js";
import type { LocalAgentTransportInput } from "./transport.js";

type Request = { id?: number; method: string; params?: Record<string, unknown> };

function captureThreadStart(mcpEndpoint: LocalAgentTransportInput["mcpEndpoint"]) {
  const listeners = new Set<(line: string) => void>();
  const requests: Request[] = [];
  const emit = (message: Record<string, unknown>) => {
    for (const listener of [...listeners]) listener(JSON.stringify(message));
  };
  const connection: StdioConnection = {
    send(line) {
      const req = JSON.parse(line) as Request;
      requests.push(req);
      const result = req.method === "account/read" ? { account: { type: "chatgpt" } }
        : req.method === "thread/start" ? { thread: { id: "thread-1" } }
        : req.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
      queueMicrotask(() => emit({ id: req.id, result }));
    },
    onLine(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() {}
  };
  const input = (): LocalAgentTransportInput => ({
    configDir: "/tmp/config", workDir: "/tmp/work", loopbackUrl: null, stdio: connection,
    model: "gpt-test", prompt: "hi", allowedTools: [], toolToken: null, mcpEndpoint,
    resumeNativeId: null, signal: new AbortController().signal, onEvent: () => undefined
  });
  return { requests, emit, input };
}

const transport = () => createCodexAppServerTransport({ protocolVersion: "2025-06-18", clientVersion: "test" });

describe("讨论回合关闭内建生图", () => {
  it("讨论回合（无 MCP endpoint）设置 features.image_generation=false", async () => {
    const fake = captureThreadStart(null);
    const run = transport().run(fake.input());
    for (let n = 0; n < 200 && !fake.requests.some(r => r.method === "turn/start"); n++) await Promise.resolve();
    expect(fake.requests.some(r => r.method === "turn/start")).toBe(true);
    fake.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await run;
    const start = fake.requests.find(r => r.method === "thread/start");
    const config = start?.params?.config as Record<string, unknown> | undefined;
    expect(config?.["features.image_generation"]).toBe(false);
  });

  it("未声明生图能力时，即使有 MCP endpoint 也关闭生图", async () => {
    const fake = captureThreadStart({ name: "woohaa3-model-canvas", url: "http://127.0.0.1/mcp/model-canvas" });
    const run = transport().run(fake.input());
    for (let n = 0; n < 80 && !fake.requests.some(r => r.method === "thread/start"); n++) await Promise.resolve();
    // 目标回合会核对 MCP 工具面；直接给一个带工具的响应避免等待。
    const statusReq = fake.requests.find(r => r.method === "mcpServerStatus/list");
    if (statusReq) {
      fake.emit({ id: statusReq.id, result: { data: [{ name: "woohaa3-model-canvas", tools: [] }] } });
    }
    for (let n = 0; n < 200 && !fake.requests.some(r => r.method === "turn/start"); n++) {
      await Promise.resolve();
      const pending = fake.requests.find(r => r.method === "mcpServerStatus/list" && !statusReq);
      if (pending) fake.emit({ id: pending.id, result: { data: [{ name: "woohaa3-model-canvas", tools: [] }] } });
    }
    fake.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await run;
    const start = fake.requests.find(r => r.method === "thread/start");
    const config = start?.params?.config as Record<string, unknown> | undefined;
    expect(config).toBeDefined();
    expect(config?.["features.image_generation"]).toBe(false);
  });
});
