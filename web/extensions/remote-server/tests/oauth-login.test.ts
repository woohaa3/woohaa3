/**
 * 本机宿主侧的浏览器授权码登录测试（oauth-start / 公开回调 / oauth-poll）。
 *
 * 被测的是**宿主的协议解释与状态机**，不是远端实现：远端用 fake（`ExchangeLocalLogin` 按
 * 服务端语义校验一次性码、PKCE S256 与 loopback redirect）。三条安全性质必须锁住：
 * 1. 授权码只在回调里出现一次，页面/URL/日志都拿不到它，也拿不到 verifier 与 state；
 * 2. state 必须命中进程内的 pending 且一次性（重放/过期都失败）；
 * 3. loopback 之外的 origin、站内相对地址、没有公开回调的宿主一律 unsupported（回退短码）。
 */
import { describe, expect, it } from "vitest";
import { createMemorySessionStore, createRemoteServerPlugin, type RemoteSessionStore } from "../src/backend/index.js";
import {
  REMOTE_SERVER_OAUTH_CALLBACK_ROUTE,
  REMOTE_SERVER_OAUTH_DONE_ROUTE,
  REMOTE_SERVER_OAUTH_POLL_ROUTE,
  REMOTE_SERVER_OAUTH_START_ROUTE,
  REMOTE_SERVER_SESSION_ROUTE,
  buildTofAuthorizeUrl,
  isLoopbackHostname,
  oauthCallbackUrl,
  oauthDonePath,
  parseLoopbackOrigin,
  resolveRemoteEndpoints
} from "../src/shared.js";
import { createFakeServer } from "./fake-server.js";

type HandlerResult = { status?: number; body: unknown };

type RawCall = { status: number; headers: Record<string, string>; body: string };

/** 最小宿主替身：本扩展用到的面 + 可选的公开 HTTP 接缝。 */
function createHost(input: { basePath?: string; raw?: boolean; canvas?: Record<string, unknown> } = {}) {
  const handlers = new Map<string, (request: { body: unknown; context: unknown }) => Promise<HandlerResult> | HandlerResult>();
  const rawHandlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const logEvents: Array<Record<string, unknown>> = [];
  const canvas = input.canvas ?? {
    requestNodeRun: async () => ({ ok: false as const, code: "unavailable", message: "test" }),
    requestNodeCancel: async () => ({ ok: false as const, code: "unavailable", message: "test" })
  };
  const undos: Array<() => void> = [];
  const host: Record<string, unknown> = {
    deployment: { basePath: input.basePath ?? "" },
    log: { scope: () => (event: Record<string, unknown>) => { logEvents.push(event); } },
    capabilities: { register: () => () => undefined },
    services: { canvas },
    storage: { register: () => () => undefined, unregister: () => undefined },
    telemetry: { registerExport: () => () => undefined, emit: () => undefined, query: async () => ({ events: [], nextCursor: null }), unregisterExport: () => undefined },
    generation: {
      register: () => () => undefined,
      unregister: () => undefined,
      list: () => [],
      resolve: () => undefined,
      conversions: () => [],
      registerConversion: () => () => undefined
    },
    marketplace: { register: () => () => undefined, unregister: () => undefined, list: () => [], resolve: () => undefined },
    effect: (run: () => (() => void) | void) => {
      const undo = run();
      if (typeof undo === "function") undos.push(undo);
    },
    webServer: {
      register: (registration: { route: string; handle: (request: { body: unknown; context: unknown }) => Promise<HandlerResult> | HandlerResult }) => {
        handlers.set(registration.route, registration.handle);
      },
      registerHttp: () => undefined,
      ...(input.raw !== false
        ? {
            registerRawHttp: (registration: { route: string; handle: (req: unknown, res: unknown) => Promise<void> }) => {
              rawHandlers.set(registration.route, registration.handle);
            }
          }
        : {})
    }
  };
  const call = async (route: string, body: unknown = {}): Promise<HandlerResult> => {
    const handler = handlers.get(route);
    if (!handler) throw new Error("未注册 handler：" + route);
    return handler({ body, context: {} });
  };
  /** 调公开 HTTP handler：只记录状态码、响应头（小写键）与正文文本。 */
  const callRaw = async (route: string, url: string): Promise<RawCall> => {
    const handler = rawHandlers.get(route);
    if (!handler) throw new Error("未注册原始 handler：" + route);
    const headers: Record<string, string> = {};
    let status = 200;
    let body = "";
    const req = { method: "GET", url, headers: {}, on: () => req, destroy: () => undefined };
    const res = {
      set statusCode(value: number) { status = value; },
      get statusCode() { return status; },
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
      writeHead(next: number) { status = next; },
      write(chunk: unknown) { body += String(chunk); },
      end(chunk?: unknown) {
        if (chunk !== undefined) body += String(chunk);
      },
      get writableEnded() { return true; },
      on: () => res
    };
    await handler(req as never, res as never);
    return { status, headers, body };
  };
  return { host, handlers, rawHandlers, logEvents, call, callRaw };
}

function activate(options: {
  deployment: { serverUrl: string | null; deviceToken: string | null; keyPrefix: string };
  fetchImpl: typeof globalThis.fetch;
  now?: () => number;
  basePath?: string;
  raw?: boolean;
  canvas?: Record<string, unknown>;
  store?: RemoteSessionStore;
}) {
  const fixture = createHost({
    ...(options.basePath !== undefined ? { basePath: options.basePath } : {}),
    ...(options.raw !== undefined ? { raw: options.raw } : {}),
    ...(options.canvas !== undefined ? { canvas: options.canvas } : {})
  });
  const definition = createRemoteServerPlugin({
    deployment: () => options.deployment,
    fetchImpl: options.fetchImpl,
    // 这些用例断言的是登录流程本身；激活时的后台自动登录会多打一次请求，干扰计数。
    autoLoginWithDeviceToken: false,
    ...(options.now ? { now: options.now } : {}),
    ...(options.store ? { store: options.store } : {})
  });
  void definition.apply(fixture.host as never, {} as never);
  return fixture;
}

/** 从 authorizeUrl 里取出回调要用的参数（redirect_uri / state / PKCE challenge）。 */
function authorizeParams(authorizeUrl: string) {
  const url = new URL(authorizeUrl);
  return {
    url,
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
    state: url.searchParams.get("state") ?? "",
    challenge: url.searchParams.get("code_challenge") ?? "",
    method: url.searchParams.get("code_challenge_method") ?? ""
  };
}

/** 发起一次成功的 start，返回 attemptId 与授权参数。 */
async function startAttempt(fixture: ReturnType<typeof createHost>, origin = "http://127.0.0.1:5173") {
  const result = await fixture.call(REMOTE_SERVER_OAUTH_START_ROUTE, { origin });
  const body = result.body as { ok: boolean; attemptId: string; authorizeUrl: string; expiresAt: number };
  expect(body.ok).toBe(true);
  return { attemptId: body.attemptId, authorizeUrl: body.authorizeUrl, expiresAt: body.expiresAt, params: authorizeParams(body.authorizeUrl) };
}

describe("shared 纯函数（loopback 与 URL 形状）", () => {
  it("只把 127.0.0.1 / localhost / [::1] 当 loopback", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("10.0.0.5")).toBe(false);
    expect(isLoopbackHostname("127.0.0.2")).toBe(false);
    // 以 .localhost 结尾的域名解析权在系统 DNS/hosts，不是「本机」的同义词。
    expect(isLoopbackHostname("app.localhost")).toBe(false);
  });

  it("只接受 http 的 loopback origin：显式端口、无路径/查询/片段/凭据", () => {
    expect(parseLoopbackOrigin("http://127.0.0.1:5173")).toEqual({ ok: true, value: "http://127.0.0.1:5173" });
    expect(parseLoopbackOrigin("http://localhost:3000")).toEqual({ ok: true, value: "http://localhost:3000" });
    expect(parseLoopbackOrigin("http://[::1]:8080")).toEqual({ ok: true, value: "http://[::1]:8080" });
    for (const bad of [
      "https://127.0.0.1:5173",
      "http://10.0.0.5:5173",
      "http://127.0.0.1:5173/app",
      "http://127.0.0.1:5173/?a=1",
      "http://user:pw@127.0.0.1:5173",
      "ftp://127.0.0.1:5173",
      "127.0.0.1:5173",
      ""
    ]) {
      expect(parseLoopbackOrigin(bad).ok, bad).toBe(false);
    }
    expect(parseLoopbackOrigin(undefined).ok).toBe(false);
  });

  it("回调与完成页地址都挂在应用基址下，授权入口挂在 rpcBase 下", () => {
    expect(oauthCallbackUrl("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173/api/remote-server/auth/callback");
    expect(oauthCallbackUrl("http://127.0.0.1:5173/", "/app/")).toBe("http://127.0.0.1:5173/app/api/remote-server/auth/callback");
    expect(oauthDonePath("/app/")).toBe("/app/api/remote-server/auth/done");
    expect(oauthDonePath(undefined)).toBe("/api/remote-server/auth/done");
    const authorize = new URL(buildTofAuthorizeUrl({
      rpcBase: "https://canvas.example.com/remote/",
      redirectUri: "http://127.0.0.1:5173/app/api/remote-server/auth/callback",
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43)
    }));
    expect(authorize.origin + authorize.pathname).toBe("https://canvas.example.com/remote/tof/authorize");
    // 参数名与编码由契约固定：redirect_uri 的 :// 必须被编码，challenge 方法只能是 S256。
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5173/app/api/remote-server/auth/callback");
    expect(authorize.searchParams.get("state")).toBe("s".repeat(32));
    expect(authorize.searchParams.get("code_challenge")).toBe("c".repeat(43));
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("oauth-start", () => {
  it("非 loopback 的 origin 直接 unsupported，且不发任何远端请求", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    for (const origin of ["https://canvas.example.com", "http://10.0.0.5:5173", "http://127.0.0.1:5173/x"]) {
      const result = await fixture.call(REMOTE_SERVER_OAUTH_START_ROUTE, { origin });
      expect(result.body).toMatchObject({ ok: false, error: "unsupported" });
      expect(String((result.body as { message: string }).message)).toContain("本机");
    }
    expect(fake.calls).toHaveLength(0);
    // 日志只留稳定码，不含 origin 原文（它可能带部署信息）。
    expect(JSON.stringify(fixture.logEvents)).not.toContain("10.0.0.5");
  });

  it("返回的授权入口地址形状正确：tof/authorize、loopback redirect、state 与 attemptId 一致", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch, basePath: "/app" });
    const { attemptId, params, expiresAt } = await startAttempt(fixture);
    expect(params.url.origin).toBe("https://canvas.example.com");
    expect(params.url.pathname).toBe("/tof/authorize");
    expect(params.redirectUri).toBe("http://127.0.0.1:5173/app/api/remote-server/auth/callback");
    expect(params.method).toBe("S256");
    expect(params.state).toBe(attemptId);
    expect(params.state).toMatch(/^[0-9a-f]{32}$/);
    // 32 字节 base64url = 43 字符（RFC 7636 的挑战长度）。
    expect(params.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it("部署文件缺失但已登录时，浏览器登录用会话地址（不再报「还没有配置服务端地址」）", async () => {
    const fake = createFakeServer();
    const store = createMemorySessionStore();
    await store.save({
      serverUrl: "https://canvas.example.com",
      token: "session-1",
      subject: "ops-admin",
      displayName: null,
      expiresAt: Date.now() + 3_600_000
    });
    const fixture = activate({
      deployment: { serverUrl: null, deviceToken: null, keyPrefix: "" },
      fetchImpl: fake.fetch,
      store
    });

    const { params } = await startAttempt(fixture);
    expect(params.url.origin).toBe("https://canvas.example.com");
    expect(params.url.pathname).toBe("/tof/authorize");
  });

  it("响应体里没有 verifier（只有 challenge 能出门）", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const result = await fixture.call(REMOTE_SERVER_OAUTH_START_ROUTE, { origin: "http://127.0.0.1:5173" });
    const body = result.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["attemptId", "authorizeUrl", "expiresAt", "ok"]);
  });

  it("站内相对 serverUrl 不支持浏览器登录（无法构造绝对授权入口）", async () => {
    const fake = createFakeServer();
    const fixture = activate({
      deployment: { serverUrl: "/remote", deviceToken: null, keyPrefix: "" },
      fetchImpl: fake.fetch
    });
    const result = await fixture.call(REMOTE_SERVER_OAUTH_START_ROUTE, { origin: "http://127.0.0.1:5173" });
    expect(result.body).toMatchObject({ ok: false, error: "unsupported" });
    expect(fake.calls).toHaveLength(0);
  });

  it("宿主没有公开 HTTP 回调接缝时 unsupported（旧宿主自动回退短码）", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch, raw: false });
    const result = await fixture.call(REMOTE_SERVER_OAUTH_START_ROUTE, { origin: "http://127.0.0.1:5173" });
    expect(result.body).toMatchObject({ ok: false, error: "unsupported" });
    expect(String((result.body as { message: string }).message)).toContain("短码");
  });

  it("没有配置服务端地址时给 not-configured，而不是 unsupported", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: { serverUrl: null, deviceToken: null, keyPrefix: "" }, fetchImpl: fake.fetch });
    const result = await fixture.call(REMOTE_SERVER_OAUTH_START_ROUTE, { origin: "http://127.0.0.1:5173" });
    expect(result.body).toMatchObject({ ok: false, error: "not-configured" });
  });

  it("面板手填地址（还没写进部署配置、也没登录过）时，按这个地址发起浏览器登录", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: { serverUrl: null, deviceToken: null, keyPrefix: "" }, fetchImpl: fake.fetch });
    const result = await fixture.call(REMOTE_SERVER_OAUTH_START_ROUTE, {
      origin: "http://127.0.0.1:5173",
      serverUrl: "https://canvas.example.com"
    });
    const body = result.body as { ok: boolean; authorizeUrl: string };
    expect(body.ok).toBe(true);
    // 授权入口必须落在手填的那台服务端上，而不是「未配置」。
    expect(authorizeParams(body.authorizeUrl).url.origin).toBe("https://canvas.example.com");
  });

  it("手填地址非法时给 invalid-server-url，不静默换成别的地址", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: { serverUrl: null, deviceToken: null, keyPrefix: "" }, fetchImpl: fake.fetch });
    const result = await fixture.call(REMOTE_SERVER_OAUTH_START_ROUTE, {
      origin: "http://127.0.0.1:5173",
      serverUrl: "canvas.example.com"
    });
    expect(result.body).toMatchObject({ ok: false, error: "invalid-server-url" });
  });

  it("各基址下 redirect_uri 始终指向宿主的公开回调（rpcBase 只影响授权入口）", async () => {
    const fake = createFakeServer();
    const fixture = activate({
      deployment: { serverUrl: "https://canvas.example.com/remote", deviceToken: null, keyPrefix: "" },
      fetchImpl: fake.fetch
    });
    const { params } = await startAttempt(fixture);
    expect(params.url.pathname).toBe("/remote/tof/authorize");
    expect(params.redirectUri).toBe("http://127.0.0.1:5173/api/remote-server/auth/callback");
    expect(resolveRemoteEndpoints("https://canvas.example.com/remote").rpcBase).toBe("https://canvas.example.com/remote");
  });
});

const CALLBACK_URL = "/api/remote-server/auth/callback";
const DONE_URL = "/api/remote-server/auth/done";

/** 计数用的 canvas facade：只关心「会话变了有没有通知宿主」。 */
function countingCanvas() {
  const counter = { refresh: 0 };
  return {
    counter,
    canvas: {
      requestNodeRun: async () => ({ ok: false as const, code: "unavailable", message: "test" }),
      requestNodeCancel: async () => ({ ok: false as const, code: "unavailable", message: "test" }),
      refreshSyncUpstream: async () => {
        counter.refresh += 1;
      }
    }
  };
}

describe("公开回调（remote-server/auth/callback）", () => {
  it("成功：服务端换码、落会话、302 到完成页；回调响应里没有授权码", async () => {
    const fake = createFakeServer();
    const refresh = countingCanvas();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch, basePath: "/app", canvas: refresh.canvas });
    const started = await startAttempt(fixture);
    fake.grantLocalLoginCode({ code: "auth-code-1", challenge: started.params.challenge });

    const callback = await fixture.callRaw(
      REMOTE_SERVER_OAUTH_CALLBACK_ROUTE,
      CALLBACK_URL + "?code=auth-code-1&state=" + started.attemptId
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe("/app/api/remote-server/auth/done?attempt=" + started.attemptId);
    expect(callback.headers.location).not.toContain("auth-code-1");
    // 这类响应不该被缓存，也不该把地址栏/来源带给下一跳。
    expect(callback.headers["cache-control"]).toBe("no-store");
    expect(callback.headers["referrer-policy"]).toBe("no-referrer");

    // 换码请求：POST ExchangeLocalLogin，带 verifier 与精确 redirect_uri，且不带授权头。
    const exchange = fake.calls.find((call) => call.path.endsWith("/ExchangeLocalLogin"));
    expect(exchange).toBeDefined();
    expect(exchange?.authorization).toBeNull();
    expect(exchange?.body).toMatchObject({ code: "auth-code-1", redirectUri: started.params.redirectUri });
    expect((exchange?.body as { codeVerifier: string }).codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // 会话已落库（令牌留在宿主里），宿主收到一次「重新解析同步上游」的通知。
    const session = await fixture.call(REMOTE_SERVER_SESSION_ROUTE);
    expect(session.body).toMatchObject({ phase: "connected", subject: "oauth-alice" });
    expect(refresh.counter.refresh).toBeGreaterThan(0);
  });

  it("完成页只说成功/失败，不含授权码、state 与令牌", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const started = await startAttempt(fixture);
    fake.grantLocalLoginCode({ code: "auth-code-2", challenge: started.params.challenge });
    await fixture.callRaw(REMOTE_SERVER_OAUTH_CALLBACK_ROUTE, CALLBACK_URL + "?code=auth-code-2&state=" + started.attemptId);

    const done = await fixture.callRaw(REMOTE_SERVER_OAUTH_DONE_ROUTE, DONE_URL + "?attempt=" + started.attemptId);
    expect(done.status).toBe(200);
    expect(done.headers["content-type"]).toContain("text/html");
    expect(done.headers["cache-control"]).toBe("no-store");
    expect(done.body).toContain("登录成功");
    expect(done.body).not.toContain("auth-code-2");
    expect(done.body).not.toContain(started.attemptId);
    // fake 内部签发的会话令牌是 session-N：页面只有文字，没有令牌。
    expect(done.body).not.toContain("session-");
  });

  it("state 缺失 → 400，且不发起换码", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const callback = await fixture.callRaw(REMOTE_SERVER_OAUTH_CALLBACK_ROUTE, CALLBACK_URL + "?code=whatever");
    expect(callback.status).toBe(400);
    expect(callback.headers["cache-control"]).toBe("no-store");
    expect(fake.calls).toHaveLength(0);
  });

  it("state 重放 → 400（先消费再使用），只换一次码", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const started = await startAttempt(fixture);
    fake.grantLocalLoginCode({ code: "auth-code-3", challenge: started.params.challenge });
    const url = CALLBACK_URL + "?code=auth-code-3&state=" + started.attemptId;
    expect((await fixture.callRaw(REMOTE_SERVER_OAUTH_CALLBACK_ROUTE, url)).status).toBe(302);
    const replay = await fixture.callRaw(REMOTE_SERVER_OAUTH_CALLBACK_ROUTE, url);
    expect(replay.status).toBe(400);
    expect(fake.calls.filter((call) => call.path.endsWith("/ExchangeLocalLogin"))).toHaveLength(1);
  });

  it("error=<契约 reason> → 302 到完成页，失败短语进结果表", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const started = await startAttempt(fixture);
    const callback = await fixture.callRaw(
      REMOTE_SERVER_OAUTH_CALLBACK_ROUTE,
      CALLBACK_URL + "?error=tof.rejected&state=" + started.attemptId
    );
    expect(callback.status).toBe(302);
    expect(fake.calls.filter((call) => call.path.endsWith("/ExchangeLocalLogin"))).toHaveLength(0);

    const poll = await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId: started.attemptId });
    // 失败结果带**稳定码**（排障/上报用）与中文短语（界面用）。码就是 proto 里的 reason。
    expect(poll.body).toMatchObject({ state: "failed", code: "tof.rejected" });
    expect(String((poll.body as { error: string }).error)).toContain("过期");

    const done = await fixture.callRaw(REMOTE_SERVER_OAUTH_DONE_ROUTE, DONE_URL + "?attempt=" + started.attemptId);
    expect(done.body).toContain("登录未完成");
    expect(done.body).toContain("过期");
  });

  it.each([
    // 「认得这个人但不放行」必须原样到达界面：文案由契约生成，不是本文件手写的。
    ["auth.subject_disabled", "停用", "auth.subject_disabled"],
    ["tof.subject_unregistered", "尚未开通", "tof.subject_unregistered"]
  ])("error=%s 保留稳定码并显示可执行文案", async (raw, needle, expectedCode) => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const started = await startAttempt(fixture);
    const callback = await fixture.callRaw(
      REMOTE_SERVER_OAUTH_CALLBACK_ROUTE,
      CALLBACK_URL + "?error=" + raw + "&state=" + started.attemptId
    );
    expect(callback.status).toBe(302);

    // 先看完成页（peek），再轮询（消费）：反过来，页面只会显示"结果已不可用"。
    const done = await fixture.callRaw(REMOTE_SERVER_OAUTH_DONE_ROUTE, DONE_URL + "?attempt=" + started.attemptId);
    expect(done.body).toContain("登录未完成");
    expect(done.body).toContain(needle);
    expect(done.body).not.toContain("服务端暂时无法完成登录");

    const poll = await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId: started.attemptId });
    expect(poll.body).toMatchObject({ state: "failed", code: expectedCode });
    const message = String((poll.body as { error: string }).error);
    expect(message).toContain(needle);
    expect(message).not.toContain("服务端暂时无法完成登录");
  });

  it("未知的 error 码回落通用文案，不反射远端文本", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const started = await startAttempt(fixture);
    await fixture.callRaw(
      REMOTE_SERVER_OAUTH_CALLBACK_ROUTE,
      CALLBACK_URL + "?error=some_internal_detail&state=" + started.attemptId
    );
    const poll = await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId: started.attemptId });
    expect(poll.body).toMatchObject({ state: "failed" });
    expect(String((poll.body as { error: string }).error)).not.toContain("some_internal_detail");
    // 认不出来的码不猜原因：只说清"没完成、要重来"。
    expect(String((poll.body as { error: string }).error)).toContain("登录没有完成");
  });

  it("远端拒绝换码（PKCE 不匹配）→ 失败且不回显远端正文", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const started = await startAttempt(fixture);
    // 登记一个与本次 challenge 不同的值：模拟攻击者拿到 code 但没有 verifier。
    fake.grantLocalLoginCode({ code: "auth-code-4", challenge: "A".repeat(43) });
    const callback = await fixture.callRaw(
      REMOTE_SERVER_OAUTH_CALLBACK_ROUTE,
      CALLBACK_URL + "?code=auth-code-4&state=" + started.attemptId
    );
    expect(callback.status).toBe(302);

    const poll = await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId: started.attemptId });
    expect(poll.body).toMatchObject({ state: "failed" });
    const error = String((poll.body as { error: string }).error);
    // 文案来自 proto 的失败分类（tof.invalid_code），不是本扩展手写的。
    expect(error).toContain("统一登录返回的凭证无效");
    expect(error).not.toContain("PKCE");
    expect(JSON.stringify(poll.body)).not.toContain("session-");

    // 没落半份会话：会话面仍是未连接。
    const session = await fixture.call(REMOTE_SERVER_SESSION_ROUTE);
    expect(session.body).toMatchObject({ subject: null });
  });

  it("远端拒绝换码（rejectLocalExchange）→ 失败 + 稳定日志码", async () => {
    const fake = createFakeServer({ rejectLocalExchange: true });
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const started = await startAttempt(fixture);
    fake.grantLocalLoginCode({ code: "auth-code-5", challenge: started.params.challenge });
    await fixture.callRaw(REMOTE_SERVER_OAUTH_CALLBACK_ROUTE, CALLBACK_URL + "?code=auth-code-5&state=" + started.attemptId);
    const poll = await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId: started.attemptId });
    expect(poll.body).toMatchObject({ state: "failed" });
    const failures = fixture.logEvents.filter((event) => event.event === "remote-oauth-failed");
    expect(failures.some((event) => event.code === "tof.invalid_code")).toBe(true);
  });

  it("换码成功但响应形状不符 → 失败，不落半份会话", async () => {
    const fake = createFakeServer();
    const malformed: typeof globalThis.fetch = async (input, init) => {
      if (String(input).includes("ExchangeLocalLogin")) {
        return new Response(JSON.stringify({ sessionToken: "only-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return fake.fetch(input, init);
    };
    const fixture = activate({ deployment: fake.deployment, fetchImpl: malformed });
    const started = await startAttempt(fixture);
    await fixture.callRaw(REMOTE_SERVER_OAUTH_CALLBACK_ROUTE, CALLBACK_URL + "?code=any&state=" + started.attemptId);
    const poll = await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId: started.attemptId });
    expect(poll.body).toMatchObject({ state: "failed" });
    expect(String((poll.body as { error: string }).error)).toContain("形状不符");
    const session = await fixture.call(REMOTE_SERVER_SESSION_ROUTE);
    expect(session.body).toMatchObject({ subject: null });
  });

  it("过期的 state → 400，且换码请求一个都不发", async () => {
    const fake = createFakeServer();
    let now = Date.now();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch, now: () => now });
    const started = await startAttempt(fixture);
    now += 11 * 60_000;
    const callback = await fixture.callRaw(
      REMOTE_SERVER_OAUTH_CALLBACK_ROUTE,
      CALLBACK_URL + "?code=late&state=" + started.attemptId
    );
    expect(callback.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
    // 过期尝试已被消费：轮询立刻得到 failed，不必再空转到面板的超时。
    const poll = await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId: started.attemptId });
    expect((poll.body as { state: string }).state).toBe("failed");
  });

  it("pending 表有界：压满上限后最早的尝试被淘汰，最新的仍然可用", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const attempts = [];
    for (let index = 0; index < 33; index += 1) {
      attempts.push(await startAttempt(fixture, "http://127.0.0.1:" + (5100 + index)));
    }
    const oldest = attempts[0];
    expect((await fixture.callRaw(REMOTE_SERVER_OAUTH_CALLBACK_ROUTE, CALLBACK_URL + "?code=x&state=" + oldest.attemptId)).status).toBe(400);

    const newest = attempts[attempts.length - 1];
    fake.grantLocalLoginCode({ code: "auth-code-6", challenge: newest.params.challenge });
    const callback = await fixture.callRaw(
      REMOTE_SERVER_OAUTH_CALLBACK_ROUTE,
      CALLBACK_URL + "?code=auth-code-6&state=" + newest.attemptId
    );
    expect(callback.status).toBe(302);
  });

  it("日志只有 remote-oauth-* 稳定事件与稳定码，不含授权码/state/verifier/令牌", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const started = await startAttempt(fixture);
    fake.grantLocalLoginCode({ code: "auth-code-7", challenge: started.params.challenge });
    await fixture.callRaw(REMOTE_SERVER_OAUTH_CALLBACK_ROUTE, CALLBACK_URL + "?code=auth-code-7&state=" + started.attemptId);
    await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId: started.attemptId });

    const serialized = JSON.stringify(fixture.logEvents);
    expect(serialized).not.toContain("auth-code-7");
    expect(serialized).not.toContain(started.attemptId);
    // verifier / challenge 都是 43 字符的 base64url：日志里不该出现这种长度的串。
    expect(serialized).not.toMatch(/[A-Za-z0-9_-]{43}/);
    const events = fixture.logEvents.map((event) => String(event.event)).filter((event) => event.startsWith("remote-oauth-"));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(["remote-oauth-start", "remote-oauth-approved", "remote-oauth-failed"]).toContain(event);
    }
    expect(events).toContain("remote-oauth-approved");
  });
});

describe("oauth-poll", () => {
  it("pending → approved（一次性读取）→ 再读即失效", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const started = await startAttempt(fixture);

    // 回调之前：会话还没落库，轮询只能是 pending。
    expect((await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId: started.attemptId })).body).toEqual({ state: "pending" });
    expect((await fixture.call(REMOTE_SERVER_SESSION_ROUTE)).body).toMatchObject({ phase: "local" });

    fake.grantLocalLoginCode({ code: "auth-code-8", challenge: started.params.challenge });
    await fixture.callRaw(REMOTE_SERVER_OAUTH_CALLBACK_ROUTE, CALLBACK_URL + "?code=auth-code-8&state=" + started.attemptId);

    const approved = await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId: started.attemptId });
    expect(approved.body).toMatchObject({ state: "approved" });
    const snapshot = (approved.body as { snapshot: { phase: string; subject: string } }).snapshot;
    expect(snapshot.phase).toBe("connected");
    expect(snapshot.subject).toBe("oauth-alice");
    // 快照里没有令牌。
    expect(JSON.stringify(approved.body)).not.toContain("session-");

    const again = await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId: started.attemptId });
    expect(again.body).toMatchObject({ state: "failed" });
  });

  it("failed 结果同样一次性读取", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const started = await startAttempt(fixture);
    await fixture.callRaw(REMOTE_SERVER_OAUTH_CALLBACK_ROUTE, CALLBACK_URL + "?error=tof.state_invalid&state=" + started.attemptId);
    const first = await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId: started.attemptId });
    expect(first.body).toMatchObject({ state: "failed" });
    expect(String((first.body as { error: string }).error)).toContain("回跳已失效");
    const second = await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId: started.attemptId });
    expect(second.body).toMatchObject({ state: "failed" });
    expect(String((second.body as { error: string }).error)).toContain("已失效");
  });

  it("未知/非法 attemptId → failed（面板据此改走短码）", async () => {
    const fake = createFakeServer();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    for (const attemptId of ["f".repeat(32), "not-a-state", ""]) {
      const result = await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId });
      expect((result.body as { state: string }).state).toBe("failed");
    }
    const missing = await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, {});
    expect((missing.body as { state: string }).state).toBe("failed");
  });

  it("等待超时（10 分钟）→ failed，不再永远 pending", async () => {
    const fake = createFakeServer();
    let now = Date.now();
    const fixture = activate({ deployment: fake.deployment, fetchImpl: fake.fetch, now: () => now });
    const started = await startAttempt(fixture);
    now += 11 * 60_000;
    const result = await fixture.call(REMOTE_SERVER_OAUTH_POLL_ROUTE, { attemptId: started.attemptId });
    expect(result.body).toMatchObject({ state: "failed" });
    expect(String((result.body as { error: string }).error)).toContain("超时");
  });
});
