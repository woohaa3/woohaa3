/**
 * ChatGPT 服务端到端（HTTP 面）
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 3.1/3.5/6.1）。
 *
 * 使用 fake SDK 与 fake Canvas 端口，经真实 HTTP handler 覆盖：owner cookie、生成、状态快照、
 * 公开面无 token、requestId 恢复、未授权拒绝、两用户隔离与断开。
 */
import http from "node:http";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexFactoryOptions, CodexLike } from "../src/backend/index.js";
import { createChatGptService } from "../src/backend/service.js";
import { CHATGPT_PLAN_SCOPE } from "../src/backend/oauth.js";
import type { ChatGptCanvasPorts } from "../src/backend/ports.js";

const dirs: string[] = [];
const apps: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-chatgpt-e2e-"));
  dirs.push(dir);
  return dir;
}

const VALID_SCRIPT = `scene.box({ id: "box", size: [1,1,1] });`;
void VALID_SCRIPT;

function fakeCodex(threads: Parameters<CodexLike["startThread"]>[0][] = []): (options: CodexFactoryOptions) => CodexLike {
  return () => ({
    startThread: (options) => {
      threads.push(options);
      return {
        runStreamed: async () => ({
          events: (async function* () {
            // 工具模式（design D4b）：写工具调用事件派生回执。
            yield { type: "item.completed", item: { id: "1", type: "mcp_tool_call", server: "s", tool: "submit_model_script", arguments: {}, status: "completed" } };
            yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
          })()
        })
      };
    }
  });
}

function ports(): ChatGptCanvasPorts {
  return {
    readNode: async () => ({ ok: true, nodeType: "model3d", title: "m", prompt: "", references: [], modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "c" }, cameras: [] }),
    submitModel: async () => ({ ok: true, canvasId: "cv", nodeId: "n", commandId: "cmd", duplicate: false, noop: false }),
    mutateCamerasBatch: async () => ({ ok: true, canvasId: "cv", nodeId: "n", commandId: "cmd", duplicate: false, noop: false })
  };
}

async function boot(
  threads: Parameters<CodexLike["startThread"]>[0][] = [],
  options: { fetchImpl?: typeof globalThis.fetch } = {}
) {
  const dir = tempDir();
  const service = createChatGptService({
    env: {
      WOOHAA3_CHATGPT_CREDENTIAL_DIR: path.join(dir, "chatgpt-creds"),
      WOOHAA3_CHATGPT_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"),
      WOOHAA3_CHATGPT_ALLOW_LOCAL_CALLBACK: "1",
      // 本地 loopback 回调；allowLocalCallback 启用本地会话。
      WOOHAA3_CHATGPT_CALLBACK_ORIGIN: "http://127.0.0.1:1455"
    },
    canvasPorts: ports(),
    authConfigured: false,
    createCodex: fakeCodex(threads),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  });
  const server = http.createServer((req, res) => {
    void service.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const app = {
    base: `http://127.0.0.1:${port}`,
    service,
    async close() {
      await service.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  apps.push(app);
  return app;
}

/** 模拟浏览器：捕获并回传 Set-Cookie。 */
function client(base: string) {
  let cookie = "";
  return {
    cookie: () => cookie,
    async fetch(pathname: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers ?? {});
      if (cookie) headers.set("cookie", cookie);
      const response = await fetch(`${base}${pathname}`, { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0]!;
      return response;
    }
  };
}

describe("ChatGPT HTTP 面", () => {
  it("本地会话签发 HttpOnly cookie；公开状态不含 token", async () => {
    const app = await boot();

    const c = client(app.base);
    const status = await c.fetch("/api/oauth-agent/status");
    expect(status.status).toBe(200);
    const body = (await status.json()) as { state: string; ownerKind: string };
    expect(body.state).toBe("disconnected");
    expect(body.ownerKind).toBe("local-session");
    expect(c.cookie()).toContain("woohaa3-chatgpt-session=");
    expect(JSON.stringify(body)).not.toMatch(/access|refresh|id_token/i);
  });

  it("本地开发回调 redirect URI 与请求同 host（保证 popup 与主页面共享会话）", async () => {
    const app = await boot();
    const c = client(app.base);
    await c.fetch("/api/oauth-agent/status");
    const response = await c.fetch("/api/oauth-agent/authorize/start", {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.base },
      body: "{}"
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    const redirectUri = new URL(body.url).searchParams.get("redirect_uri")!;
    expect(redirectUri.startsWith(`${app.base}/api/oauth-agent/authorize/complete`)).toBe(true);
  });

  it("授权回调在同一会话下不因 Cookie 头差异被误判为会话不匹配（回归）", async () => {
    // token 交换必须在本机完成：真实请求会让断言依赖外网可达性（离线时只会拿到 `fetch failed`）。
    const app = await boot([], {
      fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      })
    });
    const c = client(app.base);
    await c.fetch("/api/oauth-agent/status");
    const cookie = c.cookie();
    const startRes = await c.fetch("/api/oauth-agent/authorize/start", {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.base },
      body: "{}"
    });
    const state = new URL(((await startRes.json()) as { url: string }).url).searchParams.get("state")!;
    // 模拟浏览器回调：同一会话 cookie，但请求带**不同的 Cookie 头**（额外 cookie / 顺序不同），
    // 顶层导航场景下这是常态。会话绑定必须只看已认证 owner，而不是原始 Cookie 头。
    const response = await fetch(`${app.base}/api/oauth-agent/authorize/complete?state=${state}&code=fake&client_id=realid`, {
      headers: { cookie: `other=1; ${cookie}; extra=2` }
    });
    const html = await response.text();
    // 会话绑定通过 → 进入 token 交换（假 code 会失败），而不是「会话不匹配」。
    expect(html).not.toContain("会话不匹配");
    expect(html).toContain("OAuth token 请求失败");
  });

  it("未授权时生成请求被拒（authorization-required）", async () => {
    const app = await boot();

    const c = client(app.base);
    await c.fetch("/api/oauth-agent/status");
    const response = await c.fetch("/api/oauth-agent/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r1", canvasId: "cv", nodeId: "n", mode: "model3d", model: "gpt-6.1-sol", prompt: "x" })
    });
    expect(response.status).toBe(409);
  });

  it("已授权（注入凭据）+ fake SDK：生成经 SSE 返回权威回执，requestId 可恢复", async () => {
    const threads: Parameters<CodexLike["startThread"]>[0][] = [];
    const app = await boot(threads);

    const c = client(app.base);
    await c.fetch("/api/oauth-agent/status");
    // 直接注入一个已订阅可用的账户（模拟已完成 OAuth；不消费真实额度）。
    const ownerId = ownerFromCookie(c.cookie());
    app.service.credentials!.write(ownerId, {
      account: {
        clientId: "client-1",
        subject: "chatgpt-sub",
        scopes: [CHATGPT_PLAN_SCOPE],
        accessToken: "at-secret",
        refreshToken: "rt-secret",
        expiresAt: Date.now() + 3600_000,
        connectedAt: new Date().toISOString()
      },
      host: { extAgentHostId: "h1" }
    });
    const status = (await (await c.fetch("/api/oauth-agent/status")).json()) as { state: string };
    expect(status.state).toBe("ready");

    const response = await c.fetch("/api/oauth-agent/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "gen-1", canvasId: "cv", nodeId: "n", mode: "model3d", model: "gpt-6.1-sol", prompt: "make a box", reasoningEffort: "xhigh" })
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: result");
    expect(text).toContain("succeeded");
    // 公开 SSE 响应不含 token。
    expect(text).not.toContain("at-secret");
    expect(text).not.toContain("rt-secret");

    const receipt = (await (await c.fetch("/api/oauth-agent/generate/gen-1")).json()) as { status: string };
    expect(receipt.status).toBe("succeeded");
    expect(threads[0]).toMatchObject({ modelReasoningEffort: "xhigh" });

    const defaultResponse = await c.fetch("/api/oauth-agent/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "gen-default", canvasId: "cv", nodeId: "n", mode: "model3d", model: "gpt-6.1-sol", prompt: "make a box" })
    });
    expect(await defaultResponse.text()).toContain("succeeded");
    expect(threads).toHaveLength(2);
    expect(threads[1]).not.toHaveProperty("modelReasoningEffort");

    const invalidResponse = await c.fetch("/api/oauth-agent/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "gen-invalid", canvasId: "cv", nodeId: "n", mode: "model3d", model: "gpt-6.1-sol", prompt: "make a box", reasoningEffort: "invalid" })
    });
    expect(invalidResponse.status).toBe(400);
    expect(threads).toHaveLength(2);
  });

  it("两用户凭据隔离：B 不能读取 A 的授权", async () => {
    const app = await boot();

    const a = client(app.base);
    const b = client(app.base);
    await a.fetch("/api/oauth-agent/status");
    await b.fetch("/api/oauth-agent/status");
    const ownerA = ownerFromCookie(a.cookie());
    const ownerB = ownerFromCookie(b.cookie());
    expect(ownerA).not.toBe(ownerB);
    app.service.credentials!.write(ownerA, {
      account: { clientId: "c", subject: "s-a", scopes: [CHATGPT_PLAN_SCOPE], accessToken: "a", refreshToken: "ra", expiresAt: Date.now() + 3600_000, connectedAt: new Date().toISOString() },
      host: { extAgentHostId: "ha" }
    });
    const statusA = (await (await a.fetch("/api/oauth-agent/status")).json()) as { state: string; account?: { subject?: string } };
    const statusB = (await (await b.fetch("/api/oauth-agent/status")).json()) as { state: string };
    expect(statusA.state).toBe("ready");
    expect(statusA.account?.subject).toBe("s-a");
    expect(statusB.state).toBe("disconnected");
    // 断开 A 不影响 B 的会话存在性。
    await a.fetch("/api/oauth-agent/disconnect", { method: "POST" });
    expect(((await (await a.fetch("/api/oauth-agent/status")).json()) as { state: string }).state).toBe("disconnected");
    expect(((await (await b.fetch("/api/oauth-agent/status")).json()) as { state: string }).state).toBe("disconnected");
  });

  it("Codex 会话目录/凭据目录不含明文 token", async () => {
    const app = await boot();

    const c = client(app.base);
    await c.fetch("/api/oauth-agent/status");
    const ownerId = ownerFromCookie(c.cookie());
    app.service.credentials!.write(ownerId, {
      account: { clientId: "c", subject: "s", scopes: [CHATGPT_PLAN_SCOPE], accessToken: "plain-at", refreshToken: "plain-rt", idToken: "plain-id", expiresAt: Date.now() + 3600_000, connectedAt: new Date().toISOString() },
      host: { extAgentHostId: "h" }
    });
    const dir = app.service.credentialDirectory()!;
    const files: string[] = [];
    const walk = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(dir);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expect(content).not.toContain("plain-at");
      expect(content).not.toContain("plain-rt");
      expect(content).not.toContain("plain-id");
    }
  });
});

/** 从会话 cookie 值派生 owner（与 identity.ts 的 ownerId 规则一致）。 */
function ownerFromCookie(cookie: string): string {
  const value = cookie.split("=")[1] ?? "";
  const id = value.split(".")[0] ?? "";
  return `local:${id}`;
}

/** 部署未配置凭据目录时服务禁用，返回 503。 */
describe("ChatGPT 未配置部署", () => {
  it("缺少凭据目录时返回明确不可用", async () => {
    const service = createChatGptService({
      env: {},
      canvasPorts: ports(),
      authConfigured: false
    });
    expect(service.enabled).toBe(false);
    let status = 0;
    const server = http.createServer((req, res) => {
      void service.handle(req, res).then((handled) => {
        if (!handled) { res.writeHead(404); res.end(); }
      });
    });
    void server;
    // 直接调用 handler 需要 res 对象；用最小桩验证 503。
    const fakeRes = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      setHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value; },
      end() { status = this.statusCode; }
    };
    await service.handle({ url: "/api/oauth-agent/status", method: "GET", headers: {} } as never, fakeRes as never);
    expect(status).toBe(503);
    expect(service.credentialDirectory()).toBeNull();
  });
});
