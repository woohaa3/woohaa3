/**
 * endpoint 允许策略与有界 HTTP 客户端测试
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 1.5/5.1 验收）。
 *
 * 覆盖：未允许主机拒绝、http 仅回环、内嵌凭据拒绝、跨 origin 重定向不转发 Authorization/
 * x-api-key、同 origin 重定向受限、错误映射与取消。
 */
import { describe, expect, it } from "vitest";
import { createEndpointPolicy, guardedFetch } from "./endpoint-policy.js";
import { createBoundedHttpClient } from "./http-client.js";

const policy = createEndpointPolicy({ allowedHosts: ["api.openai.com", "*.example.com"] });

describe("endpoint 允许策略（任务 1.5）", () => {
  it("允许 https 且命中允许列表；未允许主机拒绝", () => {
    expect(policy.check("https://api.openai.com/v1/models").ok).toBe(true);
    expect(policy.check("https://proxy.example.com/v1").ok).toBe(true);
    const denied = policy.check("https://evil.test/v1");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("endpoint-not-allowed");
  });

  it("默认拒绝明文 http，且拒绝内嵌凭据 URL", () => {
    expect(policy.check("http://api.openai.com/v1").ok).toBe(false);
    expect(policy.check("https://user:pass@api.openai.com/v1").ok).toBe(false);
  });

  it("允许回环 http 仅在显式开启时", () => {
    const local = createEndpointPolicy({ allowedHosts: ["127.0.0.1", "localhost"], allowHttp: true });
    expect(local.check("http://127.0.0.1:4321/v1").ok).toBe(true);
    expect(local.check("http://localhost:4321/v1").ok).toBe(true);
    expect(local.check("http://10.0.0.5:4321/v1").ok).toBe(false);
  });

  it("通配 host 匹配子域但不匹配裸后缀", () => {
    const wildcard = createEndpointPolicy({ allowedHosts: ["*.example.com"] });
    expect(wildcard.check("https://a.example.com").ok).toBe(true);
    expect(wildcard.check("https://example.com").ok).toBe(false);
  });

  it("未指定 allowedHosts 或包含 * 时允许任意合法 https host（所有中转站均可填）", () => {
    const open = createEndpointPolicy({});
    expect(open.check("https://any-proxy.example.com/v1").ok).toBe(true);
    expect(open.check("https://my-custom-relay.org/v1").ok).toBe(true);
    const star = createEndpointPolicy({ allowedHosts: ["*"] });
    expect(star.check("https://any-proxy.example.com/v1").ok).toBe(true);
  });
});

describe("带凭据请求的重定向保护（任务 1.5）", () => {
  it("跨 origin 重定向失败，且不把 Authorization 转发到新主机", async () => {
    const seen: Array<{ url: string; authorization?: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      seen.push({ url: target, authorization: (init?.headers as Record<string, string> | undefined)?.authorization });
      return new Response(null, { status: 302, headers: { location: "https://evil.test/collect" } });
    }) as unknown as typeof globalThis.fetch;

    const result = await guardedFetch("https://api.openai.com/v1/chat", { method: "POST", headers: { authorization: "Bearer sk-secret" } }, policy, fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("endpoint-not-allowed");
    // 只请求了原 origin；evil.test 从未收到请求，凭据未外泄。
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.openai.com/v1/chat");
  });

  it("同 origin 重定向在允许跳数内跟随", async () => {
    let hop = 0;
    const fetchImpl = (async () => {
      hop += 1;
      if (hop === 1) return new Response(null, { status: 307, headers: { location: "https://api.openai.com/v1/chat/final" } });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const result = await guardedFetch("https://api.openai.com/v1/chat", {}, policy, fetchImpl);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response.status).toBe(200);
    expect(hop).toBe(2);
  });
});

describe("有界 HTTP 客户端（任务 5.1）", () => {
  it("错误按状态映射为稳定错误码，且携带截断正文", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "invalid api key" }), { status: 401 })) as unknown as typeof globalThis.fetch;
    const client = createBoundedHttpClient({ policy, fetchImpl });
    const result = await client.request({ url: "https://api.openai.com/v1/responses", body: { model: "gpt-4o" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("model-access-denied");
      expect(result.status).toBe(401);
    }
  });

  it("非 JSON 响应标记 protocol-mismatch（不把 HTML 200 当成功）", async () => {
    const fetchImpl = (async () => new Response("<html>login</html>", { status: 200 })) as unknown as typeof globalThis.fetch;
    const client = createBoundedHttpClient({ policy, fetchImpl });
    const result = await client.request({ url: "https://api.openai.com/v1/models" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("protocol-mismatch");
  });

  it("AbortSignal 取消中断请求", async () => {
    const controller = new AbortController();
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof globalThis.fetch;
    const client = createBoundedHttpClient({ policy, fetchImpl });
    const promise = client.request({ url: "https://api.openai.com/v1/responses", body: {}, signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("transport-unavailable");
  });

  it("客户端不读取全局环境凭据：显式头才发送", async () => {
    const captured: Record<string, string> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      Object.assign(captured, (init?.headers ?? {}) as Record<string, string>);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = createBoundedHttpClient({ policy, fetchImpl });
    await client.request({ url: "https://api.openai.com/v1/models" });
    expect(Object.keys(captured)).not.toContain("authorization");
    expect(Object.keys(captured)).not.toContain("x-api-key");
  });
});

describe("诊断脱敏（任务 1.4）", () => {
  it("敏感键与 token 形态的值被替换", async () => {
    const { redactEvent, redactString } = await import("./redact.js");
    const event = redactEvent({ event: "probe", apiKey: "sk-abcdefghijklmnop", nested: { authorization: "Bearer abcdefghijklmnop" }, message: "failed with sk-abcdefghijklmnop" });
    expect(event.apiKey).toBe("[redacted]");
    expect((event.nested as Record<string, unknown>).authorization).toBe("[redacted]");
    expect(String(event.message)).not.toContain("sk-abcdefghijklmnop");
    expect(redactString("hello sk-abcdefghijklmnop world")).toBe("hello [redacted] world");
  });
});
