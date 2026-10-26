/**
 * 安全模式提示条与重连遮罩（change: 2026-10-21-harden-extension-fault-isolation，任务 4.5 / 5.4）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostSafeModeView, SettingsSnapshot } from "@woohaa3/contracts";
import { createHostConnectivityService, type HostConnectivityService } from "./host-connectivity.js";
import { HostConnectivityOverlay } from "./host-connectivity-overlay.js";
import { SafeModeBanner, readSafeMode } from "./safe-mode-banner.js";
import type { SettingsRemote } from "./settings-remote.js";
import type { HostRestartRemote } from "./host-restart-remote.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
};

function snapshot(safeMode: unknown): SettingsSnapshot {
  return { settings: [], plugins: [], files: { config: "c", secrets: "s" }, ...(safeMode === undefined ? {} : { safeMode }) } as SettingsSnapshot;
}

/** 契约形状的安全模式视图（字段漂移会在这里类型报错）。 */
function safeMode(overrides: Partial<HostSafeModeView> = {}): HostSafeModeView {
  return { reason: "boot-failures", since: "2026-10-21T00:00:00Z", suspendedCount: 1, suspended: ["provider-x"], ...overrides };
}

function connectivity(): HostConnectivityService {
  return createHostConnectivityService({
    probe: async () => ({ reachable: false }),
    pinnedReleaseId: () => "r1",
    setTimer: () => null,
    clearTimer: () => undefined
  });
}

describe("readSafeMode", () => {
  it("缺省或形状不对视为未进入", () => {
    expect(readSafeMode(snapshot(undefined))).toBeNull();
    expect(readSafeMode(snapshot(null))).toBeNull();
    expect(readSafeMode(snapshot({ reason: "forced" }))).toBeNull();
    expect(readSafeMode(snapshot(safeMode({ reason: "forced", suspendedCount: 2 })))).toMatchObject({ suspendedCount: 2, suspended: ["provider-x"] });
  });
});

describe("SafeModeBanner", () => {
  const settingsRemote = (value: unknown, ok = true): SettingsRemote => ({
    fetchSnapshot: async () => (ok ? { ok: true, snapshot: snapshot(value) } : { ok: false, code: "unauthorized", error: "x" }),
    write: async () => ({ ok: false, code: "x", error: "x" })
  });

  it("安全模式下显示暂停数量、原因与最近失败；点击退出发出 exitSafeMode 并进入重连", async () => {
    const calls: unknown[] = [];
    const restartRemote: HostRestartRemote = { restart: async (input) => { calls.push(input); return { ok: true }; } };
    const service = connectivity();
    const el = mount(
      <SafeModeBanner
        connectivity={service}
        settingsRemote={settingsRemote(safeMode({ suspendedCount: 3, suspended: ["a", "b", "c"], lastFailure: "provider-x 激活失败" }))}
        restartRemote={restartRemote}
      />
    );
    await flush();
    const banner = el.querySelector('[data-testid="safe-mode-banner"]');
    expect(banner?.textContent).toContain("已暂停 3 个扩展（连续多次启动失败）");
    expect(banner?.textContent).toContain("provider-x 激活失败");
    await act(async () => {
      banner!.querySelector("button")!.click();
    });
    await flush();
    expect(calls).toEqual([{ reason: "exit-safe-mode", exitSafeMode: true }]);
    expect(service.getSnapshot().phase).toBe("reconnecting");
  });

  it("重启请求被拒绝：显示原因，不进入重连", async () => {
    const restartRemote: HostRestartRemote = { restart: async () => ({ ok: false, code: "forbidden", error: "需要站点管理员授权" }) };
    const service = connectivity();
    const el = mount(<SafeModeBanner connectivity={service} settingsRemote={settingsRemote(safeMode({ reason: "forced" }))} restartRemote={restartRemote} />);
    await flush();
    expect(el.textContent).toContain("已暂停 1 个扩展（由 WOOHAA3_SAFE_MODE 强制开启）");
    await flush();
    await act(async () => {
      el.querySelector("button")!.click();
    });
    await flush();
    expect(el.textContent).toContain("需要站点管理员授权");
    expect(service.getSnapshot().phase).toBe("online");
  });

  it("未进入安全模式或读取失败（未授权）时不显示", async () => {
    const service = connectivity();
    const off = mount(<SafeModeBanner connectivity={service} settingsRemote={settingsRemote(null)} />);
    await flush();
    expect(off.querySelector('[data-testid="safe-mode-banner"]')).toBeNull();
    act(() => root?.unmount());
    const denied = mount(<SafeModeBanner connectivity={service} settingsRemote={settingsRemote(safeMode(), false)} />);
    await flush();
    expect(denied.querySelector('[data-testid="safe-mode-banner"]')).toBeNull();
  });
});

describe("HostConnectivityOverlay", () => {
  it("在线不渲染；重连时显示遮罩；restarted 时显示提示并可重开", async () => {
    let reopened = 0;
    const timers: Array<() => void> = [];
    const results = [{ reachable: true as const, releaseId: "r2" }];
    const service = createHostConnectivityService({
      probe: async () => results.shift() ?? { reachable: false },
      pinnedReleaseId: () => "r1",
      reopenCanvas: () => { reopened += 1; },
      setTimer: (callback) => { timers.push(callback); return null; },
      clearTimer: () => undefined
    });
    const el = mount(<HostConnectivityOverlay connectivity={service} />);
    expect(el.innerHTML).toBe("");
    act(() => service.expectRestart());
    expect(el.querySelector('[data-testid="host-reconnecting"]')?.textContent).toContain("正在重新连接本机服务");
    await act(async () => {
      timers.shift()?.();
    });
    await flush();
    const notice = el.querySelector('[data-testid="host-restarted"]');
    expect(notice?.textContent).toContain("扩展已更新");
    await act(async () => {
      (notice!.querySelector("button") as HTMLButtonElement).click();
    });
    expect(reopened).toBe(1);
    expect(el.innerHTML).toBe("");
  });
});
