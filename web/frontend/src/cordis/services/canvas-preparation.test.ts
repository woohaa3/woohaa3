/**
 * 首次打开准备 remote/store 测试
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 5.1、5.5）。
 *
 * 覆盖：来源目录/作品分页解码、prepare 显式触发、status 轮询收敛、迟到响应隔离（切换画布
 * 不污染新 scope）、abort/dispose 后不发布、410 DELETED 解析、malformed 响应。
 */
import { describe, expect, it } from "vitest";
import { createCanvasPreparationRemote } from "./canvas-preparation-remote.js";
import { CanvasPreparationStore, initialPreparationState } from "./canvas-preparation-store.js";
import type { CanvasPreparationRemote } from "../contract/canvas-preparation.js";

function fetchImpl(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SOURCE = { sourceId: "legacy-source", displayName: "LegacyCanvas", availability: "available" as const };

describe("createCanvasPreparationRemote（任务 5.1）", () => {
  it("listSources 解码受认证来源目录", async () => {
    const remote = createCanvasPreparationRemote({ fetchImpl: fetchImpl(() => json({ sources: [SOURCE] })) });
    expect(await remote.listSources()).toEqual({ ok: true, sources: [SOURCE] });
  });

  it("listAccessible 发送 cursor/limit 并解码分页", async () => {
    const urls: string[] = [];
    const remote = createCanvasPreparationRemote({
      fetchImpl: fetchImpl((url) => {
        urls.push(url);
        return json({ items: [], nextCursor: "c2" });
      })
    });
    const result = await remote.listAccessible({ sourceId: "legacy-source", cursor: "c1", limit: 5 });
    expect(result).toEqual({ ok: true, page: { items: [], nextCursor: "c2" } });
    expect(urls[0]).toBe("/api/canvas-sources/legacy-source/canvases?cursor=c1&limit=5");
  });

  it("status 解析 202 preparing / 200 ready / 410 deleted", async () => {
    const preparing = createCanvasPreparationRemote({
      fetchImpl: fetchImpl(() => json({ state: "preparing", jobId: "j1", phase: "reading", completedMedia: 1, totalMedia: 2, pollAfterMs: 1500 }, 202))
    });
    expect(await preparing.status("legacy-1")).toMatchObject({ ok: true, state: { state: "preparing", jobId: "j1" } });

    const ready = createCanvasPreparationRemote({
      fetchImpl: fetchImpl(() => json({ state: "ready", canvasId: "legacy-1", revision: 1 }))
    });
    expect(await ready.status("legacy-1")).toMatchObject({ ok: true, state: { state: "ready" } });

    const deleted = createCanvasPreparationRemote({
      fetchImpl: fetchImpl(() => json({ state: "deleted", code: "DELETED" }, 410))
    });
    expect(await deleted.status("legacy-1")).toEqual({ ok: true, state: { state: "deleted", code: "DELETED" } });
  });

  it("malformed 响应不泄漏、返回稳定 code", async () => {
    const remote = createCanvasPreparationRemote({ fetchImpl: fetchImpl(() => json({ sources: "nope" })) });
    expect(await remote.listSources()).toEqual({ ok: false, code: "malformed-response", error: "来源目录响应形态非法" });
  });

  it("来源目录/分页/prepare/status 都不附加管理员令牌，只走同源会话", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers }> = [];
    const impl = fetchImpl((url, init) => {
      calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      if (url === "/api/canvas-sources") return json({ sources: [SOURCE] });
      if (url.includes("/canvases?") && url.startsWith("/api/canvas-sources/")) return json({ items: [], nextCursor: null });
      if (url.endsWith("/preparation")) return json({ state: "ready", canvasId: "c1", revision: 1 });
      return json({ state: "preparing", jobId: "j1", phase: "reading", completedMedia: 0, totalMedia: 1, pollAfterMs: 1500 }, 202);
    });

    const remote = createCanvasPreparationRemote({ fetchImpl: impl });
    await remote.listSources();
    await remote.listAccessible({ sourceId: "legacy-source", cursor: "c1", limit: 5 });
    await remote.status("c1");
    await remote.prepare({ canvasId: "c1", sourceId: "legacy-source" });

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.headers.has("x-woohaa3-admin-token")).toBe(false);
    }
    expect(calls.some((call) => call.url === "/api/dev-admin")).toBe(false);
  });
});

describe("CanvasPreparationStore（任务 5.5）", () => {
  const noSleep = async () => undefined;

  function store(remote: CanvasPreparationRemote, overrides: { maxPollAttempts?: number } = {}) {
    return new CanvasPreparationStore({
      remote,
      sleep: noSleep,
      ...(overrides.maxPollAttempts !== undefined ? { maxPollAttempts: overrides.maxPollAttempts } : {})
    });
  }

  it("observe：status preparing → ready 收敛，进度发布", async () => {
    let calls = 0;
    const remote = {
      listSources: async () => ({ ok: true as const, sources: [SOURCE] }),
      listAccessible: async () => ({ ok: true as const, page: { items: [], nextCursor: null } }),
      prepare: async () => ({ ok: true as const, state: { state: "preparing" as const, jobId: "j1", phase: "reading" as const, completedMedia: 0, totalMedia: 2, pollAfterMs: 1 } }),
      status: async () => {
        calls += 1;
        return calls < 2
          ? { ok: true as const, state: { state: "preparing" as const, jobId: "j1", phase: "reading" as const, completedMedia: 1, totalMedia: 2, pollAfterMs: 1 } }
          : { ok: true as const, state: { state: "ready" as const, canvasId: "legacy-1", revision: 1 } };
      }
    } satisfies CanvasPreparationRemote;
    const s = store(remote);
    const snapshots: string[] = [];
    s.subscribe(() => snapshots.push(s.getState().status));
    const final = await s.observe({ canvasId: "legacy-1" });
    expect(final).toEqual({ state: "ready", canvasId: "legacy-1", revision: 1 });
    expect(s.getState().status).toBe("ready");
    expect(snapshots).toContain("preparing");
  });

  it("prepare：显式 POST 后进入后台轮询，订阅者观察到 ready", async () => {
    const posts: Array<{ canvasId: string; sourceId?: string }> = [];
    const remote = {
      listSources: async () => ({ ok: true as const, sources: [SOURCE] }),
      listAccessible: async () => ({ ok: true as const, page: { items: [], nextCursor: null } }),
      prepare: async (input) => {
        posts.push(input);
        return { ok: true as const, state: { state: "preparing" as const, jobId: "j1", phase: "admitted" as const, completedMedia: 0, totalMedia: 0, pollAfterMs: 1 } };
      },
      status: async () => ({ ok: true as const, state: { state: "ready" as const, canvasId: "legacy-1", revision: 1 } })
    } satisfies CanvasPreparationRemote;
    const s = store(remote);
    const statuses: string[] = [];
    s.subscribe(() => statuses.push(s.getState().status));
    await s.prepare({ canvasId: "legacy-1", sourceId: "legacy-source" });
    expect(posts).toEqual([{ canvasId: "legacy-1", sourceId: "legacy-source" }]);
    // prepare 已在 POST 后返回；后台轮询由订阅发布 ready。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.getState().status).toBe("ready");
    expect(statuses).toContain("ready");
  });

  it("切换画布隔离迟到响应：旧 observe 不覆盖新 scope 状态", async () => {
    let releaseOld: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const remote = {
      listSources: async () => ({ ok: true as const, sources: [SOURCE] }),
      listAccessible: async () => ({ ok: true as const, page: { items: [], nextCursor: null } }),
      prepare: async () => ({ ok: true as const, state: { state: "preparing" as const, jobId: "j1", phase: "admitted" as const, completedMedia: 0, totalMedia: 0, pollAfterMs: 1 } }),
      status: async (canvasId) => {
        if (canvasId === "old") {
          await gate;
          return { ok: true as const, state: { state: "ready" as const, canvasId: "old", revision: 1 } };
        }
        return { ok: true as const, state: { state: "ready" as const, canvasId: "new", revision: 1 } };
      }
    } satisfies CanvasPreparationRemote;
    const s = store(remote);
    const oldRun = s.observe({ canvasId: "old" });
    // 切换：新画布 observe 使旧 serial 失效。
    const newRun = await s.observe({ canvasId: "new" });
    expect(newRun).toEqual({ state: "ready", canvasId: "new", revision: 1 });
    releaseOld!();
    await oldRun;
    expect(s.getState().canvasId).toBe("new");
  });

  it("dispose 后不发布迟到结果且状态复位 idle", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const remote = {
      listSources: async () => ({ ok: true as const, sources: [] }),
      listAccessible: async () => ({ ok: true as const, page: { items: [], nextCursor: null } }),
      prepare: async () => ({ ok: true as const, state: { state: "preparing" as const, jobId: "j1", phase: "admitted" as const, completedMedia: 0, totalMedia: 0, pollAfterMs: 1 } }),
      status: async () => {
        await gate;
        return { ok: true as const, state: { state: "ready" as const, canvasId: "legacy-1", revision: 1 } };
      }
    } satisfies CanvasPreparationRemote;
    const s = store(remote);
    const run = s.observe({ canvasId: "legacy-1" });
    s.dispose();
    release!();
    await run;
    expect(s.getState()).toEqual(initialPreparationState());
  });

  it("deleted 结论态不轮询", async () => {
    let statusCalls = 0;
    const remote = {
      listSources: async () => ({ ok: true as const, sources: [] }),
      listAccessible: async () => ({ ok: true as const, page: { items: [], nextCursor: null } }),
      prepare: async () => ({ ok: true as const, state: { state: "deleted" as const, code: "DELETED" as const } }),
      status: async () => {
        statusCalls += 1;
        return { ok: true as const, state: { state: "deleted" as const, code: "DELETED" as const } };
      }
    } satisfies CanvasPreparationRemote;
    const s = store(remote);
    const result = await s.observe({ canvasId: "legacy-1" });
    expect(result).toEqual({ state: "deleted", code: "DELETED" });
    expect(statusCalls).toBe(1);
    expect(s.getState().status).toBe("deleted");
  });

  it("listSources 缓存：重复调用只请求一次，force 强制刷新", async () => {
    let calls = 0;
    const remote = {
      listSources: async () => {
        calls += 1;
        return { ok: true as const, sources: [SOURCE] };
      },
      listAccessible: async () => ({ ok: true as const, page: { items: [], nextCursor: null } }),
      prepare: async () => ({ ok: true as const, state: { state: "preparing" as const, jobId: "j1", phase: "admitted" as const, completedMedia: 0, totalMedia: 0, pollAfterMs: 1 } }),
      status: async () => ({ ok: true as const, state: { state: "ready" as const, canvasId: "c", revision: 1 } })
    } satisfies CanvasPreparationRemote;
    const s = store(remote);
    await s.listSources();
    await s.listSources();
    expect(calls).toBe(1);
    await s.listSources(true);
    expect(calls).toBe(2);
  });
});
