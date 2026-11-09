// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { SdpppxAccountService } from "../src/frontend/account-service.js";
import { SdpppxLoginDialog } from "../src/frontend/login-dialog.js";
import { SdpppxProviderBalance } from "../src/frontend/provider-balance.js";
import { SdpppxProviderLogin } from "../src/frontend/provider-login.js";
import { SdpppxSettingsPanel } from "../src/frontend/settings-panel.js";
import {
  EMPTY_SDPPPX_SNAPSHOT,
  SDPPPX_ERROR_CODES,
  type SdpppxLoginStatus,
  type SdpppxSessionSnapshot
} from "../src/shared.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function sessionSnapshot(overrides: Partial<SdpppxSessionSnapshot> = {}): SdpppxSessionSnapshot {
  return {
    ...EMPTY_SDPPPX_SNAPSHOT,
    status: "authenticated",
    config: {
      ...EMPTY_SDPPPX_CONFIG_SUMMARY_CONST,
      tenantId: "tenant-1",
      supabaseHost: "project.supabase.co",
      authingAppIdConfigured: true
    },
    session: {
      displayName: "小伍",
      avatarUrl: null,
      expiresAt: 1_800_000_000_000,
      balance: { totalBalance: 12 }
    },
    ...overrides
  };
}

const EMPTY_SDPPPX_CONFIG_SUMMARY_CONST = EMPTY_SDPPPX_SNAPSHOT.config;

function fakeService(options: {
  start?: Awaited<ReturnType<SdpppxAccountService["startLogin"]>>;
  polls?: SdpppxLoginStatus[];
  snapshot?: SdpppxSessionSnapshot;
} = {}) {
  let snapshot = options.snapshot ?? sessionSnapshot();
  const listeners = new Set<() => void>();
  const polls = [...(options.polls ?? [])];
  const cancelLogin = vi.fn(async () => undefined);
  const refreshModels = vi.fn(async () => ({
    ok: true as const,
    available: true,
    modelCount: 2,
    catalogRevision: 5,
    error: null
  }));
  const service = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(async () => snapshot),
    startLogin: vi.fn(async () =>
      options.start ?? {
        ok: true as const,
        loginId: "login-1",
        qrDataUrl: "data:image/png;base64,AAAA",
        phase: "pending" as const,
        expiresAt: Date.now() + 300_000
      }
    ),
    pollLogin: vi.fn(async () => polls.shift() ?? { phase: "pending" as const }),
    cancelLogin,
    logout: vi.fn(async () => {
      snapshot = { ...snapshot, status: "anonymous", session: null };
      for (const listener of listeners) listener();
      return { ok: true as const, snapshot };
    }),
    refreshModels,
    applySession: vi.fn(),
    dispose: vi.fn(),
    setSnapshotForTest: (next: SdpppxSessionSnapshot) => {
      snapshot = next;
      for (const listener of listeners) listener();
    }
  };
  return { service: service as unknown as SdpppxAccountService, cancelLogin, refreshModels };
}

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    unmount: () => act(() => root.unmount())
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SdpppxLoginDialog", () => {
  it("start 失败时显示稳定短语与重试，不渲染二维码", async () => {
    const { service } = fakeService({
      start: { ok: false, code: SDPPPX_ERROR_CODES.wechatUnavailable, message: "未开通" }
    });
    const onClose = vi.fn();
    const { container, unmount } = await mount(
      createElement(SdpppxLoginDialog, { service, onClose })
    );
    expect(container.querySelector('[data-testid="sdpppx-login-status"]')?.textContent).toContain("未开通微信登录");
    expect(container.querySelector('[data-testid="sdpppx-login-retry"]')).toBeNull();
    expect(container.querySelector('[data-testid="sdpppx-login-error-retry"]')).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    unmount();
  });

  it("pending → scanned → authorized；终态后自动关窗并停止轮询", async () => {
    vi.useFakeTimers();
    const { service } = fakeService({
      polls: [{ phase: "scanned", nickname: "小伍" }, { phase: "authorized", session: sessionSnapshot().session! }]
    });
    const onClose = vi.fn();
    const onAuthorized = vi.fn();
    const { container, unmount } = await mount(
      createElement(SdpppxLoginDialog, { service, onClose, onAuthorized })
    );
    expect(container.querySelector("img")?.getAttribute("src")).toContain("data:image/png;base64");
    expect(container.querySelector('[data-testid="sdpppx-login-status"]')?.textContent).toContain("请用微信扫描");

    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="sdpppx-login-scanned"]')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onAuthorized).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("「稍后」关闭弹窗并取消进行中的登录", async () => {
    const { service, cancelLogin } = fakeService();
    const onClose = vi.fn();
    const { container, unmount } = await mount(
      createElement(SdpppxLoginDialog, { service, onClose })
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="sdpppx-login-later"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cancelLogin).toHaveBeenCalledWith("login-1");
    unmount();
  });
});

describe("SdpppxProviderBalance", () => {
  it("挂载后读取会话，有余额时显示读数；未登录或余额不可用时不占位", async () => {
    const authenticated = fakeService({ snapshot: { ...EMPTY_SDPPPX_SNAPSHOT, status: "anonymous" } });
    // 初始快照未登录；挂载时主动读取一次才拿到余额。
    (authenticated.service.refresh as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      authenticated.service.setSnapshotForTest(sessionSnapshot());
      return sessionSnapshot();
    });
    const mounted = await mount(createElement(SdpppxProviderBalance, { service: authenticated.service }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.container.querySelector('[data-testid="sdpppx-provider-balance"]')?.textContent).toBe("余额 12");
    mounted.unmount();

    const anonymous = fakeService({ snapshot: { ...EMPTY_SDPPPX_SNAPSHOT, status: "anonymous" } });
    const guest = await mount(createElement(SdpppxProviderBalance, { service: anonymous.service }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(guest.container.querySelector('[data-testid="sdpppx-provider-balance"]')).toBeNull();
    guest.unmount();

    const noBalanceSnapshot = sessionSnapshot({ session: { ...sessionSnapshot().session!, balance: null } });
    const noBalance = fakeService({ snapshot: noBalanceSnapshot });
    const empty = await mount(createElement(SdpppxProviderBalance, { service: noBalance.service }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(empty.container.querySelector('[data-testid="sdpppx-provider-balance"]')).toBeNull();
    empty.unmount();
  });
});

describe("SdpppxSettingsPanel", () => {
  it("只读展示解析后的配置，并可从按钮刷新模型", async () => {
    const { service, refreshModels } = fakeService({ snapshot: sessionSnapshot() });
    const { container, unmount } = await mount(createElement(SdpppxSettingsPanel, { service }));
    expect(container.querySelector('[data-testid="sdpppx-settings-status"]')?.textContent).toContain("已登录");
    expect(container.querySelector('[data-testid="sdpppx-settings-config"]')?.textContent).toContain("tenant-1");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="sdpppx-settings-refresh-models"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshModels).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="sdpppx-settings-feedback"]')?.textContent).toContain("2 个模板");
    unmount();
  });
});

describe("SDPPPX 供应商登录入口", () => {
  it("点选后读取会话；未登录自动打开登录窗，按钮可再次打开", async () => {
    const { service } = fakeService({ snapshot: { ...EMPTY_SDPPPX_SNAPSHOT, status: "anonymous" } });
    const onOpenLogin = vi.fn();
    const onOpenAccount = vi.fn();
    const { container, unmount } = await mount(
      createElement(SdpppxProviderLogin, { service, onOpenLogin, onOpenAccount })
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onOpenLogin).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="sdpppx-provider-login"]')?.getAttribute("data-state")).toBe("anonymous");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="sdpppx-provider-login"] button')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onOpenLogin).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("已登录不自动弹登录窗，只提供账号管理", async () => {
    const { service } = fakeService();
    const onOpenLogin = vi.fn();
    const onOpenAccount = vi.fn();
    const { container, unmount } = await mount(
      createElement(SdpppxProviderLogin, { service, onOpenLogin, onOpenAccount })
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onOpenLogin).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="sdpppx-provider-login"]')?.getAttribute("data-state")).toBe("authenticated");
    expect(container.querySelector('[data-testid="sdpppx-provider-login-account"]')?.textContent).toBe("小伍");
    expect(container.querySelector('[data-testid="sdpppx-provider-login-balance"]')?.textContent).toBe("12");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="sdpppx-provider-login"] button')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("会话读取失败或未配置时不误弹登录", async () => {
    const unavailable = fakeService({ snapshot: { ...EMPTY_SDPPPX_SNAPSHOT, status: "anonymous" } });
    (unavailable.service.refresh as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const open = vi.fn();
    const first = await mount(
      createElement(SdpppxProviderLogin, { service: unavailable.service, onOpenLogin: open, onOpenAccount: vi.fn() })
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(open).not.toHaveBeenCalled();
    first.unmount();

    const unconfigured = fakeService({
      snapshot: { ...EMPTY_SDPPPX_SNAPSHOT, status: "unconfigured", degradedCode: SDPPPX_ERROR_CODES.configIncomplete, missing: ["deployment.tenantId"] }
    });
    const second = await mount(
      createElement(SdpppxProviderLogin, { service: unconfigured.service, onOpenLogin: open, onOpenAccount: vi.fn() })
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(open).not.toHaveBeenCalled();
    expect(second.container.textContent).toContain("deployment.tenantId");
    second.unmount();
  });
});
