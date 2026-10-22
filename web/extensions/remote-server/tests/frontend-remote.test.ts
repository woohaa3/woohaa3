/**
 * 前端读模型与界面测试：锁住「本地 / 已连接 / 异常」三态的语义边界。
 *
 * 这些用例的价值在于防止两类回归：
 * 1. 把 `local` 渲染成错误（让「我只用本地」看起来像坏了）；
 * 2. 令牌或远端原始错误正文漏进界面。
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRemoteServerApi, createRemoteServerService } from "../src/frontend/remote.js";
import {
  LOCAL_ONLY_SNAPSHOT,
  REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE,
  REMOTE_SERVER_DIAGNOSTICS_ROUTE,
  REMOTE_SERVER_SYNC_ENABLE_ROUTE
} from "../src/shared.js";

type RequestInput = { path: string; method?: string; body?: unknown };

/** 最小 transport 替身：按路径返回预设响应，并记录调用。 */
function createTransport(responses: Record<string, unknown | ((input: RequestInput) => unknown)>) {
  const calls: RequestInput[] = [];
  return {
    calls,
    transport: {
      request: vi.fn(async (input: RequestInput) => {
        calls.push(input);
        const key = Object.keys(responses).find((suffix) => input.path.endsWith(suffix));
        if (key === undefined) return { ok: false as const, code: "unavailable" as const, error: "未配置" };
        const entry = responses[key];
        const data = typeof entry === "function" ? (entry as (input: RequestInput) => unknown)(input) : entry;
        return { ok: true as const, status: 200, data };
      })
    }
  };
}

const connected = {
  phase: "connected",
  serverUrl: "https://canvas.example.com",
  subject: "alice",
  displayName: "Alice",
  expiresAt: 1_800_000_000_000,
  methods: [],
  error: null
};

describe("前端 remote 读模型", () => {
  it("读不到状态时回落到 local，不自称已连接", async () => {
    const { transport } = createTransport({});
    const api = createRemoteServerApi(transport);
    await expect(api.loadSnapshot()).resolves.toMatchObject({ phase: "local", subject: null });
  });

  it("status 不是已知相位时也回落到 local（不信任形状）", async () => {
    const { transport } = createTransport({ "/session": { phase: "weird", subject: "x" } });
    const api = createRemoteServerApi(transport);
    await expect(api.loadSnapshot()).resolves.toMatchObject({ phase: "local" });
  });

  it("登录成功后返回宿主给的快照，且请求体里没有令牌时也不编造", async () => {
    const { transport, calls } = createTransport({
      "/login": { ok: true, snapshot: connected }
    });
    const api = createRemoteServerApi(transport);
    await expect(api.login({ serverUrl: "https://canvas.example.com" })).resolves.toMatchObject({ ok: true });
    expect(calls[0]?.body).toEqual({ serverUrl: "https://canvas.example.com" });
    expect(JSON.stringify(calls[0]?.body)).not.toContain("session");
  });

  it("登录失败返回稳定错误短语", async () => {
    const { transport } = createTransport({ "/login": { ok: false, error: "凭证无效或会话已失效" } });
    const api = createRemoteServerApi(transport);
    await expect(api.login({})).resolves.toEqual({ ok: false, error: "凭证无效或会话已失效" });
  });

  it("探测把版本与登录方式交给界面，失败时给出原因", async () => {
    const { transport } = createTransport({
      "/probe": { ok: true, serverUrl: "https://x", version: "v1", commit: "abc", methods: [{ kind: "machine-token" }] }
    });
    const api = createRemoteServerApi(transport);
    await expect(api.probe({})).resolves.toMatchObject({ ok: true, version: "v1", commit: "abc" });

    const down = createTransport({ "/probe": { ok: false, error: "无法连接远端服务端" } });
    await expect(createRemoteServerApi(down.transport).probe({})).resolves.toEqual({
      ok: false,
      error: "无法连接远端服务端"
    });
  });

  it("service 的并发刷新只发一次请求", async () => {
    const { transport, calls } = createTransport({ "/session": connected });
    const service = createRemoteServerService(transport);
    await Promise.all([service.refresh(), service.refresh(), service.refresh()]);
    expect(calls.filter((call) => call.path.endsWith("/session"))).toHaveLength(1);
    expect(service.isLoaded()).toBe(true);
    expect(service.getSnapshot()).toMatchObject({ phase: "connected" });
  });

  it("相同快照不重复通知订阅者", () => {
    const { transport } = createTransport({});
    const service = createRemoteServerService(transport);
    const listener = vi.fn();
    service.subscribe(listener);
    service.setSnapshot({ ...LOCAL_ONLY_SNAPSHOT });
    expect(listener).not.toHaveBeenCalled();
    service.setSnapshot({ ...LOCAL_ONLY_SNAPSHOT, phase: "connected", subject: "alice" });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("显式启用画布同步（本地画布默认不上传）", () => {
  it("POST 到 canvas-sync-enable，体里只有 canvasId", async () => {
    const { transport, calls } = createTransport({ [`/${REMOTE_SERVER_SYNC_ENABLE_ROUTE}`]: { ok: true } });
    await expect(createRemoteServerApi(transport).enableCanvasSync("canvas-1")).resolves.toEqual({ ok: true });
    // 走宿主受控 handler，浏览器不直连远端。
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(`/api/extensions/remote-server/handlers/${REMOTE_SERVER_SYNC_ENABLE_ROUTE}`);
    expect(calls[0]?.body).toEqual({ canvasId: "canvas-1" });
  });

  it("宿主拒绝时带出可展示的原因（不抛到组件外）", async () => {
    const { transport } = createTransport({
      [`/${REMOTE_SERVER_SYNC_ENABLE_ROUTE}`]: { ok: false, error: "未连接服务端" }
    });
    await expect(createRemoteServerApi(transport).enableCanvasSync("canvas-1")).resolves.toEqual({
      ok: false,
      error: "未连接服务端"
    });
  });

  it("传输层失败时透传原因", async () => {
    const { transport } = createTransport({});
    await expect(createRemoteServerApi(transport).enableCanvasSync("canvas-1")).resolves.toEqual({
      ok: false,
      error: "未配置"
    });
  });

  it("形状不符 / 传输层异常都给稳定短语，按钮永远拿得到一句可读原因", async () => {
    const weird = createTransport({ [`/${REMOTE_SERVER_SYNC_ENABLE_ROUTE}`]: null });
    await expect(createRemoteServerApi(weird.transport).enableCanvasSync("canvas-1")).resolves.toEqual({
      ok: false,
      error: "无法启用远端同步"
    });

    const throwing = {
      request: vi.fn(async () => {
        throw new Error("网络中断");
      })
    };
    await expect(createRemoteServerApi(throwing).enableCanvasSync("canvas-1")).resolves.toEqual({
      ok: false,
      error: "网络中断"
    });
  });
});

const diagnosticsSnapshot = {
  entries: [
    {
      seq: 7,
      time: 1_700_000_000_000,
      level: "info",
      category: "probe",
      event: "remote-probe-ok",
      code: "ok",
      message: "探测成功",
      attributes: { status: "200", server: "canvas.example.com:443" }
    }
  ],
  capturedAt: 1_700_000_001_000,
  capacity: 200,
  available: true
};

describe("诊断读模型", () => {
  it("读取诊断缓冲：解析条目、采集时刻、上限与可用性", async () => {
    const { transport, calls } = createTransport({ [`/${REMOTE_SERVER_DIAGNOSTICS_ROUTE}`]: diagnosticsSnapshot });
    const api = createRemoteServerApi(transport);
    const result = await api.loadDiagnostics();
    expect(result).toEqual({
      ok: true,
      snapshot: {
        entries: diagnosticsSnapshot.entries,
        capturedAt: diagnosticsSnapshot.capturedAt,
        capacity: 200,
        available: true
      }
    });
    // 走宿主 handler，且是 POST：浏览器不直连远端。
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(`/api/extensions/remote-server/handlers/${REMOTE_SERVER_DIAGNOSTICS_ROUTE}`);
  });

  it("宿主不支持诊断时保留 available:false，而不是伪装成空列表", async () => {
    const { transport } = createTransport({
      [`/${REMOTE_SERVER_DIAGNOSTICS_ROUTE}`]: { entries: [], capturedAt: 0, capacity: 0, available: false }
    });
    await expect(createRemoteServerApi(transport).loadDiagnostics()).resolves.toMatchObject({
      ok: true,
      snapshot: { available: false, entries: [] }
    });
  });

  it("形状不符（缺少 available / entries 不是数组）时返回结构化失败", async () => {
    const missingAvailable = createTransport({
      [`/${REMOTE_SERVER_DIAGNOSTICS_ROUTE}`]: { entries: [], capturedAt: 1, capacity: 10 }
    });
    await expect(createRemoteServerApi(missingAvailable.transport).loadDiagnostics()).resolves.toEqual({
      ok: false,
      error: "宿主返回的诊断数据形状不符"
    });

    const badEntries = createTransport({ [`/${REMOTE_SERVER_DIAGNOSTICS_ROUTE}`]: { available: true, entries: "nope" } });
    await expect(createRemoteServerApi(badEntries.transport).loadDiagnostics()).resolves.toEqual({
      ok: false,
      error: "宿主返回的诊断数据形状不符"
    });
  });

  it("坏条目被丢弃，但不让整次读取失败", async () => {
    const { transport } = createTransport({
      [`/${REMOTE_SERVER_DIAGNOSTICS_ROUTE}`]: {
        available: true,
        entries: [
          { seq: 1, time: 1, level: "loud", category: "probe", event: "x" },
          { seq: 2, time: 2, level: "warn", category: "login", event: "remote-login-failed" }
        ],
        capturedAt: 3,
        capacity: 10
      }
    });
    const result = await createRemoteServerApi(transport).loadDiagnostics();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.entries).toHaveLength(1);
      expect(result.snapshot.entries[0]?.event).toBe("remote-login-failed");
    }
  });

  it("attributes 防御性读取：非对象/非字符串整对丢弃，值截断到 256，空对象不出现", async () => {
    const { transport } = createTransport({
      [`/${REMOTE_SERVER_DIAGNOSTICS_ROUTE}`]: {
        available: true,
        entries: [
          {
            seq: 1,
            time: 1,
            level: "info",
            category: "probe",
            event: "remote-probe-ok",
            // 非字符串值、空 key、空值整对丢弃；合法对保留。
            attributes: { status: "200", bad: 2, nested: { a: 1 }, nullish: null, "": "x", empty: "" }
          },
          { seq: 2, time: 2, level: "warn", category: "login", event: "remote-login-failed", attributes: "nope" },
          { seq: 3, time: 3, level: "info", category: "probe", event: "remote-probe-ok", attributes: [["status", "200"]] },
          { seq: 4, time: 4, level: "info", category: "probe", event: "remote-probe-ok", attributes: {} },
          {
            seq: 5,
            time: 5,
            level: "info",
            category: "probe",
            event: "remote-probe-ok",
            attributes: { server: "x".repeat(300) }
          }
        ],
        capturedAt: 6,
        capacity: 10
      }
    });
    const result = await createRemoteServerApi(transport).loadDiagnostics();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [mixed, nonObject, arrayForm, empty, truncated] = result.snapshot.entries;
    // 合法对保留，非法对丢弃；条目本身照常可读。
    expect(mixed?.attributes).toEqual({ status: "200" });
    // 非对象、数组、空对象都当作「没有细节」，不产出这个键。
    expect(nonObject).not.toHaveProperty("attributes");
    expect(arrayForm).not.toHaveProperty("attributes");
    expect(empty).not.toHaveProperty("attributes");
    // 超长值截断到 256 字符（255 + 省略号），而不是整次读取失败。
    expect(truncated?.attributes?.server).toBe(`${"x".repeat(255)}…`);
    expect(truncated?.attributes?.server).toHaveLength(256);
  });

  it("attributes 最多保留 16 对，超出丢弃但不让读取失败", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`k${String(index).padStart(2, "0")}`, String(index)])
    );
    const { transport } = createTransport({
      [`/${REMOTE_SERVER_DIAGNOSTICS_ROUTE}`]: {
        available: true,
        entries: [
          { seq: 1, time: 1, level: "info", category: "probe", event: "remote-probe-ok", attributes: many }
        ],
        capturedAt: 2,
        capacity: 10
      }
    });
    const result = await createRemoteServerApi(transport).loadDiagnostics();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const attributes = result.snapshot.entries[0]?.attributes;
    expect(Object.keys(attributes ?? {})).toHaveLength(16);
    expect(Object.keys(attributes ?? {})[15]).toBe("k15");
  });

  it("传输层失败时把原因收敛成 { ok:false }，不抛给界面", async () => {
    const transport = {
      request: vi.fn(async () => ({ ok: false as const, code: "unavailable" as const, error: "宿主不支持接入日志" }))
    };
    await expect(createRemoteServerApi(transport).loadDiagnostics()).resolves.toEqual({
      ok: false,
      error: "宿主不支持接入日志"
    });
  });

  it("上报成功返回受理条数", async () => {
    const { transport, calls } = createTransport({
      [`/${REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE}`]: { ok: true, acceptedCount: 12 }
    });
    await expect(createRemoteServerApi(transport).reportDiagnostics()).resolves.toEqual({ ok: true, acceptedCount: 12 });
    expect(calls[0]?.path).toBe(
      `/api/extensions/remote-server/handlers/${REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE}`
    );
  });

  it("上报失败与未实现都返回可展示的原因", async () => {
    const notConnected = createTransport({
      [`/${REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE}`]: { ok: false, error: "未连接服务端" }
    });
    await expect(createRemoteServerApi(notConnected.transport).reportDiagnostics()).resolves.toEqual({
      ok: false,
      error: "未连接服务端"
    });

    const unimplemented = createTransport({
      [`/${REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE}`]: { ok: false, error: "服务端尚未实现诊断上报接口" }
    });
    await expect(createRemoteServerApi(unimplemented.transport).reportDiagnostics()).resolves.toEqual({
      ok: false,
      error: "服务端尚未实现诊断上报接口"
    });

    // 宿主回了非对象：也要有稳定短语，不能把 undefined 抛给按钮文案。
    const weird = createTransport({ [`/${REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE}`]: null });
    await expect(createRemoteServerApi(weird.transport).reportDiagnostics()).resolves.toEqual({
      ok: false,
      error: "上报失败"
    });
  });

  it("上报时传输层异常收敛成失败", async () => {
    const transport = {
      request: vi.fn(async () => {
        throw new Error("网络中断");
      })
    };
    await expect(createRemoteServerApi(transport).reportDiagnostics()).resolves.toEqual({
      ok: false,
      error: "网络中断"
    });
  });
});

describe("浏览器授权登录的前端适配", () => {
  it("发起：把 origin 交给宿主，原样带出 attemptId 与授权入口地址", async () => {
    const { transport, calls } = createTransport({
      "/oauth-start": {
        ok: true,
        attemptId: "a".repeat(32),
        authorizeUrl: "https://canvas.example.com/tof/authorize?state=" + "a".repeat(32),
        expiresAt: 1_800_000_000_000
      }
    });
    const result = await createRemoteServerApi(transport).startOauthLogin({ origin: "http://127.0.0.1:5173" });
    expect(calls[0]?.body).toEqual({ origin: "http://127.0.0.1:5173" });
    expect(result).toMatchObject({ ok: true, attemptId: "a".repeat(32) });
  });

  it("发起失败时区分 unsupported（面板据此不再重试浏览器登录）", async () => {
    const unsupported = createTransport({
      "/oauth-start": { ok: false, error: "unsupported", message: "当前宿主不支持浏览器登录，请改用短码" }
    });
    await expect(
      createRemoteServerApi(unsupported.transport).startOauthLogin({ origin: "http://127.0.0.1:5173" })
    ).resolves.toEqual({ ok: false, unsupported: true, error: "当前宿主不支持浏览器登录，请改用短码" });

    const transportDown = createTransport({});
    await expect(
      createRemoteServerApi(transportDown.transport).startOauthLogin({ origin: "http://127.0.0.1:5173" })
    ).resolves.toMatchObject({ ok: false, unsupported: false });
  });

  it("轮询：approved 只交快照（没有令牌），failed 给中文短语与稳定码", async () => {
    const approved = createTransport({ "/oauth-poll": { state: "approved", snapshot: connected } });
    const result = await createRemoteServerApi(approved.transport).pollOauthLogin("b".repeat(32));
    expect(result).toMatchObject({ state: "approved" });
    expect(JSON.stringify(result)).not.toContain("session-");

    const failed = createTransport({
      "/oauth-poll": { state: "failed", code: "tof_expired", error: "授权码已过期，请重新发起" }
    });
    await expect(createRemoteServerApi(failed.transport).pollOauthLogin("c".repeat(32))).resolves.toEqual({
      state: "failed",
      code: "tof_expired",
      error: "授权码已过期，请重新发起"
    });
  });

  it("轮询遇到传输失败仍按 pending（一次抖动不等于登录失败）", async () => {
    const transport = {
      request: vi.fn(async () => {
        throw new Error("网络中断");
      })
    };
    await expect(createRemoteServerApi(transport).pollOauthLogin("d".repeat(32))).resolves.toEqual({ state: "pending" });
  });
});
