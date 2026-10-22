/**
 * Snippet Catalog Service 测试
 * （change: add-prompt-snippet-library，任务 2.3/2.4）。
 */
import { describe, expect, it, vi } from "vitest";
import type { CanvasRemoteService } from "@woohaa3/frontend/extension-api";
import { createSnippetCatalog } from "../src/frontend/catalog.js";
import type { PromptSnippet } from "@woohaa3/contracts";

function snippet(id: string): PromptSnippet {
  return {
    id,
    formatVersion: 1,
    builtIn: false,
    name: id,
    body: "body",
    materials: [],
    tagIds: [],
    revision: 1,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z"
  };
}

function makeRemote(overrides: Partial<CanvasRemoteService> = {}): CanvasRemoteService {
  return {
    listSnippets: vi.fn(async () => ({ ok: true as const, value: { items: [snippet("s1")], nextCursor: null, total: 1 } })),
    getSnippet: vi.fn(async () => ({ ok: true as const, value: snippet("s1") })),
    createSnippet: vi.fn(async () => ({ ok: true as const, value: snippet("new") })),
    updateSnippet: vi.fn(async () => ({ ok: true as const, value: snippet("s1") })),
    deleteSnippet: vi.fn(async () => ({ ok: true as const, value: null })),
    listSnippetTags: vi.fn(async () => ({ ok: true as const, value: [] })),
    createSnippetTag: vi.fn(async () => ({ ok: true as const, value: { id: "t1", name: "t", builtIn: false, revision: 1, createdAt: "", updatedAt: "" } })),
    renameSnippetTag: vi.fn(async () => ({ ok: true as const, value: { id: "t1", name: "t2", builtIn: false, revision: 2, createdAt: "", updatedAt: "" } })),
    deleteSnippetTag: vi.fn(async () => ({ ok: true as const, value: null })),
    resolveSnippetMaterial: vi.fn(async () => ({ ok: true as const, value: { storageKey: "sha256-x", resolvable: true } })),
    ...overrides
  } as unknown as CanvasRemoteService;
}

describe("createSnippetCatalog", () => {
  it("refresh 载入片段与标签", async () => {
    const catalog = createSnippetCatalog({ remote: makeRemote(), debounceMs: 0 });
    await catalog.refresh();
    expect(catalog.getState().status).toBe("ready");
    expect(catalog.getState().items).toHaveLength(1);
    expect(catalog.getTagState().status).toBe("ready");
  });

  it("查询失败呈现可诊断错误而非空目录", async () => {
    const catalog = createSnippetCatalog({
      remote: makeRemote({ listSnippets: vi.fn(async () => ({ ok: false, code: "unavailable", error: "boom" })) as never }),
      debounceMs: 0
    });
    await catalog.refresh();
    expect(catalog.getState().status).toBe("error");
    expect(catalog.getState().error).toBe("boom");
  });

  it("setQuery 防抖后重新查询", async () => {
    vi.useFakeTimers();
    const listSnippets = vi.fn(async () => ({ ok: true as const, value: { items: [], nextCursor: null, total: 0 } }));
    const catalog = createSnippetCatalog({ remote: makeRemote({ listSnippets: listSnippets as never }), debounceMs: 10 });
    catalog.setQuery("猫");
    expect(listSnippets).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15);
    expect(listSnippets).toHaveBeenCalledTimes(1);
    expect(listSnippets).toHaveBeenCalledWith(expect.objectContaining({ query: "猫" }));
    catalog.dispose();
    vi.useRealTimers();
  });

  it("dispose 后迟到结果不覆盖状态", async () => {
    const deferred: {
      resolve: (value: { ok: true; value: { items: PromptSnippet[]; nextCursor: null; total: number } }) => void;
    } = { resolve: () => undefined };
    const catalog = createSnippetCatalog({
      remote: makeRemote({
        listSnippets: (() =>
          new Promise((resolve) => {
            deferred.resolve = resolve as never;
          })) as never
      }),
      debounceMs: 0
    });
    const pending = catalog.refresh();
    catalog.dispose();
    deferred.resolve({ ok: true, value: { items: [snippet("late")], nextCursor: null, total: 1 } });
    await pending;
    expect(catalog.getState().status).not.toBe("ready");
    expect(catalog.getState().items).toEqual([]);
  });

  it("update 局部替换条目并保留列表", async () => {
    const remote = makeRemote({
      listSnippets: vi.fn(async () => ({ ok: true as const, value: { items: [snippet("s1"), snippet("s2")], nextCursor: null, total: 2 } })),
      updateSnippet: vi.fn(async () => ({ ok: true as const, value: { ...snippet("s1"), name: "updated", revision: 2 } }))
    });
    const catalog = createSnippetCatalog({ remote, debounceMs: 0 });
    await catalog.refresh();
    const result = await catalog.updateSnippet({ snippetId: "s1", expectedRevision: 1, name: "updated", body: "body", materials: [], tagIds: [] });
    expect(result.ok).toBe(true);
    expect(catalog.getState().items.find((item) => item.id === "s1")?.name).toBe("updated");
    expect(catalog.getState().items).toHaveLength(2);
  });

  it("revision conflict 原样返回稳定错误码", async () => {
    const catalog = createSnippetCatalog({
      remote: makeRemote({
        updateSnippet: vi.fn(async () => ({ ok: false, code: "SNIPPET_REVISION_CONFLICT", error: "冲突" })) as never
      }),
      debounceMs: 0
    });
    const result = await catalog.updateSnippet({ snippetId: "s1", expectedRevision: 1, name: "x", body: "y", materials: [], tagIds: [] });
    expect(result).toMatchObject({ ok: false, code: "SNIPPET_REVISION_CONFLICT" });
  });
});
