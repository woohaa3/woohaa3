/**
 * 素材库在图片面板里的呈现。
 *
 * 素材库里的图**不属于任何画布**（浏览器扩展 / Pinterest 窗口存进来，攒着备用），
 * 但图片面板的一切都以「画布」为单位：分组、下拉、过滤、放置。
 * 所以这里给素材库一个**固定的虚拟画布身份**，让它进现有的模型，而不是改一遍面板：
 *
 * - `canvasId = LIBRARY_CANVAS_ID`，标题「素材库」，来源 `external`（落在「外部导入」分组）；
 * - 放到画布时走素材库自己的路径（见 `planPlaceLibraryItem`）：资产本来就在媒体存储里，
 *   节点只引用它，不需要「读回原画布的资产」那一套跨画布放置。
 *
 * 虚拟画布不是真画布：它不会出现在 `GET /api/canvases`，也永远不会等于 `currentCanvasId`。
 * 任何拿 `canvasId` 当真实画布 id 去请求后端的地方都要先排除它（见 `isLibraryItem`）。
 */
import type { CanvasCommand, StoredAsset } from "@woohaa3/contracts";
import { buildUploadedAsset, planUploadedNode, type UploadedMedia } from "../../../extension-api/upload-asset.js";
import { nextPlacement, type ImageLibraryItem } from "./image-library.js";

/** 素材库的虚拟画布 id。真实画布 id 是高熵随机串，不会撞上这个字面量。 */
export const LIBRARY_CANVAS_ID = "library";
export const LIBRARY_CANVAS_TITLE = "素材库";

/** `GET /api/library` 返回的一条（字段与后端 `LibraryItem` 一一对应）。 */
export type LibraryEntry = {
  id: string;
  title: string;
  sourceUrl: string;
  pageUrl?: string;
  url: string;
  storageKey: string;
  contentType: string;
  bytes: number;
  createdAt: number;
};

export function isLibraryItem(item: Pick<ImageLibraryItem, "canvasId">): boolean {
  return item.canvasId === LIBRARY_CANVAS_ID;
}

/** 后端条目 → 图片面板的条目。`id` 沿用内容哈希：面板内以 `canvasId:id` 为键，不会和画布资产撞。 */
export function libraryEntryToItem(entry: LibraryEntry, resolveUrl: (url: string) => string): ImageLibraryItem {
  return {
    id: entry.id,
    title: entry.title,
    url: resolveUrl(entry.url),
    origin: "external",
    // 素材库暂不支持收藏：收藏是写进画布资产里的 `isFavorite`，素材库没有这个概念
    isFavorite: false,
    createdAt: new Date(entry.createdAt).toISOString(),
    canvasId: LIBRARY_CANVAS_ID,
    canvasTitle: LIBRARY_CANVAS_TITLE
  };
}

/** 素材库条目 → 稳定资产。媒体对象已经在存储里，`storageKey` / `checksum` 用后端给的，不重新上传。 */
export function libraryEntryToAsset(entry: LibraryEntry): StoredAsset {
  // 后端的 `id` 就是内容哈希（checksum）；`storageKey` 才是读取用的稳定引用
  const media: UploadedMedia = {
    storageKey: entry.storageKey,
    checksum: entry.id,
    contentType: entry.contentType,
    size: entry.bytes,
    url: entry.url,
    deduplicated: true
  };
  return {
    ...buildUploadedAsset({
      media,
      mediaKind: "image",
      file: { name: entry.title || "素材", type: entry.contentType, size: entry.bytes },
      now: new Date(entry.createdAt).toISOString()
    }),
    source: "external"
  };
}

/**
 * 把素材库的图放到画布：资产 + 图片节点，位置规则与「添加到画布」一致（连续放不会叠在一起）。
 * 资产 id 是 `asset-upload-<checksum>`，同一张图放两次是同一个资产（`asset.upsert` 幂等），只多一个节点。
 */
export function planPlaceLibraryItem(input: {
  entry: LibraryEntry;
  center: { x: number; y: number; zoom: number };
  nearby: number;
}): CanvasCommand[] {
  const asset = libraryEntryToAsset(input.entry);
  return planUploadedNode({
    nodeType: "image",
    position: nextPlacement(input.center, input.nearby),
    file: { name: asset.title, type: input.entry.contentType, size: input.entry.bytes },
    asset
  });
}

/**
 * 默认视图的过滤值：当前画布 + 素材库。
 *
 * 过滤用的 `canvasId` 是单值（`null` 表示全部），而用户存完图要**马上**看到它 ——
 * 默认只看当前画布就等于看不到刚存的图，会以为保存失败。这个特殊值只在默认视图用，
 * 下拉里其余选项（全部 / 某张画布 / 素材库）的行为一律不变。
 */
export const CURRENT_AND_LIBRARY = "__current-and-library__";

/** 这个过滤值下，一张图该不该显示。`currentCanvasId` 为空（没有打开的画布）时只剩素材库。 */
export function matchesCanvasFilter(
  canvasFilter: string | null,
  item: Pick<ImageLibraryItem, "canvasId">,
  currentCanvasId: string | null
): boolean {
  if (canvasFilter === null) return true;
  if (canvasFilter === CURRENT_AND_LIBRARY) {
    return item.canvasId === LIBRARY_CANVAS_ID || (currentCanvasId !== null && item.canvasId === currentCanvasId);
  }
  return item.canvasId === canvasFilter;
}

/** 面板与图片库数据源共用的最小切面（只取包装需要的几项，避免这个文件反向依赖整个源类型）。 */
type SourceLike = {
  scopeLabel: string;
  getItems(): readonly ImageLibraryItem[];
  subscribe(listener: () => void): () => void;
  setFavorite(id: string, favorite: boolean): { ok: true } | { ok: false; reason: string };
  addToCanvas(id: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  refresh?(): Promise<void>;
  dispose?(): void;
};

/**
 * 把素材库并进一个已有的图片数据源，**不改它的合并逻辑**。
 *
 * - 条目：`getItems()` = 原条目 + 素材库条目（素材库在前，保持各自的时间顺序由面板排序）；
 * - 「添加到画布」：素材库的条目走自己的放置（资产已在媒体存储里，只引用），其余原样委托；
 * - 收藏：素材库不支持，直接说明原因，不去碰画布资产（它们不是画布资产）；
 * - 刷新：素材库每次 `refresh` 一并重读，**失败不影响画布里的图**（图少几张好过整块报错）。
 *
 * 为什么用包装而不是改 `crossCanvasSource`：那个函数已经承担「当前画布实时 + 其他画布缓存」的合并，
 * 再塞一个来源会让去重键、订阅、失败状态全部变复杂；素材库的生命周期也完全不同（不随画布切换）。
 */
export function withLibrary<T extends SourceLike>(
  base: T,
  input: {
    /** 读后端素材库；失败时抛出，由这里降级成「没有素材库条目」。 */
    fetchLibrary: () => Promise<readonly LibraryEntry[]>;
    resolveUrl: (url: string) => string;
    /** 把素材库的图放到当前画布。 */
    placeLibraryItem: (entry: LibraryEntry) => { ok: true } | { ok: false; reason: string };
  }
): T {
  let entries: readonly LibraryEntry[] = [];
  let items: readonly ImageLibraryItem[] = [];
  let merged: readonly ImageLibraryItem[] = [];
  let lastBase: readonly ImageLibraryItem[] | null = null;
  const listeners = new Set<() => void>();

  // **引用稳定**：`useSyncExternalStore` 要求同一份数据返回同一个数组，否则会死循环渲染
  const rebuild = () => {
    const baseItems = base.getItems();
    if (baseItems === lastBase && merged.length === baseItems.length + items.length) return;
    lastBase = baseItems;
    merged = [...baseItems, ...items];
  };
  const notify = () => {
    rebuild();
    for (const listener of [...listeners]) listener();
  };
  const unsubscribeBase = base.subscribe(notify);

  let loading: Promise<void> | null = null;
  const loadLibrary = (): Promise<void> => {
    if (loading) return loading;
    loading = input
      .fetchLibrary()
      .then((fetched) => {
        entries = fetched;
        items = fetched.map((entry) => libraryEntryToItem(entry, input.resolveUrl));
      })
      .catch(() => {
        // 素材库读不到（后端没起 / 网络）：保留上一次的结果，不影响画布里的图
      })
      .finally(() => {
        loading = null;
        lastBase = null;
        notify();
      });
    return loading;
  };
  // 面板一打开就要看见素材库：默认视图包含它
  void loadLibrary();

  const wrapped = Object.create(base) as T;
  Object.defineProperties(wrapped, {
    getItems: { value: () => {
      rebuild();
      return merged;
    } },
    subscribe: {
      value: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }
    },
    setFavorite: {
      value: (id: string, favorite: boolean) => {
        if (items.some((item) => item.id === id) && !base.getItems().some((item) => item.id === id)) {
          return { ok: false as const, reason: "素材库里的图暂不支持收藏" };
        }
        return base.setFavorite(id, favorite);
      }
    },
    addToCanvas: {
      value: async (id: string) => {
        const entry = entries.find((candidate) => candidate.id === id);
        // 只有「不是画布里的图」才走素材库：同一个 id 不会同时是两者，但这里仍以画布优先，
        // 因为画布条目带有更完整的信息（收藏、所属画布）
        if (entry && !base.getItems().some((item) => item.id === id)) return input.placeLibraryItem(entry);
        return base.addToCanvas(id);
      }
    },
    refresh: {
      value: async () => {
        await Promise.all([base.refresh?.(), loadLibrary()]);
      }
    },
    dispose: {
      value: () => {
        unsubscribeBase();
        listeners.clear();
        base.dispose?.();
      }
    }
  });
  return wrapped;
}
