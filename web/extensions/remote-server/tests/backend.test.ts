/**
 * remote-server 后端测试：用 fake 远端跑通登录 / 状态 / 登出，并锁住三条安全性质。
 *
 * 这个套件的重点是**结论**而不是实现细节：
 * 1. 令牌永远不进 URL，也不出现在任何响应体里；
 * 2. 会话到期或换了地址就当作未登录（不拿死令牌去连中继）；
 * 3. 登出尽力撤销远端会话，但一定清本地。
 */
import { describe, expect, it } from "vitest";
import type {
  ApplicationBackendDiagnosticEntry,
  ApplicationBackendDiagnostics,
  CanvasUpstreamProvider
} from "@woohaa3/contracts";
import { createRemoteServerPlugin, createMemorySessionStore, type RemoteSessionStore } from "../src/backend/index.js";
import { createDocumentSessionStore } from "../src/backend/session-store.js";
import {
  parseServerUrl,
  resolveRemoteEndpoints,
  pickLoginAssertionHeaders,
  REMOTE_SERVER_CANVAS_INVITE_CREATE_ROUTE,
  REMOTE_SERVER_CANVAS_INVITE_REVOKE_ROUTE,
  REMOTE_SERVER_CANVAS_INVITES_ROUTE,
  REMOTE_SERVER_CANVAS_MEMBER_REMOVE_ROUTE,
  REMOTE_SERVER_CANVAS_MEMBER_UPSERT_ROUTE,
  REMOTE_SERVER_CANVAS_MEMBERS_ROUTE,
  REMOTE_SERVER_CANVAS_SHARE_ROUTE,
  REMOTE_SERVER_CANVAS_SHARE_UPDATE_ROUTE,
  REMOTE_SERVER_DEVICE_POLL_ROUTE,
  REMOTE_SERVER_DEVICE_START_ROUTE,
  REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE,
  REMOTE_SERVER_DIAGNOSTICS_ROUTE,
  REMOTE_SERVER_SESSION_ROUTE,
  REMOTE_SERVER_LOGIN_ROUTE,
  REMOTE_SERVER_LOGOUT_ROUTE,
  REMOTE_SERVER_PROBE_ROUTE,
  REMOTE_SERVER_SYNC_ENABLE_ROUTE
} from "../src/shared.js";
import { createFakeServer, type FakeCanvasInviteConfig } from "./fake-server.js";

type HandlerResult = { status?: number; body: unknown };

/** 最小宿主替身：只实现本扩展用到的那几个面。 */
function createHost(
  services: { documents?: unknown; canvas?: unknown } = {},
  diagnostics?: ApplicationBackendDiagnostics
) {
  const handlers = new Map<string, (input: { body: unknown; context: unknown }) => Promise<HandlerResult> | HandlerResult>();
  const capabilityRegistry = new Map<string, unknown>();
  const rawHandlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  /** 捕获宿主日志：断言「接入过程记了什么、没记什么」比断言界面文案更接近真实泄漏面。 */
  const logEvents: Array<Record<string, unknown>> = [];
  // 生产宿主的 `services.canvas` 是必需面；替身也给一份最小实现，避免测试夹具随通知面变化。
  const canvas = services.canvas ?? {
    requestNodeRun: async () => ({ ok: false as const, code: "unavailable", message: "test" }),
    requestNodeCancel: async () => ({ ok: false as const, code: "unavailable", message: "test" })
  };
  const effects: Array<() => void> = [];
  /** 统一形态的 ctx 替身：HTTP 走 webServer、日志走 log.scope、能力走 capabilities。 */
  const ctx = {
    handlers,
    capabilityRegistry,
    rawHandlers,
    logEvents,
    effects,
    ...(diagnostics ? { diagnostics } : {}),
    log: {
      scope: () => (event: Record<string, unknown>) => {
        logEvents.push(event);
      }
    },
    capabilities: {
      register: (id: string, value: unknown) => {
        capabilityRegistry.set(id, value);
        return () => capabilityRegistry.delete(id);
      }
    },
    services: { ...services, canvas },
    generation: {
      register: () => () => undefined,
      unregister: () => undefined,
      list: () => [],
      resolve: () => undefined,
      conversions: () => [],
      registerConversion: () => () => undefined
    },
    storage: { register: () => () => undefined, unregister: () => undefined },
    telemetry: { registerExport: () => () => undefined, emit: () => undefined, query: async () => ({ events: [], nextCursor: null }), unregisterExport: () => undefined },
    marketplace: { register: () => () => undefined, unregister: () => undefined, list: () => [], resolve: () => undefined },
    effect: (run: () => (() => void) | void) => {
      const undo = run();
      if (typeof undo === "function") effects.push(undo);
    },
    webServer: {
      register: (registration: { route: string; handle: (input: { body: unknown; context: unknown }) => Promise<HandlerResult> | HandlerResult }) => {
        handlers.set(registration.route, registration.handle);
      },
      registerHttp: () => undefined,
      registerRawHttp: (registration: { route: string; handle: (req: unknown, res: unknown) => Promise<void> }) => {
        rawHandlers.set(registration.route, registration.handle);
      }
    },
    call: async (route: string, body: unknown = {}) => {
      const handler = handlers.get(route);
      if (!handler) throw new Error(`未注册 handler：${route}`);
      return handler({ body, context: {} });
    }
  };
  return ctx;
}

async function activate(options: {
  deployment: { serverUrl: string | null; deviceToken: string | null; keyPrefix: string };
  fetchImpl: typeof globalThis.fetch;
  now?: () => number;
  store?: RemoteSessionStore;
  documents?: unknown;
  canvas?: unknown;
  diagnostics?: ApplicationBackendDiagnostics;
  loginAssertionHeaders?: readonly string[];
}) {
  const services = {
    ...(options.documents ? { documents: options.documents } : {}),
    ...(options.canvas ? { canvas: options.canvas } : {})
  };
  const host = createHost(services, options.diagnostics);
  const plugin = createRemoteServerPlugin({
    deployment: () => options.deployment,
    fetchImpl: options.fetchImpl,
    loginAssertionHeaders: options.loginAssertionHeaders,
    ...(options.now ? { now: options.now } : {}),
    ...(options.store ? { store: options.store } : {})
  });
  await plugin.apply(host as never, {} as never);
  return host;
}

describe("remote-server 后端", () => {
  it("未配置远端时是 local，不是 error", async () => {
    const fake = createFakeServer();
    const host = await activate({ deployment: { serverUrl: null, deviceToken: null, keyPrefix: "" }, fetchImpl: fake.fetch });
    const result = await host.call(REMOTE_SERVER_SESSION_ROUTE);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ phase: "local", serverUrl: null, subject: null });
  });

  it("部署文件缺失但已登录时，登录的默认目标地址取会话里那个服务端", async () => {
    const fake = createFakeServer();
    const store = createMemorySessionStore();
    await store.save({
      serverUrl: "https://canvas.example.com",
      token: "session-1",
      subject: "ops-admin",
      displayName: null,
      expiresAt: Date.now() + 3_600_000
    });
    // 记录出站地址：要证明的是「打到会话里那个服务端」，而不是「恰好登录成功了」。
    const outbound: string[] = [];
    const host = await activate({
      deployment: { serverUrl: null, deviceToken: null, keyPrefix: "" },
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
        outbound.push(String(input));
        return fake.fetch(input as never, init);
      }) as typeof globalThis.fetch,
      store
    });

    const login = await host.call(REMOTE_SERVER_LOGIN_ROUTE, { token: "device-token" });
    // 不再是「还没有配置服务端地址」的 400：默认目标来自已登录会话。
    expect(login.status).toBe(200);
    expect((login.body as { ok: boolean }).ok).toBe(true);
    expect(outbound.length).toBeGreaterThan(0);
    expect(outbound.every((url) => url.startsWith("https://canvas.example.com"))).toBe(true);
  });

  it("一键登录：用部署凭证换会话，并把主体收敛到 WhoAmI 的答案", async () => {
    const fake = createFakeServer({ identities: { "device-token": "channel-alice" }, whoAmIOverride: "alice@example.com" });
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });

    const login = await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    expect(login.status).toBe(200);
    const body = login.body as { ok: boolean; snapshot: { phase: string; subject: string; expiresAt: number } };
    expect(body.ok).toBe(true);
    expect(body.snapshot.phase).toBe("connected");
    // 渠道身份与主体可能不同（别名表），界面必须显示会话真正指向的主体。
    expect(body.snapshot.subject).toBe("alice@example.com");
    expect(body.snapshot.expiresAt).toBeGreaterThan(Date.now());

    // 令牌不出现在响应里——只可能在 fake 的会话表内部。
    expect(JSON.stringify(login.body)).not.toContain("session-1");

    const session = await host.call(REMOTE_SERVER_SESSION_ROUTE);
    expect(session.body).toMatchObject({ phase: "connected", subject: "alice@example.com" });
  });

  it("令牌只走 Authorization 头，从不进 URL", async () => {
    const fake = createFakeServer();
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    // 每个调用路径都必须是纯过程名，不带查询串。
    for (const call of fake.calls) {
      expect(call.path).toMatch(/^\/woohaa\.[a-z0-9.]+\.[A-Za-z]+Service\/[A-Za-z]+$/);
      expect(call.path).not.toContain("token");
    }
    // 登录之后的调用都带 Bearer。
    const loginCall = fake.calls.find((call) => call.path.endsWith("/Login"));
    expect(loginCall?.authorization).toBeNull();
    const whoCall = fake.calls.find((call) => call.path.endsWith("/WhoAmI"));
    expect(whoCall?.authorization).toMatch(/^Bearer session-/);
  });

  it("坏凭证返回稳定错误短语，不泄漏远端正文", async () => {
    const fake = createFakeServer({ rejectLogin: true });
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const login = await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const body = login.body as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("凭证无效或会话已失效");
    expect(JSON.stringify(body)).not.toContain("未认证");
  });

  it("既无本机网关身份也无部署凭证时明确报错，不发一个空登录", async () => {
    const fake = createFakeServer();
    const host = await activate({ deployment: { serverUrl: fake.serverUrl, deviceToken: null, keyPrefix: "" }, fetchImpl: fake.fetch });
    // DTO 入口拿不到 headers，等价于「本机不在网关后面」。
    const login = await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    expect((login.body as { ok: boolean }).ok).toBe(false);
    expect((login.body as { error: string }).error).toContain("企业身份网关");
    expect(fake.calls).toHaveLength(0);
  });

  it("请求里的一次性令牌优先于部署凭证", async () => {
    const fake = createFakeServer({ identities: { "one-shot": "bob" } });
    const host = await activate({ deployment: { serverUrl: fake.serverUrl, deviceToken: "device-token", keyPrefix: "" }, fetchImpl: fake.fetch });
    const login = await host.call(REMOTE_SERVER_LOGIN_ROUTE, { token: "one-shot" });
    expect((login.body as { ok: boolean }).ok).toBe(true);
    expect((login.body as { snapshot: { subject: string } }).snapshot.subject).toBe("bob");
  });

  it("会话到期后回到未登录，不拿死令牌继续用", async () => {
    const fake = createFakeServer();
    let now = Date.now();
    // 提前失效余量是 30s：让会话在 10s 内到期即视为不可用。
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, now: () => now, store: createMemorySessionStore() });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    now += 60 * 60 * 1000;
    const session = await host.call(REMOTE_SERVER_SESSION_ROUTE);
    expect(session.body).toMatchObject({ phase: "local", subject: null });
  });

  it("换了远端地址后旧会话不再生效", async () => {
    const fake = createFakeServer();
    let serverUrl: string | null = fake.serverUrl;
    const host = createHost();
    const plugin = createRemoteServerPlugin({
      deployment: () => ({ serverUrl, deviceToken: "device-token", keyPrefix: "" }),
      fetchImpl: fake.fetch
    });
    void plugin.apply(host as never, {} as never);

    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    serverUrl = "https://other.example.com";
    const session = await host.call(REMOTE_SERVER_SESSION_ROUTE);
    expect(session.body).toMatchObject({ subject: null });
  });

  it("登出撤销远端会话并清本地；重复登出仍然成功", async () => {
    const fake = createFakeServer();
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    expect(fake.sessions.size).toBe(1);

    const first = await host.call(REMOTE_SERVER_LOGOUT_ROUTE);
    expect(first.body).toEqual({ ok: true });
    expect(fake.revoked).toHaveLength(1);
    expect(fake.sessions.size).toBe(0);

    const second = await host.call(REMOTE_SERVER_LOGOUT_ROUTE);
    expect(second.body).toEqual({ ok: true });
    const session = await host.call(REMOTE_SERVER_SESSION_ROUTE);
    expect(session.body).toMatchObject({ phase: "local" });
  });

  it("远端撤销失败仍然清本地（不让界面卡在撤不掉的登录态）", async () => {
    let reachable = true;
    const fake = createFakeServer();
    const flaky: typeof globalThis.fetch = async (input, init) => {
      if (!reachable) throw new TypeError("fetch failed");
      return fake.fetch(input, init);
    };
    const host = await activate({ deployment: fake.deployment, fetchImpl: flaky });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    reachable = false;
    const result = await host.call(REMOTE_SERVER_LOGOUT_ROUTE);
    expect((result.body as { ok: boolean }).ok).toBe(false);
    // 本地仍然清掉：后续读到的必须是未登录。
    reachable = true;
    const session = await host.call(REMOTE_SERVER_SESSION_ROUTE);
    expect(session.body).toMatchObject({ subject: null });
  });

  it("探测返回可达性、版本与登录方式，且不改变登录态", async () => {
    const fake = createFakeServer({ gatewayAmbient: true });
    const host = await activate({ deployment: { serverUrl: null, deviceToken: null, keyPrefix: "" }, fetchImpl: fake.fetch });
    const probe = await host.call(REMOTE_SERVER_PROBE_ROUTE, { serverUrl: fake.serverUrl });
    const body = probe.body as { ok: boolean; methods: Array<{ kind: string; ambient?: boolean }>; commit: string };
    expect(body.ok).toBe(true);
    expect(body.commit).toBe("abc123");
    expect(body.methods).toEqual([
      { kind: "machine-token" },
      { kind: "gateway", ambient: true }
    ]);
    // 探测不是登录：会话仍是 local。
    const session = await host.call(REMOTE_SERVER_SESSION_ROUTE);
    expect(session.body).toMatchObject({ phase: "local" });
  });

  it("远端不可达时探测给出可读原因", async () => {
    const fake = createFakeServer({ down: true });
    const host = await activate({ deployment: { serverUrl: null, deviceToken: null, keyPrefix: "" }, fetchImpl: fake.fetch });
    const probe = await host.call(REMOTE_SERVER_PROBE_ROUTE, { serverUrl: fake.serverUrl });
    expect(probe.body).toMatchObject({ ok: false, error: "无法连接远端服务端" });
  });

  it("地址非法时拒绝探测与登录，不发任何请求", async () => {
    const fake = createFakeServer();
    const host = await activate({ deployment: { serverUrl: null, deviceToken: "device-token", keyPrefix: "" }, fetchImpl: fake.fetch });
    const probe = await host.call(REMOTE_SERVER_PROBE_ROUTE, { serverUrl: "ftp://nope" });
    expect(probe.status).toBe(400);
    const login = await host.call(REMOTE_SERVER_LOGIN_ROUTE, { serverUrl: "//evil.example" });
    expect(login.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it("宿主的文档存储可用时会话跨实例保留", async () => {
    const fake = createFakeServer();
    const store = createDocumentSessionStore(createFakeDocuments());
    const first = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, store });
    await first.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    // 第二个实例（模拟进程重启）读同一份存储。
    const second = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, store });
    const session = await second.call(REMOTE_SERVER_SESSION_ROUTE);
    expect(session.body).toMatchObject({ phase: "connected" });
  });

  it("文档存储里的损坏记录按未登录处理（安全方向）", async () => {
    const docs = createFakeDocuments();
    await docs.batch([{ op: "set", key: "session/current", value: { serverUrl: 1 } }]);
    const fake = createFakeServer();
    const host = await activate({
      deployment: fake.deployment,
      fetchImpl: fake.fetch,
      store: createDocumentSessionStore(docs)
    });
    const session = await host.call(REMOTE_SERVER_SESSION_ROUTE);
    expect(session.body).toMatchObject({ phase: "local" });
  });

  it("登录/登出都会通知宿主重新解析同步上游（否则界面显示已连接、画布仍不同步）", async () => {
    const fake = createFakeServer();
    const refresh = { count: 0 };
    const host = await activate({
      deployment: fake.deployment,
      fetchImpl: fake.fetch,
      canvas: {
        requestNodeRun: async () => ({ ok: false as const, code: "unavailable", message: "test" }),
        requestNodeCancel: async () => ({ ok: false as const, code: "unavailable", message: "test" }),
        refreshSyncUpstream: async () => {
          refresh.count += 1;
        }
      }
    });

    const login = await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    expect((login.body as { ok: boolean }).ok).toBe(true);
    expect(refresh.count).toBe(1);

    await host.call(REMOTE_SERVER_LOGOUT_ROUTE);
    expect(refresh.count).toBe(2);
  });

  it("登录失败不通知（不给宿主一个空转的重新解析）", async () => {
    const fake = createFakeServer();
    const refresh = { count: 0 };
    const host = await activate({
      deployment: { serverUrl: fake.serverUrl, deviceToken: "bad-token", keyPrefix: "" },
      fetchImpl: fake.fetch,
      canvas: {
        requestNodeRun: async () => ({ ok: false as const, code: "unavailable", message: "test" }),
        requestNodeCancel: async () => ({ ok: false as const, code: "unavailable", message: "test" }),
        refreshSyncUpstream: async () => {
          refresh.count += 1;
        }
      }
    });

    const login = await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    expect((login.body as { ok: boolean }).ok).toBe(false);
    expect(refresh.count).toBe(0);
  });
});

describe("接入端身份（网关断言）", () => {
  /** 调原始 handler：构造一个可读的请求体与可断言的响应。 */
  async function callRaw(host: ReturnType<typeof createHost>, route: string, input: { headers: Record<string, string>; body?: unknown }) {
    const handler = host.rawHandlers.get(route);
    if (!handler) throw new Error(`未注册原始 handler：${route}`);
    const payload = Buffer.from(JSON.stringify(input.body ?? {}));
    const req = {
      headers: input.headers,
      on(event: string, listener: (arg?: unknown) => void) {
        if (event === "data") listener(payload);
        if (event === "end") listener();
        return req;
      }
    };
    let status = 200;
    let text = "";
    const res = {
      set statusCode(value: number) { status = value; },
      get statusCode() { return status; },
      setHeader() {},
      end(chunk?: unknown) { text = chunk === undefined ? "" : String(chunk); }
    };
    await handler(req, res);
    return { status, body: JSON.parse(text || "{}") as Record<string, unknown> };
  }

  it("只带网关断言、不填任何令牌也能登录（这就是一键接入）", async () => {
    const fake = createFakeServer({ gatewaySubject: "alice-from-gateway" });
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, loginAssertionHeaders: ["x-example-assertion"] });

    const result = await callRaw(host, REMOTE_SERVER_LOGIN_ROUTE, {
      headers: { "x-example-assertion": "jwe-assertion", "x-example-mode": "1", "x-example-request": "rio-1", timestamp: "1700000000", signature: "abc" }
    });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect((result.body.snapshot as { subject: string }).subject).toBe("alice-from-gateway");
    // 断言被原样转发给远端 Login（不是换成令牌再发）。
    const loginCall = fake.calls.find((call) => call.path.endsWith("/Login"));
    expect(loginCall?.body).toEqual({});
    // 一次性令牌的任何残留都不该出现。
    expect(JSON.stringify(result.body)).not.toContain("device-token");
  });

  it("断言不成立时回落到配置的设备凭证（与远端语义一致）", async () => {
    // gatewaySubject 未设 → fake 不认断言，只会按令牌登录。
    const fake = createFakeServer({ identities: { "device-token": "device-alice" } });
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, loginAssertionHeaders: ["x-example-assertion"] });

    const result = await callRaw(host, REMOTE_SERVER_LOGIN_ROUTE, {
      headers: { "x-example-assertion": "stale-assertion" }
    });
    expect(result.body.ok).toBe(true);
    expect((result.body.snapshot as { subject: string }).subject).toBe("device-alice");
  });

  it("既无断言也无凭证时给出可读原因，不假装登录成功", async () => {
    const fake = createFakeServer();
    const host = await activate({ deployment: { serverUrl: fake.serverUrl, deviceToken: null, keyPrefix: "" }, fetchImpl: fake.fetch });
    const result = await callRaw(host, REMOTE_SERVER_LOGIN_ROUTE, { headers: {} });
    expect(result.body.ok).toBe(false);
    expect(String(result.body.error)).toContain("企业身份网关");
  });

  it("缺省不转发浏览器断言，必须显式安装登录适配器", async () => {
    const fake = createFakeServer({ gatewaySubject: "alice-from-gateway" });
    const host = await activate({ deployment: { serverUrl: fake.serverUrl, deviceToken: null, keyPrefix: "" }, fetchImpl: fake.fetch });
    const result = await callRaw(host, REMOTE_SERVER_LOGIN_ROUTE, { headers: { "x-example-assertion": "untrusted" } });
    expect(result.body.ok).toBe(false);
    expect(fake.calls.some(call => call.path.endsWith("/Login"))).toBe(false);
    expect(pickLoginAssertionHeaders({ "x-example-assertion": "untrusted" })).toEqual({});
  });

  it("只转发网关断言头，不把浏览器的其它头带给远端", () => {
    const picked = pickLoginAssertionHeaders({
      "x-example-assertion": "jwe",
      timestamp: "1",
      signature: "s",
      cookie: "secret-cookie",
      authorization: "Bearer something",
      "x-custom": "nope",
      host: "browser.example.com"
    }, ["X-Example-Assertion", "timestamp", "signature", "cookie", "authorization", "host"]);
    expect(picked).toEqual({ "x-example-assertion": "jwe", timestamp: "1", signature: "s" });
  });
});

describe("shared 纯函数", () => {
  it("接受 https origin 与站内路径，拒绝危险形状", () => {
    expect(parseServerUrl("https://canvas.example.com/")).toEqual({ ok: true, value: "https://canvas.example.com" });
    expect(parseServerUrl("/remote/")).toEqual({ ok: true, value: "/remote" });
    expect(parseServerUrl("//evil.example").ok).toBe(false);
    expect(parseServerUrl("ftp://x").ok).toBe(false);
    expect(parseServerUrl("https://user:pw@x").ok).toBe(false);
    expect(parseServerUrl("https://x/?a=1").ok).toBe(false);
    expect(parseServerUrl("   ").ok).toBe(false);
  });

  it("由同一基址推出 Connect 与 WS 根", () => {
    expect(resolveRemoteEndpoints("https://canvas.example.com")).toEqual({
      rpcBase: "https://canvas.example.com",
      wsBase: "wss://canvas.example.com"
    });
    expect(resolveRemoteEndpoints("http://127.0.0.1:8790")).toEqual({
      rpcBase: "http://127.0.0.1:8790",
      wsBase: "ws://127.0.0.1:8790"
    });
    expect(resolveRemoteEndpoints("/remote")).toEqual({ rpcBase: "/remote", wsBase: "/remote" });
  });
});

/** 内存版文档存储：实现契约要求的最小子集（get / batch / scan / schema）。 */
function createFakeDocuments() {
  const records = new Map<string, { value: unknown; revision: number }>();
  let schema = 0;
  return {
    owner: () => "remote-server",
    async scan(prefix: string, _options?: { cursor?: string; limit?: number }) {
      const entries = [...records.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, record]) => ({
          key,
          value: record.value as never,
          revision: record.revision,
          updatedAt: new Date().toISOString()
        }));
      return { entries, nextCursor: null };
    },
    async schemaVersion() {
      return schema;
    },
    async setSchemaVersion(version: number) {
      schema = version;
    },
    async get(key: string) {
      const record = records.get(key);
      if (!record) return { found: false as const };
      return {
        found: true as const,
        document: { key, value: record.value as never, revision: record.revision, updatedAt: new Date().toISOString() }
      };
    },
    async batch(operations: readonly ({ op: "set"; key: string; value: unknown } | { op: "delete"; key: string })[]) {
      const revisions: Record<string, number | null> = {};
      for (const operation of operations) {
        if (operation.op === "delete") {
          records.delete(operation.key);
          revisions[operation.key] = null;
        } else {
          const revision = (records.get(operation.key)?.revision ?? 0) + 1;
          records.set(operation.key, { value: operation.value, revision });
          revisions[operation.key] = revision;
        }
      }
      return { ok: true as const, revisions };
    }
  };
}

describe("remote-server 目录能力", () => {
  /**
   * 目录是 provider 式的：接入端既是"内容同步上游"，也是"远端画布来源"。
   * 两者共用同一份会话；目录失败必须返回空数组，不能让本机列表跟着消失。
   */
  it("登录后暴露远端画布，供宿主合并进本机目录", async () => {
    const fake = createFakeServer();
    const host = await activate({
      deployment: { serverUrl: "https://remote.example", deviceToken: "device-token", keyPrefix: "" },
      fetchImpl: fake.fetch
    });
    // 先登录拿到会话：没有会话时来源必须是空（不能拿匿名请求去猜目录）。
    const capability = [...host.capabilityRegistry.values()].find(
      (value): value is { resolve: () => Promise<unknown>; listCanvases?: () => Promise<unknown[]> } =>
        typeof (value as { resolve?: unknown })?.resolve === "function"
    );
    expect(capability).toBeDefined();
    expect(await capability!.listCanvases!()).toEqual([]);

    await host.call(REMOTE_SERVER_LOGIN_ROUTE, { token: "device-token" });
    const canvases = (await capability!.listCanvases!()) as Array<{ id: string; title: string }>;
    expect(canvases).toEqual([
      expect.objectContaining({ id: "canvas-remote-1", title: "远端画布" })
    ]);
  });

  it("远端不可达时目录返回空而不是抛错", async () => {
    const fake = createFakeServer({ down: true });
    const host = await activate({
      deployment: { serverUrl: "https://remote.example", deviceToken: "device-token", keyPrefix: "" },
      fetchImpl: fake.fetch
    });
    const capability = [...host.capabilityRegistry.values()].find(
      (value): value is { listCanvases?: () => Promise<unknown[]> } =>
        typeof (value as { listCanvases?: unknown })?.listCanvases === "function"
    );
    expect(await capability!.listCanvases!()).toEqual([]);
  });
});

describe("服务端接入诊断", () => {
  /**
   * UUID v4 形状的固定 id。
   *
   * 幂等键必须在「记录那一刻」生成并固定，测试不能每次生成随机值，否则无法断言
   * 「同一条目多次上报带同一个 entryId」。
   */
  function entryId(value: number): string {
    return `11111111-1111-4111-8111-${String(value).padStart(12, "0")}`;
  }

  const sampleEntries: ApplicationBackendDiagnosticEntry[] = [
    {
      id: entryId(1),
      seq: 1,
      time: 1_700_000_000_000,
      level: "info",
      category: "application",
      event: "remote-probe-ok",
      message: "远端探测成功",
      attributes: { status: "200", server: "canvas.example.com" }
    },
    {
      id: entryId(2),
      seq: 2,
      time: 1_700_000_001_000,
      level: "warn",
      category: "application",
      event: "remote-login-failed",
      code: "unauthenticated",
      message: "凭证无效或会话已失效"
    }
  ];

  /** 只读诊断替身：记录读取参数，让「读了多大一页」也可断言。 */
  function diagnosticsStub(entries: ApplicationBackendDiagnosticEntry[]) {
    const reads: Array<{ since?: number; limit?: number }> = [];
    const value: ApplicationBackendDiagnostics = {
      snapshot: (input = {}) => {
        reads.push(input);
        return entries.map((entry) => ({ ...entry }));
      }
    };
    return { reads, value };
  }

  const REPORT_PATH = "/woohaa.diagnostics.v1alpha1.ClientDiagnosticsService/ReportDiagnostics";

  /** 生成带单调 seq 的条目；`messageLength` 用来把窗口撑过单次请求的字节预算。 */
  function sizedEntries(count: number, messageLength: number): ApplicationBackendDiagnosticEntry[] {
    const base = 1_700_000_000_000;
    return Array.from({ length: count }, (_, index) => ({
      id: entryId(index + 1),
      seq: index + 1,
      time: base + index * 1000,
      level: "info" as const,
      category: "application",
      event: "remote-probe-ok",
      ...(messageLength > 0 ? { message: "x".repeat(messageLength) } : {})
    }));
  }

  /** 上报请求（按发出顺序）：fake 记录的 body 就是真实 JSON，字节数按同一口径复算。 */
  function reportCalls(fake: ReturnType<typeof createFakeServer>) {
    return fake.calls.filter((call) => call.path === REPORT_PATH);
  }

  /** 一条上报请求里的条目载荷（未做类型收窄，字段由各用例按 proto 形状自行断言）。 */
  function sentEntries(call: { body: unknown }): Array<Record<string, unknown>> {
    const entries = (call.body as { entries?: unknown }).entries;
    return Array.isArray(entries) ? (entries as Array<Record<string, unknown>>) : [];
  }

  function sentTimes(call: { body: unknown }): string[] {
    return sentEntries(call).map((entry) => String(entry.time));
  }

  it("宿主没有诊断能力时明说不可用，而不是返回一份空列表", async () => {
    const fake = createFakeServer();
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const result = await host.call(REMOTE_SERVER_DIAGNOSTICS_ROUTE);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ entries: [], capacity: 0, available: false });
    expect(Number((result.body as { capturedAt: number }).capturedAt)).toBeGreaterThan(0);
  });

  it("有诊断缓冲时原样返回已脱敏条目，并按 200 条上限读取", async () => {
    const fake = createFakeServer();
    const stub = diagnosticsStub(sampleEntries);
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, diagnostics: stub.value });

    const result = await host.call(REMOTE_SERVER_DIAGNOSTICS_ROUTE);
    expect(result.body).toEqual({
      entries: sampleEntries,
      capturedAt: expect.any(Number),
      capacity: 200,
      available: true
    });
    expect(stub.reads).toEqual([{ limit: 200 }]);
  });

  it("没有会话时上报返回稳定错误，且一个请求都不发", async () => {
    const fake = createFakeServer();
    const host = await activate({
      deployment: { serverUrl: fake.serverUrl, deviceToken: null, keyPrefix: "" },
      fetchImpl: fake.fetch,
      diagnostics: diagnosticsStub(sampleEntries).value
    });

    const result = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    expect(result.body).toEqual({ ok: false, error: "未连接服务端" });
    expect(fake.calls).toHaveLength(0);
  });

  it("有会话但没有诊断缓冲时给出稳定原因，不去编造一次空上报", async () => {
    const fake = createFakeServer();
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const result = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    expect(result.body).toEqual({ ok: false, error: "宿主没有提供诊断缓冲" });
    expect(fake.calls.filter((call) => call.path.endsWith("/ReportDiagnostics"))).toHaveLength(0);
  });

  it("上报成功：宿主代发 POST 并带 Bearer，只把 acceptedCount 带回浏览器", async () => {
    const fake = createFakeServer();
    const host = await activate({
      deployment: fake.deployment,
      fetchImpl: fake.fetch,
      diagnostics: diagnosticsStub(sampleEntries).value
    });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const result = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, acceptedCount: 2 });

    const reportCall = fake.calls.find((call) =>
      call.path === "/woohaa.diagnostics.v1alpha1.ClientDiagnosticsService/ReportDiagnostics"
    );
    expect(reportCall).toBeDefined();
    expect(reportCall?.authorization).toMatch(/^Bearer session-/);
    // 条目形状必须与 proto 的 Connect JSON 对齐：entry_id 幂等键、RFC3339 时间、枚举名级别。
    expect(reportCall?.body).toEqual({
      frontendVersion: "",
      entries: [
        {
          entryId: entryId(1),
          time: new Date(sampleEntries[0].time).toISOString(),
          level: "LEVEL_INFO",
          category: "application",
          event: "remote-probe-ok",
          message: "远端探测成功",
          // 宿主投影出的键值细节原样透传；扩展不重新解释其形状。
          attributes: { status: "200", server: "canvas.example.com" }
        },
        {
          entryId: entryId(2),
          time: new Date(sampleEntries[1].time).toISOString(),
          level: "LEVEL_WARN",
          category: "application",
          event: "remote-login-failed",
          code: "unauthenticated",
          message: "凭证无效或会话已失效"
        }
      ]
    });
    // 令牌不出现在响应体里。
    expect(JSON.stringify(result.body)).not.toContain("session-");
  });

  it("把浏览器自报的构建版本转发给服务端；形状非法就归一为空串而不是拒绝上报", async () => {
    // 版本属于浏览器那份 bundle：宿主只做形状校验再转发，不能自己编，也不该因为一个辅助字段
    // 把整批诊断弄失败（服务端同样只做形状清洗）。
    const accepted = createFakeServer();
    const acceptedHost = await activate({
      deployment: accepted.deployment,
      fetchImpl: accepted.fetch,
      diagnostics: diagnosticsStub(sampleEntries).value
    });
    await acceptedHost.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    await acceptedHost.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE, { frontendVersion: "abc1234-dirty" });
    expect(reportCalls(accepted)[0]?.body).toMatchObject({ frontendVersion: "abc1234-dirty" });

    const rejected = createFakeServer();
    const rejectedHost = await activate({
      deployment: rejected.deployment,
      fetchImpl: rejected.fetch,
      diagnostics: diagnosticsStub(sampleEntries).value
    });
    await rejectedHost.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const result = await rejectedHost.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE, {
      frontendVersion: "v1.2.3 build"
    });
    expect(result.body).toEqual({ ok: true, acceptedCount: 2 });
    expect(reportCalls(rejected)[0]?.body).toMatchObject({ frontendVersion: "" });
  });

  it("attributes 为空时不上报该字段，非空时原样透传", async () => {
    const fake = createFakeServer();
    const entries: ApplicationBackendDiagnosticEntry[] = [
      // 空 map 与「没有细节」等价：不发 `"attributes":{}`，省一对无谓字节。
      {
        id: entryId(1),
        seq: 1,
        time: 1_700_000_000_000,
        level: "info",
        category: "application",
        event: "remote-probe-ok",
        attributes: {}
      },
      {
        id: entryId(2),
        seq: 2,
        time: 1_700_000_001_000,
        level: "warn",
        category: "application",
        event: "remote-login-failed",
        message: "凭证无效或会话已失效",
        attributes: { status: "401", phase: "probe" }
      },
      {
        id: entryId(3),
        seq: 3,
        time: 1_700_000_002_000,
        level: "info",
        category: "application",
        event: "remote-probe-ok"
      }
    ];
    const host = await activate({
      deployment: fake.deployment,
      fetchImpl: fake.fetch,
      diagnostics: diagnosticsStub(entries).value
    });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const result = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    expect(result.body).toEqual({ ok: true, acceptedCount: 3 });

    const sent = sentEntries(reportCalls(fake)[0]);
    expect(sent[0]).not.toHaveProperty("attributes");
    expect(sent[1].attributes).toEqual({ status: "401", phase: "probe" });
    expect(sent[2]).not.toHaveProperty("attributes");
  });

  it("按字节切批：超过 24 KiB 的窗口拆成多批，每批都不越过服务端解码上限", async () => {
    const fake = createFakeServer();
    // 问题现场：200 条带短说明实测就有 36–39 KB，只按条数发会被 32 KiB 解码上限拒掉。
    // 这里用 480 字符说明把窗口撑到约 128 KB，确保必然拆成多批。
    const entries = sizedEntries(200, 480);
    const host = await activate({
      deployment: fake.deployment,
      fetchImpl: fake.fetch,
      diagnostics: diagnosticsStub(entries).value
    });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const result = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    const calls = reportCalls(fake);
    expect(calls.length).toBeGreaterThan(1);

    const allTimes: string[] = [];
    const allIds: string[] = [];
    for (const call of calls) {
      const batch = sentEntries(call);
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(200);
      // 断言的是**实际发出去的 JSON**：fake 记录的 body 就是 callConnect 序列化的结果。
      expect(Buffer.byteLength(JSON.stringify(call.body), "utf8")).toBeLessThanOrEqual(24 * 1024);
      for (const entry of batch) {
        // 每批每条都必须带幂等键——服务端正是按它去重的。
        expect(typeof entry.entryId).toBe("string");
        expect(entry.entryId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
        // seq 是宿主进程内的读取游标，不属于契约，不能出现在载荷里。
        expect(entry).not.toHaveProperty("seq");
        allIds.push(String(entry.entryId));
      }
      allTimes.push(...sentTimes(call));
    }
    // 每条恰好发一次：既不漏（被预算挤掉）也不重（跨批重复）；entryId 与宿主条目一一对应。
    expect(allTimes).toHaveLength(entries.length);
    expect(new Set(allTimes).size).toBe(entries.length);
    expect(new Set(allIds)).toEqual(new Set(entries.map((entry) => entry.id)));
    // acceptedCount 取服务端返回值并按批累加。
    expect(result.body).toEqual({ ok: true, acceptedCount: 200 });
  });

  it("同一快照连续上报两次：第二次不发请求，acceptedCount 为 0", async () => {
    const fake = createFakeServer();
    const host = await activate({
      deployment: fake.deployment,
      fetchImpl: fake.fetch,
      diagnostics: diagnosticsStub(sampleEntries).value
    });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const first = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    expect(first.body).toEqual({ ok: true, acceptedCount: 2 });
    const sent = reportCalls(fake).length;
    expect(sent).toBeGreaterThan(0);

    const second = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    expect(second.body).toEqual({ ok: true, acceptedCount: 0 });
    // 没有新条目时连一个请求都不该发：水位让重复点击不发无谓请求。
    expect(reportCalls(fake)).toHaveLength(sent);
  });

  it("扩展重载后水位归零会重发整窗，但 entryId 与原批一致（服务端据此去重）", async () => {
    // 先上报一次；再新建一个扩展实例（等价于扩展重载：闭包里的水位归零），用同一份宿主缓冲
    // 再上报一次。两次载荷的 entryId 必须逐条相同，服务端才会把重发认成同一批条目。
    const entries = sampleEntries;
    const firstFake = createFakeServer();
    const firstHost = await activate({
      deployment: firstFake.deployment,
      fetchImpl: firstFake.fetch,
      diagnostics: diagnosticsStub(entries).value
    });
    await firstHost.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const first = await firstHost.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    expect(first.body).toEqual({ ok: true, acceptedCount: 2 });
    const firstIds = sentEntries(reportCalls(firstFake)[0]).map((entry) => String(entry.entryId));
    expect(firstIds).toEqual([entryId(1), entryId(2)]);

    const secondFake = createFakeServer();
    const secondHost = await activate({
      deployment: secondFake.deployment,
      fetchImpl: secondFake.fetch,
      diagnostics: diagnosticsStub(entries).value
    });
    await secondHost.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const second = await secondHost.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    expect(second.body).toEqual({ ok: true, acceptedCount: 2 });
    const secondIds = sentEntries(reportCalls(secondFake)[0]).map((entry) => String(entry.entryId));
    // 同一条目在被重新读取/重发时 entryId 不变：这就是服务端的幂等依据。
    expect(secondIds).toEqual(firstIds);
  });

  it("上报成功留下的自指事件不会被再次上报：真实宿主里连点两次仍然是 0", async () => {
    // 真实宿主会把 `remote-diagnostics-report-ok` 也投影回诊断缓冲（log 出口 → 诊断缓冲）。
    // 若把它当成普通条目再上报，每次点击都会「恰好有一条新条目」，去重就永远看不到空状态。
    const entries = [
      ...sampleEntries,
      {
        id: entryId(3),
        seq: 3,
        time: 1_700_000_002_000,
        level: "info" as const,
        category: "application",
        event: "remote-diagnostics-report-ok"
      }
    ];
    const fake = createFakeServer();
    const host = await activate({
      deployment: fake.deployment,
      fetchImpl: fake.fetch,
      diagnostics: diagnosticsStub(entries).value
    });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const first = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    // 自指事件被排除，只上报样本里的两条。
    expect(first.body).toEqual({ ok: true, acceptedCount: 2 });
    expect(reportCalls(fake)).toHaveLength(1);
    expect(sentTimes(reportCalls(fake)[0])).toHaveLength(2);

    // 本次成功又会往缓冲里投影一条 seq 4 的成功事件；再点一次必须彻底没有可发的。
    entries.push({
      id: entryId(4),
      seq: 4,
      time: 1_700_000_003_000,
      level: "info",
      category: "application",
      event: "remote-diagnostics-report-ok"
    });
    const second = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    expect(second.body).toEqual({ ok: true, acceptedCount: 0 });
    expect(reportCalls(fake)).toHaveLength(1);
  });

  it("某批失败时水位只推进到最后一个成功批：重试只补后续条目", async () => {
    const fake = createFakeServer({ diagnosticsFailOnCall: 2 });
    const entries = sizedEntries(120, 480);
    const host = await activate({
      deployment: fake.deployment,
      fetchImpl: fake.fetch,
      diagnostics: diagnosticsStub(entries).value
    });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const failed = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    expect(failed.body).toEqual({ ok: false, error: "远端调用失败" });
    const firstAttempt = reportCalls(fake);
    // 第二批失败：第一次尝试恰好发出两个请求。
    expect(firstAttempt).toHaveLength(2);
    const delivered = new Set(sentTimes(firstAttempt[0]));
    expect(delivered.size).toBeGreaterThan(0);
    expect(delivered.size).toBeLessThan(entries.length);
    // 部分成功的事实进日志（不含条目内容），便于对照服务端落库。
    const failureLog = host.logEvents.filter((event) => event.event === "remote-diagnostics-report-failed").at(-1);
    expect(failureLog?.acceptedCount).toBe(delivered.size);

    const retried = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    expect(retried.body).toEqual({ ok: true, acceptedCount: entries.length - delivered.size });
    const retriedTimes = reportCalls(fake).slice(firstAttempt.length).flatMap((call) => sentTimes(call));
    // 已成功批次一条都不重发，失败批及后续批次逐条补齐。
    for (const time of retriedTimes) expect(delivered.has(time)).toBe(false);
    expect(new Set(retriedTimes).size).toBe(entries.length - delivered.size);
  });

  it("acceptedCount 以服务端返回为准并跨批累加", async () => {
    // 服务端每批只报 7 条，与客户端发出的条数无关：累加必须按返回值算。
    const fake = createFakeServer({ diagnosticsAcceptedCount: 7 });
    const entries = sizedEntries(120, 480);
    const host = await activate({
      deployment: fake.deployment,
      fetchImpl: fake.fetch,
      diagnostics: diagnosticsStub(entries).value
    });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const result = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    const batches = reportCalls(fake).length;
    expect(batches).toBeGreaterThan(1);
    expect(result.body).toEqual({ ok: true, acceptedCount: 7 * batches });
  });

  it("服务端返回空对象（acceptedCount 缺失）时按新增 0 条计，而不是本批条数", async () => {
    // proto3 的 JSON 编码省略零值：幂等键命中、一条都没新增时服务端回的就是 `{}`。
    // 若把「缺失」退化成本批条数，扩展重载后重发整窗（实际新增 0）会显示成「已上报 2 条」。
    const fake = createFakeServer({ diagnosticsOmitAcceptedCount: true });
    const host = await activate({
      deployment: fake.deployment,
      fetchImpl: fake.fetch,
      diagnostics: diagnosticsStub(sampleEntries).value
    });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const result = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    // 请求确实发出去了（条目带 entryId），但服务端一条都没新增。
    expect(reportCalls(fake)).toHaveLength(1);
    expect(sentEntries(reportCalls(fake)[0])).toHaveLength(2);
    expect(result.body).toEqual({ ok: true, acceptedCount: 0 });
  });

  it("单条自身超预算时独占一批，而不是被丢掉或与别的条目拼在一起", async () => {
    const fake = createFakeServer();
    // 30 000 字符说明让单条 JSON ≈30 KB：超客户端 24 KiB 预算，但仍低于服务端 32 KiB，
    // 因此「独占一批」是唯一正确解——切不开，也不该丢。
    const entries: ApplicationBackendDiagnosticEntry[] = [
      { id: entryId(1), seq: 1, time: 1_700_000_000_000, level: "info", category: "application", event: "remote-probe-ok" },
      {
        id: entryId(2),
        seq: 2,
        time: 1_700_000_001_000,
        level: "warn",
        category: "application",
        event: "remote-login-failed",
        message: "y".repeat(30_000)
      },
      { id: entryId(3), seq: 3, time: 1_700_000_002_000, level: "info", category: "application", event: "remote-probe-ok" }
    ];
    const host = await activate({
      deployment: fake.deployment,
      fetchImpl: fake.fetch,
      diagnostics: diagnosticsStub(entries).value
    });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const result = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    const calls = reportCalls(fake);
    expect(calls.map((call) => sentTimes(call).length)).toEqual([1, 1, 1]);
    for (const call of calls) {
      const batch = sentTimes(call);
      if (batch.length === 1 && batch[0] === new Date(entries[1].time).toISOString()) {
        // 超大条目确实发出去了，且没有把邻居拖进同一批。
        expect(JSON.stringify(call.body)).toContain("y".repeat(100));
      } else {
        expect(Buffer.byteLength(JSON.stringify(call.body), "utf8")).toBeLessThanOrEqual(24 * 1024);
      }
    }
    expect(result.body).toEqual({ ok: true, acceptedCount: 3 });
  });

  it("每批条数不超过 200：条数上限先于字节预算生效", async () => {
    const fake = createFakeServer();
    // 真实 UUID 的 entryId 会让 200 条本身就超过 24 KiB，字节预算会先触发，条数上限无法单独验证。
    // 这里用短 id 只为把字节预算压下去：分批逻辑不校验 id 形状（校验在服务端），这条用例
    // 验证的是防御性约束「每批 ≤200 条」。
    const entries: ApplicationBackendDiagnosticEntry[] = Array.from({ length: 250 }, (_, index) => ({
      id: `${index + 1}`,
      seq: index + 1,
      time: 1_700_000_000_000 + index * 1000,
      level: "info" as const,
      category: "a",
      event: "a"
    }));
    const host = await activate({
      deployment: fake.deployment,
      fetchImpl: fake.fetch,
      diagnostics: diagnosticsStub(entries).value
    });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const result = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    expect(reportCalls(fake).map((call) => sentTimes(call).length)).toEqual([200, 50]);
    expect(result.body).toEqual({ ok: true, acceptedCount: 250 });
  });

  it("服务端未实现上报时给可行动文案，且不透传远端正文", async () => {
    const fake = createFakeServer({ diagnosticsUnimplemented: true });
    const host = await activate({
      deployment: fake.deployment,
      fetchImpl: fake.fetch,
      diagnostics: diagnosticsStub(sampleEntries).value
    });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const result = await host.call(REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE);
    expect(result.body).toEqual({ ok: false, error: "服务端尚未实现诊断上报接口" });
    expect(JSON.stringify(result.body)).not.toContain("not implemented");
    // 远端正文也不进日志：日志只留稳定码与稳定短语。
    expect(JSON.stringify(host.logEvents)).not.toContain("not implemented");
  });

  it("接入日志只含稳定字段：没有令牌、会话令牌、设备码与短码", async () => {
    const fake = createFakeServer({ identities: { "one-shot": "bob" } });
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });

    await host.call(REMOTE_SERVER_PROBE_ROUTE, { serverUrl: fake.serverUrl });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, { token: "one-shot" });
    const started = await host.call(REMOTE_SERVER_DEVICE_START_ROUTE, { serverUrl: fake.serverUrl });
    expect((started.body as { ok: boolean }).ok).toBe(true);
    const poll = await host.call(REMOTE_SERVER_DEVICE_POLL_ROUTE);
    expect((poll.body as { state: string }).state).toBe("approved");

    const serialized = JSON.stringify(host.logEvents);
    for (const secret of ["one-shot", "session-", "device-code-", "USER-CODE-"]) {
      expect(serialized).not.toContain(secret);
    }
    // 远端地址只留 host[:port]：完整 URL 可能带部署路径，不该进日志。
    expect(serialized).not.toContain("https://");
    expect(serialized).toContain("canvas.example.com");

    // 接入步骤都要有事件，否则诊断窗口只能显示一个结果、看不到卡在哪一步。
    const remoteEvents = host.logEvents.filter((event) => String(event.event).startsWith("remote-"));
    expect(remoteEvents.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "remote-probe-start",
        "remote-probe-ok",
        "remote-login-start",
        "remote-login-ok",
        "remote-device-start",
        "remote-device-pending",
        "remote-device-approved"
      ])
    );
    // 事件名与级别都必须能被宿主白名单投影（否则诊断窗口会静默丢事件）。
    for (const event of remoteEvents) {
      expect(String(event.event)).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
      expect(["debug", "info", "warn", "error"]).toContain(event.level);
      // 宿主投影对 code / serverHost / method 各有形状要求；形状不符会被静默省略。
      if (event.code !== undefined) expect(String(event.code)).toMatch(/^[a-z0-9][a-z0-9_.:-]{0,63}$/);
      if (event.serverHost !== undefined) expect(String(event.serverHost)).toMatch(/^[A-Za-z0-9.-]{1,255}(?::\d{1,5})?$/);
      if (event.method !== undefined) expect(String(event.method)).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
    }
  });
});

/** 取注册的同步上游 provider：按能力形状找，不依赖具体扩展 id。 */
function upstreamProviderOf(host: ReturnType<typeof createHost>): CanvasUpstreamProvider {
  const provider = [...host.capabilityRegistry.values()].find(
    (value): value is CanvasUpstreamProvider => typeof (value as { resolve?: unknown })?.resolve === "function"
  );
  if (!provider) throw new Error("未注册同步上游 capability");
  return provider;
}

/** 文档存储里的待同步集合；不存在返回 null（断言实现真的落盘，而不是只在内存里）。 */
async function pendingDocument(documents: ReturnType<typeof createFakeDocuments>): Promise<unknown> {
  const record = await documents.get("canvas-sync/pending");
  return record.found ? record.document.value : null;
}

/** 统计打到远端目录的请求（用来断言缓存命中时不重复列目录）。 */
function listMyCanvasesCalls(fake: ReturnType<typeof createFakeServer>) {
  return fake.calls.filter((call) => call.path.endsWith("/ListMyCanvases"));
}

describe("按画布门控同步（登录 ≠ 上传）", () => {
  it("登录后未启用的本地画布不拿到链路；远端已有的画布无需启用就自动同步", async () => {
    const fake = createFakeServer();
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const provider = upstreamProviderOf(host);

    // 缺省：登录 != 上传。本地画布返回 null，宿主回落静态配置/纯本地。
    expect(await provider.resolve("canvas-local-1")).toBeNull();
    // 缓存为空时 resolve 自己列一次目录，不能把「没列过」当成「不在远端」。
    expect(listMyCanvasesCalls(fake)).toHaveLength(1);

    // 已在远端目录里的画布是普通远端画布：无需任何显式动作。
    const remote = await provider.resolve("canvas-remote-1");
    expect(remote).toMatchObject({ url: "wss://canvas.example.com" });
    expect(remote?.token).toMatch(/^session-/);

    // 第二次解析命中缓存，不再打远端目录。
    expect(await provider.resolve("canvas-local-1")).toBeNull();
    expect(listMyCanvasesCalls(fake)).toHaveLength(1);
  });

  it("显式启用后拿到链路：待同步集合落盘、宿主被通知刷新、日志不含令牌", async () => {
    const fake = createFakeServer();
    const documents = createFakeDocuments();
    const refresh = { count: 0 };
    const mediaSync: string[] = [];
    const host = await activate({
      deployment: fake.deployment,
      fetchImpl: fake.fetch,
      documents,
      canvas: {
        requestNodeRun: async () => ({ ok: false as const, code: "unavailable", message: "test" }),
        requestNodeCancel: async () => ({ ok: false as const, code: "unavailable", message: "test" }),
        refreshSyncUpstream: async () => {
          refresh.count += 1;
        },
        syncCanvasMedia: (canvasId: string) => {
          mediaSync.push(canvasId);
        }
      }
    });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const refreshBefore = refresh.count;

    const enabled = await host.call(REMOTE_SERVER_SYNC_ENABLE_ROUTE, { canvasId: "canvas-local-1" });
    expect(enabled).toEqual({ status: 200, body: { ok: true } });
    // 点了「同步远端」就要真的切过去：宿主必须被通知重新解析一次。
    expect(refresh.count).toBe(refreshBefore + 1);
    // 文档链路之外，媒体字节也要显式对账一次（进度由目录徽标表达）。
    expect(mediaSync).toContain("canvas-local-1");
    // 待同步集合按会话维度持久化到文档存储。
    expect(JSON.stringify(await pendingDocument(documents))).toContain("canvas-local-1");

    const provider = upstreamProviderOf(host);
    const link = await provider.resolve("canvas-local-1");
    expect(link).toMatchObject({ url: "wss://canvas.example.com" });
    expect(link?.token).toMatch(/^session-/);

    // 启用过程写的事件在白名单形状内，且不泄漏令牌。
    expect(host.logEvents.map((event) => event.event)).toContain("remote-sync-enable");
    expect(JSON.stringify(host.logEvents)).not.toContain("session-");
  });

  it("首次推送完成、远端目录出现该 id 后清掉待同步标记，之后按普通远端画布同步", async () => {
    const fake = createFakeServer();
    const documents = createFakeDocuments();
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, documents });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    await host.call(REMOTE_SERVER_SYNC_ENABLE_ROUTE, { canvasId: "canvas-local-1" });
    expect(JSON.stringify(await pendingDocument(documents))).toContain("canvas-local-1");

    // 首次推送完成：远端目录开始包含这张画布。
    fake.remoteCanvasIds.push("canvas-local-1");
    const provider = upstreamProviderOf(host);
    const listed = Array.from(await provider.listCanvases!(), (canvas) => canvas.id);
    expect(listed).toContain("canvas-local-1");
    // 已在远端 = 已「成为远端画布」：待同步标记被移除并持久化。
    expect(JSON.stringify(await pendingDocument(documents))).not.toContain("canvas-local-1");

    // 用新实例（模拟重启、待同步集合不再有该 id）重连：仍按远端画布拿到链路。
    const restarted = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, documents });
    await restarted.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    expect(await upstreamProviderOf(restarted).resolve("canvas-local-1")).toMatchObject({
      url: "wss://canvas.example.com"
    });
  });

  it("没有会话或已登出时 resolve 返回 null", async () => {
    const fake = createFakeServer();
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const provider = upstreamProviderOf(host);

    // 未登录：纯本地形态，不是错误。
    expect(await provider.resolve("canvas-remote-1")).toBeNull();
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    expect(await provider.resolve("canvas-remote-1")).not.toBeNull();
    await host.call(REMOTE_SERVER_LOGOUT_ROUTE);
    expect(await provider.resolve("canvas-remote-1")).toBeNull();
  });

  it("非法 canvasId 被拒、不写存储也不发远端请求；无会话时给可读错误而非 5xx", async () => {
    const fake = createFakeServer();
    const documents = createFakeDocuments();
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, documents });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const callsBefore = fake.calls.length;

    for (const body of [{}, { canvasId: "" }, { canvasId: "x".repeat(201) }, { canvasId: 42 }]) {
      const rejected = await host.call(REMOTE_SERVER_SYNC_ENABLE_ROUTE, body);
      expect(rejected).toMatchObject({ status: 400, body: { ok: false } });
    }
    // 拒绝发生在任何远端调用与文档写入之前。
    expect(fake.calls.length).toBe(callsBefore);
    expect(await pendingDocument(documents)).toBeNull();

    // 没有会话：可读错误（不是 5xx），也不该悄悄写一份「待同步」状态。
    // 用一份**空**文档存储，避免继承上面已登录的会话。
    const anonymousDocuments = createFakeDocuments();
    const anonymous = await activate({
      deployment: { serverUrl: fake.serverUrl, deviceToken: null, keyPrefix: "" },
      fetchImpl: fake.fetch,
      documents: anonymousDocuments
    });
    const noSession = await anonymous.call(REMOTE_SERVER_SYNC_ENABLE_ROUTE, { canvasId: "canvas-local-1" });
    expect(noSession).toEqual({ status: 200, body: { ok: false, error: "未连接服务端" } });
    expect(fake.calls.length).toBe(callsBefore);
    expect(await pendingDocument(anonymousDocuments)).toBeNull();
  });

  it("待同步集合跨实例保留、登出不删除，但换账号或换地址不串用", async () => {
    const fake = createFakeServer({ identities: { "device-token": "device-alice", "device-bob": "device-bob" } });
    const documents = createFakeDocuments();

    const alice = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, documents });
    await alice.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    await alice.call(REMOTE_SERVER_SYNC_ENABLE_ROUTE, { canvasId: "canvas-local-1" });
    await alice.call(REMOTE_SERVER_LOGOUT_ROUTE);
    // 登出不删除：同一账号重连后还要继续完成首次同步。
    expect(JSON.stringify(await pendingDocument(documents))).toContain("canvas-local-1");

    const aliceAgain = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, documents });
    await aliceAgain.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    expect(await upstreamProviderOf(aliceAgain).resolve("canvas-local-1")).not.toBeNull();

    // 换账号：另一个主体的待同步集合是空的，不能继承 alice 的启用决定。
    const bob = await activate({
      deployment: { serverUrl: fake.serverUrl, deviceToken: "device-bob", keyPrefix: "" },
      fetchImpl: fake.fetch,
      documents
    });
    await bob.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    expect(await upstreamProviderOf(bob).resolve("canvas-local-1")).toBeNull();

    // 换地址同理：同一主体、不同远端部署不是同一个集合。
    const otherServer = await activate({
      deployment: { serverUrl: "https://other.example.com", deviceToken: "device-token", keyPrefix: "" },
      fetchImpl: fake.fetch,
      documents
    });
    await otherServer.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    expect(await upstreamProviderOf(otherServer).resolve("canvas-local-1")).toBeNull();
  });

// ---------------------------------------------------------------------------
// 画布协作者（CanvasService 成员接口的宿主代发面）
//
// 这几条用例锁的是**服务端的授权结论被如实转达**，而不是宿主再判一遍：作者与部署管理员
// 能代管成员，普通协作者只看到自己那一条且写操作被拒；浏览器拿到的错误是稳定中文短语，
// 不含令牌与远端正文。
  it("远端目录暂时不可达时保留旧缓存，不把已同步画布误判成「不在远端」", async () => {
    const fake = createFakeServer();
    let reachable = true;
    const flaky: typeof globalThis.fetch = async (input, init) => {
      if (!reachable) throw new TypeError("fetch failed");
      return fake.fetch(input, init);
    };
    const host = await activate({ deployment: fake.deployment, fetchImpl: flaky });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const provider = upstreamProviderOf(host);
    await provider.listCanvases!(); // 成功列一次，填充缓存

    reachable = false;
    // 列目录失败仍然返回空数组（目录不消失），但不得清掉缓存。
    expect(await provider.listCanvases!()).toEqual([]);
    // 已在远端目录里的画布仍按远端画布同步。
    expect(await provider.resolve("canvas-remote-1")).not.toBeNull();
    // 未启用的本地画布仍然不同步。
    expect(await provider.resolve("canvas-local-1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("remote-server 后端 · 画布协作者", () => {
  type MemberView = {
    ok: boolean;
    error?: string;
    canvasId?: string;
    owner?: string;
    isOwner?: boolean;
    role?: "viewer" | "editor";
    canManage?: boolean;
    complete?: boolean;
    members?: Array<{ actorId: string; role: "viewer" | "editor"; grantedBy: string; grantedAt: string }>;
  };

  function aclFake() {
    return createFakeServer({
      identities: { "author-token": "alice", "admin-token": "ops-admin", "viewer-token": "bob", "editor-token": "carol" },
      canvasAcl: {
        "canvas-remote-1": {
          owner: "alice",
          members: { bob: "viewer", carol: "editor" }
        }
      },
      adminSubjects: ["ops-admin"]
    });
  }

  async function signedIn(fake: ReturnType<typeof aclFake>, deviceToken: string) {
    return await activate({
      deployment: { serverUrl: fake.serverUrl, deviceToken, keyPrefix: "" },
      fetchImpl: fake.fetch
    });
  }

  it("作者看到完整名单，并能新增/移除协作者", async () => {
    const fake = aclFake();
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const view = await host.call(REMOTE_SERVER_CANVAS_MEMBERS_ROUTE, { canvasId: "canvas-remote-1" });
    const body = view.body as MemberView;
    expect(body).toMatchObject({
      ok: true,
      canvasId: "canvas-remote-1",
      owner: "alice",
      isOwner: true,
      role: "editor",
      canManage: true,
      complete: true
    });
    expect(body.members?.map((member) => member.actorId + ":" + member.role).sort()).toEqual(["bob:viewer", "carol:editor"]);

    const added = await host.call(REMOTE_SERVER_CANVAS_MEMBER_UPSERT_ROUTE, {
      canvasId: "canvas-remote-1",
      actorId: "dave",
      role: "editor"
    });
    expect(added.body).toMatchObject({
      ok: true,
      member: { actorId: "dave", role: "editor", grantedBy: "alice" }
    });
    expect(fake.canvasAcls.get("canvas-remote-1")?.members.get("dave")?.role).toBe("editor");

    const removed = await host.call(REMOTE_SERVER_CANVAS_MEMBER_REMOVE_ROUTE, {
      canvasId: "canvas-remote-1",
      actorId: "bob"
    });
    expect(removed.body).toMatchObject({ ok: true, member: null });
    expect(fake.canvasAcls.get("canvas-remote-1")?.members.has("bob")).toBe(false);
  });

  it("部署管理员（非作者）也能代管：canManage 来自管理端通道，而不是伪装成作者", async () => {
    const fake = aclFake();
    const host = await signedIn(fake, "admin-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const view = await host.call(REMOTE_SERVER_CANVAS_MEMBERS_ROUTE, { canvasId: "canvas-remote-1" });
    expect(view.body).toMatchObject({
      ok: true,
      owner: "alice",
      isOwner: false,
      canManage: true,
      complete: true
    });

    const added = await host.call(REMOTE_SERVER_CANVAS_MEMBER_UPSERT_ROUTE, {
      canvasId: "canvas-remote-1",
      actorId: "erin",
      role: "viewer"
    });
    expect(added.body).toMatchObject({ ok: true, member: { actorId: "erin", grantedBy: "ops-admin" } });
  });

  it("普通协作者只看到自己，写操作得到稳定短语", async () => {
    const fake = aclFake();
    const host = await signedIn(fake, "viewer-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const view = await host.call(REMOTE_SERVER_CANVAS_MEMBERS_ROUTE, { canvasId: "canvas-remote-1" });
    const body = view.body as MemberView;
    expect(body).toMatchObject({ ok: true, canManage: false, complete: false, role: "viewer" });
    // 不完整名单不能画成"只有这些人"：服务端只给本人一条，宿主如实标记 complete=false。
    expect(body.members?.map((member) => member.actorId)).toEqual(["bob"]);

    const denied = await host.call(REMOTE_SERVER_CANVAS_MEMBER_UPSERT_ROUTE, {
      canvasId: "canvas-remote-1",
      actorId: "dave",
      role: "viewer"
    });
    expect(denied.body).toEqual({ ok: false, error: "只有作者或部署管理员能管理协作者" });
    expect(fake.canvasAcls.get("canvas-remote-1")?.members.has("dave")).toBe(false);
  });

  it("未连接服务端时明确拒绝，且不发任何画布调用", async () => {
    const fake = aclFake();
    const host = await activate({
      deployment: { serverUrl: fake.serverUrl, deviceToken: "author-token", keyPrefix: "" },
      fetchImpl: fake.fetch
    });
    // 不登录。
    const view = await host.call(REMOTE_SERVER_CANVAS_MEMBERS_ROUTE, { canvasId: "canvas-remote-1" });
    expect(view.body).toEqual({ ok: false, error: "未连接服务端" });
    expect(fake.calls.filter((call) => call.path.includes("CanvasService"))).toHaveLength(0);
  });

  it("浏览器可控输入在宿主就拒绝，不把非法 id/角色带到远端", async () => {
    const fake = aclFake();
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const blankActor = await host.call(REMOTE_SERVER_CANVAS_MEMBER_UPSERT_ROUTE, {
      canvasId: "canvas-remote-1",
      actorId: "   ",
      role: "viewer"
    });
    expect(blankActor.status).toBe(400);
    expect((blankActor.body as { error: string }).error).toContain("主体标识");

    const spacedActor = await host.call(REMOTE_SERVER_CANVAS_MEMBER_UPSERT_ROUTE, {
      canvasId: "canvas-remote-1",
      actorId: "bad actor",
      role: "viewer"
    });
    expect(spacedActor.status).toBe(400);

    const badRole = await host.call(REMOTE_SERVER_CANVAS_MEMBER_UPSERT_ROUTE, {
      canvasId: "canvas-remote-1",
      actorId: "dave",
      role: "admin"
    });
    expect(badRole.status).toBe(400);
    expect((badRole.body as { error: string }).error).toContain("角色");

    const badCanvas = await host.call(REMOTE_SERVER_CANVAS_MEMBERS_ROUTE, { canvasId: "" });
    expect(badCanvas.status).toBe(400);

    // 一次远端写都没发出去。
    expect(fake.calls.filter((call) => call.path.endsWith("/UpsertCanvasMember") || call.path.endsWith("/RemoveCanvasMember"))).toHaveLength(0);
  });

  it("响应体不含会话令牌", async () => {
    const fake = aclFake();
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const view = await host.call(REMOTE_SERVER_CANVAS_MEMBERS_ROUTE, { canvasId: "canvas-remote-1" });
    expect(JSON.stringify(view.body)).not.toContain("session-");
  });
});

// ---------------------------------------------------------------------------
// 链接打开：拿到链接的人按 id 打开一张「不在我目录里」的远端画布。
//
// 链接分享不会让画布进入对方目录（ListMyCanvases 仍只认作者与协作者），所以必须有独立的
// 按 id 读取路径；而「打开过」等价于用户同意这张画布走上游——它要写进与「显式启用同步」
// 共用的待同步集合，否则重启后 resolve 会把它当本地画布，静默停在陈旧内容上。
describe("remote-server 后端 · 链接打开（按 id 取远端画布）", () => {
  function linkFake() {
    return createFakeServer({
      identities: { "author-token": "alice", "viewer-token": "bob", "stranger-token": "mallory" },
      canvasIds: ["canvas-remote-1"],
      canvasAcl: {
        "canvas-remote-1": { owner: "alice", members: { bob: "viewer" } },
        // 不在远端目录里：链接打开的画布。配置了 ACL/分享就能按 id 查到（模拟链接打开）。
        "canvas-linked": { owner: "alice" },
        // 什么都没分享：陌生人按 id 也看不见（restricted 下的 not_found）。
        "canvas-private": { owner: "alice" }
      },
      canvasShare: { "canvas-linked": { mode: "everyone_view", revision: 3 } }
    });
  }

  it("没有会话时按 id 取不到画布，也不发远端调用", async () => {
    const fake = linkFake();
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    const provider = upstreamProviderOf(host);
    expect(await provider.getCanvas?.("canvas-linked")).toBeNull();
    expect(fake.calls.filter((call) => call.path.endsWith("/GetCanvas"))).toHaveLength(0);
  });

  it("链接不在目录里：按 id 取到摘要，并把这张画布纳入上游同步", async () => {
    const fake = linkFake();
    const documents = createFakeDocuments();
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, documents });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, { token: "author-token" });
    const provider = upstreamProviderOf(host);

    const summary = await provider.getCanvas?.("canvas-linked");
    expect(summary).toMatchObject({
      id: "canvas-linked",
      title: "画布 canvas-linked",
      revision: 0,
      updatedAt: "2026-10-18T01:00:00Z",
      createdAt: "2026-10-18T00:00:00Z"
    });
    // 链接不会让画布进入对方目录：它仍然不在「我的画布」里。
    expect((await provider.listCanvases!()).map((canvas) => canvas.id)).not.toContain("canvas-linked");
    // 但打开过 = 用户明确同意这张画布走上游：resolve 放行，中继才会真的去拉内容。
    const link = await provider.resolve("canvas-linked");
    expect(link).toMatchObject({ url: "wss://canvas.example.com" });
    expect(link?.token).toMatch(/^session-/);
    // 写进的正是「显式启用同步」那份待同步集合（owner-scoped 文档，跨重启保留）。
    expect(JSON.stringify(await pendingDocument(documents))).toContain("canvas-linked");
  });

  it("远端取不到（不可见 / 不可达）时返回 null，不留下同步标记", async () => {
    const fake = linkFake();
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, { token: "stranger-token" });
    const provider = upstreamProviderOf(host);

    // 不在 ACL 里、也没分享：按 id 也看不见（服务端回 not_found，不区分「存在但没权限」）。
    expect(await provider.getCanvas?.("canvas-private")).toBeNull();
    expect(await provider.resolve("canvas-private")).toBeNull();

    let reachable = true;
    const flaky: typeof globalThis.fetch = async (input, init) => {
      if (!reachable) throw new TypeError("fetch failed");
      return fake.fetch(input, init);
    };
    const flakyHost = await activate({ deployment: fake.deployment, fetchImpl: flaky });
    await flakyHost.call(REMOTE_SERVER_LOGIN_ROUTE, { token: "author-token" });
    reachable = false;
    expect(await upstreamProviderOf(flakyHost).getCanvas?.("canvas-linked")).toBeNull();
  });

  it("按 id 打开后重启仍然放行（持久化），换账号不再放行", async () => {
    const fake = linkFake();
    const documents = createFakeDocuments();
    const first = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, documents });
    await first.call(REMOTE_SERVER_LOGIN_ROUTE, { token: "author-token" });
    await upstreamProviderOf(first).getCanvas?.("canvas-linked");

    // 新实例（模拟重启）：不必再打开一次，resolve 仍然为这张画布返回链路。
    const restarted = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, documents });
    await restarted.call(REMOTE_SERVER_LOGIN_ROUTE, { token: "author-token" });
    expect(await upstreamProviderOf(restarted).resolve("canvas-linked")).not.toBeNull();

    // 换账号：待同步集合按会话（serverUrl + subject）隔离，别的账号不继承这份打开结论。
    const bob = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, documents });
    await bob.call(REMOTE_SERVER_LOGIN_ROUTE, { token: "viewer-token" });
    expect(await upstreamProviderOf(bob).resolve("canvas-linked")).toBeNull();
  });

  it("待同步集合写不进去时仍返回摘要（缓存是优化），只记一条诊断", async () => {
    const fake = linkFake();
    const documents = createFakeDocuments();
    // 会话能落盘，但待同步集合那一次写入失败：模拟文档存储故障。
    const flakyDocuments = {
      ...documents,
      batch: (operations: readonly ({ op: "set"; key: string; value: unknown } | { op: "delete"; key: string })[]) =>
        operations.some((operation) => operation.op === "set" && operation.key === "canvas-sync/pending")
          ? Promise.reject(new Error("disk full"))
          : documents.batch(operations)
    };
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, documents: flakyDocuments });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, { token: "author-token" });
    const provider = upstreamProviderOf(host);

    expect(await provider.getCanvas?.("canvas-linked")).toMatchObject({ id: "canvas-linked" });
    expect(host.logEvents.map((event) => event.event)).toContain("remote-canvas-link-persist-failed");
    // 没写进去就不假装可以同步：resolve 仍然回落到「本地画布」。
    expect(await provider.resolve("canvas-linked")).toBeNull();
    // 诊断事件同样不得含令牌。
    expect(JSON.stringify(host.logEvents)).not.toContain("session-");
  });
});

// ---------------------------------------------------------------------------
// 链接分享设置：读模式/revision 与按 revision 的乐观并发写。
//
// 这几条锁的是「服务端的授权结论与冲突语义被如实转达」：作者能改并拿到新 revision，
// 普通协作者能读但不可管理，过期 revision 得到一条可重读的提示；响应里没有令牌。
// 服务端尚未放开 everyone 模式时返回 invalid_argument——这里如实翻成「尚未开放」，
// 不在宿主伪装成功。
describe("remote-server 后端 · 链接分享设置", () => {
  function shareFake() {
    return createFakeServer({
      identities: {
        "author-token": "alice",
        "admin-token": "ops-admin",
        "viewer-token": "bob",
        "editor-token": "carol"
      },
      canvasIds: ["canvas-remote-1"],
      canvasAcl: {
        "canvas-remote-1": { owner: "alice", members: { bob: "viewer", carol: "editor" } }
      },
      canvasShare: { "canvas-remote-1": { mode: "restricted", revision: 2 } },
      adminSubjects: ["ops-admin"]
    });
  }

  async function signedIn(fake: ReturnType<typeof shareFake>, deviceToken: string) {
    return await activate({
      deployment: { serverUrl: fake.serverUrl, deviceToken, keyPrefix: "" },
      fetchImpl: fake.fetch
    });
  }

  it("作者读到模式与 revision，并知道自己是可管理的", async () => {
    const fake = shareFake();
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const read = await host.call(REMOTE_SERVER_CANVAS_SHARE_ROUTE, { canvasId: "canvas-remote-1" });
    // revision 是 ProtoJSON 的 int64 字符串：原样传，不折成 number。
    expect(read.body).toEqual({ ok: true, mode: "restricted", revision: "2", canManage: true });
  });

  it("普通协作者能读，但不可管理（canManage 来自服务端 allowed_actions）", async () => {
    const fake = shareFake();
    const host = await signedIn(fake, "viewer-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const read = await host.call(REMOTE_SERVER_CANVAS_SHARE_ROUTE, { canvasId: "canvas-remote-1" });
    expect(read.body).toEqual({ ok: true, mode: "restricted", revision: "2", canManage: false });
  });

  it("部署管理员能读，但改不了分享：canManage 只认作者", async () => {
    const fake = shareFake();
    const host = await signedIn(fake, "admin-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    // 管理员有 canvas.manage（能代管成员），但没有 canvas.share：分享设置仍只属于作者。
    const read = await host.call(REMOTE_SERVER_CANVAS_SHARE_ROUTE, { canvasId: "canvas-remote-1" });
    expect(read.body).toEqual({ ok: true, mode: "restricted", revision: "2", canManage: false });
    const updated = await host.call(REMOTE_SERVER_CANVAS_SHARE_UPDATE_ROUTE, {
      canvasId: "canvas-remote-1",
      mode: "everyone_view",
      expectedRevision: "2"
    });
    expect(updated.body).toEqual({ ok: false, error: "只有作者能修改分享设置" });
    expect(fake.canvasShares.get("canvas-remote-1")).toEqual({ mode: "restricted", revision: 2 });
  });

  it("未连接服务端时明确拒绝，且不发任何画布调用", async () => {
    const fake = shareFake();
    const host = await activate({
      deployment: { serverUrl: fake.serverUrl, deviceToken: "author-token", keyPrefix: "" },
      fetchImpl: fake.fetch
    });
    const read = await host.call(REMOTE_SERVER_CANVAS_SHARE_ROUTE, { canvasId: "canvas-remote-1" });
    expect(read.body).toEqual({ ok: false, error: "未连接服务端" });
    const update = await host.call(REMOTE_SERVER_CANVAS_SHARE_UPDATE_ROUTE, {
      canvasId: "canvas-remote-1",
      mode: "everyone_view",
      expectedRevision: "2"
    });
    expect(update.body).toEqual({ ok: false, error: "未连接服务端" });
    expect(fake.calls.filter((call) => call.path.includes("CanvasService"))).toHaveLength(0);
  });

  it("作者改分享：带当前 revision 成功，revision 递增并真正落库", async () => {
    const fake = shareFake();
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const updated = await host.call(REMOTE_SERVER_CANVAS_SHARE_UPDATE_ROUTE, {
      canvasId: "canvas-remote-1",
      mode: "everyone_view",
      expectedRevision: "2"
    });
    expect(updated.body).toEqual({ ok: true, mode: "everyone_view", revision: "3" });
    expect(fake.canvasShares.get("canvas-remote-1")).toEqual({ mode: "everyone_view", revision: 3 });

    // 再读一次：界面「重读后重试」拿到的就是这份新状态。
    const read = await host.call(REMOTE_SERVER_CANVAS_SHARE_ROUTE, { canvasId: "canvas-remote-1" });
    expect(read.body).toMatchObject({ ok: true, mode: "everyone_view", revision: "3", canManage: true });
  });

  it("期望 revision 过期时得到「请重读后重试」，且不覆盖别人的修改", async () => {
    const fake = shareFake();
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const conflicted = await host.call(REMOTE_SERVER_CANVAS_SHARE_UPDATE_ROUTE, {
      canvasId: "canvas-remote-1",
      mode: "everyone_edit",
      expectedRevision: "1"
    });
    expect(conflicted.body).toEqual({ ok: false, error: "分享设置已被其他人修改，请重读后重试" });
    expect(fake.canvasShares.get("canvas-remote-1")).toEqual({ mode: "restricted", revision: 2 });
  });

  it("普通协作者不能改分享：得到稳定短语，远端状态不变", async () => {
    const fake = shareFake();
    const host = await signedIn(fake, "editor-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const updated = await host.call(REMOTE_SERVER_CANVAS_SHARE_UPDATE_ROUTE, {
      canvasId: "canvas-remote-1",
      mode: "everyone_edit",
      expectedRevision: "2"
    });
    expect(updated.body).toEqual({ ok: false, error: "只有作者能修改分享设置" });
    expect(fake.canvasShares.get("canvas-remote-1")).toEqual({ mode: "restricted", revision: 2 });
  });

  it("浏览器可控输入在宿主就拒绝，不把非法值带到远端", async () => {
    const fake = shareFake();
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const callsBefore = fake.calls.filter((call) => call.path.endsWith("/UpdateCanvasShare")).length;

    for (const body of [
      {},
      { canvasId: "", mode: "restricted" },
      { canvasId: "canvas-remote-1", mode: "public" },
      { canvasId: "x".repeat(201), mode: "everyone_view" }
    ]) {
      const rejected = await host.call(REMOTE_SERVER_CANVAS_SHARE_UPDATE_ROUTE, body);
      expect(rejected).toMatchObject({ status: 400, body: { ok: false } });
    }
    const badRead = await host.call(REMOTE_SERVER_CANVAS_SHARE_ROUTE, { canvasId: "" });
    expect(badRead.status).toBe(400);

    expect(fake.calls.filter((call) => call.path.endsWith("/UpdateCanvasShare"))).toHaveLength(callsBefore);
  });

  it("服务端尚未放开 everyone 模式：invalid_argument 翻成可读短语，不伪装成功", async () => {
    const fake = shareFake();
    // 以「旧服务端」回答：这两个 RPC 都回 invalid_argument（协议里预留但部署尚未放开）。
    const strictFetch: typeof globalThis.fetch = async (input, init) => {
      const path = typeof input === "string" ? input : String(input);
      if (path.endsWith("/UpdateCanvasShare") || path.endsWith("/GetCanvasShare")) {
        return new Response(JSON.stringify({ code: "invalid_argument", message: "分享模式尚未开放" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
      return fake.fetch(input, init);
    };
    const host = await activate({
      deployment: { serverUrl: fake.serverUrl, deviceToken: "author-token", keyPrefix: "" },
      fetchImpl: strictFetch
    });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const read = await host.call(REMOTE_SERVER_CANVAS_SHARE_ROUTE, { canvasId: "canvas-remote-1" });
    expect(read.body).toEqual({ ok: false, error: "服务端返回了不支持的分享设置" });
    const updated = await host.call(REMOTE_SERVER_CANVAS_SHARE_UPDATE_ROUTE, {
      canvasId: "canvas-remote-1",
      mode: "everyone_view",
      expectedRevision: "2"
    });
    expect(updated.body).toEqual({ ok: false, error: "服务端尚未开放这个分享模式" });
    // 远端状态没变：没有把一次拒绝显示成生效。
    expect(fake.canvasShares.get("canvas-remote-1")).toEqual({ mode: "restricted", revision: 2 });
  });

  it("分享响应不含会话令牌", async () => {
    const fake = shareFake();
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const read = await host.call(REMOTE_SERVER_CANVAS_SHARE_ROUTE, { canvasId: "canvas-remote-1" });
    const updated = await host.call(REMOTE_SERVER_CANVAS_SHARE_UPDATE_ROUTE, {
      canvasId: "canvas-remote-1",
      mode: "everyone_edit",
      expectedRevision: "2"
    });
    expect(JSON.stringify(read.body)).not.toContain("session-");
    expect(JSON.stringify(updated.body)).not.toContain("session-");
  });
});

// ---------------------------------------------------------------------------
// 协作邀请：服务端签发链接，宿主只代发并原样透传 url。
//
// 这几条锁住四件事：创建 body 的线格式（int64 是字符串）、url 不经过客户端拼装、
// 授权失败/未配置对外地址的稳定短语，以及链接里的 token 不进日志、响应不含会话令牌。
describe("remote-server 后端 · 协作邀请", () => {
  type InviteCreateBody = {
    ok: boolean;
    error?: string;
    inviteId?: string;
    role?: "viewer" | "editor";
    expiresAt?: string;
    url?: string;
  };

  function inviteFake(options: {
    inviteUrl?: string;
    inviteUrlUnconfigured?: boolean;
    canvasInvites?: Record<string, FakeCanvasInviteConfig[]>;
  } = {}) {
    return createFakeServer({
      identities: { "author-token": "alice", "admin-token": "ops-admin", "viewer-token": "bob" },
      canvasAcl: {
        "canvas-remote-1": { owner: "alice", members: { bob: "viewer" } }
      },
      adminSubjects: ["ops-admin"],
      ...(options.inviteUrl !== undefined ? { inviteUrl: options.inviteUrl } : {}),
      ...(options.inviteUrlUnconfigured ? { inviteUrlUnconfigured: true } : {}),
      ...(options.canvasInvites ? { canvasInvites: options.canvasInvites } : {})
    });
  }

  async function signedIn(fake: ReturnType<typeof inviteFake>, deviceToken: string) {
    return await activate({
      deployment: { serverUrl: fake.serverUrl, deviceToken, keyPrefix: "" },
      fetchImpl: fake.fetch
    });
  }

  it("作者创建邀请：body 是 ProtoJSON（int64 字符串），url 原样透传且 token 不进日志", async () => {
    const fake = inviteFake({ inviteUrl: "https://canvas.example.com/invite/tok-secret" });
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const created = await host.call(REMOTE_SERVER_CANVAS_INVITE_CREATE_ROUTE, {
      canvasId: "canvas-remote-1",
      role: "editor",
      expiresInSeconds: 604_800
    });
    expect(created.status).toBe(200);
    const body = created.body as InviteCreateBody;
    expect(body.ok).toBe(true);
    expect(body.role).toBe("editor");
    // 服务端给什么 url 就透传什么：宿主不拼、不改写。
    expect(body.url).toBe("https://canvas.example.com/invite/tok-secret");
    expect(body.inviteId).toBeTruthy();
    expect(body.expiresAt).toBeTruthy();

    // 远端收到的线格式：CanvasRole 用枚举名，int64 用十进制字符串。
    const call = fake.calls.find((entry) => entry.path.endsWith("/CreateCanvasInvite"));
    expect(call?.body).toEqual({
      canvasId: "canvas-remote-1",
      role: "CANVAS_ROLE_EDITOR",
      expiresInSeconds: "604800"
    });
    // 邀请真的落库（列表能对账）。
    expect(fake.canvasInvites.get("canvas-remote-1")).toHaveLength(1);
    // 链接里带 token：日志不得留下它。
    expect(JSON.stringify(host.logEvents)).not.toContain("tok-secret");
    expect(JSON.stringify(created.body)).not.toContain("session-");
  });

  it("缺省有效期按 7 天发给服务端", async () => {
    const fake = inviteFake();
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    await host.call(REMOTE_SERVER_CANVAS_INVITE_CREATE_ROUTE, { canvasId: "canvas-remote-1", role: "viewer" });
    const call = fake.calls.find((entry) => entry.path.endsWith("/CreateCanvasInvite"));
    expect(call?.body).toEqual({
      canvasId: "canvas-remote-1",
      role: "CANVAS_ROLE_VIEWER",
      expiresInSeconds: "604800"
    });
  });

  it("读取邀请列表：角色 / 到期时间 / 接受次数 / 撤销状态", async () => {
    const fake = inviteFake({
      canvasInvites: {
        "canvas-remote-1": [
          {
            inviteId: "invite-a",
            role: "viewer",
            acceptedCount: 2,
            lastAcceptedAt: "2026-10-20T00:00:00Z"
          },
          { inviteId: "invite-b", role: "editor", revoked: true }
        ]
      }
    });
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const listed = await host.call(REMOTE_SERVER_CANVAS_INVITES_ROUTE, { canvasId: "canvas-remote-1" });
    expect(listed.body).toEqual({
      ok: true,
      canvasId: "canvas-remote-1",
      invites: [
        {
          inviteId: "invite-a",
          role: "viewer",
          createdBy: "alice",
          createdAt: "2026-10-18T03:00:00Z",
          expiresAt: "2026-10-25T03:00:00Z",
          acceptedCount: 2,
          lastAcceptedAt: "2026-10-20T00:00:00Z",
          revoked: false
        },
        {
          inviteId: "invite-b",
          role: "editor",
          createdBy: "alice",
          createdAt: "2026-10-18T03:00:00Z",
          expiresAt: "2026-10-25T03:00:00Z",
          acceptedCount: 0,
          lastAcceptedAt: "",
          revoked: true
        }
      ]
    });
  });

  it("撤销邀请：远端标记 revoked，再列出时状态一致", async () => {
    const fake = inviteFake();
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const created = await host.call(REMOTE_SERVER_CANVAS_INVITE_CREATE_ROUTE, {
      canvasId: "canvas-remote-1",
      role: "viewer"
    });
    const inviteId = (created.body as InviteCreateBody).inviteId!;

    const revoked = await host.call(REMOTE_SERVER_CANVAS_INVITE_REVOKE_ROUTE, {
      canvasId: "canvas-remote-1",
      inviteId
    });
    expect(revoked.body).toEqual({ ok: true });
    expect(fake.canvasInvites.get("canvas-remote-1")?.find((invite) => invite.inviteId === inviteId)?.revoked).toBe(true);

    const listed = await host.call(REMOTE_SERVER_CANVAS_INVITES_ROUTE, { canvasId: "canvas-remote-1" });
    const invites = (listed.body as { invites: Array<{ inviteId: string; revoked: boolean }> }).invites;
    expect(invites.find((invite) => invite.inviteId === inviteId)?.revoked).toBe(true);
  });

  it("部署管理员也能管理邀请（服务端的 canManage 结论，不是宿主自证）", async () => {
    const fake = inviteFake();
    const host = await signedIn(fake, "admin-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const created = await host.call(REMOTE_SERVER_CANVAS_INVITE_CREATE_ROUTE, {
      canvasId: "canvas-remote-1",
      role: "editor"
    });
    expect((created.body as InviteCreateBody).ok).toBe(true);
    const listed = await host.call(REMOTE_SERVER_CANVAS_INVITES_ROUTE, { canvasId: "canvas-remote-1" });
    expect((listed.body as { ok: boolean }).ok).toBe(true);
  });

  it("普通协作者管理邀请得到稳定短语，且远端状态不变", async () => {
    const fake = inviteFake();
    const host = await signedIn(fake, "viewer-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const created = await host.call(REMOTE_SERVER_CANVAS_INVITE_CREATE_ROUTE, {
      canvasId: "canvas-remote-1",
      role: "viewer"
    });
    expect(created.body).toEqual({ ok: false, error: "只有作者或部署管理员能管理协作邀请" });
    const listed = await host.call(REMOTE_SERVER_CANVAS_INVITES_ROUTE, { canvasId: "canvas-remote-1" });
    expect(listed.body).toEqual({ ok: false, error: "只有作者或部署管理员能管理协作邀请" });
    const revoked = await host.call(REMOTE_SERVER_CANVAS_INVITE_REVOKE_ROUTE, {
      canvasId: "canvas-remote-1",
      inviteId: "invite-a"
    });
    expect(revoked.body).toEqual({ ok: false, error: "只有作者或部署管理员能管理协作邀请" });
    expect(fake.canvasInvites.get("canvas-remote-1") ?? []).toHaveLength(0);
  });

  it("撤销不存在的邀请得到可读短语", async () => {
    const fake = inviteFake();
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const revoked = await host.call(REMOTE_SERVER_CANVAS_INVITE_REVOKE_ROUTE, {
      canvasId: "canvas-remote-1",
      inviteId: "invite-missing"
    });
    expect(revoked.body).toEqual({ ok: false, error: "邀请不存在或已被撤销" });
  });

  it("服务端未配置对外地址：failed_precondition 翻成可读短语，客户端不自己拼链接", async () => {
    const fake = inviteFake({ inviteUrlUnconfigured: true });
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});

    const created = await host.call(REMOTE_SERVER_CANVAS_INVITE_CREATE_ROUTE, {
      canvasId: "canvas-remote-1",
      role: "viewer"
    });
    expect(created.body).toEqual({ ok: false, error: "服务端未配置对外地址，无法生成邀请链接" });
    // 失败响应里不能出现任何“本地拼出来的”链接。
    expect(JSON.stringify(created.body)).not.toContain("http");
  });

  it("未连接服务端时明确拒绝，且不发任何画布调用", async () => {
    const fake = inviteFake();
    const host = await activate({
      deployment: { serverUrl: fake.serverUrl, deviceToken: "author-token", keyPrefix: "" },
      fetchImpl: fake.fetch
    });
    const listed = await host.call(REMOTE_SERVER_CANVAS_INVITES_ROUTE, { canvasId: "canvas-remote-1" });
    expect(listed.body).toEqual({ ok: false, error: "未连接服务端" });
    const created = await host.call(REMOTE_SERVER_CANVAS_INVITE_CREATE_ROUTE, {
      canvasId: "canvas-remote-1",
      role: "viewer"
    });
    expect(created.body).toEqual({ ok: false, error: "未连接服务端" });
    const revoked = await host.call(REMOTE_SERVER_CANVAS_INVITE_REVOKE_ROUTE, {
      canvasId: "canvas-remote-1",
      inviteId: "invite-a"
    });
    expect(revoked.body).toEqual({ ok: false, error: "未连接服务端" });
    expect(fake.calls.filter((call) => call.path.includes("CanvasService"))).toHaveLength(0);
  });

  it("浏览器可控输入在宿主就拒绝，不把非法值带到远端", async () => {
    const fake = inviteFake();
    const host = await signedIn(fake, "author-token");
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const callsBefore = fake.calls.filter((call) => call.path.includes("Invite")).length;

    for (const body of [
      {},
      { canvasId: "", role: "viewer" },
      { canvasId: "canvas-remote-1", role: "admin" },
      { canvasId: "canvas-remote-1", role: "viewer", expiresInSeconds: 12_345 },
      { canvasId: "x".repeat(201), role: "viewer" }
    ]) {
      const rejected = await host.call(REMOTE_SERVER_CANVAS_INVITE_CREATE_ROUTE, body);
      expect(rejected).toMatchObject({ status: 400, body: { ok: false } });
    }
    const badList = await host.call(REMOTE_SERVER_CANVAS_INVITES_ROUTE, { canvasId: "" });
    expect(badList.status).toBe(400);
    for (const body of [
      {},
      { canvasId: "canvas-remote-1" },
      { canvasId: "canvas-remote-1", inviteId: "   " }
    ]) {
      const rejected = await host.call(REMOTE_SERVER_CANVAS_INVITE_REVOKE_ROUTE, body);
      expect(rejected).toMatchObject({ status: 400, body: { ok: false } });
    }

    expect(fake.calls.filter((call) => call.path.includes("Invite"))).toHaveLength(callsBefore);
  });
});

describe("access()：进入画布时回答的内容权限", () => {
  it("作者可写、viewer 只读；远端看不见的画布返回 null（不猜）", async () => {
    const fake = createFakeServer({
      canvasIds: ["canvas-owned", "canvas-viewer"],
      canvasAcl: {
        "canvas-owned": { owner: "device-alice" },
        "canvas-viewer": { owner: "someone-else", members: { "device-alice": "viewer" } }
      }
    });
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const provider = upstreamProviderOf(host);
    // 服务端回填 allowed_actions；这里只做映射，不自己推判定。
    expect(await provider.access!("canvas-owned")).toEqual({ canRead: true, canWrite: true, canDelete: true });
    expect(await provider.access!("canvas-viewer")).toEqual({ canRead: true, canWrite: false, canDelete: false });
    // 看不见与不存在在服务端是同一结论（not_found）：扩展返回 null，由宿主按归属决定是否判只读。
    expect(await provider.access!("canvas-invisible")).toBeNull();
  });

  it("没有会话时返回 null：未知不等于只读", async () => {
    const fake = createFakeServer();
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    expect(await upstreamProviderOf(host).access!("canvas-remote-1")).toBeNull();
  });
});



describe("deleteCanvas()：删除属于远端的画布", () => {
  it("先问远端，成功后清掉目录缓存与待同步标记", async () => {
    const fake = createFakeServer({ canvasAcl: { "canvas-remote-1": { owner: "device-alice" } } });
    const documents = createFakeDocuments();
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch, documents });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const provider = upstreamProviderOf(host);
    // 显式启用一张本地画布：它的远端归属由待同步标记表达。
    await host.call(REMOTE_SERVER_SYNC_ENABLE_ROUTE, { canvasId: "canvas-local-1" });
    fake.remoteCanvasIds.push("canvas-local-1");
    await provider.listCanvases!();
    expect(JSON.stringify(await pendingDocument(documents))).not.toContain("canvas-local-1");

    expect(await provider.deleteCanvas!("canvas-remote-1")).toBe("deleted");
    expect(fake.remoteCanvasIds).not.toContain("canvas-remote-1");
    // 缓存同步清理：下一次解析不再把已删画布当远端画布。
    expect(await provider.resolve("canvas-remote-1")).toBeNull();
  });

  it("远端已不存在按删除幂等处理；非作者得到 forbidden", async () => {
    const fake = createFakeServer({
      canvasIds: ["canvas-owned", "canvas-other"],
      canvasAcl: {
        "canvas-owned": { owner: "device-alice" },
        "canvas-other": { owner: "someone-else" }
      }
    });
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const provider = upstreamProviderOf(host);
    await provider.listCanvases!();

    expect(await provider.deleteCanvas!("canvas-other")).toBe("forbidden");
    expect(fake.remoteCanvasIds).toContain("canvas-other");
    expect(await provider.deleteCanvas!("canvas-owned")).toBe("deleted");
    // 远端目录里已经不再有它：宿主应按本机删除语义继续，而不是假装远端删成功。
    expect(await provider.deleteCanvas!("canvas-owned")).toBe("skipped");
  });

  it("未登录时返回 skipped，纯本地删除语义不变", async () => {
    const fake = createFakeServer();
    const host = await activate({ deployment: fake.deployment, fetchImpl: fake.fetch });
    expect(await upstreamProviderOf(host).deleteCanvas!("canvas-remote-1")).toBe("skipped");
  });

  it("远端不可达时返回 unavailable，宿主据此中止删除", async () => {
    const fake = createFakeServer();
    let reachable = true;
    const flaky: typeof globalThis.fetch = async (input, init) => {
      if (!reachable) throw new TypeError("fetch failed");
      return fake.fetch(input, init);
    };
    const host = await activate({ deployment: fake.deployment, fetchImpl: flaky });
    await host.call(REMOTE_SERVER_LOGIN_ROUTE, {});
    const provider = upstreamProviderOf(host);
    await provider.listCanvases!();
    reachable = false;
    expect(await provider.deleteCanvas!("canvas-remote-1")).toBe("unavailable");
  });
});
