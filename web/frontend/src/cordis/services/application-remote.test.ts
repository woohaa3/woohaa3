/**
 * Application Remote 通用插件传输测试
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 6.1 / design D9）。
 *
 * 验证：JSON 请求映射（状态码→稳定错误码、同源凭证、不附加服务令牌）、SSE 解析与取消。
 */
import { describe, expect, it } from "vitest";
import { createApplicationTransport } from "./application-remote.js";

function sseStream(blocks: string[]): ReadableStream<Uint8Array> {
  const encoded = blocks.map((block) => new TextEncoder().encode(block));
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= encoded.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoded[index]!);
      index += 1;
    }
  });
}

describe("createApplicationTransport", () => {
  it("不附加本地管理员令牌，扩展/会话/来源路径都只走同源会话", async () => {
    const calls: RequestInit[] = [];
    const transport = createApplicationTransport({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        calls.push(init);
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof globalThis.fetch
    });
    await transport.request({ path: "/api/extensions/game-furnace/handlers/collect", method: "POST", body: { canvasId: "c" } });
    expect(calls[0]).toMatchObject({ credentials: "same-origin", body: '{"canvasId":"c"}',
      headers: { "content-type": "application/json", "x-requested-with": "woohaa3" } });
    for (const path of [
      "/api/agent-conversations/connections?adapterId=codex-appserver",
      "/api/oauth-agent/status",
      "/api/sdk-agent/connections",
      "/api/local-agent/connections",
      "https://example.com/api/extensions/test",
      "//example.com/api/oauth-agent/status",
      "/api/chatgpt/status",
      "/api/canvases/canvas-a/runs"
    ]) {
      await transport.request({ path });
      expect(new Headers(calls.at(-1)!.headers).has("x-woohaa3-admin-token")).toBe(false);
    }
  });

  it("JSON 请求走同源路径并携带同源凭证；成功返回 data", async () => {
    const calls: Array<{ url: string; credentials?: RequestCredentials; headers?: unknown }> = [];
    const transport = createApplicationTransport({
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, credentials: init?.credentials ?? undefined, headers: init?.headers });
        return { ok: true, status: 200, json: async () => ({ hello: "world" }) };
      }) as unknown as typeof globalThis.fetch
    });
    const result = await transport.request({ path: "/api/chatgpt/status", method: "GET" });
    expect(result).toEqual({ ok: true, status: 200, data: { hello: "world" } });
    expect(calls[0]!.url).toBe("/api/chatgpt/status");
    expect(calls[0]!.credentials).toBe("same-origin");
  });

  it("错误状态映射稳定错误码，不泄漏正文以外的字段", async () => {
    const transport = createApplicationTransport({
      fetchImpl: (async () => ({ ok: false, status: 404, json: async () => ({ message: "未知路由" }) })) as unknown as typeof globalThis.fetch
    });
    const result = await transport.request({ path: "/api/chatgpt/x" });
    expect(result).toEqual({ ok: false, code: "not-found", error: "未知路由", status: 404 });
  });

  it("401 → unauthorized", async () => {
    const transport = createApplicationTransport({
      fetchImpl: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof globalThis.fetch
    });
    const result = await transport.request({ path: "/api/chatgpt/status" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unauthorized");
  });

  it("stream 解析 progress/result 事件并忽略 heartbeat 注释", async () => {
    const transport = createApplicationTransport({
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        body: sseStream([
          ": heartbeat\n\n",
          "event: progress\ndata: {\"stage\":\"reasoning\"}\n\n",
          "event: result\ndata: {\"status\":\"succeeded\"}\n\n"
        ])
      })) as unknown as typeof globalThis.fetch
    });
    const events: string[] = [];
    let closed = false;
    await new Promise<void>((resolve) => {
      transport.stream({
        path: "/api/chatgpt/generate",
        method: "POST",
        body: {},
        callbacks: {
          onEvent: (event) => events.push(`${event.type}:${event.data}`),
          onError: () => undefined,
          onClose: () => {
            closed = true;
            resolve();
          }
        }
      });
    });
    expect(events).toEqual([
      'progress:{"stage":"reasoning"}',
      'result:{"status":"succeeded"}'
    ]);
    expect(closed).toBe(true);
  });

  it("stream 失败回调 onError", async () => {
    const transport = createApplicationTransport({
      fetchImpl: (async () => ({ ok: false, status: 502, json: async () => ({ message: "上游失败" }) })) as unknown as typeof globalThis.fetch
    });
    const errors: Array<{ message: string; code: string }> = [];
    await new Promise<void>((resolve) => {
      transport.stream({
        path: "/api/chatgpt/generate",
        callbacks: {
          onEvent: () => undefined,
          onError: (message, code) => {
            errors.push({ message, code });
            resolve();
          }
        }
      });
    });
    expect(errors[0]!.message).toBe("上游失败");
  });
});
