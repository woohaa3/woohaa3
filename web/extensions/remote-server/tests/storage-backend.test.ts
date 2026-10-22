/**
 * 服务端托管存储后端测试：注入 fake transport / fake fetch，**不打真实网络**。
 *
 * 锁住这几条对外行为：
 * - 会话与 remote-server **共用一份**（同一份会话来源，不自己登录、不自己缓存）；
 * - 三个 RPC 的映射：head / delete / presign，以及 put/get 走签名地址（PUT 绑定 Content-Type）；
 * - ProtoJSON 的 int64 两种形态（字符串与数字）都容错；
 * - 对象键前缀拼接（core 已带 namespace，后端只加自己那层）；
 * - 画布作用域键布局（`<canvasId>/[<keyPrefix>/]<key>`）与无作用域的旧布局；
 * - 配置门槛只有 `serverUrl`：缺地址时只记日志、不注册；缺凭证仍然注册（调用期会话报错）；
 * - 响应与日志里永远没有令牌或设备凭证。
 */
import { describe, expect, it } from "vitest";
import { StorageObjectNotFoundError, type StorageBackend } from "@woohaa3/contracts";
import { parseServerUrl } from "../src/shared.js";
import { resolveServerStorageConfig, type ServerStorageConfig } from "../src/backend/storage/config.js";
import {
  createServerStorageClient,
  parseProtoJsonInt,
  resolveOutboundUrl,
  resolveRpcBase,
  storageErrorText,
  type ServerStorageClient,
  type ServerStorageSessionSource
} from "../src/backend/storage/client.js";
import { createServerStorageBackend } from "../src/backend/storage/backend.js";
import {
  createMemorySessionStore,
  createRemoteSessionSource,
  parseSessionExpiry,
  type RemoteSessionSource
} from "../src/backend/session.js";
import { createRemoteServerExtension } from "../src/backend/index.js";

const CONFIG: ServerStorageConfig = {
  serverUrl: "https://canvas.example.com",
  keyPrefix: ""
};

/** 部署配置：存储后端只，不拿凭证（换会话由会话来源负责）。 */
const DEVICE_TOKEN = "device-token-secret";

/** 固定会话：等价于「用户已经登录过」，测试只关心传输层。 */
function fixedSession(token = "session-1"): ServerStorageSessionSource {
  return {
    async ensure() {
      return {
        ok: true as const,
        session: {
          serverUrl: CONFIG.serverUrl,
          token,
          subject: "device-actor",
          displayName: null,
          // 远在未来：这些用例不关心到期。
          expiresAt: Date.now() + 3_600_000
        }
      };
    },
    async invalidate() {
      // 静态来源不参与换发。
    }
  };
}

type Call = { url: string; method: string; authorization: string | null; body: unknown };

type FakeServerOptions = {
  /** 有效的设备凭证；不匹配则 Login 回 unauthenticated。 */
  deviceToken?: string;
  /** 对象表：key → { bytes, contentType }。 */
  objects?: Map<string, { bytes: Uint8Array; contentType?: string }>;
  /** 会话有效期（毫秒）。 */
  sessionTtlMs?: number;
  /** 让第 N 次（1 起）带会话的 StorageService 调用回 401。 */
  unauthenticatedAtCall?: number;
  /** 让 Login 直接失败（模拟坏凭证 / 网络错误）。 */
  loginDown?: boolean;
  /** 签名地址（缺省按服务端代理形态给站内路径）。 */
  signedUrlFor?: (key: string, method: string) => string;
  /** expiresAt 用数字而不是字符串（模拟非标准网关）。 */
  numericInt64?: boolean;
  /** head 的 size 用字符串（ProtoJSON 规范形态）。 */
  stringSize?: boolean;
  /** 服务端时钟（测试注入）；缺省用真实时间。 */
  now?: () => number;
};

/**
 * fake 服务端：照 `woohaa.storage.v1` 的 Connect JSON 线格式应答。
 *
 * 被测对象是本扩展的协议解释与会话收敛，不是服务端实现；真实服务端由 Go 侧测试覆盖，
 * 两边只在「Connect JSON 形状 + 签名地址语义」这一层对齐。
 */
function fakeServer(options: FakeServerOptions = {}) {
  const objects = options.objects ?? new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const calls: Call[] = [];
  const sessions = new Set<string>();
  const deviceToken = options.deviceToken ?? "device-token-secret";
  const now = options.now ?? (() => Date.now());
  let issued = 0;
  let storageCalls = 0;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const int64 = (value: number) => (options.numericInt64 ? value : String(value));

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    const parsed = new URL(url);
    const requestHeaders = new Headers(init?.headers as HeadersInit | undefined);
    const authorization = requestHeaders.get("authorization");
    let body: unknown = null;
    try {
      body = init?.body === undefined || typeof init.body !== "string" ? null : JSON.parse(init.body);
    } catch {
      body = null;
    }
    calls.push({ url: parsed.toString(), method: init?.method ?? "GET", authorization, body });

    // 签名地址：走 `authorization === null` 的路径（签名本身就是凭证）。
    if (parsed.pathname.startsWith("/storage/objects/")) {
      // 服务端不转义键（字符集本身是路径安全的），fake 保持一致以免测出「假想的两端差异」。
      const key = parsed.pathname.slice("/storage/objects/".length);
      const method = parsed.searchParams.get("m") ?? "GET";
      const record = objects.get(key);
      const expected = parsed.searchParams.get("ct");
      if (method === "PUT") {
        if (expected && requestHeaders.get("content-type") !== expected) return new Response("forbidden", { status: 403 });
        objects.set(key, { bytes: new Uint8Array(init?.body as Uint8Array<ArrayBuffer>), contentType: expected ?? "application/octet-stream" });
        return new Response(null, { status: 200 });
      }
      if (!record) return new Response("not found", { status: 404 });
      const contentType = record.contentType ?? "application/octet-stream";
      const range = requestHeaders.get("range");
      if (range) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        const start = match ? Number(match[1]) : 0;
        const end = match ? Number(match[2]) : record.bytes.byteLength - 1;
        const slice = record.bytes.slice(start, end + 1);
        return new Response(slice as unknown as BodyInit, {
          status: 206,
          headers: { "Content-Type": contentType, "Content-Range": `bytes ${start}-${end}/${record.bytes.byteLength}` }
        });
      }
      return new Response(record.bytes as unknown as BodyInit, { status: 200, headers: { "Content-Type": contentType } });
    }

    if (options.loginDown) throw new TypeError("fetch failed");

    const procedure = parsed.pathname;
    if (procedure === "/woohaa.identity.v1alpha1.IdentityService/Login") {
      const token = (body as { token?: unknown } | null)?.token;
      if (token !== deviceToken) return json({ code: "unauthenticated", message: "bad credential" }, 401);
      issued += 1;
      const session = `session-${issued}`;
      sessions.add(session);
      const expiresAt = new Date(now() + (options.sessionTtlMs ?? 3_600_000)).toISOString();
      return json({ sessionToken: session, subjectId: "device-actor", expiresAt });
    }
    if (procedure === "/woohaa.identity.v1alpha1.IdentityService/WhoAmI") {
      if (!authorization) return json({ code: "unauthenticated", message: "missing session" }, 401);
      const session = authorization.replace(/^Bearer /, "");
      if (!sessions.has(session)) return json({ code: "unauthenticated", message: "expired session" }, 401);
      return json({ subjectId: "device-actor", expiresAt: new Date(now() + (options.sessionTtlMs ?? 3_600_000)).toISOString() });
    }

    if (!authorization) return json({ code: "unauthenticated", message: "missing session" }, 401);
    const session = authorization.replace(/^Bearer /, "");
    if (!sessions.has(session)) return json({ code: "unauthenticated", message: "expired session" }, 401);

    storageCalls += 1;
    if (options.unauthenticatedAtCall !== undefined && storageCalls === options.unauthenticatedAtCall) {
      return json({ code: "unauthenticated", message: "session rotated" }, 401);
    }

    const method = procedure.split("/").pop();
    if (method === "HeadObject") {
      const key = String((body as { key?: unknown } | null)?.key ?? "");
      const record = objects.get(key);
      if (!record) return json({ info: { exists: false } });
      return json({
        info: {
          exists: true,
          size: options.stringSize ? String(record.bytes.byteLength) : record.bytes.byteLength,
          contentType: record.contentType ?? ""
        }
      });
    }
    if (method === "DeleteObject") {
      const key = String((body as { key?: unknown } | null)?.key ?? "");
      objects.delete(key);
      return json({});
    }
    if (method === "CreateSignedUrl") {
      const parsedBody = (body ?? {}) as { key?: unknown; method?: unknown; contentType?: unknown; expiresSeconds?: unknown };
      const key = String(parsedBody.key ?? "");
      const signedMethod = String(parsedBody.method ?? "SIGNED_URL_METHOD_GET");
      const expiresAt = Math.floor(now() / 1000) + Number(parsedBody.expiresSeconds ?? 600);
      const url = options.signedUrlFor
        ? options.signedUrlFor(key, signedMethod)
        : `/storage/objects/${key}?m=${signedMethod === "SIGNED_URL_METHOD_PUT" ? "PUT" : "GET"}&exp=${expiresAt}${
            parsedBody.contentType ? `&ct=${encodeURIComponent(String(parsedBody.contentType))}` : ""
          }&sig=deadbeef`;
      return json({ url, expiresAt: int64(expiresAt) });
    }
    return new Response("unknown procedure", { status: 404 });
  };

  /**
   * 把 fake 服务端当传输层，接上**真实**的会话来源（用部署凭证走它的 Login 换会话）。
   *
   * 这样测的是「存储后端 + 共用会话」的组合，而不是一个假的会话抽象：401 重换、到期提前失效
   * 这些行为都在真实实现里跑。
   */
  const sessionSource = (): RemoteSessionSource =>
    createRemoteSessionSource({
      store: createMemorySessionStore(),
      configuredServerUrl: () => CONFIG.serverUrl,
      now,
      loginWithDeviceToken: async (serverUrl) => {
        const response = await fetchImpl(`${serverUrl}/woohaa.identity.v1alpha1.IdentityService/Login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: DEVICE_TOKEN })
        });
        if (!response.ok) return { ok: false as const, code: "unauthenticated" };
        const payload = (await response.json()) as { sessionToken: string; subjectId: string; expiresAt: string };
        return {
          ok: true as const,
          session: {
            serverUrl,
            token: payload.sessionToken,
            subject: payload.subjectId,
            displayName: null,
            expiresAt: Date.parse(payload.expiresAt)
          }
        };
      }
    });

  return { fetchImpl, calls, objects, sessions, sessionSource };
}

function backendOf(
  server: ReturnType<typeof fakeServer>,
  config: ServerStorageConfig = CONFIG,
  session: ServerStorageSessionSource = server.sessionSource()
): FullBackend {
  return createServerStorageBackend({
    config,
    session,
    fetchImpl: server.fetchImpl,
    hostOrigin: "http://127.0.0.1:5180"
  }) as FullBackend;
}

/**
 * 这个后端把 `delete` / `openRead` / `presign` 都实现了（可选方法是契约里的「能力」，
 * 不是这里的不确定性），测试里直接调用、不必到处写 `?.` 与 `!`。
 */
type FullBackend = StorageBackend &
  Required<Pick<StorageBackend, "delete" | "openRead" | "presign">>;

/**
 * 构造一个 fake 传输层。
 *
 * `call` 是泛型的（真实实现也一样），所以这里显式声明成泛型函数：让被测后端按自己的
 * 期望形状取响应，同时测试不必为每个方法的返回类型写一遍断言。
 */
function fakeClient(
  call: (method: string, body: unknown) => unknown | Promise<unknown>,
  fetchSigned?: (url: string, init?: RequestInit) => Promise<Response>
): ServerStorageClient {
  return {
    call: async <T>(method: string, body: unknown): Promise<T> => (await call(method, body)) as T,
    fetchSigned: fetchSigned ?? (async () => new Response(null))
  };
}

describe("serverUrl 有界校验（与 remote-server 共用同一套规则）", () => {
  it("接受 http/https 绝对地址与同源站内路径，并去掉尾部斜杠", () => {
    expect(parseServerUrl("https://canvas.example.com/")).toEqual({ ok: true, value: "https://canvas.example.com" });
    expect(parseServerUrl("http://127.0.0.1:5180/remote")).toEqual({ ok: true, value: "http://127.0.0.1:5180/remote" });
    expect(parseServerUrl("/remote/")).toEqual({ ok: true, value: "/remote" });
  });

  it("拒绝非字符串、空串、过长与协议相对地址", () => {
    expect(parseServerUrl(123).ok).toBe(false);
    expect(parseServerUrl("   ").ok).toBe(false);
    expect(parseServerUrl(`https://x.test/${"a".repeat(2048)}`).ok).toBe(false);
    expect(parseServerUrl("//evil.example")).toEqual({ ok: false, message: "服务端地址不能是协议相对地址" });
  });

  it("拒绝内嵌凭据、查询串、片段与其它协议", () => {
    expect(parseServerUrl("https://user:pass@canvas.example.com").ok).toBe(false);
    expect(parseServerUrl("https://canvas.example.com/?x=1").ok).toBe(false);
    expect(parseServerUrl("https://canvas.example.com/#frag").ok).toBe(false);
    expect(parseServerUrl("ftp://canvas.example.com").ok).toBe(false);
    expect(parseServerUrl("canvas.example.com").ok).toBe(false);
  });
});

describe("存储配置归一化（复用 remote-server 的部署配置）", () => {
  it("齐备时归一化 keyPrefix 的两端斜杠", () => {
    const resolved = resolveServerStorageConfig(
      { serverUrl: "https://canvas.example.com", deviceToken: "token", keyPrefix: "" },
      { keyPrefix: "/tenant-a/" }
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // `deviceToken` 刻意**不**进存储配置：合并进 remote-server 后凭据归共享会话所有
    // （`sessionSource` 统一换发），存储侧只拿地址与前缀，免得两处各持一份令牌。
    expect(resolved.config).toEqual({
      serverUrl: "https://canvas.example.com",
      keyPrefix: "tenant-a"
    });
    expect(JSON.stringify(resolved.config)).not.toContain("token");
  });

  it("缺 serverUrl 时返回 missing（不抛错，由调用方跳过注册）", () => {
    const resolved = resolveServerStorageConfig({ serverUrl: null, deviceToken: null, keyPrefix: "" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.missing).toEqual(["serverUrl"]);
  });

  it("deviceToken 不是门槛：缺凭证仍然 ok，且返回值里不带任何凭证值", () => {
    const resolved = resolveServerStorageConfig({
      serverUrl: "https://canvas.example.com",
      deviceToken: null,
      keyPrefix: ""
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config).toEqual({ serverUrl: "https://canvas.example.com", keyPrefix: "" });
    expect(JSON.stringify(resolved)).not.toContain("device-token-secret");
  });
});

describe("站点扩展装配（激活时注册存储后端）", () => {
  /** 最小宿主替身：只实现本扩展用到的面。 */
  function fakeHost(options: { registerStorage?: boolean }) {
    const registered: StorageBackend[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const host = {
      extensionId: "remote-server",
      host: "application",
      config: { values: () => ({}), configVersion: () => 1, secretRefs: () => [], desiredEnabled: () => true },
      services: {},
      work: { admit: () => ({ ok: false, reason: "not-ready" }), resume: () => null, activeWorkCount: () => 0 },
      logger: (event: Record<string, unknown>) => logs.push(event),
      registerCapability: () => undefined,
      registerHandler: () => undefined,
      registerRawHttpHandler: () => undefined,
      registerResource: () => undefined,
      ...(options.registerStorage === false
        ? {}
        : { registerStorage: (backend: StorageBackend) => registered.push(backend) })
    };
    return { host: host as never, registered, logs };
  }

  it("缺 serverUrl 时只记日志、不注册后端，且日志里没有凭证值", () => {
    const fake = fakeHost({});
    createRemoteServerExtension({
      deployment: () => ({ serverUrl: null, deviceToken: null, keyPrefix: "" })
    }).activate(fake.host);
    expect(fake.registered).toEqual([]);
    expect(fake.logs).toContainEqual({ event: "server-storage-unconfigured", missing: ["serverUrl"] });
    expect(JSON.stringify(fake.logs)).not.toContain("device-token-secret");
  });

  it("配置齐备时注册 backendId=server（带 presign，能当主存储或 expose）", () => {
    const fake = fakeHost({});
    createRemoteServerExtension({
      deployment: () => ({ serverUrl: "https://canvas.example.com", deviceToken: "device-token-secret", keyPrefix: "tenant-a" })
    }).activate(fake.host);

    expect(fake.registered.map((backend) => backend.backendId)).toEqual(["server"]);
    expect(fake.registered[0]?.label).toBe("服务端托管存储");
    expect(typeof fake.registered[0]?.presign).toBe("function");
    expect(fake.logs).toContainEqual({
      event: "server-storage-activated",
      backendId: "server",
      credential: "device-token"
    });
    expect(JSON.stringify(fake.logs)).not.toContain("device-token-secret");
  });

  it("只配了 serverUrl（没有 deviceToken）时仍注册；日志只记 credential=none，不记值", () => {
    const fake = fakeHost({});
    createRemoteServerExtension({
      deployment: () => ({ serverUrl: "https://canvas.example.com", deviceToken: null, keyPrefix: "" })
    }).activate(fake.host);

    expect(fake.registered.map((backend) => backend.backendId)).toEqual(["server"]);
    expect(fake.logs).toContainEqual({
      event: "server-storage-activated",
      backendId: "server",
      credential: "none"
    });
    expect(fake.logs.some((entry) => entry.event === "server-storage-unconfigured")).toBe(false);
    expect(JSON.stringify(fake.logs)).not.toContain("device-token-secret");
  });

  it("宿主没有存储扩展点时记日志跳过，不抛错（纯本地宿主本来就没有这个后端）", () => {
    const fake = fakeHost({ registerStorage: false });
    expect(() =>
      createRemoteServerExtension({
        deployment: () => ({ serverUrl: "https://canvas.example.com", deviceToken: "t", keyPrefix: "" })
      }).activate(fake.host)
    ).not.toThrow();
    expect(fake.registered).toEqual([]);
    expect(fake.logs).toContainEqual({ event: "server-storage-unavailable", reason: "宿主没有提供存储扩展点" });
  });
});

describe("会话（与 remote-server 共用一份）", () => {
  it("用部署凭证登录一次并复用缓存的会话", async () => {
    const server = fakeServer();
    const storage = backendOf(server);

    await storage.delete("media/a.png");
    await storage.delete("media/b.png");

    const logins = server.calls.filter((call) => call.url.includes("IdentityService/Login"));
    expect(logins).toHaveLength(1);
    expect(logins[0]?.body).toEqual({ token: "device-token-secret" });
    // 会话只经 Authorization 头走，不进 URL（令牌进 URL 会落访问日志与代理日志）。
    for (const call of server.calls) expect(call.url).not.toContain("device-token-secret");
    expect(server.calls.filter((call) => call.url.includes("DeleteObject")).every((call) => call.authorization === "Bearer session-1")).toBe(true);
  });

  it("登录失败时抛稳定短语，且错误信息不含凭证", async () => {
    const server = fakeServer({ deviceToken: "other-token" });
    const storage = backendOf(server);

    const error = await storage.delete("media/a.png").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(storageErrorText("unauthenticated"));
    expect(String((error as Error).message)).not.toContain("device-token-secret");
    expect(JSON.stringify(error)).not.toContain("device-token-secret");
  });

  it("网络不可达时抛「无法连接」而不是透传底层异常", async () => {
    const server = fakeServer({ loginDown: true });
    const storage = backendOf(server);

    await expect(storage.delete("media/a.png")).rejects.toThrow("无法连接服务端存储");
  });

  it("会话过期后重新换一次（不等到 401）", async () => {
    let now = 1_000_000;
    const server = fakeServer({ sessionTtlMs: 60_000, now: () => now });
    const session = createRemoteSessionSource({
      store: createMemorySessionStore(),
      configuredServerUrl: () => CONFIG.serverUrl,
      now: () => now,
      loginWithDeviceToken: async (serverUrl) => {
        const response = await server.fetchImpl(`${serverUrl}/woohaa.identity.v1alpha1.IdentityService/Login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: DEVICE_TOKEN })
        });
        if (!response.ok) return { ok: false as const, code: "unauthenticated" };
        const payload = (await response.json()) as { sessionToken: string; subjectId: string; expiresAt: string };
        return {
          ok: true as const,
          session: {
            serverUrl,
            token: payload.sessionToken,
            subject: payload.subjectId,
            displayName: null,
            expiresAt: Date.parse(payload.expiresAt)
          }
        };
      }
    });
    const storage = backendOf(server, CONFIG, session);

    await storage.delete("media/a.png");
    const loginCount = () => server.calls.filter((call) => call.url.includes("IdentityService/Login")).length;
    expect(loginCount()).toBe(1);

    // 提前 30 秒失效：59 秒后（TTL 60 秒）已经不该再用旧会话，且不需要先吃一个 401。
    now += 59_000;
    await storage.delete("media/b.png");
    expect(loginCount()).toBe(2);
    const deletes = server.calls.filter((call) => call.url.includes("DeleteObject"));
    expect(deletes.map((call) => call.authorization)).toEqual(["Bearer session-1", "Bearer session-2"]);
  });

  it("收到 401 时作废该令牌、重换会话并重试一次", async () => {
    // 第 1 次带会话的调用回 401（模拟服务端轮换/撤销会话），之后正常。
    const server = fakeServer({ unauthenticatedAtCall: 1 });
    const storage = backendOf(server);

    await expect(storage.delete("media/a.png")).resolves.toBeUndefined();

    const logins = server.calls.filter((call) => call.url.includes("IdentityService/Login"));
    expect(logins).toHaveLength(2);
    const deletes = server.calls.filter((call) => call.url.includes("DeleteObject"));
    expect(deletes.map((call) => call.authorization)).toEqual(["Bearer session-1", "Bearer session-2"]);
  });

  it("重试后仍 401 时抛稳定短语，不无限重试", async () => {
    const client = createServerStorageClient({
      config: CONFIG,
      session: fixedSession("session-x"),
      // 所有带会话的调用都回 401：会话不被接受（服务端撤销/时钟偏差）。
      fetchImpl: async (_input, init) => {
        if (!new Headers(init?.headers as HeadersInit).get("authorization")) throw new Error("缺少 Authorization 头");
        return new Response(JSON.stringify({ code: "unauthenticated", message: "nope" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      },
      hostOrigin: "http://127.0.0.1:5180"
    });

    await expect(client.call("DeleteObject", { key: "media/a.png" })).rejects.toThrow(
      "服务端存储认证失败：设备凭证或会话已失效"
    );
  });

  it("没有任何可用会话时直接给稳定短语，不发一个空登录", async () => {
    const calls: string[] = [];
    const storage = createServerStorageBackend({
      config: CONFIG,
      session: { ensure: async () => ({ ok: false, code: "unconfigured" }), invalidate: async () => undefined },
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response("{}");
      }
    }) as FullBackend;
    // 「没有可用身份」说的是配置状态，不该被冒充成「令牌失效」——那会把人引向换令牌。
    await expect(storage.delete("media/a.png")).rejects.toThrow("服务端存储未接入");
    expect(calls).toEqual([]);
  });
});

describe("head", () => {
  it("exists=false 返回 null（不是抛 not-found）", async () => {
    const server = fakeServer();
    expect(await backendOf(server).head("media/missing.png")).toBeNull();
    expect(server.calls.some((call) => call.url.includes("HeadObject"))).toBe(true);
  });

  it("读 size 与 contentType（size 为 ProtoJSON 字符串形态）", async () => {
    const objects = new Map([["media/a.png", { bytes: Uint8Array.of(1, 2, 3, 4), contentType: "image/png" }]]);
    const server = fakeServer({ objects, stringSize: true });
    expect(await backendOf(server).head("media/a.png")).toEqual({ size: 4, contentType: "image/png" });
  });

  it("size 为数字形态同样能读", async () => {
    const objects = new Map([["media/a.png", { bytes: Uint8Array.of(1, 2), contentType: "image/png" }]]);
    const server = fakeServer({ objects, stringSize: false });
    expect(await backendOf(server).head("media/a.png")).toEqual({ size: 2, contentType: "image/png" });
  });

  it("ProtoJSON 省略零值：空对象的 size 缺字段按 0 解释", async () => {
    const backend = createServerStorageBackend({
      config: CONFIG,
      session: fixedSession(),
      client: fakeClient(async (method) => (method === "HeadObject" ? { info: { exists: true, contentType: "" } } : {}))
    });
    // 空对象的 `contentType` 同样被省略：两者都不该让对象变成「读不出来」。
    expect(await backend.head("media/empty.bin")).toEqual({ size: 0 });
  });

  it("size 不可解析时抛错而不是返回假大小", async () => {
    const backend = createServerStorageBackend({
      config: CONFIG,
      session: fixedSession(),
      client: fakeClient(async (method) =>
        method === "HeadObject" ? { info: { exists: true, size: "not-a-number" } } : {})
    });
    await expect(backend.head("media/bad.png")).rejects.toThrow(/无法读取服务端对象大小/);
  });
});

describe("put / get / openRead", () => {
  it("put 先签 PUT 地址再 PUT，签名与写入使用同一个 Content-Type", async () => {
    const server = fakeServer();
    await backendOf(server).put("media/shot.png", Uint8Array.of(9, 8, 7), "image/png");

    const signed = server.calls.find((call) => call.url.includes("CreateSignedUrl"));
    expect((signed?.body as { method?: unknown } | null)?.method).toBe("SIGNED_URL_METHOD_PUT");
    expect((signed?.body as { contentType?: unknown } | null)?.contentType).toBe("image/png");
    // 字节本身不进一元 RPC：PUT 只在签名地址上出现。
    const put = server.calls.find((call) => call.method === "PUT");
    expect(put?.url).toContain("/storage/objects/media/shot.png");
    expect(server.objects.get("media/shot.png")?.contentType).toBe("image/png");
    expect(Array.from(server.objects.get("media/shot.png")?.bytes ?? [])).toEqual([9, 8, 7]);
  });

  it("get 取签名地址后 fetch，返回字节与 content type", async () => {
    const objects = new Map([["media/a.png", { bytes: Uint8Array.of(4, 5, 6), contentType: "image/png" }]]);
    const server = fakeServer({ objects });

    const object = await backendOf(server).get("media/a.png");
    expect(Array.from(object.bytes)).toEqual([4, 5, 6]);
    expect(object.contentType).toBe("image/png");
  });

  it("get 遇到签名地址 404 时抛 StorageObjectNotFoundError（跨 bundle 认 code/name/key）", async () => {
    const server = fakeServer();
    const storage = backendOf(server);

    await expect(storage.get("media/missing.png")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    try {
      await storage.get("media/missing.png");
    } catch (error) {
      const notFound = error as StorageObjectNotFoundError;
      expect(notFound.code).toBe("STORAGE_OBJECT_NOT_FOUND");
      expect(notFound.name).toBe("StorageObjectNotFoundError");
      expect(notFound.key).toBe("media/missing.png");
    }
  });

  it("openRead 带 Range 取片段，首段不等完整对象", async () => {
    const objects = new Map([["media/video.mp4", { bytes: Uint8Array.from({ length: 32 }, (_v, index) => index), contentType: "video/mp4" }]]);
    const server = fakeServer({ objects });

    const stream = await backendOf(server).openRead("media/video.mp4", { start: 10, end: 12 });
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.bytes) chunks.push(chunk);
    expect(Array.from(Buffer.concat(chunks))).toEqual([10, 11, 12]);

    const signedRead = server.calls.find((call) => call.url.startsWith("https://canvas.example.com/storage/objects/"));
    expect(signedRead?.url).toContain("m=GET");
  });

  it("openRead 的 cancel 会中止底层请求", async () => {
    let aborted = false;
    const client = fakeClient(
      async () => ({ url: "/storage/objects/media%2Fvideo.mp4?m=GET&sig=x", expiresAt: null }),
      async (_url, init) => {
        const signal = init?.signal;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(1));
            signal?.addEventListener("abort", () => {
              aborted = true;
              controller.error(new Error("aborted"));
            });
          }
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "video/mp4" } });
      }
    );
    const backend = createServerStorageBackend({ config: CONFIG, session: fixedSession(), client });
    const stream = await (backend as FullBackend).openRead("media/video.mp4", { start: 0, end: 1 });
    stream.cancel();
    expect(aborted).toBe(true);
  });
});

describe("presign / delete", () => {
  it("presign 回签名地址，并接受 expiresSeconds", async () => {
    const server = fakeServer();
    const url = await backendOf(server).presign("media/a.png", { expiresSeconds: 60 });

    const signed = server.calls.find((call) => call.url.includes("CreateSignedUrl"));
    expect((signed?.body as { method?: unknown } | null)?.method).toBe("SIGNED_URL_METHOD_GET");
    expect((signed?.body as { expiresSeconds?: unknown } | null)?.expiresSeconds).toBe(60);
    expect(url).toContain("/storage/objects/media/a.png");
    expect(url).toContain("m=GET");
  });

  it("presign 缺省按服务端默认值（expiresSeconds=0）", async () => {
    const server = fakeServer();
    await backendOf(server).presign("media/a.png");
    const signed = server.calls.find((call) => call.url.includes("CreateSignedUrl"));
    expect((signed?.body as { expiresSeconds?: unknown } | null)?.expiresSeconds).toBe(0);
  });

  it("delete 幂等：对象不存在时服务端仍成功，后端不报错", async () => {
    const server = fakeServer();
    const storage = backendOf(server);
    await expect(storage.delete("media/missing.png")).resolves.toBeUndefined();
    await expect(storage.delete("media/missing.png")).resolves.toBeUndefined();
  });
});

describe("keyPrefix 与 64 位整型", () => {
  it("keyPrefix 拼在 core 传入的 key 前面（core 已带 namespace）", async () => {
    const server = fakeServer();
    const storage = backendOf(server, { ...CONFIG, keyPrefix: "tenant-a" });

    await storage.delete("media/a.png");
    await storage.presign("media/b.png");

    const deleted = server.calls.find((call) => call.url.includes("DeleteObject"));
    expect((deleted?.body as { key?: unknown } | null)?.key).toBe("tenant-a/media/a.png");
    const signed = server.calls.find((call) => call.url.includes("CreateSignedUrl"));
    expect((signed?.body as { key?: unknown } | null)?.key).toBe("tenant-a/media/b.png");
  });

  it("ProtoJSON 的 int64 两种形态都能解析，垃圾值返回 null", () => {
    expect(parseProtoJsonInt("42")).toBe(42);
    expect(parseProtoJsonInt(42)).toBe(42);
    expect(parseProtoJsonInt("0")).toBe(0);
    expect(parseProtoJsonInt("")).toBeNull();
    expect(parseProtoJsonInt("12.5")).toBeNull();
    expect(parseProtoJsonInt("abc")).toBeNull();
    expect(parseProtoJsonInt(null)).toBeNull();
    expect(parseProtoJsonInt(Number.NaN)).toBeNull();
  });

  it("expiresAt 字符串形态不破坏 presign（签出的地址原样返回）", async () => {
    const server = fakeServer({ numericInt64: false });
    await expect(backendOf(server).presign("media/a.png")).resolves.toContain("sig=deadbeef");
    const server2 = fakeServer({ numericInt64: true });
    await expect(backendOf(server2).presign("media/a.png")).resolves.toContain("sig=deadbeef");
  });

  it("会话到期时刻容错 RFC3339 / Unix 秒 / 无法解析的兜底", () => {
    const base = 1_700_000_000_000;
    expect(parseSessionExpiry("2026-10-19T00:00:00Z", base)).toBe(Date.parse("2026-10-19T00:00:00Z"));
    expect(parseSessionExpiry("1700000000", base)).toBe(1_700_000_000_000);
    expect(parseSessionExpiry("1700000000000", 0)).toBe(1_700_000_000_000);
    expect(parseSessionExpiry("nonsense", base)).toBe(base + 3_600_000);
    expect(parseSessionExpiry(null, base)).toBe(base + 3_600_000);
  });
});

describe("画布作用域键布局（服务端 ACL 依赖首段是 canvasId）", () => {
  const SCOPE = { canvasId: "canvas-1" };

  it("带 scope 时键为 <canvasId>/<core 传入的 key>，且 get/put 落在同一布局", async () => {
    const server = fakeServer();
    const storage = backendOf(server);

    await storage.put("media/a.png", Uint8Array.of(1, 2), "image/png", SCOPE);
    expect(server.objects.has("canvas-1/media/a.png")).toBe(true);
    expect(server.objects.has("media/a.png")).toBe(false);

    const object = await storage.get("media/a.png", SCOPE);
    expect(Array.from(object.bytes)).toEqual([1, 2]);
    const signed = server.calls.filter((call) => call.url.includes("CreateSignedUrl"));
    expect(signed.every((call) => (call.body as { key?: unknown } | null)?.key === "canvas-1/media/a.png")).toBe(true);
  });

  it("带 scope 且配了 keyPrefix 时键为 <canvasId>/<keyPrefix>/<key>（canvasId 必须在首段）", async () => {
    const server = fakeServer();
    const storage = backendOf(server, { ...CONFIG, keyPrefix: "tenant-a" });

    await storage.delete("media/a.png", SCOPE);
    await storage.presign("media/b.png", undefined, SCOPE);

    const deleted = server.calls.find((call) => call.url.includes("DeleteObject"));
    expect((deleted?.body as { key?: unknown } | null)?.key).toBe("canvas-1/tenant-a/media/a.png");
    const signed = server.calls.find((call) => call.url.includes("CreateSignedUrl"));
    expect((signed?.body as { key?: unknown } | null)?.key).toBe("canvas-1/tenant-a/media/b.png");
  });

  it("head / openRead 带 scope 时读画布键", async () => {
    const objects = new Map([
      ["canvas-1/media/video.mp4", { bytes: Uint8Array.from({ length: 8 }, (_v, index) => index), contentType: "video/mp4" }]
    ]);
    const server = fakeServer({ objects });
    const storage = backendOf(server);

    expect(await storage.head("media/video.mp4", SCOPE)).toEqual({ size: 8, contentType: "video/mp4" });
    const stream = await storage.openRead("media/video.mp4", { start: 2, end: 3 }, SCOPE);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.bytes) chunks.push(chunk);
    expect(Array.from(Buffer.concat(chunks))).toEqual([2, 3]);
  });

  it("无 scope 时保持旧布局（<keyPrefix>/<key>，兼容已存对象）", async () => {
    const server = fakeServer();
    const storage = backendOf(server, { ...CONFIG, keyPrefix: "tenant-a" });

    await storage.put("media/a.png", Uint8Array.of(1), "image/png");
    expect(server.objects.has("tenant-a/media/a.png")).toBe(true);
    expect(server.objects.has("canvas-1/tenant-a/media/a.png")).toBe(false);
  });
});

describe("地址派生", () => {
  it("绝对基址取 origin + pathname；站内路径保持路径形态", () => {
    expect(resolveRpcBase("https://canvas.example.com/")).toBe("https://canvas.example.com");
    expect(resolveRpcBase("https://canvas.example.com/remote")).toBe("https://canvas.example.com/remote");
    expect(resolveRpcBase("/remote")).toBe("/remote");
  });

  it("签名地址是相对路径时补 origin，绝对地址原样保留", () => {
    expect(resolveOutboundUrl("/storage/objects/a?m=GET", "https://canvas.example.com", "http://127.0.0.1:5180")).toBe(
      "https://canvas.example.com/storage/objects/a?m=GET"
    );
    // 服务端签的是相对它自己挂载根的路径；反代带前缀时字节入口也在同一前缀下。
    expect(resolveOutboundUrl("/storage/objects/a?m=GET", "/remote", "http://127.0.0.1:5180")).toBe(
      "http://127.0.0.1:5180/remote/storage/objects/a?m=GET"
    );
    const cos = "https://bucket.cos.ap-beijing.myqcloud.com/media/a.png?sign=x";
    expect(resolveOutboundUrl(cos, "https://canvas.example.com", "http://127.0.0.1:5180")).toBe(cos);
  });
});

describe("凭据不外泄", () => {
  it("会话令牌与设备凭证都不出现在错误信息里", async () => {
    const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
    const server = fakeServer({ objects });
    const storage = backendOf(server);

    // 正常路径：拿一次签名，确认返回的只是地址。
    const url = await storage.presign("media/a.png");
    expect(url).not.toContain("session-1");
    expect(url).not.toContain("device-token-secret");

    // 异常路径：错误信息同样只有稳定短语。
    const failing = backendOf(fakeServer({ deviceToken: "wrong" }));
    const error = await failing.get("media/a.png").catch((value: unknown) => value);
    expect((error as Error).message).not.toContain("device-token-secret");
  });

  it("登录请求只发 {token}，不回显响应里的会话", async () => {
    const server = fakeServer();
    const client = createServerStorageClient({
      config: CONFIG,
      session: server.sessionSource(),
      fetchImpl: server.fetchImpl,
      hostOrigin: "http://127.0.0.1:5180"
    });
    await client.call("DeleteObject", { key: "media/a.png" });

    const login = server.calls.find((call) => call.url.includes("IdentityService/Login"));
    expect(login?.body).toEqual({ token: "device-token-secret" });
    const storageCall = server.calls.find((call) => call.url.includes("StorageService"));
    expect(storageCall?.authorization).toBe("Bearer session-1");
    expect(JSON.stringify(storageCall?.body)).not.toContain("session-1");
  });
});
