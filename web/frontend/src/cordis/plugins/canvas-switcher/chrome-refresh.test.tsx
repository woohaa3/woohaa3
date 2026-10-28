/**
 * 画布切换器的「刷新」入口与自动刷新测试
 * （change: 2026-09-29-add-multi-canvas-workspace；拆分自 chrome.test.tsx）。
 *
 * 绕过 DialogHost 直接挂载 renderer，用真实 CanvasCatalogStore + 假 remote 观察请求节奏，
 * 避免 Radix Presence 的动画定时器与 fake timers 相互干扰。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SlotRegistry } from "../../slots.js";
import { CATALOG_AUTO_REFRESH_MS, createCanvasSwitcherRenderer } from "./chrome.js";
import { CanvasCatalogStore } from "../../services/canvas-catalog-store.js";
import { createFakeCanvasCatalogRemote, makeSummary } from "../../test-support/canvas-catalog.js";
import type { CanvasSession } from "../../contract/session.js";
import type { CanvasCatalogService, CanvasCatalogListResult } from "../../contract/canvas-catalog.js";

function fakeSession(phase: "synced" | "offline" = "synced"): CanvasSession {
  return {
    getStatus: () => ({
      phase: "ready",
      error: null,
      hydrated: true,
      remote: {
        mode: phase === "synced" ? "remote" : "offline",
        phase,
        confirmedRevision: 1,
        pendingCount: 0,
        error: null
      }
    }),
    subscribe: () => () => undefined,
    retry: async () => undefined,
    requestHydrate: () => undefined,
    commandLifecycle: () => null,
    submitCommands: () => ({ ok: false, reason: "stub" }),
    isWritable: () => phase === "synced",
    shutdown: () => undefined
  } as unknown as CanvasSession;
}

const emptyInstance = {
  instanceId: "i1",
  dialogId: "canvas-switcher",
  payload: {},
  parentInstanceId: null,
  dismissible: true,
  busy: false
};

/**
 * 「刷新」入口与自动刷新的测试装置：绕过 DialogHost 直接挂载 renderer，
 * 用真实 CanvasCatalogStore + 假 remote 观察请求节奏，避免 Radix Presence 的动画定时器
 * 与 fake timers 相互干扰。
 */
function catalogHarness(entries: Array<[string, string]> = [["a", "画布 A"], ["b", "画布 B"]]) {
  const remote = createFakeCanvasCatalogRemote(entries.map(([id, title]) => makeSummary(id, title)));
  return { remote, catalog: new CanvasCatalogStore({ remote }) };
}

async function mountRefreshable(catalog: CanvasCatalogService) {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // getStatus 必须返回同一快照对象，否则 useSyncExternalStore 每次读取都「变化」并无限重渲染。
  const session = fakeSession("synced");
  const sessionStatus = session.getStatus();
  session.getStatus = () => sessionStatus;
  const Renderer = createCanvasSwitcherRenderer({
    catalog,
    slots: new SlotRegistry(),
    selection: { getRecentCanvasId: () => null, setRecentCanvasId: () => undefined },
    session,
    currentCanvasId: () => "a",
    switchTo: () => undefined,
    create: async () => ({ ok: true, canvasId: "new" }),
    rename: async () => ({ ok: true }),

    exportArchive: async () => ({ ok: true })
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Renderer instance={emptyInstance} requestClose={() => undefined} setBusy={() => undefined} replace={() => undefined} />
    );
  });
  return {
    container,
    button: () => container.querySelector<HTMLButtonElement>('[data-testid="canvas-switcher-refresh"]')!,
    status: () => container.querySelector('[data-testid="canvas-switcher-refresh-status"]')?.textContent ?? "",
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    }
  };
}

/** 排空 promise 链：刷新完成后的状态更新都在微任务里。 */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("CanvasSwitcher 刷新与自动刷新", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("自动刷新间隔导出为 15 秒（供测试与文案复用）", () => {
    expect(CATALOG_AUTO_REFRESH_MS).toBe(15_000);
  });

  it("点击「刷新」先失效缓存再强制重取目录", async () => {
    const { catalog } = catalogHarness();
    await catalog.load();
    const invalidate = vi.spyOn(catalog, "invalidate");
    const load = vi.spyOn(catalog, "load");
    const view = await mountRefreshable(catalog);
    try {
      expect(view.button().disabled).toBe(false);
      expect(view.status()).toBe("自动刷新 · 刚刚更新");

      await act(async () => {
        view.button().click();
      });
      // invalidate + load(true) 都在第一个 await 之前同步发出。
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledWith(true);

      await flushMicrotasks();
      expect(view.button().disabled).toBe(false);
      expect(view.status()).toBe("自动刷新 · 刚刚更新");
    } finally {
      await view.unmount();
    }
  });

  it("Dialog 打开期间每 15 秒自动刷新一次，关闭后不再触发", async () => {
    const { catalog } = catalogHarness();
    await catalog.load();
    const load = vi.spyOn(catalog, "load");
    const forcedLoads = () => load.mock.calls.filter(([force]) => force === true).length;
    const view = await mountRefreshable(catalog);
    try {
      expect(forcedLoads()).toBe(0);
      await act(async () => {
        vi.advanceTimersByTime(CATALOG_AUTO_REFRESH_MS);
      });
      await flushMicrotasks();
      expect(forcedLoads()).toBe(1);

      await act(async () => {
        vi.advanceTimersByTime(CATALOG_AUTO_REFRESH_MS);
      });
      await flushMicrotasks();
      expect(forcedLoads()).toBe(2);
    } finally {
      await view.unmount();
    }

    // Dialog 关闭（组件卸载）后定时器必须清掉，不再偷偷重取。
    await act(async () => {
      vi.advanceTimersByTime(CATALOG_AUTO_REFRESH_MS * 3);
    });
    await flushMicrotasks();
    expect(forcedLoads()).toBe(2);
  });

  it("状态行显示自动刷新的相对更新时间，并随 ticker 推进", async () => {
    const { catalog } = catalogHarness();
    await catalog.load();
    const view = await mountRefreshable(catalog);
    try {
      expect(view.status()).toBe("自动刷新 · 刚刚更新");

      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      expect(view.status()).toBe("自动刷新 · 3 秒前更新");

      // 到 15 秒自动刷新一次，相对时间重新从「刚刚」开始。
      await act(async () => {
        vi.advanceTimersByTime(CATALOG_AUTO_REFRESH_MS - 3_000);
      });
      await flushMicrotasks();
      expect(view.status()).toBe("自动刷新 · 刚刚更新");
    } finally {
      await view.unmount();
    }
  });

  it("刷新失败保留之前的列表，并说明失败原因", async () => {
    const { catalog, remote } = catalogHarness();
    await catalog.load();
    const view = await mountRefreshable(catalog);
    try {
      // 本机宿主不可用：真实 store 走失败分支会清空 entries，界面仍应保留上一份列表。
      (remote as unknown as { list: () => Promise<{ ok: false; code: string; error: string }> }).list = async () => ({
        ok: false,
        code: "UNAVAILABLE",
        error: "目录服务不可用"
      });

      await act(async () => {
        view.button().click();
      });
      await flushMicrotasks();

      expect(view.status()).toBe("刷新失败：目录服务不可用");
      expect(view.container.textContent).toContain("画布 A");
      expect(view.container.textContent).toContain("画布 B");
      expect(view.container.textContent).toContain("2 张画布");
      // 原因只在状态行出现一次，不重复另一段同样的大段文案。
      expect((view.container.textContent ?? "").split("目录服务不可用")).toHaveLength(2);
      // 失败后仍可再次刷新。
      expect(view.button().disabled).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it("刷新进行中按钮禁用并显示进行中，且不叠加请求", async () => {
    const { catalog } = catalogHarness();
    await catalog.load();
    const view = await mountRefreshable(catalog);
    const load = vi.spyOn(catalog, "load");
    let resolveLoad!: (result: CanvasCatalogListResult) => void;
    load.mockImplementationOnce(
      () =>
        new Promise<CanvasCatalogListResult>((resolve) => {
          resolveLoad = resolve;
        })
    );
    const forcedLoads = () => load.mock.calls.filter(([force]) => force === true).length;
    try {
      expect(view.button().disabled).toBe(false);

      await act(async () => {
        view.button().click();
      });
      expect(forcedLoads()).toBe(1);
      expect(view.button().disabled).toBe(true);
      expect(view.button().getAttribute("data-loading")).toBe("true");
      expect(view.button().textContent).toContain("刷新中");
      expect(view.status()).toBe("正在刷新…");

      // 再点一次：按钮已禁用，即便触发也走互斥，不叠加第二个请求。
      await act(async () => {
        view.button().click();
      });
      // 15 秒自动刷新到点时同样不叠加。
      await act(async () => {
        vi.advanceTimersByTime(CATALOG_AUTO_REFRESH_MS);
      });
      expect(forcedLoads()).toBe(1);

      await act(async () => {
        resolveLoad({ ok: true, entries: [makeSummary("a", "画布 A")], total: 1, offset: 0, limit: 20 });
      });
      await flushMicrotasks();
      expect(view.button().disabled).toBe(false);
      expect(view.button().getAttribute("data-loading")).toBeNull();
      expect(view.status()).toBe("自动刷新 · 刚刚更新");
    } finally {
      await view.unmount();
    }
  });
});

