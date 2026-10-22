/**
 * 设置面板的浏览器授权登录（同机 = loopback）测试。
 *
 * 重点是产品判断被真的渲染出来：
 * - 同机时「登录并连接」默认走浏览器授权（调 oauth-start、打开授权入口、显示等待），
 * - approved 自动接上、failed/超时给出可读文案与「改用短码」，
 * - 设备码路径不回归（短码、批准页地址、复制按钮照旧）。
 *
 * 默认 jsdom 地址是 http://localhost:3000，正好是 loopback 形态。非 loopback 的用例见
 * frontend-oauth-nonloopback.test.tsx（它需要不同的 jsdom url）。
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { RemoteServerSettingsPanel } from "../src/frontend/settings-panel.js";
import { createRemoteServerService } from "../src/frontend/remote.js";
import { REMOTE_SERVER_OAUTH_POLL_INTERVAL_MS, REMOTE_SERVER_OAUTH_POLL_TIMEOUT_MS } from "../src/shared.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOCAL_SNAPSHOT = { phase: "local", serverUrl: "https://canvas.example.com", subject: null, displayName: null, expiresAt: null, methods: [], error: null };

const CONNECTED_SNAPSHOT = {
  phase: "connected",
  serverUrl: "https://canvas.example.com",
  subject: "alice",
  displayName: "Alice",
  expiresAt: Date.now() + 3600_000,
  methods: [],
  error: null
};

const AUTHORIZE_URL = "https://canvas.example.com/tof/authorize?redirect_uri=x&state=s&code_challenge=c&code_challenge_method=S256";

function createService(responses: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const transport = {
    request: vi.fn(async (input: { path: string; body?: unknown }) => {
      calls.push(input);
      const key = Object.keys(responses).find((suffix) => input.path.endsWith(suffix));
      if (key === undefined) return { ok: false as const, code: "unavailable" as const, error: "未配置" };
      return { ok: true as const, status: 200, data: responses[key] };
    })
  };
  return { service: createRemoteServerService(transport), calls };
}

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

/** 点击「登录并连接」并让 await 链跑完。 */
async function clickConnect(container: HTMLElement) {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="server-connect"]')!.click();
  });
}

/** 推进一次轮询间隔（轮询是 setTimeout 链，必须按异步定时器推进）。 */
async function advancePoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(REMOTE_SERVER_OAUTH_POLL_INTERVAL_MS);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("浏览器授权登录（同机 loopback）", () => {
  it("「登录并连接」默认走浏览器登录：调 oauth-start、打开授权入口、显示等待", async () => {
    vi.useFakeTimers();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const { service, calls } = createService({
      "/session": LOCAL_SNAPSHOT,
      "/oauth-start": { ok: true, attemptId: "a".repeat(32), authorizeUrl: AUTHORIZE_URL, expiresAt: Date.now() + 600_000 }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    await clickConnect(container);

    const startCall = calls.find((call) => call.path.endsWith("/oauth-start"));
    expect(startCall).toBeDefined();
    // origin 由浏览器自报，宿主据此拼 loopback redirect_uri。
    // serverUrl 是面板里当前这个地址（预置值时也照传）：宿主只认部署配置与会话，不带上的话
    // 手填地址的首次登录会被判成「还没有配置服务端地址」，静默退回短码。
    expect(startCall?.body).toEqual({ origin: "http://localhost:3000", serverUrl: "https://canvas.example.com" });
    expect(openSpy).toHaveBeenCalledWith(AUTHORIZE_URL, "_blank", "noopener,noreferrer");
    expect(container.querySelector('[data-testid="server-oauth-pending"]')).not.toBeNull();
    // 没有退到设备码：这条路径不需要任何人抄短码。
    expect(container.querySelector('[data-testid="server-device-code"]')).toBeNull();
    expect(calls.some((call) => call.path.endsWith("/device-start"))).toBe(false);
    unmount();
  });

  it("轮询到 approved 就自动连接，不需要再操作", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "open").mockImplementation(() => null);
    const attemptId = "b".repeat(32);
    const { service, calls } = createService({
      "/session": LOCAL_SNAPSHOT,
      "/oauth-start": { ok: true, attemptId, authorizeUrl: AUTHORIZE_URL, expiresAt: Date.now() + 600_000 },
      "/oauth-poll": { state: "approved", snapshot: CONNECTED_SNAPSHOT }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    await clickConnect(container);
    await advancePoll();

    expect(calls.find((call) => call.path.endsWith("/oauth-poll"))?.body).toEqual({ attemptId });
    expect(container.textContent).toContain("已连接");
    expect(container.textContent).toContain("Alice");
    expect(container.querySelector('[data-testid="server-oauth-pending"]')).toBeNull();
    expect(container.querySelector('[data-testid="server-device-code"]')).toBeNull();
    unmount();
  });

  it("轮询 failed：显示可读文案并提供「改用短码」，点了就真的走设备码", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "open").mockImplementation(() => null);
    const { service, calls } = createService({
      "/session": LOCAL_SNAPSHOT,
      "/oauth-start": { ok: true, attemptId: "c".repeat(32), authorizeUrl: AUTHORIZE_URL, expiresAt: Date.now() + 600_000 },
      "/oauth-poll": { state: "failed", error: "企业统一登录没有完成（授权码无效）" },
      "/device-start": {
        ok: true,
        userCode: "BCDF-GHJK",
        verificationUri: "https://canvas.example.com/device",
        intervalMs: 3000,
        expiresAt: Date.now() + 900_000
      }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    await clickConnect(container);
    await advancePoll();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("企业统一登录没有完成");
    const fallback = container.querySelector<HTMLButtonElement>('[data-testid="server-oauth-fallback"]');
    expect(fallback).not.toBeNull();
    await act(async () => {
      fallback!.click();
    });
    expect(calls.some((call) => call.path.endsWith("/device-start"))).toBe(true);
    expect(container.querySelector('[data-testid="server-device-code"]')?.textContent).toContain("BCDF-GHJK");
    unmount();
  });

  it("等待超时（5 分钟）→ 可读文案 + 改用短码，不永远转圈", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "open").mockImplementation(() => null);
    const { service, calls } = createService({
      "/session": LOCAL_SNAPSHOT,
      "/oauth-start": { ok: true, attemptId: "d".repeat(32), authorizeUrl: AUTHORIZE_URL, expiresAt: Date.now() + 10 * 60_000 },
      "/oauth-poll": { state: "pending" }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    await clickConnect(container);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_SERVER_OAUTH_POLL_TIMEOUT_MS + REMOTE_SERVER_OAUTH_POLL_INTERVAL_MS);
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("超时");
    expect(container.querySelector('[data-testid="server-oauth-fallback"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="server-oauth-pending"]')).toBeNull();
    // 超时只是「这条路没成」，面板不能替人自动开短码审批页。
    expect(calls.some((call) => call.path.endsWith("/device-start"))).toBe(false);
    unmount();
  });

  it("宿主说这条路径不存在（unsupported）→ 回退设备码，并把原因写在面板上", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    const { service, calls } = createService({
      "/session": LOCAL_SNAPSHOT,
      "/oauth-start": { ok: false, error: "unsupported", message: "当前宿主不支持浏览器登录，请改用短码" },
      "/device-start": {
        ok: true,
        userCode: "BCDF-GHJK",
        verificationUri: "https://canvas.example.com/device",
        intervalMs: 3000,
        expiresAt: Date.now() + 900_000
      }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    await clickConnect(container);

    expect(calls.filter((call) => call.path.endsWith("/oauth-start"))).toHaveLength(1);
    expect(container.querySelector('[data-testid="server-device-code"]')?.textContent).toContain("BCDF-GHJK");
    // 自动改走短码不是「静默」的：面板要说明为什么，否则人只会看到短码框。
    expect(container.querySelector('[data-testid="server-login-fallback"]')?.textContent).toContain(
      "当前宿主不支持浏览器登录"
    );
    unmount();
  });

  it("设备码路径不回归：短码、批准页地址与复制按钮照旧", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    const { service } = createService({
      "/session": LOCAL_SNAPSHOT,
      "/oauth-start": { ok: false, error: "unsupported", message: "当前宿主不支持浏览器登录，请改用短码" },
      "/device-start": {
        ok: true,
        userCode: "BCDF-GHJK",
        verificationUri: "https://canvas.example.com/device",
        intervalMs: 3000,
        expiresAt: Date.now() + 900_000
      }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    await clickConnect(container);
    const device = container.querySelector('[data-testid="server-device-code"]');
    expect(device?.textContent).toContain("BCDF-GHJK");
    expect(device?.textContent).toContain("canvas.example.com/device");
    expect(container.querySelector('[data-testid="server-device-copy"]')).not.toBeNull();
    // 面板仍然不收集任何凭据。
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('[data-testid="server-token"]')).toBeNull();
    unmount();
  });
});
