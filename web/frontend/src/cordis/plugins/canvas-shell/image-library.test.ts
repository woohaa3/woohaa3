import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import type { ImageLibraryItem } from "./image-library.js";
import {
  collectImages,
  countByOrigin,
  crossCanvasSource,
  currentCanvasSource,
  DEFAULT_IMAGE_FILTER,
  filterImages
} from "./image-library.js";

const NOW = "2026-11-02T00:00:00.000Z";

function asset(id: string, patch: Partial<StoredAsset> = {}): StoredAsset {
  return {
    id,
    title: id,
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    url: `/api/media/${id}`,
    createdAt: NOW,
    ...patch
  };
}

function canvasWith(assets: StoredAsset[]): ServerCanvas {
  return { ...createEmptyWoohaa3ServerCanvas("c1", NOW), assets };
}

/** 测试里不走真实的 URL 校验，只验证「过不了就丢掉」的行为。 */
const resolve = (a: StoredAsset, canvasId: string) => (a.url ? `${a.url}?canvas=${canvasId}` : null);

describe("collectImages", () => {
  it("只取 ready 的图片，带上画布提示的地址", () => {
    const canvas = canvasWith([
      asset("a"),
      asset("video", { mediaKind: "video" }),
      asset("pending", { status: "generating" }),
      asset("failed", { status: "failed" })
    ]);
    const items = collectImages(canvas, "c1", resolve);
    expect(items.map((i) => i.id)).toEqual(["a"]);
    expect(items[0]?.url).toBe("/api/media/a?canvas=c1");
  });

  it("视频海报不进图库", () => {
    const canvas = canvasWith([
      asset("asset-run1-poster", { source: "generated", provenance: { taskKind: "video-generation", outputIndex: 1 } }),
      asset("asset-run2", { source: "generated", provenance: { taskKind: "image-generation", outputIndex: 0 } })
    ]);
    expect(collectImages(canvas, "c1", resolve).map((i) => i.id)).toEqual(["asset-run2"]);
  });

  it("地址过不了校验的资产直接丢掉，不拿原始 url 凑数", () => {
    const canvas = canvasWith([asset("ok"), asset("bad", { url: undefined })]);
    expect(collectImages(canvas, "c1", resolve).map((i) => i.id)).toEqual(["ok"]);
  });

  it("按创建时间倒序，占位的 1970 沉到最后", () => {
    const canvas = canvasWith([
      asset("old", { createdAt: "2026-01-01T00:00:00.000Z" }),
      asset("baseline", { createdAt: new Date(0).toISOString() }),
      asset("new", { createdAt: "2026-10-01T00:00:00.000Z" })
    ]);
    expect(collectImages(canvas, "c1", resolve).map((i) => i.id)).toEqual(["new", "old", "baseline"]);
  });

  it("没有画布时返回空数组", () => {
    expect(collectImages(null, "c1", resolve)).toEqual([]);
  });
});

describe("filterImages / countByOrigin", () => {
  const items = collectImages(
    canvasWith([
      asset("up-1", { title: "前台", source: "uploaded" }),
      asset("up-2", { title: "客厅", source: "uploaded", isFavorite: true }),
      asset("gen-1", { title: "Lobby 渲染", source: "generated", isFavorite: true }),
      asset("gen-2", { title: "卧室", source: "generated" })
    ]),
    "c1",
    resolve
  );

  it("默认不过滤", () => {
    expect(filterImages(items, DEFAULT_IMAGE_FILTER)).toHaveLength(4);
  });

  it("收藏 tab 只留 isFavorite", () => {
    const ids = filterImages(items, { ...DEFAULT_IMAGE_FILTER, tab: "favorite" }).map((i) => i.id).sort();
    expect(ids).toEqual(["gen-1", "up-2"]);
  });

  it("来源与收藏可叠加", () => {
    const filtered = filterImages(items, { tab: "favorite", origin: "generated", canvasId: null, query: "" });
    expect(filtered.map((i) => i.id)).toEqual(["gen-1"]);
  });

  it("搜索忽略大小写、按标题匹配", () => {
    expect(filterImages(items, { ...DEFAULT_IMAGE_FILTER, query: "  lobby " }).map((i) => i.id)).toEqual(["gen-1"]);
    expect(filterImages(items, { ...DEFAULT_IMAGE_FILTER, query: "不存在" })).toEqual([]);
  });

  it("各来源计数受收藏 tab 和搜索影响，不受来源筛选自己影响", () => {
    expect(countByOrigin(items, { tab: "all", query: "" })).toEqual({ uploaded: 2, generated: 2, external: 0 });
    expect(countByOrigin(items, { tab: "favorite", query: "" })).toEqual({ uploaded: 1, generated: 1, external: 0 });
  });
});

describe("currentCanvasSource", () => {
  function fakeState(initial: ServerCanvas) {
    let canvas = initial;
    const listeners = new Set<() => void>();
    return {
      state: {
        getCanvas: () => canvas,
        getWorkingCanvas: () => null,
        subscribe(l: () => void) {
          listeners.add(l);
          return () => listeners.delete(l);
        }
      },
      set(next: ServerCanvas) {
        canvas = next;
        for (const l of listeners) l();
      },
      listeners
    };
  }

  it("读到当前画布的图片，范围如实标为「当前画布」", () => {
    const { state } = fakeState(canvasWith([asset("a")]));
    const source = currentCanvasSource(state, "c1", resolve);
    expect(source.scopeLabel).toBe("当前画布");
    expect(source.getItems().map((i) => i.id)).toEqual(["a"]);
  });

  it("资产数组没变（例如只是移动了节点）时不通知、不重算", () => {
    const base = canvasWith([asset("a")]);
    const { state, set } = fakeState(base);
    const source = currentCanvasSource(state, "c1", resolve);
    const listener = vi.fn();
    source.subscribe(listener);
    const before = source.getItems();

    set({ ...base, revision: base.revision + 1 }); // 同一个 assets 引用
    expect(listener).not.toHaveBeenCalled();
    expect(source.getItems()).toBe(before);
  });

  it("资产变了就通知，并返回新数据", () => {
    const base = canvasWith([asset("a")]);
    const { state, set } = fakeState(base);
    const source = currentCanvasSource(state, "c1", resolve);
    const listener = vi.fn();
    source.subscribe(listener);

    set({ ...base, assets: [...base.assets, asset("b", { createdAt: "2026-11-03T00:00:00.000Z" })] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getItems().map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("取消订阅后不再通知", () => {
    const base = canvasWith([asset("a")]);
    const { state, set, listeners } = fakeState(base);
    const source = currentCanvasSource(state, "c1", resolve);
    const listener = vi.fn();
    const off = source.subscribe(listener);
    off();
    expect(listeners.size).toBe(0);
    set({ ...base, assets: [] });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("图库的写操作（收藏 / 添加到画布）", () => {
  function canvasWithNodes() {
    const base = canvasWith([asset("a")]);
    return {
      ...base,
      document: {
        ...base.document,
        nodes: [{ id: "n1", type: "image", position: { x: 0, y: 0 } }]
      }
    } as ServerCanvas;
  }

  function fakeWrites(writable = true) {
    const submitted: unknown[][] = [];
    return {
      submitted,
      writes: {
        isWritable: () => writable,
        submit: (commands: readonly unknown[]) => {
          submitted.push([...commands]);
          return { ok: true };
        },
        viewportCenter: () => ({ x: 100, y: 200, zoom: 1 }),
        addForeignToCanvas: async () => ({ ok: true as const })
      }
    };
  }

  it("收藏把整条 canonical 资产写回，而不是图库的精简视图", () => {
    const state = { getCanvas: () => canvasWithNodes(), getWorkingCanvas: () => null, subscribe: () => () => undefined };
    const { submitted, writes } = fakeWrites();
    const source = currentCanvasSource(state, "c1", resolve, writes);

    expect(source.setFavorite("a", true)).toEqual({ ok: true });
    const [commands] = submitted;
    const upsert = (commands as Array<{ type: string; asset: Record<string, unknown> }>)[0]!;
    expect(upsert.type).toBe("asset.upsert");
    expect(upsert.asset.isFavorite).toBe(true);
    // 只改收藏位，URL / 时间等原始字段原样保留
    expect(upsert.asset.url).toBe("/api/media/a");
    expect(upsert.asset.createdAt).toBe(NOW);
  });

  it("取消收藏会删掉 isFavorite 键", () => {
    const canvas = canvasWith([asset("a", { isFavorite: true })]);
    const state = { getCanvas: () => canvas, getWorkingCanvas: () => null, subscribe: () => () => undefined };
    const { submitted, writes } = fakeWrites();
    currentCanvasSource(state, "c1", resolve, writes).setFavorite("a", false);
    const upsert = (submitted[0] as Array<{ asset: Record<string, unknown> }>)[0]!;
    expect("isFavorite" in upsert.asset).toBe(false);
  });

  it("添加到画布提交 asset.upsert + node.add，节点引用这张图并落在视口中心", async () => {
    const state = { getCanvas: () => canvasWithNodes(), getWorkingCanvas: () => null, subscribe: () => () => undefined };
    const { submitted, writes } = fakeWrites();
    await expect(currentCanvasSource(state, "c1", resolve, writes).addToCanvas("a")).resolves.toEqual({ ok: true });

    const commands = submitted[0] as Array<Record<string, never>>;
    expect(commands.map((c) => (c as unknown as { type: string }).type)).toEqual(["asset.upsert", "node.add"]);
    const add = commands[1] as unknown as { node: { type: string }; nodeData: Record<string, unknown> };
    expect(add.node.type).toBe("image");
    expect(add.nodeData.outputAssetId).toBe("a");
    expect(add.nodeData.resourceKind).toBe("image");
  });

  it("只读会话直接给出原因，不提交任何命令", async () => {
    const state = { getCanvas: () => canvasWithNodes(), getWorkingCanvas: () => null, subscribe: () => () => undefined };
    const { submitted, writes } = fakeWrites(false);
    const source = currentCanvasSource(state, "c1", resolve, writes);
    expect(source.setFavorite("a", true)).toMatchObject({ ok: false });
    await expect(source.addToCanvas("a")).resolves.toMatchObject({ ok: false });
    expect(submitted).toHaveLength(0);
  });

  it("找不到资产时报错，不提交空资产", () => {
    const state = { getCanvas: () => canvasWithNodes(), getWorkingCanvas: () => null, subscribe: () => () => undefined };
    const { submitted, writes } = fakeWrites();
    expect(currentCanvasSource(state, "c1", resolve, writes).setFavorite("missing", true)).toMatchObject({
      ok: false
    });
    expect(submitted).toHaveLength(0);
  });
});

describe("跨画布数据源：其他画布的图可以加到当前画布", () => {
  const libItem = (id: string, patch: Partial<ImageLibraryItem> = {}): ImageLibraryItem => ({
    id,
    title: id,
    url: `/api/media/${id}`,
    origin: "uploaded",
    isFavorite: false,
    createdAt: NOW,
    canvasId: "c1",
    ...patch
  });
  const currentItem = (id: string): ImageLibraryItem => libItem(id, { canvasId: "c1" });

  function makeSource() {
    const current = {
      scopeLabel: "当前画布",
      getItems: () => [currentItem("a")],
      subscribe: () => () => undefined,
      setFavorite: vi.fn(() => ({ ok: true as const })),
      addToCanvas: vi.fn(async () => ({ ok: true as const }))
    };
    const addForeign = vi.fn(async (target: ImageLibraryItem) => ({
      ok: true as const,
      reason: target.id
    }));
    const source = crossCanvasSource({
      current,
      currentCanvasId: "c1",
      fetchOthers: async () => [
        {
          canvasId: "c2",
          canvasTitle: "别的画布",
          id: "b",
          title: "b",
          url: "/api/media/b",
          source: "uploaded",
          isFavorite: false,
          createdAt: "2026-11-05T00:00:00.000Z"
        }
      ],
      addForeignToCanvas: addForeign,
      resolveUrl: (url, canvasId) => `${url}?canvas=${canvasId}`
    });
    return { source, current, addForeign };
  }

  it("合并当前画布与其他画布，按创建时间倒序", async () => {
    const { source } = makeSource();
    await source.refresh?.();
    expect(source.getItems().map((i) => i.id)).toEqual(["b", "a"]);
    expect(source.scopeLabel).toBe("全部画布");
  });

  it("其他画布的图走跨画布放置，当前画布的图仍走本地添加", async () => {
    const { source, current, addForeign } = makeSource();
    await source.refresh?.();

    await expect(source.addToCanvas("b")).resolves.toMatchObject({ ok: true });
    expect(addForeign).toHaveBeenCalledTimes(1);
    expect(addForeign.mock.calls[0]![0]).toMatchObject({ id: "b", canvasId: "c2" });
    expect(current.addToCanvas).not.toHaveBeenCalled();

    await expect(source.addToCanvas("a")).resolves.toMatchObject({ ok: true });
    expect(current.addToCanvas).toHaveBeenCalledWith("a");
  });

  it("收藏仍然只对当前画布生效（其他画布不在本会话里）", async () => {
    const { source, current } = makeSource();
    await source.refresh?.();
    expect(source.setFavorite("b", true)).toMatchObject({ ok: false });
    expect(current.setFavorite).not.toHaveBeenCalled();
  });

  it("图片地址带原画布的读取提示", async () => {
    const { source } = makeSource();
    await source.refresh?.();
    expect(source.getItems().find((i) => i.id === "b")?.url).toBe("/api/media/b?canvas=c2");
  });
});
