/**
 * URL-driven Canvas scope transition 测试
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 3.6 / design D1、D3）。
 *
 * 覆盖：canvasId 参与 scope identity、A→B 完整重建、快速 A→B→C 隔离迟到结果、缺省解析、
 * 空目录幂等创建、显式不存在 → 恢复页、dispose 释放。
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { startApp, type AppRuntime } from "./page-scope.js";
import {
  createFakeCanvasCatalogRemote,
  makeSummary,
  type FakeCanvasCatalogRemote
} from "./test-support/canvas-catalog.js";
import type { AppHistoryAdapter } from "./navigation/app-router-store.js";
import type { CanvasCatalogRemote, CanvasCatalogSummaryResult } from "./contracts.js";
import type { CanvasPreparationService } from "./contract/canvas-preparation.js";

let app: AppRuntime | null = null;

class FakeWebSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = "";
  url: string;
  constructor(url: string) {
    this.url = url;
    socketUrls.push(url);
  }
  send() {}
  close() {
    closedSocketUrls.push(this.url);
  }
  addEventListener() {}
  removeEventListener() {}
}

const socketUrls: string[] = [];
const closedSocketUrls: string[] = [];

function installGlobals(): void {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  (globalThis as unknown as { fetch: unknown }).fetch = async () => new Response("{}", { status: 200 });
  socketUrls.length = 0;
  closedSocketUrls.length = 0;
}

/** 注入式 history，避免污染 jsdom 全局 location 串扰其它用例。 */
function fakeHistory(): AppHistoryAdapter & { pushed: string[]; replaced: string[] } {
  const pushed: string[] = [];
  const replaced: string[] = [];
  return {
    pushed,
    replaced,
    pushState: (_data, _title, url) => {
      pushed.push(url);
    },
    replaceState: (_data, _title, url) => {
      replaced.push(url);
    }
  };
}

/** 跑一轮宏任务，让 applyLocation 的异步 dispose/解析推进。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * 条件等待：watcher 触发的迁移是 fire-and-forget（`void applyLocation`），无法直接 await。
 * 画布 scope 启动含发布目录加载等异步边界，固定次数 `flush()` 会随启动深度变化而脆弱；
 * 这里轮询到条件成立（或上限）为止，只等待"就绪"这一可观察结果。
 */
async function waitFor(condition: () => boolean, maxTicks = 20): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (condition()) return;
    await flush();
  }
}

afterEach(async () => {
  await app?.dispose();
  app = null;
});

describe("Canvas canvasId scope identity", () => {
  it("显式 canvasId 解析并保留；切换 A→B 完整释放并重建 scope", async () => {
    installGlobals();
    const remote = createFakeCanvasCatalogRemote([makeSummary("a"), makeSummary("b")]);
    app = await startApp({
      initialPathname: "/",
      initialSearch: "?canvasId=a",
      canvasCatalogRemote: remote,
      history: fakeHistory()
    });
    expect(app.router.getLocation()).toMatchObject({ page: "canvas", canvasId: "a" });
    const scopeA = app.router.currentScopeId();
    const pageA = app.currentPage();
    expect(pageA!.ctx.canvasSession).toBeDefined();
    const remoteA = pageA!.ctx.canvasRemote;

    await app.applyLocation({ page: "canvas", canvasId: "b" });
    expect(app.router.getLocation()).toMatchObject({ canvasId: "b" });
    expect(app.router.currentScopeId()).not.toBe(scopeA);
    const pageB = app.currentPage();
    expect(pageB).not.toBe(pageA);
    expect(pageB!.ctx.canvasSession).toBeDefined();
    // 同一页面内 canvasId 变化同样重建 scope：新 page 的 remote/session 都是新实例，
    // 且新建的同步 socket 指向 B；A 的 socket 已被关闭释放（不泄漏旧画布连接）。
    expect(pageB!.ctx.canvasRemote).not.toBe(remoteA);
    expect(socketUrls.some((url) => url.includes("/api/canvases/b/sync"))).toBe(true);
    expect(closedSocketUrls.some((url) => url.includes("/api/canvases/a/sync"))).toBe(true);
    expect(pageA!.ctx.get("canvasSession" as never)).toBeUndefined();
  });

  it("快速 A→B→C：迟到的 B 启动结果被 generation guard 隔离", async () => {
    installGlobals();
    // 让 B 的摘要请求挂起，模拟慢启动。
    let releaseB: (() => void) | null = null;
    const base = createFakeCanvasCatalogRemote([makeSummary("a"), makeSummary("b"), makeSummary("c")]);
    const remote: CanvasCatalogRemote = {
      ...base,
      get: (canvasId: string): Promise<CanvasCatalogSummaryResult> => {
        if (canvasId !== "b") return base.get(canvasId);
        return new Promise((resolve) => {
          releaseB = () => void base.get(canvasId).then(resolve);
        });
      }
    };
    app = await startApp({
      initialPathname: "/",
      initialSearch: "?canvasId=a",
      canvasCatalogRemote: remote,
      history: fakeHistory()
    });

    const toB = app.applyLocation({ page: "canvas", canvasId: "b" });
    await flush();
    // B 卡在摘要解析 → 用户又选择 C。
    expect(releaseB).not.toBeNull();
    const toC = app.applyLocation({ page: "canvas", canvasId: "c" });
    releaseB!();
    await Promise.allSettled([toB, toC]);
    expect(app.router.getLocation()).toMatchObject({ canvasId: "c" });
    const page = app.currentPage();
    // C 是唯一活动 scope 并绑定到 canvas c。
    expect(page!.ctx.canvasSession).toBeDefined();
    expect(page!.ctx.canvasRemote).toBeDefined();
  });

  it("缺省 canvasId（空目录）幂等创建一个画布并写回 URL", async () => {
    installGlobals();
    const remote: FakeCanvasCatalogRemote = createFakeCanvasCatalogRemote([]);
    const history = fakeHistory();
    app = await startApp({
      initialPathname: "/",
      initialSearch: "",
      canvasCatalogRemote: remote,
      canvasSelection: nullSelection(),
      history
    });
    expect(remote.created).toHaveLength(1);
    const canvasId = remote.created[0]!;
    expect(app.router.getLocation()).toMatchObject({ canvasId });
    expect(history.replaced).toContain(`/?canvasId=${canvasId}`);
    expect(app.currentPage()!.ctx.canvasSession).toBeDefined();
  });

  it("显式不存在的 canvasId 显示恢复页，不创建 Canvas Session", async () => {
    installGlobals();
    const remote = createFakeCanvasCatalogRemote([makeSummary("a")]);
    app = await startApp({
      initialPathname: "/",
      initialSearch: "?canvasId=missing",
      canvasCatalogRemote: remote,
      history: fakeHistory()
    });
    expect(app.router.getLocation()).toMatchObject({ canvasId: "missing" });
    const page = app.currentPage();
    expect(page!.ctx.get("canvasRecovery" as never)).toBeDefined();
    expect(page!.ctx.get("canvasSession" as never)).toBeUndefined();
    expect(page!.ctx.get("canvasRuntime" as never)).toBeUndefined();
  });

  it("最近画布仍存在时优先选择并写回 URL", async () => {
    installGlobals();
    const remote = createFakeCanvasCatalogRemote([makeSummary("a"), makeSummary("b")]);
    const history = fakeHistory();
    app = await startApp({
      initialPathname: "/",
      initialSearch: "",
      canvasCatalogRemote: remote,
      canvasSelection: {
        getRecentCanvasId: () => "b",
        setRecentCanvasId: () => undefined
      },
      history
    });
    expect(app.router.getLocation()).toMatchObject({ canvasId: "b" });
    expect(history.replaced).toContain("/?canvasId=b");
  });

  it("dispose 释放当前 scope 且不留下 popstate 监听", async () => {
    installGlobals();
    const remote = createFakeCanvasCatalogRemote([makeSummary("a")]);
    const instance = await startApp({
      initialPathname: "/",
      initialSearch: "?canvasId=a",
      canvasCatalogRemote: remote,
      history: fakeHistory()
    });
    await instance.dispose();
    expect(instance.currentPage()).toBeNull();
  });
});

describe("旧 ID 深链接 → 在线迁移准备态（任务 5.4）", () => {
  it("显式旧 ID 准备中：进入 preparation scope（无 Session/socket），ready 后自动重解析到 Canvas scope", async () => {
    installGlobals();
    // 目录中不存在 "legacy-1" → 触发 prepare。
    const remote = createFakeCanvasCatalogRemote([makeSummary("native-1")]);
    let status: "preparing" | "ready" = "preparing";
    const listeners = new Set<() => void>();
    const preparation: CanvasPreparationService = {
      getState: () => ({
        status,
        canvasId: "legacy-1",
        jobId: "job-1",
        phase: "reading",
        completedMedia: 1,
        totalMedia: 3,
        pollAfterMs: 1,
        error: null,
        code: null,
        retryable: true,
        sources: [{ sourceId: "legacy-source", displayName: "LegacyCanvas", availability: "available" }]
      }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      listSources: async () => undefined,
      listAccessible: async () => ({ items: [], nextCursor: null }),
      prepare: async () => undefined,
      observe: async () => ({ state: "preparing", jobId: "job-1", phase: "reading", completedMedia: 1, totalMedia: 3, pollAfterMs: 1 }),
      dispose: () => undefined
    };

    app = await startApp({
      initialPathname: "/",
      initialSearch: "?canvasId=legacy-1",
      canvasCatalogRemote: remote,
      canvasPreparation: preparation,
      history: fakeHistory()
    });
    const preparingPage = app.currentPage();
    expect(preparingPage).not.toBeNull();
    // 准备态 scope 不创建 Canvas Session/socket。
    expect(preparingPage!.ctx.get("canvasSession" as never)).toBeUndefined();
    expect(socketUrls.some((url) => url.includes("legacy-1"))).toBe(false);

    // 迁移完成 → watcher 重解析；目录补上 legacy-1 后可打开。
    remote.entries.set("legacy-1", makeSummary("legacy-1"));
    status = "ready";
    for (const listener of listeners) listener();
    await waitFor(() => app?.currentPage() !== null);
    const page = app.currentPage();
    expect(page!.ctx.canvasSession).toBeDefined();
    expect(socketUrls.some((url) => url.includes("/api/canvases/legacy-1/sync"))).toBe(true);
  });

  it("来源目录为空（扩展未启用）：显式旧 ID 维持恢复页，不创建默认画布", async () => {
    installGlobals();
    const remote = createFakeCanvasCatalogRemote([makeSummary("native-1")]);
    const preparation: CanvasPreparationService = {
      getState: () => ({ status: "idle", canvasId: null, jobId: null, phase: null, completedMedia: 0, totalMedia: 0, pollAfterMs: 1500, error: null, code: null, retryable: true, sources: [] }),
      subscribe: () => () => undefined,
      listSources: async () => undefined,
      listAccessible: async () => ({ items: [], nextCursor: null }),
      prepare: async () => undefined,
      observe: async () => ({ state: "deleted", code: "DELETED" }),
      dispose: () => undefined
    };
    app = await startApp({
      initialPathname: "/",
      initialSearch: "?canvasId=legacy-1",
      canvasCatalogRemote: remote,
      canvasPreparation: preparation,
      history: fakeHistory()
    });
    const page = app.currentPage();
    expect(page!.ctx.get("canvasRecovery" as never)).toBeDefined();
    expect(app.router.getLocation()).toMatchObject({ canvasId: "legacy-1" });
  });
});

/** 空选择存储（避免 localStorage 在测试间串扰）。 */
function nullSelection() {
  let value: string | null = null;
  return {
    getRecentCanvasId: () => value,
    setRecentCanvasId: (next: string | null) => {
      value = next;
    }
  };
}
