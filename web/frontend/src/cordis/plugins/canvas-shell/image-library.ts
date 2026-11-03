/**
 * 画布图库的数据层（纯函数，无 React、无服务依赖）。
 *
 * 资源栏「图片」面板与四喜扩展的「资源」页读的是**同一份**数据：都从这里的
 * `collectImages` 出，再各自筛选展示。界面不直接碰 `canvas.assets`，是为了日后把
 * 「当前画布」换成「跨画布」时，只需要换 {@link ImageLibrarySource} 的实现。
 *
 * 当前范围**只有正在打开的这张画布**：宿主没有跨画布列资产的接口
 * （`canvasCatalog` 只有 `assetCount`，`mediaRemote` 没有 list），不要在这里假装有。
 */
import type { CanvasCommand, CanvasNodeData, ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import { createHighEntropyId, getWoohaa3CanvasNodeRect } from "@woohaa3/contracts";
import { planInsertNode } from "../../../extension-api/command-planner.js";
import { planImportLayout } from "../paste-import/batch.js";
import { resolveCanonicalMediaUrl } from "../../services/media-remote.js";
import { matchesCanvasFilter } from "./library-source.js";

export type ImageOrigin = "uploaded" | "generated" | "external";

export type ImageLibraryItem = {
  id: string;
  title: string;
  /** 可直接放进 `<img src>` 的地址（已加部署前缀与 `?canvas=` 提示）。 */
  url: string;
  origin: ImageOrigin;
  isFavorite: boolean;
  createdAt: string;
  canvasId: string;
  /** 所属画布标题（跨画布视图里用来分组 / 标注）。 */
  canvasTitle?: string;
};

/**
 * 图库数据源的写操作结果。
 *
 * 失败必须带一句能直接显示的中文原因（只读会话、找不到资产、写入被拒），
 * 界面不猜原因，也不把 `ok: false` 静默吞掉 —— 点了没反应比报错更难查。
 */
export type ImageLibraryResult = { ok: true } | { ok: false; reason: string };

/**
 * 图库数据源。面板与四喜都只依赖它；换成跨画布实现时界面不用改。
 *
 * 读（`getItems` / `subscribe`）与写（`setFavorite` / `addToCanvas`）放在一起，
 * 是因为写操作也依赖「这份数据属于哪张画布」；拆成两个服务后，扩展还得自己拼 canvasId。
 */
export interface ImageLibrarySource {
  getItems(): readonly ImageLibraryItem[];
  /** 数据变化通知；返回取消订阅函数。 */
  subscribe(listener: () => void): () => void;
  /** 面板头部显示的范围说明，如实反映数据覆盖了什么（当前是「当前画布」）。 */
  readonly scopeLabel: string;
  /** 收藏 / 取消收藏。 */
  setFavorite(id: string, favorite: boolean): ImageLibraryResult;
  /**
   * 把这张图放到当前视口附近，生成一个引用它的图片节点。
   *
   * **可以跨画布**：其他画布的图片会以原画布为归属写入节点，媒体地址带原画布的读取提示
   * （字节按画布分开存，少了这个提示当前画布读不到）。
   * 异步是因为跨画布要先把原资产读回来（见 {@link ImageLibraryWrites.addForeignToCanvas}）。
   */
  addToCanvas(id: string): Promise<ImageLibraryResult>;
  /**
   * 重新拉取非当前画布的图（跨画布数据源才有）。切到「全部画布」时调用；
   * 单画布数据源不实现，界面也就不会显示画布下拉。
   */
  refresh?(): Promise<void>;
  /** 跨画布数据是否在加载（只在 `refresh` 存在时有意义）。 */
  readonly loadingOthers?: boolean;
  /** 跨画布拉取失败的原因；成功或没有这层时为 null。 */
  readonly othersFailure?: string | null;
  /** 释放内部订阅（面板卸载时调用）。没有这层的实现可以不提供。 */
  dispose?(): void;
}

/**
 * 视频海报也是 `mediaKind: "image"` 的资产（`asset-<runId>-poster`，
 * `provenance.taskKind === "video-generation"`）。它是视频的附属物，不是用户的图片，
 * 放进图库会让每个生成的视频多出一张莫名其妙的图。
 */
function isVideoPoster(asset: StoredAsset): boolean {
  return asset.provenance?.taskKind === "video-generation";
}

/**
 * 取出画布里可展示的图片，按创建时间倒序。
 *
 * - 只要 `ready` 的图片：生成中 / 失败 / 缺失的没有可看的内容；
 * - 地址必须能过 `resolveCanonicalMediaUrl` 的受控校验，过不了就不展示（宁缺毋滥，
 *   不拿原始 `asset.url` 凑数 —— 那样会绕过宿主对媒体地址的校验）；
 * - 图片编辑产生的「编辑原图」没有真实创建时间（占位为 1970），倒序时自然沉到最后。
 */
export function collectImages(
  canvas: ServerCanvas | null | undefined,
  canvasId: string,
  resolveUrl: (asset: StoredAsset, canvasId: string) => string | null = resolveCanonicalMediaUrl
): ImageLibraryItem[] {
  if (!canvas) return [];
  const items: ImageLibraryItem[] = [];
  for (const asset of canvas.assets) {
    if (asset.mediaKind !== "image" || asset.status !== "ready") continue;
    if (isVideoPoster(asset)) continue;
    const url = resolveUrl(asset, canvasId);
    if (!url) continue;
    items.push({
      id: asset.id,
      title: asset.title,
      url,
      origin: asset.source,
      isFavorite: asset.isFavorite === true,
      createdAt: asset.createdAt,
      canvasId
    });
  }
  return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export type ImageTab = "all" | "favorite";

export type ImageFilter = {
  tab: ImageTab;
  /** `null` 表示不按来源筛。 */
  origin: ImageOrigin | null;
  /**
   * `null` 表示全部画布；否则只留这一张。
   * 特殊值 {@link CURRENT_AND_LIBRARY} 是默认视图：当前画布 + 素材库（见 `library-source.ts`）。
   */
  canvasId: string | null;
  /** 当前打开的画布。只有 {@link CURRENT_AND_LIBRARY} 需要它来判断「哪张是当前画布」。 */
  currentCanvasId?: string | null;
  query: string;
};

export const DEFAULT_IMAGE_FILTER: ImageFilter = { tab: "all", origin: null, canvasId: null, query: "" };

export function filterImages(items: readonly ImageLibraryItem[], filter: ImageFilter): ImageLibraryItem[] {
  const needle = filter.query.trim().toLowerCase();
  return items.filter((item) => {
    if (filter.tab === "favorite" && !item.isFavorite) return false;
    if (filter.origin && item.origin !== filter.origin) return false;
    if (!matchesCanvasFilter(filter.canvasId, item, filter.currentCanvasId ?? null)) return false;
    if (needle && !item.title.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** 各来源的数量（按「收藏」tab 与搜索词过滤后统计，不受来源筛选自己影响）。 */
export function countByOrigin(
  items: readonly ImageLibraryItem[],
  filter: Pick<ImageFilter, "tab" | "query">
): Record<ImageOrigin, number> {
  const counts: Record<ImageOrigin, number> = { uploaded: 0, generated: 0, external: 0 };
  for (const item of filterImages(items, { ...filter, origin: null, canvasId: null })) counts[item.origin] += 1;
  return counts;
}

/**
 * 各画布的数量（同样只在「收藏」与搜索之后统计）。
 *
 * 顺序按「当前画布在最前，其余按图片数倒序」—— 用户最常看的就是自己正在做的这张。
 */
export function countByCanvas(
  items: readonly ImageLibraryItem[],
  filter: Pick<ImageFilter, "tab" | "query">,
  currentCanvasId: string | null
): Array<{ canvasId: string; canvasTitle: string; count: number }> {
  const counts = new Map<string, { canvasTitle: string; count: number }>();
  for (const item of items) {
    if (filter.tab === "favorite" && !item.isFavorite) continue;
    const needle = filter.query.trim().toLowerCase();
    if (needle && !item.title.toLowerCase().includes(needle)) continue;
    const entry = counts.get(item.canvasId);
    if (entry) entry.count += 1;
    else counts.set(item.canvasId, { canvasTitle: item.canvasTitle ?? "", count: 1 });
  }
  return [...counts.entries()]
    .map(([canvasId, value]) => ({ canvasId, ...value }))
    .sort((a, b) => {
      if (a.canvasId === currentCanvasId) return -1;
      if (b.canvasId === currentCanvasId) return 1;
      return b.count - a.count;
    });
}

/**
 * 当前画布的图库数据源。
 *
 * `canvasState.subscribe` 是整个 store 粒度的通知（任何节点移动都会触发），所以这里按
 * 「资产数组引用」去重：引用没变就不重算、不通知，避免拖一个节点就让整个网格重渲染。
 *
 * 写操作走 {@link ImageLibraryWrites}（由安装点提供），图库自己不 import 会话：
 * 资源栏面板与扩展共用同一个实现，行为不会分叉。
 */
export interface ImageLibraryWrites {
  /** 会话是否可写。只读时两个写操作都要直接给出原因，不假装成功。 */
  isWritable(): boolean;
  submit(commands: readonly CanvasCommand[], commandId: string): { ok: boolean; reason?: string };
  /** 当前视口中心对应的世界坐标与缩放；拿不到就退回原点。 */
  viewportCenter(): { x: number; y: number; zoom: number };
  /**
   * 把**其他画布**的一张图放到当前画布。
   *
   * 字节按画布分开存，当前画布读不到别的画布的对象；所以节点里的媒体地址必须带
   * 原画布的读取提示，而资产本体照抄原画布那份（id / metadata / url 都不改）。
   * 拿不到原资产就不写 —— 写一个引用不到字节的节点比不写更糟。
   */
  addForeignToCanvas(canvasId: string, assetId: string): Promise<ImageLibraryResult>;
}

export function currentCanvasSource(
  state: {
    getCanvas(): ServerCanvas | null;
    getWorkingCanvas(): ServerCanvas | null;
    subscribe(listener: () => void): () => void;
  },
  canvasId: string,
  resolveUrl?: (asset: StoredAsset, canvasId: string) => string | null,
  writes?: ImageLibraryWrites
): ImageLibrarySource {
  const read = () => state.getWorkingCanvas() ?? state.getCanvas();
  let lastAssets: ServerCanvas["assets"] | undefined;
  let cached: readonly ImageLibraryItem[] = [];

  /** canonical 里的原始资产：写回时必须是完整对象，不能拿图库的精简视图去覆盖。 */
  const findAsset = (id: string): StoredAsset | undefined =>
    state.getCanvas()?.assets.find((asset) => asset.id === id);

  const writable = (): ImageLibraryResult | null =>
    writes && writes.isWritable() ? null : { ok: false, reason: "画布当前是只读的（未连接或同步未就绪）" };

  return {
    scopeLabel: "当前画布",
    getItems() {
      const canvas = read();
      if (canvas?.assets !== lastAssets) {
        lastAssets = canvas?.assets;
        cached = collectImages(canvas, canvasId, resolveUrl);
      }
      return cached;
    },
    subscribe(listener) {
      let seen = read()?.assets;
      return state.subscribe(() => {
        const next = read()?.assets;
        if (next === seen) return;
        seen = next;
        listener();
      });
    },
    setFavorite(id, favorite) {
      const blocked = writable();
      if (blocked) return blocked;
      const asset = findAsset(id);
      if (!asset) return { ok: false, reason: "找不到这张图片（可能已被删除）" };
      // `isFavorite` 的归一化只认 `=== true`，取消收藏要显式去掉这个键，写 false 也一样成立。
      const next: StoredAsset = { ...asset };
      if (favorite) next.isFavorite = true;
      else delete next.isFavorite;
      const result = writes!.submit([{ type: "asset.upsert", asset: next }], createHighEntropyId("image-favorite"));
      return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? "收藏没有写入" };
    },
    async addToCanvas(id) {
      const blocked = writable();
      if (blocked) return blocked;
      const asset = findAsset(id);
      if (!asset) return { ok: false, reason: "找不到这张图片（可能已被删除）" };
      const { x, y, zoom } = writes!.viewportCenter();
      // 与导入计划同一套错位规则：同一位置连点两次不会叠成一个节点
      const position = nextPlacement({ x, y, zoom }, nearbyNodeCount(state, x, y));
      const nodeData: CanvasNodeData = {
        title: asset.title || "图片",
        outputAssetId: asset.id,
        resourceKind: "image",
        taskStatus: "successed"
      };
      const commands: CanvasCommand[] = [
        // 资产本来就在这张画布里，`upsert` 只保证节点引用到的资产此刻存在（跨画布复用时会用上）
        { type: "asset.upsert", asset },
        ...planInsertNode({ nodeType: "image", position, nodeData })
      ];
      const result = writes!.submit(commands, createHighEntropyId("image-add-to-canvas"));
      return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? "没有添加到画布" };
    }
  };
}

/**
 * 跨画布图库数据源。
 *
 * 数据分两路合并：
 * - **当前画布**读 `canvasState`（实时，刚生成/刚上传的图立刻出现）；
 * - **其他画布**读后端 `GET /api/canvases/images`（从各画布已发布的投影里抽图片）。
 *
 * 后端的列表有缓存（默认 3 秒），刷新时机由 `refresh()` 控制：切到「全部画布」时拉一次、
 * 以及当前画布资产变化时失效重拉 —— 不给它加定时器，图库不该在后台一直请求。
 *
 * 写操作只在**当前画布**的图上可用：其他画布的资产不在当前会话里，写不了。
 */
export type CrossCanvasFetch = () => Promise<Array<{
  canvasId: string;
  canvasTitle?: string;
  id: string;
  title: string;
  url: string;
  source: ImageOrigin;
  isFavorite: boolean;
  createdAt: string;
}>>;

export function crossCanvasSource(input: {
  current: ImageLibrarySource;
  currentCanvasId: string;
  /** 拉其他画布的图片；失败时返回空数组（图少几张好过整块报错）。 */
  fetchOthers: CrossCanvasFetch;
  /**
   * 把其他画布的图放到当前画布（节点引用原画布的资产与地址）。
   *
   * 需要先读回原资产，所以是异步的；读不到就失败，不写引用不到字节的节点。
   */
  addForeignToCanvas: (item: ImageLibraryItem) => Promise<ImageLibraryResult>;
  /** 其他画布图片的 `<img src>` 地址（加部署前缀与 `?canvas=` 提示）。 */
  resolveUrl: (url: string, canvasId: string) => string;
}): ImageLibrarySource {
  let others: readonly ImageLibraryItem[] = [];
  let merged: readonly ImageLibraryItem[] = others;
  let loading = false;
  let failure: string | null = null;
  const listeners = new Set<() => void>();

  const rebuild = () => {
    /*
     * 当前画布的实时数据优先：同一资产两边都有时，用实时那份（收藏状态更新）。
     *
     * **去重键是「画布 + 资产」而不是资产 id**：把别的画布的图加到当前画布之后，同一个
     * 资产 id 会同时属于两张画布，只按 id 去重会让那张图在原画布分组里凭空少一条
     * （实测「全部画布」计数从 32 掉到 31）。
     */
    const live = input.current.getItems();
    const liveKeys = new Set(live.map((item) => `${item.canvasId}:${item.id}`));
    const rest = others.filter((item) => !liveKeys.has(`${item.canvasId}:${item.id}`));
    merged = [...live, ...rest].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
    );
    for (const listener of [...listeners]) listener();
  };

  let refreshing: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing;
    loading = true;
    refreshing = input
      .fetchOthers()
      .then((entries) => {
        others = entries.map((entry) => ({
          id: entry.id,
          title: entry.title,
          // 后端给的是逻辑路径，这里只加部署前缀；图库显示不额外带 ?canvas=（那是读取提示）
          url: input.resolveUrl(entry.url, entry.canvasId),
          origin: entry.source,
          isFavorite: entry.isFavorite,
          createdAt: entry.createdAt,
          canvasId: entry.canvasId,
          canvasTitle: entry.canvasTitle
        }));
        failure = null;
      })
      .catch((error: unknown) => {
        failure = error instanceof Error ? error.message : "读取其他画布的图片失败";
      })
      .finally(() => {
        loading = false;
        refreshing = null;
        rebuild();
      });
    return refreshing;
  };

  /*
   * 当前画布变了就重建合并结果（数据本身没变，不用重拉其他画布）。
   *
   * **不在构造时拉取**：面板默认只看当前画布，一进画布就请求整份跨画布列表是白花的
   * （之前这里写着「不在这里发请求」却在下一行无条件 `refresh()`）。首次切到「全部画布」
   * 时由界面调 `refresh()`。
   */
  const unsubscribeCurrent = input.current.subscribe(rebuild);

  return {
    scopeLabel: "全部画布",
    getItems: () => merged,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** 释放对当前画布的订阅（面板卸载时调用；反复挂载不留累积订阅）。 */
    dispose() {
      unsubscribeCurrent();
      listeners.clear();
    },
    /** 重新拉其他画布（切到「全部画布」时调用）。 */
    refresh,
    get loadingOthers() {
      return loading;
    },
    get othersFailure() {
      return failure;
    },
    setFavorite(id, favorite) {
      // 只有当前画布的图能写；其他画布的资产不在本会话里
      if (merged.find((item) => item.id === id)?.canvasId !== input.currentCanvasId) {
        return { ok: false, reason: "这张图属于其他画布，请先切换到那张画布再收藏" };
      }
      return input.current.setFavorite(id, favorite);
    },
    async addToCanvas(id) {
      const item = merged.find((entry) => entry.id === id);
      if (!item) return { ok: false, reason: "找不到这张图片（可能已被删除）" };
      if (item.canvasId !== input.currentCanvasId) {
        // 其他画布的图：带到当前画布，但媒体仍归原画布（见 ImageLibraryWrites.addForeignToCanvas）
        return input.addForeignToCanvas(item);
      }
      return input.current.addToCanvas(id);
    }
  };
}

/**
 * 下一个节点该放在哪：视口中心起，按已有节点数错开。
 *
 * **同插件内唯一的摆放出口**。「添加到画布」（图库面板）、素材库放置、Pinterest 右键「发送到画布」
 * 都走它，连续放置才不会叠在一起，规则也只有一份。
 * 它背后的 `planImportLayout` 在 `paste-import` 插件里；跨插件依赖已在架构门禁里评审过
 * （`canvas-shell/image-library.ts -> paste-import`），新文件不要再各自去引它 ——
 * 经这里转一手，门禁清单就不用每多一个调用方就加一条。
 */
export function nextPlacement(center: { x: number; y: number; zoom: number }, nearby: number): { x: number; y: number } {
  const positions = planImportLayout({ x: center.x, y: center.y }, nearby + 1, center.zoom);
  return positions[positions.length - 1]!;
}

/**
 * 视口中心附近已有的节点数。
 *
 * 用来把连续「添加到画布」的节点错开摆放：每次都落在中心点会完全重叠，看起来像只加了一个。
 * 只数落在中心一小片区域里的节点 —— 用户把之前的节点挪走后，下一次又回到中心。
 */
export function nearbyNodeCount(
  state: { getWorkingCanvas(): ServerCanvas | null; getCanvas(): ServerCanvas | null },
  centerX: number,
  centerY: number
): number {
  const canvas = state.getWorkingCanvas() ?? state.getCanvas();
  if (!canvas) return 0;
  const byId = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  const radius = 200;
  let count = 0;
  for (const node of canvas.document.nodes) {
    // 返回的是绝对外框 { x, y, width, height }（不是 { position }），组内节点已换算过
    const rect = getWoohaa3CanvasNodeRect(node as never, byId as never);
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    if (Math.abs(cx - centerX) <= radius && Math.abs(cy - centerY) <= radius) count += 1;
  }
  return count;
}
