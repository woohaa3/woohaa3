/**
 * 节点历史 feature 客户端状态测试
 * （change: add-canvas-node-generation-history，任务 3.2 / 3.3 / 3.4）。
 *
 * 覆盖：打开/关闭、空态、分页合并去重、迟到响应丢弃、applying/回流 current、目标清理。
 */
import { describe, expect, it } from "vitest";
import type { NodeGenerationHistoryListItem } from "@woohaa3/contracts";
import { NodeHistoryController, type NodeHistoryClient } from "./controller.js";

function item(entryId: string, overrides: Partial<NodeGenerationHistoryListItem> = {}): NodeGenerationHistoryListItem {
  return {
    entryId,
    kind: "text",
    createdAt: "2026-09-27T00:00:00.000Z",
    current: false,
    recoverable: true,
    previewable: true,
    source: { label: "文本生成" },
    preview: { kind: "text", excerpt: "x" },
    ...overrides
  };
}

function fakeClient(overrides: Partial<NodeHistoryClient> = {}): NodeHistoryClient {
  return {
    list: async () => ({ ok: true, items: [], nextCursor: null }),
    detail: async ({ entryId }) => ({
      ok: true,
      detail: { entryId, kind: "text", text: "full" }
    }),
    apply: async () => ({ ok: true }),
    previewUrl: () => "/preview",
    ...overrides
  };
}

describe("NodeHistoryController", () => {
  it("a stale initial page cannot overwrite a newer archive refresh", async () => {
    let release!:(result:Awaited<ReturnType<NodeHistoryClient["list"]>>)=>void;
    let calls=0;
    const controller=new NodeHistoryController(fakeClient({list:async()=>++calls===1 ? new Promise(resolve=>{release=resolve;}) : {ok:true,items:[item("new")],nextCursor:"new-cursor"}}));
    const opening=controller.open({canvasId:"c1",nodeId:"n1",kind:"text",writable:true});
    await controller.refresh();
    release({ok:true,items:[],nextCursor:null});await opening;
    expect(controller.getState()?.items.map(item=>item.entryId)).toEqual(["new"]);
    expect(controller.getState()?.nextCursor).toBe("new-cursor");
  });
  it("keeps old pages, opaque cursor and selection while activity hands off to archive", async () => {
    let head = [item("old", { createdAt: "2026-01-01" })];
    const controller = new NodeHistoryController(fakeClient({
      list: async ({ cursor }) => ({ ok: true, items: cursor ? [item("older", { createdAt: "2025-01-01" })] : head, nextCursor: cursor ? "opaque-second" : "opaque-first" })
    }));
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    await controller.loadMore();
    await controller.select("older");
    const record = { canvasId: "c1", nodeId: "n1", operationId: "run", state: "running" as const, kind: "text" as const, owner: "server" as const, createdAt: "2026-10-20", updatedAt: "2026-10-20" };
    controller.setOperations([record]);
    expect(controller.getState()?.selectedEntryId).toBe("older");
    await controller.select("operation:run");
    controller.setOperations([{ ...record, state: "succeeded" }]);
    head = [item("archive", { createdAt: record.createdAt, source: { label: "generation", runId: "run" } })];
    await controller.refresh();
    await Promise.resolve();
    expect(controller.getState()?.items.map(item => item.entryId)).toEqual(["archive", "old", "older"]);
    expect(controller.getState()?.nextCursor).toBe("opaque-second");
    expect(controller.getState()?.presentations.filter(item => item.operationId === "run")).toHaveLength(1);
    expect(controller.getState()?.selectedEntryId).toBe("operation:run");
    expect(controller.getState()?.detail?.entryId).toBe("archive");
  });

  it("failure viewing only reads detail; failure restore never calls apply", async () => {
    let calls = 0;
    const controller = new NodeHistoryController(fakeClient({
      list: async () => ({ ok: true, items: [item("failed", { outcome: "failed", recoverable: false })], nextCursor: null }),
      apply: async () => { calls++; return { ok: true }; }
    }));
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: false });
    await controller.select("failed");
    expect(controller.getState()?.selectedEntryId).toBe("failed");
    expect((await controller.apply("failed")).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it("打开空历史进入 empty；关闭清除状态", async () => {
    const controller = new NodeHistoryController(fakeClient());
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    expect(controller.getState()?.status).toBe("empty");
    controller.close();
    expect(controller.getState()).toBeNull();
  });

  it("固定 current 首项始终存在且独立于 entryId", async () => {
    const controller = new NodeHistoryController(fakeClient());
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    const state = controller.getState()!;
    expect(state.current.kind).toBe("current");
    expect(state.selectedEntryId).toBe("__current__");
    // 首项不参与 items/total。
    expect(state.items.every((entry) => entry.entryId !== "__current__")).toBe(true);
    // 无历史也有首项。
    expect(state.status).toBe("empty");
  });

  it("选择固定首项不读取详情", async () => {
    let detailCalls = 0;
    const controller = new NodeHistoryController(fakeClient({
      list: async () => ({ ok: true, items: [item("a")], nextCursor: null }),
      detail: async ({ entryId }) => {
        detailCalls += 1;
        return { ok: true as const, detail: { entryId, kind: "text", text: "full" } };
      }
    }));
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    await controller.select("a");
    expect(detailCalls).toBe(1);
    await controller.select("__current__");
    expect(detailCalls).toBe(1); // 首项不读取详情
    expect(controller.getState()?.selectedEntryId).toBe("__current__");
  });

  it("setCurrentPresentation 更新草稿状态而不改 entryId/cursor", async () => {
    const controller = new NodeHistoryController(fakeClient({ list: async () => ({ ok: true, items: [item("a")], nextCursor: "c" }) }));
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    const before = controller.getState()!;
    controller.setCurrentPresentation({ draftState: "unsaved", hasOutput: true });
    const after = controller.getState()!;
    expect(after.current.draftState).toBe("unsaved");
    expect(after.nextCursor).toBe(before.nextCursor);
    expect(after.items.map((entry) => entry.entryId)).toEqual(before.items.map((entry) => entry.entryId));
  });

  it("加载更多合并并去重", async () => {
    const pages: Record<string, { items: NodeGenerationHistoryListItem[]; nextCursor: string | null }> = {
      first: { items: [item("a"), item("b")], nextCursor: "cursor-1" },
      "cursor-1": { items: [item("b"), item("c")], nextCursor: null }
    };
    const controller = new NodeHistoryController(fakeClient({
      list: async (input) => ({ ok: true, ...(input.cursor ? pages[input.cursor]! : pages.first!) })
    }));
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    expect(controller.getState()?.items).toHaveLength(2);
    await controller.loadMore();
    expect(controller.getState()?.items.map((entry) => entry.entryId)).toEqual(["a", "b", "c"]);
  });

  it("迟到详情不覆盖新的选择（generation 丢弃）", async () => {
    let resolveFirst: ((value: { ok: true; detail: { entryId: string; kind: "text"; text: string } }) => void) | null = null;
    const client = fakeClient({
      detail: (input) => new Promise((resolve) => {
        if (input.entryId === "a") {
          resolveFirst = resolve as never;
        } else {
          resolve({ ok: true, detail: { entryId: "b", kind: "text", text: "newer" } });
        }
      })
    });
    const controller = new NodeHistoryController(client);
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    void controller.select("a");
    await controller.select("b");
    // 迟到的 a 结果到达：不应覆盖 b。
    (resolveFirst as unknown as ((value: unknown) => void) | null)?.({
      ok: true,
      detail: { entryId: "a", kind: "text", text: "stale" }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getState()?.selectedEntryId).toBe("b");
    expect((controller.getState()?.detail as { text?: string } | null)?.text).toBe("newer");
  });

  it("恢复成功立即标记当前并结束恢复中，不依赖回流", async () => {
    const controller = new NodeHistoryController(fakeClient({
      list: async () => ({ ok: true, items: [item("a"), item("b", { current: true })], nextCursor: null }),
      apply: async () => ({ ok: true })
    }));
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    await controller.apply("a");
    const state = controller.getState()!;
    expect(state.applyingEntryId).toBeNull();
    expect(state.pendingCurrentEntryId).toBeNull();
    expect(state.items.find((entry) => entry.entryId === "a")?.current).toBe(true);
    expect(state.items.find((entry) => entry.entryId === "b")?.current).toBe(false);
  });

  it("恢复失败记录 applyError 且不进入 applying", async () => {
    const controller = new NodeHistoryController(fakeClient({
      apply: async () => ({ ok: false, code: "conflict", error: "生成中" })
    }));
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    const result = await controller.apply("a");
    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(controller.getState()?.applyingEntryId).toBeNull();
    expect(controller.getState()?.applyError).toBe("生成中");
  });

  it("目标删除时清理面板状态", async () => {
    const controller = new NodeHistoryController(fakeClient());
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    controller.syncValidTarget(new Set(["other"]));
    expect(controller.getState()).toBeNull();
  });

  describe("清空历史", () => {
    it("成功后收敛为空态并清掉选中详情与恢复错误", async () => {
      const cleared: Array<{ canvasId: string; nodeId: string }> = [];
      const controller = new NodeHistoryController(fakeClient({
        list: async () => ({ ok: true, items: [item("a"), item("b")], nextCursor: "next" }),
        clear: async (input) => { cleared.push(input); return { ok: true, removed: 2 }; }
      }));
      await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
      await controller.select("a");
      expect(controller.getState()?.detail).not.toBeNull();
      const result = await controller.clear();
      expect(result).toEqual({ ok: true });
      expect(cleared).toEqual([{ canvasId: "c1", nodeId: "n1" }]);
      const state = controller.getState()!;
      expect(state.items).toEqual([]);
      expect(state.nextCursor).toBeNull();
      expect(state.status).toBe("empty");
      expect(state.detail).toBeNull();
      expect(state.selectedEntryId).toBe("__current__");
      expect(state.clearing).toBe(false);
      expect(state.clearError).toBeNull();
    });

    it("服务端拒绝时保留列表并显示原因", async () => {
      const controller = new NodeHistoryController(fakeClient({
        list: async () => ({ ok: true, items: [item("a")], nextCursor: null }),
        clear: async () => ({ ok: false, code: "conflict", error: "节点存在进行中的生成，无法清空历史" })
      }));
      await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
      expect(await controller.clear()).toMatchObject({ ok: false, code: "conflict" });
      const state = controller.getState()!;
      expect(state.items).toHaveLength(1);
      expect(state.clearError).toBe("节点存在进行中的生成，无法清空历史");
      expect(state.clearing).toBe(false);
    });

    it("清空进行中不重复提交；客户端不支持时明确拒绝", async () => {
      let calls = 0;
      let release: (() => void) | null = null;
      const controller = new NodeHistoryController(fakeClient({
        list: async () => ({ ok: true, items: [item("a")], nextCursor: null }),
        clear: async () => {
          calls += 1;
          await new Promise<void>((resolve) => { release = resolve; });
          return { ok: true, removed: 1 };
        }
      }));
      await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
      const first = controller.clear();
      expect(controller.getState()?.clearing).toBe(true);
      expect(await controller.clear()).toMatchObject({ ok: false, code: "busy" });
      expect(calls).toBe(1);
      release!();
      await first;
      const unsupported = new NodeHistoryController(fakeClient());
      await unsupported.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
      expect(await unsupported.clear()).toMatchObject({ ok: false, code: "unsupported" });
    });

    it("清空期间的迟到列表回流不覆盖空态", async () => {
      let listing = 0;
      const controller = new NodeHistoryController(fakeClient({
        list: async () => {
          listing += 1;
          if (listing === 1) return { ok: true, items: [item("a")], nextCursor: null };
          return { ok: true, items: [item("a")], nextCursor: null };
        },
        clear: async () => {
          // 清空成功；随后到来的 reconcile 列表是过期数据。
          return { ok: true, removed: 1 };
        }
      }));
      await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
      controller.reconcile({});
      await controller.clear();
      controller.reconcile({});
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controller.getState()?.status).toBe("empty");
    });
  });
});

it("历史跳转的确切版本失效时保留当前作品和列表，只报告读取失败", async () => {
  let applied = 0;
  const controller = new NodeHistoryController(fakeClient({
    list: async () => ({ ok: true, items: [item("available")], nextCursor: null }),
    detail: async () => ({ ok: false, code: "not-found", error: "目标版本已失效" }),
    apply: async () => { applied++; return { ok: true }; }
  }));
  await controller.open({ canvasId: "c", nodeId: "n", kind: "text", writable: false });
  const current = controller.getState()!.current;
  await controller.select("expired-exact-id");
  expect(controller.getState()).toMatchObject({ selectedEntryId: "expired-exact-id", detail: null, error: "目标版本已失效", current });
  expect(controller.getState()!.items.map(item => item.entryId)).toEqual(["available"]);
  expect(applied).toBe(0);
});
