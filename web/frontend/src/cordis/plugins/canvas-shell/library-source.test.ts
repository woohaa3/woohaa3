/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import {
  CURRENT_AND_LIBRARY,
  LIBRARY_CANVAS_ID,
  isLibraryItem,
  libraryEntryToAsset,
  libraryEntryToItem,
  matchesCanvasFilter,
  notifyLibraryChanged,
  planPlaceLibraryItem,
  withLibrary,
  type LibraryEntry
} from "./library-source.js";
import {
  crossCanvasSource,
  filterImages,
  DEFAULT_IMAGE_FILTER,
  type ImageLibraryItem,
  type ImageLibrarySource
} from "./image-library.js";

const HASH = "c".repeat(64);
const ENTRY: LibraryEntry = {
  id: HASH,
  title: "休息室",
  sourceUrl: "https://i.pinimg.com/originals/ab/x.jpg",
  url: `/api/media/sha256-${HASH}`,
  storageKey: `sha256-${HASH}`,
  contentType: "image/jpeg",
  bytes: 4096,
  createdAt: Date.parse("2026-11-03T01:00:00.000Z")
};

function canvasItem(id: string, canvasId = "c1", patch: Partial<ImageLibraryItem> = {}): ImageLibraryItem {
  return {
    id,
    title: id,
    url: `/api/media/${id}`,
    origin: "uploaded",
    isFavorite: false,
    createdAt: "2026-11-02T00:00:00.000Z",
    canvasId,
    ...patch
  };
}

/**
 * 一个最小的「当前画布」数据源，行为与 `currentCanvasSource` 的契约一致（引用稳定、可订阅）。
 * 类型直接用真实的 `ImageLibrarySource`：自己另写一个窄类型，测试通过了也不代表真实形状能用。
 */
function baseSource(initial: ImageLibraryItem[]) {
  let items: readonly ImageLibraryItem[] = initial;
  const listeners = new Set<() => void>();
  const setFavorite = vi.fn<ImageLibrarySource["setFavorite"]>(() => ({ ok: true }));
  const addToCanvas = vi.fn<ImageLibrarySource["addToCanvas"]>(async () => ({ ok: true }));
  const source: ImageLibrarySource = {
    scopeLabel: "当前画布",
    getItems: () => items,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setFavorite,
    addToCanvas
  };
  return Object.assign(source, {
    setFavorite,
    addToCanvas,
    set(next: ImageLibraryItem[]) {
      items = next;
      for (const listener of [...listeners]) listener();
    }
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("素材库条目", () => {
  it("落在「外部导入」分组，挂在虚拟画布「素材库」下，永远不是某张真画布", () => {
    const item = libraryEntryToItem(ENTRY, (url) => `/app${url}`);
    expect(item).toMatchObject({ origin: "external", canvasId: LIBRARY_CANVAS_ID, canvasTitle: "素材库", url: `/app${ENTRY.url}` });
    expect(isLibraryItem(item)).toBe(true);
    expect(isLibraryItem(canvasItem("a", "c-real-1"))).toBe(false);
  });

  it("放画布用的资产：外部来源，稳定引用来自后端给的 storageKey，且满足引用校验", () => {
    const asset = libraryEntryToAsset(ENTRY);
    expect(asset).toMatchObject({
      source: "external",
      mediaKind: "image",
      status: "ready",
      title: "休息室",
      metadata: { storageKey: ENTRY.storageKey, checksum: HASH, contentType: "image/jpeg", size: 4096 }
    });
    expect(String(asset.metadata?.storageKey)).toMatch(/^sha256-([0-9a-f]{64})$/);
  });

  it("放画布：先写资产再插节点；同一张图放两次是同一个资产，节点位置错开", () => {
    const place = (nearby: number) => planPlaceLibraryItem({ entry: ENTRY, center: { x: 0, y: 0, zoom: 1 }, nearby });
    const first = place(0);
    expect(first[0]).toMatchObject({ type: "asset.upsert", asset: { id: `asset-upload-${HASH}` } });
    expect(first.some((command) => command.type === "node.add")).toBe(true);
    const second = place(1);
    expect((second[0] as { asset: { id: string } }).asset.id).toBe((first[0] as { asset: { id: string } }).asset.id);
    expect(JSON.stringify(second.find((c) => c.type === "node.add"))).not.toBe(JSON.stringify(first.find((c) => c.type === "node.add")));
  });
});

describe("默认视图：当前画布 + 素材库", () => {
  const library = libraryEntryToItem(ENTRY, (u) => u);

  it("包含当前画布与素材库，排除其他画布", () => {
    expect(matchesCanvasFilter(CURRENT_AND_LIBRARY, canvasItem("a", "current"), "current")).toBe(true);
    expect(matchesCanvasFilter(CURRENT_AND_LIBRARY, library, "current")).toBe(true);
    expect(matchesCanvasFilter(CURRENT_AND_LIBRARY, canvasItem("b", "other"), "current")).toBe(false);
  });

  it("没有打开的画布时只剩素材库，而不是把所有「未知画布」都放进来", () => {
    expect(matchesCanvasFilter(CURRENT_AND_LIBRARY, library, null)).toBe(true);
    expect(matchesCanvasFilter(CURRENT_AND_LIBRARY, canvasItem("a", "x"), null)).toBe(false);
  });

  it("其余过滤值行为不变：null=全部；某张画布=只留它；素材库=只留素材库", () => {
    expect(matchesCanvasFilter(null, canvasItem("a", "x"), "cur")).toBe(true);
    expect(matchesCanvasFilter("c1", canvasItem("a", "c1"), "cur")).toBe(true);
    expect(matchesCanvasFilter("c1", canvasItem("a", "c2"), "cur")).toBe(false);
    expect(matchesCanvasFilter(LIBRARY_CANVAS_ID, library, "cur")).toBe(true);
    expect(matchesCanvasFilter(LIBRARY_CANVAS_ID, canvasItem("a", "cur"), "cur")).toBe(false);
  });

  it("接进 filterImages：默认视图能同时看到当前画布的图和刚存的素材", () => {
    const items = [canvasItem("mine", "current"), canvasItem("theirs", "other"), library];
    const visible = filterImages(items, {
      ...DEFAULT_IMAGE_FILTER,
      canvasId: CURRENT_AND_LIBRARY,
      currentCanvasId: "current"
    });
    expect(visible.map((item) => item.id)).toEqual(["mine", HASH]);
  });
});

describe("withLibrary 包装", () => {
  const resolveUrl = (url: string) => url;
  const place = vi.fn(() => ({ ok: true as const }));

  it("合并素材库条目，且引用稳定（useSyncExternalStore 要求同一份数据返回同一个数组）", async () => {
    const base = baseSource([canvasItem("a")]);
    const source = withLibrary(base, { fetchLibrary: async () => [ENTRY], resolveUrl, placeLibraryItem: place });
    await flush();
    const first = source.getItems();
    expect(first.map((item) => item.id)).toEqual(["a", HASH]);
    expect(source.getItems()).toBe(first);
    source.dispose?.();
  });

  it("画布里的图变了：合并结果随之更新并通知订阅者", async () => {
    const base = baseSource([canvasItem("a")]);
    const source = withLibrary(base, { fetchLibrary: async () => [ENTRY], resolveUrl, placeLibraryItem: place });
    await flush();
    const listener = vi.fn();
    source.subscribe(listener);
    base.set([canvasItem("a"), canvasItem("b")]);
    expect(listener).toHaveBeenCalled();
    expect(source.getItems().map((item) => item.id)).toEqual(["a", "b", HASH]);
    source.dispose?.();
  });

  it("素材库读不到：画布里的图照常显示，不报错", async () => {
    const base = baseSource([canvasItem("a")]);
    const source = withLibrary(base, {
      fetchLibrary: async () => Promise.reject(new Error("503")),
      resolveUrl,
      placeLibraryItem: place
    });
    await flush();
    expect(source.getItems().map((item) => item.id)).toEqual(["a"]);
    source.dispose?.();
  });

  it("读不到时保留上一次的素材库结果，而不是一次失败就清空", async () => {
    const base = baseSource([]);
    let fail = false;
    const source = withLibrary(base, {
      fetchLibrary: async () => (fail ? Promise.reject(new Error("x")) : [ENTRY]),
      resolveUrl,
      placeLibraryItem: place
    });
    await flush();
    fail = true;
    await source.refresh?.();
    expect(source.getItems().map((item) => item.id)).toEqual([HASH]);
    source.dispose?.();
  });

  it("添加到画布：素材库的图走自己的放置；画布里的图原样委托", async () => {
    const placeLibrary = vi.fn(() => ({ ok: true as const }));
    const base = baseSource([canvasItem("a")]);
    const source = withLibrary(base, { fetchLibrary: async () => [ENTRY], resolveUrl, placeLibraryItem: placeLibrary });
    await flush();

    expect(await source.addToCanvas(HASH)).toEqual({ ok: true });
    expect(placeLibrary).toHaveBeenCalledWith(ENTRY);
    expect(base.addToCanvas).not.toHaveBeenCalled();

    await source.addToCanvas("a");
    expect(base.addToCanvas).toHaveBeenCalledWith("a");
    expect(placeLibrary).toHaveBeenCalledTimes(1);
    source.dispose?.();
  });

  it("收藏：素材库的图明确说不支持，不去碰画布资产；画布里的图照常委托", async () => {
    const base = baseSource([canvasItem("a")]);
    const source = withLibrary(base, { fetchLibrary: async () => [ENTRY], resolveUrl, placeLibraryItem: place });
    await flush();
    const result = source.setFavorite(HASH, true);
    expect(result).toEqual({ ok: false, reason: "素材库里的图暂不支持收藏" });
    expect(base.setFavorite).not.toHaveBeenCalled();
    source.setFavorite("a", true);
    expect(base.setFavorite).toHaveBeenCalledWith("a", true);
    source.dispose?.();
  });

  it("包在 crossCanvasSource 外面也能用：原有的 getter（loadingOthers 等）经原型链仍然读得到", async () => {
    const current = baseSource([canvasItem("a", "current")]);
    const cross = crossCanvasSource({
      current: { ...current, addToCanvas: current.addToCanvas, setFavorite: current.setFavorite },
      currentCanvasId: "current",
      fetchOthers: async () => [],
      resolveUrl: (u) => u,
      addForeignToCanvas: async () => ({ ok: true })
    });
    const source = withLibrary(cross, { fetchLibrary: async () => [ENTRY], resolveUrl, placeLibraryItem: place });
    await flush();
    expect(typeof source.refresh).toBe("function");
    expect(source.getItems().some((item) => item.id === HASH)).toBe(true);

    // `loadingOthers` 是 base 上的 getter，状态在 base 的闭包里。包装对象经原型链读它，
    // 必须**真的反映** base 的状态 —— 只断言「不抛错」会漏掉读到 undefined / 过期值。
    expect(source.loadingOthers).toBe(false);
    const pending = source.refresh?.();
    expect(source.loadingOthers).toBe(true);
    expect(cross.loadingOthers).toBe(true);
    await pending;
    expect(source.loadingOthers).toBe(false);
    source.dispose?.();
  });
});

describe("素材库实时性（用户报告：保存后要刷新才看到）", () => {
  const resolveUrl = (url: string) => url;
  const place = () => ({ ok: true as const });

  it("广播后重新读一次：面板不重建也能看到新存的图", async () => {
    const base = baseSource([canvasItem("a")]);
    let fetched: LibraryEntry[] = [];
    const source = withLibrary(base, { fetchLibrary: async () => fetched, resolveUrl, placeLibraryItem: place });
    await flush();
    expect(source.getItems().some((item) => item.id === HASH)).toBe(false);

    const listener = vi.fn();
    source.subscribe(listener);

    // 后端多了一条（模拟保存成功）
    fetched = [ENTRY];
    notifyLibraryChanged();
    await flush();

    expect(source.getItems().map((item) => item.id)).toEqual(["a", HASH]);
    expect(listener).toHaveBeenCalled();
    source.dispose?.();
  });

  it("广播后仍然返回新的数组引用（否则 useSyncExternalStore 不会重渲染）", async () => {
    const base = baseSource([]);
    let fetched: LibraryEntry[] = [];
    const source = withLibrary(base, { fetchLibrary: async () => fetched, resolveUrl, placeLibraryItem: place });
    await flush();
    const before = source.getItems();
    fetched = [ENTRY];
    notifyLibraryChanged();
    await flush();
    expect(source.getItems()).not.toBe(before);
    source.dispose?.();
  });

  it("dispose（面板卸载）之后仍然参与广播 —— 数据源没死，下次打开面板还要用它", async () => {
    // `dispose` 的调用方是图片面板卸载，不是数据源销毁。如果在 dispose 里退出广播表，
    // 关过一次面板之后保存就再也通知不到，表现是「以后每次保存都要刷新才看得到」（真机踩到过）。
    const base = baseSource([]);
    let fetched: LibraryEntry[] = [];
    const source = withLibrary(base, { fetchLibrary: async () => fetched, resolveUrl, placeLibraryItem: place });
    await flush();
    source.dispose?.();

    fetched = [ENTRY];
    notifyLibraryChanged();
    await flush();
    expect(source.getItems().map((item) => item.id)).toEqual([HASH]);
  });

  it("面板关掉再打开：订阅后立刻能看到关着期间存的图", async () => {
    const base = baseSource([]);
    let fetched: LibraryEntry[] = [];
    const source = withLibrary(base, { fetchLibrary: async () => fetched, resolveUrl, placeLibraryItem: place });
    await flush();

    const unsubscribe = source.subscribe(() => undefined);
    unsubscribe();
    fetched = [ENTRY];

    const listener = vi.fn();
    const stop = source.subscribe(listener);
    await flush();
    expect(source.getItems().map((item) => item.id)).toEqual([HASH]);
    stop();
  });

});
