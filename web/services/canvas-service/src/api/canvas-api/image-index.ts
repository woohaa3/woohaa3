/**
 * 跨画布图片列表（图库「全部画布」用）。
 *
 * 图片资产只存在于各画布的 Yjs published projection 里，`GET /api/canvases/:id` 返回的
 * `assets` 是空的（room 从上游拉取内容，REST 只给摘要）。所以这里不逐个开画布，而是
 * 「目录列 id → 读投影 → 抽图片」，一次请求拿全。
 *
 * 约束：
 * - 只读 published projection（`CanvasPublishedReader`），不碰 room / checkpoint，
 *   因此不会因为没人打开画布而漏数据；
 * - 只收 `mediaKind === "image"`、`status === "ready"`、且登记了 `url` 的资产 ——
 *   与前端图库（`canvas-shell/image-library.ts`）同一套口径，两边数量才对得上；
 * - 视频海报（`provenance.taskKind === "video-generation"`）不算用户的图片。
 *
 * 目录里可能包含只存在于远端的画布（本机没有投影），它们读不到就跳过，不报错：
 * 图库少一张图远好于整页 500。
 */
import type { ServerCanvas, StoredAsset } from "@woohaa3/contracts";

export type CanvasImageEntry = {
  canvasId: string;
  /** 画布标题（空标题由界面兜底显示）。 */
  canvasTitle: string;
  id: string;
  title: string;
  url: string;
  source: StoredAsset["source"];
  isFavorite: boolean;
  createdAt: string;
  /**
   * 完整资产（含 `metadata.storageKey` 等）。
   *
   * 带上它是为了让**别的画布**能把这张图放到自己的画布里：那需要原样写回一条资产，
   * 只给展示用的 id/url 不够。它本来就是画布公开投影的一部分，不算额外暴露。
   */
  asset: StoredAsset;
};

export type CanvasImageListResult = {
  items: CanvasImageEntry[];
  total: number;
  offset: number;
  limit: number;
  /** 实际扫描过的画布数（诊断用；扫描被上限截断时它等于上限）。 */
  scannedCanvases: number;
  /**
   * 画布数超过扫描上限、列表**不完整**。
   *
   * 必须如实返回：否则「图少了」看起来像数据丢了，排查时无从下手。
   */
  truncated: boolean;
};

export type CanvasImageIndexPort = {
  list(input: {
    offset: number;
    limit: number;
    /** 只列这些画布（资源授权的可发现集合）；省略表示不额外过滤。 */
    canvasIds?: readonly string[];
  }): Promise<CanvasImageListResult>;
};

export type CanvasImageIndexDeps = {
  /** 列画布 id + 标题；缺省时接口返回 503。 */
  listCanvases(input: { offset: number; limit: number }): Promise<{
    items: ReadonlyArray<{ id: string; title?: string }>;
    total: number;
  }>;
  loadPublished(canvasId: string): Promise<ServerCanvas | null>;
  /** 结果缓存时长（毫秒）；缺省 3000。设 0 关闭缓存（测试用）。 */
  cacheTtlMs?: number;
  now?: () => number;
};

/** 单次请求最多扫描的画布数：图库是浏览用的，不该把整个工作区的投影都读一遍。 */
export const MAX_SCANNED_CANVASES = 200;

function isVideoPoster(asset: StoredAsset): boolean {
  return asset.provenance?.taskKind === "video-generation";
}

export function imagesOf(canvas: ServerCanvas, canvasTitle: string): CanvasImageEntry[] {
  const items: CanvasImageEntry[] = [];
  for (const asset of canvas.assets ?? []) {
    if (asset.mediaKind !== "image" || asset.status !== "ready") continue;
    if (isVideoPoster(asset)) continue;
    if (typeof asset.url !== "string" || asset.url === "") continue;
    items.push({
      canvasId: canvas.id,
      canvasTitle,
      id: asset.id,
      title: asset.title ?? "",
      url: asset.url,
      source: asset.source,
      isFavorite: asset.isFavorite === true,
      createdAt: asset.createdAt ?? "",
      asset
    });
  }
  return items;
}

export function createCanvasImageIndex(deps: CanvasImageIndexDeps): CanvasImageIndexPort {
  const ttl = deps.cacheTtlMs ?? 3000;
  const now = deps.now ?? Date.now;
  // 缓存按「允许画布集合」分开：授权不同的人不能共用同一份结果
  let cached: { key: string; at: number; items: CanvasImageEntry[]; scanned: number; truncated: boolean } | null = null;

  const collect = async (
    canvasIds: readonly string[] | undefined
  ): Promise<{ items: CanvasImageEntry[]; scanned: number; truncated: boolean }> => {
    const key = canvasIds ? [...canvasIds].sort().join(",") : "*";
    if (cached && cached.key === key && now() - cached.at < ttl) {
      return { items: cached.items, scanned: cached.scanned, truncated: cached.truncated };
    }
    const page = await deps.listCanvases({ offset: 0, limit: MAX_SCANNED_CANVASES });
    // 目录本身的 total 可能大于这一页：那就说明有画布没被扫到，如实标记
    const truncated = page.total > page.items.length;
    const allowed = canvasIds ? new Set(canvasIds) : null;
    const items: CanvasImageEntry[] = [];
    let scanned = 0;
    for (const entry of page.items) {
      if (allowed && !allowed.has(entry.id)) continue;
      scanned += 1;
      let canvas: ServerCanvas | null = null;
      try {
        canvas = await deps.loadPublished(entry.id);
      } catch {
        // 单张画布读失败（远端-only、存储抖动）跳过，不影响整份列表
        continue;
      }
      if (!canvas) continue;
      items.push(...imagesOf(canvas, entry.title ?? ""));
    }
    // 新建的图排前面；同一时刻保持目录顺序（稳定排序）
    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    cached = { key, at: now(), items, scanned, truncated };
    return { items, scanned, truncated };
  };

  return {
    async list({ offset, limit, canvasIds }) {
      const { items: all, scanned, truncated } = await collect(canvasIds);
      return {
        items: all.slice(offset, offset + limit),
        total: all.length,
        offset,
        limit,
        scannedCanvases: scanned,
        truncated
      };
    }
  };
}
