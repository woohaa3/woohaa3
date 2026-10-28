/**
 * 历史列表预览引用的挂载路径映射
 * （change: 2026-10-15-support-configurable-app-base-path，design D5）。
 *
 * 列表项里的 `preview` 引用是应用逻辑路径；非根挂载下必须映射为浏览器公开地址，否则
 * `<img>`/`<video>` 会按 origin 根解析并绕过挂载前缀，被入口 404。映射发生在 remote
 * 解码到消费之间，且只改写受控预览引用。
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type {
  CanvasGenerationHistoryListItem,
  NodeGenerationHistoryListItem
} from "@woohaa3/contracts";
import { setAppBasePathForTesting } from "../../services/app-base-path.js";
import { createRemoteClient } from "./history-adapters.js";

afterEach(() => setAppBasePathForTesting("/"));

const base = {
  entryId: "entry-1",
  kind: "image" as const,
  createdAt: "2026-10-17T00:00:00.000Z",
  current: true,
  recoverable: true,
  previewable: true,
  source: { label: "图片生成" }
};

const imageItem: NodeGenerationHistoryListItem = {
  ...base,
  preview: { kind: "image", href: "/api/canvas-node-history/canvas-1/node-1/entry-1/preview" }
};

const videoItem: NodeGenerationHistoryListItem = {
  ...base,
  entryId: "entry-2",
  kind: "video",
  preview: {
    kind: "video",
    href: "/api/canvas-node-history/canvas-1/node-1/entry-2/preview",
    posterHref: "/api/canvas-node-history/canvas-1/node-1/entry-2/poster",
    durationSeconds: 3
  }
};

const audioItem: NodeGenerationHistoryListItem = {
  ...base,
  entryId: "entry-3",
  kind: "audio",
  preview: {
    kind: "audio",
    href: "/api/canvas-node-history/canvas-1/node-1/entry-3/preview",
    durationSeconds: null
  }
};

const modelItem: NodeGenerationHistoryListItem = {
  ...base,
  entryId: "entry-4",
  kind: "model",
  preview: {
    kind: "model",
    thumbnailHref: "/api/canvas-node-history/canvas-1/node-1/entry-4/thumbnail",
    entry: { canvasId: "canvas-1", nodeId: "node-1", entryId: "entry-4" }
  }
};

const textItem: NodeGenerationHistoryListItem = {
  ...base,
  entryId: "entry-5",
  kind: "text",
  preview: { kind: "text", excerpt: "摘要" }
};

function ctxWith(items: NodeGenerationHistoryListItem[]): Context {
  return {
    canvasRemote: {
      listNodeHistory: async () => ({
        ok: true,
        value: { items, nextCursor: null, total: items.length }
      }),
      listCanvasHistory: async () => ({
        ok: true,
        value: {
          items: items as CanvasGenerationHistoryListItem[],
          nextCursor: null,
          total: items.length,
          kindCounts: { text: 0, image: 0, video: 0, audio: 0, model: 0 }
        }
      })
    }
  } as unknown as Context;
}

describe("history-adapters 预览引用挂载映射", () => {
  it("非根挂载把节点列表预览引用映射为公开地址", async () => {
    setAppBasePathForTesting("/dev/abc");
    const client = createRemoteClient(ctxWith([imageItem, videoItem, audioItem, modelItem, textItem]));

    const result = await client.list({ canvasId: "canvas-1", nodeId: "node-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items.map((item) => item.preview)).toEqual([
      { kind: "image", href: "/dev/abc/api/canvas-node-history/canvas-1/node-1/entry-1/preview" },
      {
        kind: "video",
        href: "/dev/abc/api/canvas-node-history/canvas-1/node-1/entry-2/preview",
        posterHref: "/dev/abc/api/canvas-node-history/canvas-1/node-1/entry-2/poster",
        durationSeconds: 3
      },
      {
        kind: "audio",
        href: "/dev/abc/api/canvas-node-history/canvas-1/node-1/entry-3/preview",
        durationSeconds: null
      },
      {
        kind: "model",
        thumbnailHref: "/dev/abc/api/canvas-node-history/canvas-1/node-1/entry-4/thumbnail",
        entry: { canvasId: "canvas-1", nodeId: "node-1", entryId: "entry-4" }
      },
      { kind: "text", excerpt: "摘要" }
    ]);
  });

  it("非根挂载把画布级列表预览引用映射为公开地址", async () => {
    setAppBasePathForTesting("/dev/abc");
    const client = createRemoteClient(ctxWith([imageItem, modelItem]));

    const result = await client.listCanvas({ canvasId: "canvas-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items[0]?.preview).toEqual({
      kind: "image",
      href: "/dev/abc/api/canvas-node-history/canvas-1/node-1/entry-1/preview"
    });
    expect(result.items[1]?.preview).toEqual({
      kind: "model",
      thumbnailHref: "/dev/abc/api/canvas-node-history/canvas-1/node-1/entry-4/thumbnail",
      entry: { canvasId: "canvas-1", nodeId: "node-1", entryId: "entry-4" }
    });
  });

  it("根挂载保持逻辑路径不变", async () => {
    setAppBasePathForTesting("/");
    const client = createRemoteClient(ctxWith([imageItem]));

    const result = await client.list({ canvasId: "canvas-1", nodeId: "node-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.preview).toEqual(imageItem.preview);
  });

  it("非站内根相对引用原样透传，不被拼接前缀", async () => {
    setAppBasePathForTesting("/dev/abc");
    const inlineItem: NodeGenerationHistoryListItem = {
      ...base,
      preview: { kind: "image", href: "data:image/png;base64,AAAA" }
    };
    const client = createRemoteClient(ctxWith([inlineItem]));

    const result = await client.list({ canvasId: "canvas-1", nodeId: "node-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.preview).toEqual({ kind: "image", href: "data:image/png;base64,AAAA" });
  });
});

describe("图片历史恢复门禁与 canonical 刷新接线", () => {
  function applyCtx(state: "saved" | "unsaved" | "saving" | "error" | null, nodeId = "node-1") {
    const applyNodeHistory = vi.fn(async () => ({ ok: true as const, value: { revision: 9 } }));
    const refreshFromCanonical = vi.fn();
    const setHistoryOverride = vi.fn();
    const editor = state === null ? undefined : {
      isActive: () => true,
      nodeId: () => nodeId,
      draftState: () => state,
      setHistoryOverride,
      refreshFromCanonical
    };
    const ctx = {
      canvasSession: { isWritable: () => true },
      get: (key: string) => key === "imageEdit" ? editor : undefined,
      canvasRemote: { applyNodeHistory }
    } as unknown as Context;
    return { ctx, applyNodeHistory, refreshFromCanonical };
  }

  it("未保存草稿拒绝恢复且不提交 apply", async () => {
    const { ctx, applyNodeHistory } = applyCtx("unsaved");
    const result = await createRemoteClient(ctx).apply({ canvasId: "canvas-1", nodeId: "node-1", entryId: "entry-1" });
    expect(result).toMatchObject({ ok: false, code: "unsaved-draft" });
    expect(applyNodeHistory).not.toHaveBeenCalled();
  });

  it("无 provider 时按不可用降级：仍允许恢复，不等待扩展刷新", async () => {
    const { ctx, applyNodeHistory, refreshFromCanonical } = applyCtx(null);
    const result = await createRemoteClient(ctx).apply({ canvasId: "canvas-1", nodeId: "node-1", entryId: "entry-1" });
    expect(result.ok).toBe(true);
    expect(applyNodeHistory).toHaveBeenCalledOnce();
    expect(refreshFromCanonical).not.toHaveBeenCalled();
  });

  it("保存后恢复成功把回执 revision 交给 imageEdit 刷新，且不重复 apply", async () => {
    const { ctx, applyNodeHistory, refreshFromCanonical } = applyCtx("saved");
    const result = await createRemoteClient(ctx).apply({ canvasId: "canvas-1", nodeId: "node-1", entryId: "entry-1" });
    expect(result.ok).toBe(true);
    expect(applyNodeHistory).toHaveBeenCalledOnce();
    expect(refreshFromCanonical).toHaveBeenCalledWith(9);
  });

  it("活动文档属于另一节点时不套用该节点的草稿门禁，也不刷新另一节点", async () => {
    const { ctx, applyNodeHistory, refreshFromCanonical } = applyCtx("unsaved", "other-node");
    const result = await createRemoteClient(ctx).apply({ canvasId: "canvas-1", nodeId: "node-1", entryId: "entry-1" });
    expect(result.ok).toBe(true);
    expect(applyNodeHistory).toHaveBeenCalledOnce();
    expect(refreshFromCanonical).not.toHaveBeenCalled();
  });
});
