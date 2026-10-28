/**
 * Canvas Catalog Store 单测
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 2.4）。
 */
import { describe, expect, it } from "vitest";
import type { CanvasSummary } from "@woohaa3/contracts";
import { CanvasCatalogStore } from "./canvas-catalog-store.js";
import type {
  CanvasCatalogCreateResult,
  CanvasCatalogListResult,
  CanvasCatalogRemote,
  CanvasCatalogSummaryResult
} from "../contract/canvas-catalog.js";

function summary(id: string, title = id): CanvasSummary {
  return {
    id,
    title,
    revision: 1,
    updatedAt: "2026-09-29T00:00:00.000Z",
    createdAt: "2026-09-29T00:00:00.000Z",
    nodeCount: 0,
    assetCount: 0
  };
}

/** 可编程 fake remote：记录调用并按提供的结果解析。 */
function fakeRemote(script: {
  list?: (input: { offset: number; limit: number }) => Promise<CanvasCatalogListResult>;
  get?: (canvasId: string) => Promise<CanvasCatalogSummaryResult>;
  create?: (input: { canvasId?: string; title?: string }) => Promise<CanvasCatalogCreateResult>;
}): CanvasCatalogRemote {
  return {
    list: script.list ?? (async (input) => ({ ok: true, entries: [], total: 0, offset: input.offset, limit: input.limit })),
    get: script.get ?? (async (canvasId) => ({ ok: true, summary: detail(canvasId) })),
    create: script.create ?? (async () => ({ ok: true, canvasId: "created", revision: 1, title: "" })),
    exportArchive: async (canvasId) => ({
      ok: true,
      bytes: new Uint8Array(),
      filename: `${canvasId}.woohaa-archive`,
      missingMedia: 0
    }),
    importArchive: async () => ({ ok: true, importedCanvasIds: [], replacedCanvasIds: [], mediaWritten: 0 })
  };
}

function detail(id: string, title = id) {
  const { createdAt, ...rest } = summary(id, title);
  void createdAt;
  return rest;
}

describe("CanvasCatalogStore", () => {
  it("加载第一页并缓存（重复 load 命中缓存）", async () => {
    let calls = 0;
    const store = new CanvasCatalogStore({
      remote: fakeRemote({
        list: async (input) => {
          calls += 1;
          return { ok: true, entries: [summary("a")], total: 1, offset: input.offset, limit: input.limit };
        }
      })
    });
    await store.load();
    await store.load();
    expect(calls).toBe(1);
    expect(store.getState().entries.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("空目录返回 ready 且 total=0", async () => {
    const store = new CanvasCatalogStore({ remote: fakeRemote({}) });
    const result = await store.load();
    expect(result.ok).toBe(true);
    expect(store.getState()).toMatchObject({ status: "ready", total: 0, entries: [] });
  });

  it("错误进入 error 状态并保留安全信息", async () => {
    const store = new CanvasCatalogStore({
      remote: fakeRemote({ list: async () => ({ ok: false, code: "REPOSITORY_FAILURE", error: "服务内部错误" }) })
    });
    await store.load();
    expect(store.getState()).toMatchObject({ status: "error", error: "服务内部错误" });
  });

  it("loadMore 追加下一页并去重", async () => {
    const pages = [
      { entries: [summary("a")], total: 2, offset: 0, limit: 1 },
      { entries: [summary("a"), summary("b")], total: 2, offset: 1, limit: 1 }
    ];
    let index = 0;
    const store = new CanvasCatalogStore({
      pageSize: 1,
      remote: fakeRemote({
        list: async () => {
          const page = pages[Math.min(index, pages.length - 1)]!;
          index += 1;
          return { ok: true, ...page };
        }
      })
    });
    await store.load();
    await store.loadMore();
    expect(store.getState().entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("create 成功后失效并刷新目录", async () => {
    let listCalls = 0;
    const store = new CanvasCatalogStore({
      remote: fakeRemote({
        list: async (input) => {
          listCalls += 1;
          return { ok: true, entries: [summary("new")], total: 1, offset: input.offset, limit: input.limit };
        },
        create: async () => ({ ok: true, canvasId: "new", revision: 1, title: "" })
      })
    });
    const created = await store.create({ title: "新画布" });
    expect(created.ok).toBe(true);
    expect(listCalls).toBe(1);
    expect(store.getState().entries.map((entry) => entry.id)).toEqual(["new"]);
  });

  it("dispose 后迟到结果不发布", async () => {
    let resolveList: ((value: CanvasCatalogListResult) => void) | null = null;
    const store = new CanvasCatalogStore({
      remote: fakeRemote({
        list: () => new Promise<CanvasCatalogListResult>((resolve) => {
          resolveList = resolve;
        })
      })
    });
    const pending = store.load();
    store.dispose();
    resolveList!({ ok: true, entries: [summary("late")], total: 1, offset: 0, limit: 20 });
    await pending;
    expect(store.getState().entries).toEqual([]);
    expect(store.getState().status).toBe("idle");
  });

  it("较新的刷新取代旧请求，旧响应不覆盖", async () => {
    const resolvers: Array<(value: CanvasCatalogListResult) => void> = [];
    const store = new CanvasCatalogStore({
      remote: fakeRemote({
        list: () => new Promise<CanvasCatalogListResult>((resolve) => {
          resolvers.push(resolve);
        })
      })
    });
    void store.load(true);
    void store.load(true);
    resolvers[0]!({ ok: true, entries: [summary("stale")], total: 1, offset: 0, limit: 20 });
    resolvers[1]!({ ok: true, entries: [summary("fresh")], total: 1, offset: 0, limit: 20 });
    await Promise.resolve();
    expect(store.getState().entries.map((entry) => entry.id)).toEqual(["fresh"]);
  });
});
