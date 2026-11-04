/**
 * Codex 内建生图产物路径记录（change: 2026-11-03-add-codex-image-import）。
 *
 * 只验证传输层从 `item/completed` 的 `imageGeneration` 项提取 `savedPath`：
 * 按到达顺序累积、不转发 base64、缺路径时不产出条目。
 */
import { clearGeneratedImages, generatedImageCodexHome, generatedImagePaths } from "@woohaa3/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { connectionCodexHome } from "../codex-home.js";
import type { StdioConnection } from "../process-manager.js";
import { createCodexAppServerTransport } from "./codex-appserver-transport.js";
import type { LocalAgentTransportInput } from "./transport.js";

type Request = { id?: number; method: string; params?: Record<string, unknown> };

function fakeStdio() {
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
  const input = (onEvent: LocalAgentTransportInput["onEvent"] = () => undefined): LocalAgentTransportInput => ({
    configDir: "/tmp/config", workDir: "/tmp/work", loopbackUrl: null, stdio: connection,
    model: "gpt-test", prompt: "draw", allowedTools: [], toolToken: null, mcpEndpoint: null,
    resumeNativeId: null, signal: new AbortController().signal, onEvent
  });
  /** 等到 turn/start 已发出，事件监听就绪。 */
  const started = async () => {
    for (let n = 0; n < 40 && !requests.some(r => r.method === "turn/start"); n++) await Promise.resolve();
    expect(requests.some(r => r.method === "turn/start")).toBe(true);
  };
  return { requests, emit, input, started };
}

const transport = () => createCodexAppServerTransport({ protocolVersion: "2025-06-18", clientVersion: "test" });

describe("Codex 生图产物路径记录", () => {
  afterEach(() => clearGeneratedImages("req-registry"));

  it("到达时按回合 requestId 登记路径，供导入工具在回合结束前读取", async () => {
    const fake = fakeStdio();
    const run = transport().run({ ...fake.input(), turnRequestId: "req-registry" });
    await fake.started();
    fake.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1", turnId: "turn-1",
        item: { type: "imageGeneration", id: "g1", status: "completed", savedPath: "/codex/generated_images/s1/a.png", result: "AAA" }
      }
    });
    expect(generatedImagePaths("req-registry")).toEqual(["/codex/generated_images/s1/a.png"]);
    expect(generatedImageCodexHome("req-registry")).toBe(connectionCodexHome("/tmp/config"));
    fake.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1", status: "completed" } } });
    await run;
  });

  it("按到达顺序记录多张图的 savedPath", async () => {
    const fake = fakeStdio();
    const run = transport().run(fake.input());
    await fake.started();

    fake.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1", turnId: "turn-1",
        item: { type: "imageGeneration", id: "g1", status: "completed", savedPath: "/codex/generated_images/s1/a.png", result: "AAA" }
      }
    });
    fake.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1", turnId: "turn-1",
        item: { type: "imageGeneration", id: "g2", status: "completed", savedPath: "/codex/generated_images/s1/b.png", result: "BBB" }
      }
    });
    fake.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

    const result = await run;
    expect(result).toMatchObject({ ok: true, generatedImagePaths: ["/codex/generated_images/s1/a.png", "/codex/generated_images/s1/b.png"] });
  });

  it("缺少 savedPath 时不产出条目", async () => {
    const fake = fakeStdio();
    const run = transport().run(fake.input());
    await fake.started();

    fake.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1", turnId: "turn-1",
        item: { type: "imageGeneration", id: "g1", status: "completed", result: "AAA" }
      }
    });
    fake.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

    const result = await run;
    expect(result).toMatchObject({ ok: true, generatedImagePaths: [] });
  });

  it("不把 base64 转发进事件流", async () => {
    const fake = fakeStdio();
    const forwarded: unknown[] = [];
    const run = transport().run(fake.input((event) => { forwarded.push(event); }));
    await fake.started();

    const bigPayload = "A".repeat(5000);
    fake.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1", turnId: "turn-1",
        item: { type: "imageGeneration", id: "g1", status: "completed", savedPath: "/codex/generated_images/s1/a.png", result: bigPayload }
      }
    });
    fake.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

    await run;
    const serialized = JSON.stringify(forwarded);
    expect(serialized).not.toContain(bigPayload);
  });
});
