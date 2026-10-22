/**
 * 画布级历史 controller 测试
 * （change: add-canvas-generation-history-dialog）。
 *
 * 覆盖：首页加载、分页去重、筛选切换丢弃迟到响应、错误重试，以及只读（不暴露 apply）。
 */
import { describe, expect, it } from "vitest";
import type { CanvasGenerationHistoryListItem, NodeHistoryKindCounts } from "@woohaa3/contracts";
import { CanvasHistoryController, type CanvasHistoryClient } from "./canvas-history-controller.js";

const COUNTS: NodeHistoryKindCounts = { text: 1, image: 1, video: 0, audio: 0, model: 0 };

function item(entryId: string, overrides: Partial<CanvasGenerationHistoryListItem> = {}): CanvasGenerationHistoryListItem {
  return {
    entryId,
    kind: "text",
    createdAt: "2026-09-27T00:00:00.000Z",
    current: false,
    recoverable: true,
    previewable: true,
    source: { label: "文本生成" },
    preview: { kind: "text", excerpt: "x" },
    nodeId: "n1",
    nodeTitle: "节点",
    ...overrides
  };
}

describe("CanvasHistoryController", () => {
  it("打开加载首页并暴露计数与选中", async () => {
    const client: CanvasHistoryClient = {
      listCanvas: async () => ({ ok: true, items: [item("a"), item("b", { kind: "image" })], nextCursor: null, total: 2, kindCounts: COUNTS })
    };
    const controller = new CanvasHistoryController(client);
    await controller.open({ canvasId: "c1" });
    const state = controller.getState()!;
    expect(state.status).toBe("ready");
    expect(state.items.map((entry) => entry.entryId)).toEqual(["a", "b"]);
    expect(state.kindCounts).toEqual(COUNTS);
    controller.select("b");
    expect(controller.getState()!.selectedEntryId).toBe("b");
    controller.close();
    expect(controller.getState()).toBeNull();
  });

  it("空结果显示空态", async () => {
    const client: CanvasHistoryClient = {
      listCanvas: async () => ({ ok: true, items: [], nextCursor: null, total: 0, kindCounts: { text: 0, image: 0, video: 0, audio: 0, model: 0 } })
    };
    const controller = new CanvasHistoryController(client);
    await controller.open({ canvasId: "c1" });
    expect(controller.getState()!.status).toBe("empty");
  });

  it("加载更多按 entryId 去重并推进 cursor", async () => {
    const calls: Array<string | undefined> = [];
    const client: CanvasHistoryClient = {
      listCanvas: async (input) => {
        calls.push(input.cursor);
        if (!input.cursor) return { ok: true, items: [item("a"), item("b")], nextCursor: "cur-1", total: 3, kindCounts: COUNTS };
        return { ok: true, items: [item("b"), item("c")], nextCursor: null, total: 3, kindCounts: COUNTS };
      }
    };
    const controller = new CanvasHistoryController(client);
    await controller.open({ canvasId: "c1" });
    await controller.loadMore();
    const state = controller.getState()!;
    expect(state.items.map((entry) => entry.entryId)).toEqual(["a", "b", "c"]);
    expect(state.nextCursor).toBeNull();
    expect(calls).toEqual([undefined, "cur-1"]);
  });

  it("筛选切换请求对应 kind 并丢弃迟到响应", async () => {
    type Page = { ok: true; items: CanvasGenerationHistoryListItem[]; nextCursor: string | null; total: number; kindCounts: NodeHistoryKindCounts };
    const requests: Array<{ kind: string | undefined; resolve: (page: Page) => void }> = [];
    const client: CanvasHistoryClient = {
      listCanvas: (input) =>
        new Promise<Page>((resolve) => {
          requests.push({ kind: input.kind, resolve });
        })
    };
    const controller = new CanvasHistoryController(client);
    const opening = controller.open({ canvasId: "c1" }); // 请求 #1：all（挂起）
    const switching = controller.setFilter("image");    // 请求 #2：image（挂起）
    await Promise.resolve();
    expect(requests.map((request) => request.kind)).toEqual([undefined, "image"]);
    // 先结算较新的 image 请求，再让迟到的 all 请求返回：不得覆盖 image 状态。
    requests[1]!.resolve({ ok: true, items: [item("img-1", { kind: "image" })], nextCursor: null, total: 1, kindCounts: COUNTS });
    await switching;
    requests[0]!.resolve({ ok: true, items: [item("stale")], nextCursor: null, total: 99, kindCounts: COUNTS });
    await opening;
    const state = controller.getState()!;
    expect(state.filter).toBe("image");
    expect(state.items.map((entry) => entry.entryId)).toEqual(["img-1"]);
  });

  it("错误显示可诊断状态且可重试", async () => {
    let attempt = 0;
    const client: CanvasHistoryClient = {
      listCanvas: async () => {
        attempt += 1;
        if (attempt === 1) return { ok: false, code: "unavailable", error: "服务不可用" };
        return { ok: true, items: [item("a")], nextCursor: null, total: 1, kindCounts: COUNTS };
      }
    };
    const controller = new CanvasHistoryController(client);
    await controller.open({ canvasId: "c1" });
    expect(controller.getState()).toMatchObject({ status: "error", error: "服务不可用" });
    await controller.retry();
    expect(controller.getState()).toMatchObject({ status: "ready" });
  });

  it("只读：controller 不暴露 apply/恢复动作", () => {
    const controller = new CanvasHistoryController({ listCanvas: async () => ({ ok: true, items: [], nextCursor: null, total: 0, kindCounts: COUNTS }) });
    expect((controller as unknown as { apply?: unknown }).apply).toBeUndefined();
  });

  it("浏览与选中不写画布、不改变 selection（任务 6.4）", async () => {
    const controller = new CanvasHistoryController({
      listCanvas: async () => ({ ok: true, items: [item("a"), item("b")], nextCursor: null, total: 2, kindCounts: COUNTS })
    });
    await controller.open({ canvasId: "c1" });
    controller.select("b");
    // 只读：状态只含浏览字段；无任何命令/写入表面。
    const state = controller.getState()!;
    expect(state.selectedEntryId).toBe("b");
    expect((controller as unknown as { submitCommands?: unknown }).submitCommands).toBeUndefined();
    expect((controller as unknown as { write?: unknown }).write).toBeUndefined();
  });

  it("离线/查询失败呈现可诊断错误与重试，不退化为空列表（任务 6.4）", async () => {
    const controller = new CanvasHistoryController({
      listCanvas: async () => ({ ok: false, code: "offline", error: "网络已断开，无法查询生成历史" })
    });
    await controller.open({ canvasId: "c1" });
    const state = controller.getState()!;
    expect(state.status).toBe("error");
    expect(state.error).toContain("网络已断开");
    // 错误态不是空列表。
    expect(state.status).not.toBe("empty");
  });
});
