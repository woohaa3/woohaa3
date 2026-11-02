/**
 * 图库缩略图（浏览器端生成）。
 *
 * 为什么不在后端做：宿主 media-service 的 `?variant=thumbnail` 通道已经存在，但
 * **没有注入生成器**（实测回 415 derivative-unsupported），后端也没有可用的图像库 ——
 * 补上要新增原生依赖或把那套 Rust 编进服务端。在那之前，前端用 `createImageBitmap`
 * 在**解码阶段**就把图缩到 256px，代价低、立刻生效。
 *
 * 两个关键点：
 * - `resizeWidth/resizeHeight` 交给解码器，比「先整图解码再缩放」省一个数量级的峰值内存
 *   （图库里的原图实测最大 22MB，直接 `<img>` 会把整张解码进显存/内存，图一多就卡）；
 * - 结果按 URL 缓存成 Blob URL，滚动来回不重复解码。
 *
 * 并发上限刻意压得低：解码会占主线程外的工作线程，一次扔几十张进去同样是卡。
 */
export type ThumbnailLoader = {
  /** 已生成好的缩略图；没有就返回 null（调用方先放占位）。 */
  get(url: string): string | null;
  /** 请求一张缩略图；已在队列/已存在时直接复用。结果通过 `subscribe` 通知。 */
  request(url: string): void;
  /** 缩略图就绪通知（按 URL 订阅）。返回取消订阅。 */
  subscribe(url: string, listener: () => void): () => void;
  /** 释放缓存的 Blob URL（面板卸载时调用）。 */
  dispose(): void;
};

type CacheEntry = { state: "pending" | "ready" | "failed"; objectUrl?: string };

export const THUMBNAIL_MAX_EDGE = 256;
/** 同时解码的张数上限。 */
export const THUMBNAIL_CONCURRENCY = 3;

export function createThumbnailLoader(options: {
  /** 解码 + 缩放；默认走 `createImageBitmap` + canvas。测试可注入。 */
  generate?: (url: string, maxEdge: number) => Promise<Blob | null>;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  concurrency?: number;
} = {}): ThumbnailLoader {
  const generate = options.generate ?? generateWithBitmap;
  const createObjectUrl = options.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectUrl = options.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const limit = Math.max(1, options.concurrency ?? THUMBNAIL_CONCURRENCY);

  const cache = new Map<string, CacheEntry>();
  const waiting: string[] = [];
  const listeners = new Map<string, Set<() => void>>();
  let running = 0;
  /**
   * 代次，不是「已销毁」开关。
   *
   * **不能用永久标记**：开发模式下 `StrictMode` 会把 effect 跑成「执行 → 清理 → 执行」，
   * 清理里调 `dispose()` 之后，同一个实例还要继续用 —— 置成永久关闭会让面板从此一张缩略图
   * 都不生成（实测：占位一直不消失，`/api/media` 一个请求都没发）。
   * 所以 `dispose` 只清缓存、释放 Blob URL、作废**在途**结果（靠这个代次比对），
   * 之后的 `request` 照常工作。
   */
  let epoch = 0;

  const notify = (url: string) => {
    for (const listener of listeners.get(url) ?? []) listener();
  };

  const pump = (): void => {
    while (running < limit && waiting.length > 0) {
      const url = waiting.shift()!;
      const entry = cache.get(url);
      if (!entry || entry.state !== "pending") continue;
      const startedAt = epoch;
      running += 1;
      void generate(url, THUMBNAIL_MAX_EDGE)
        .then((blob) => {
          // 期间被 dispose 过：结果作废，不写回（那份缓存的 Blob URL 没人会释放）
          if (startedAt !== epoch) return;
          cache.set(url, blob ? { state: "ready", objectUrl: createObjectUrl(blob) } : { state: "failed" });
        })
        .catch(() => {
          if (startedAt === epoch) cache.set(url, { state: "failed" });
        })
        .finally(() => {
          running -= 1;
          notify(url);
          pump();
        });
    }
  };

  return {
    get(url) {
      const entry = cache.get(url);
      return entry?.state === "ready" ? entry.objectUrl ?? null : null;
    },
    request(url) {
      const entry = cache.get(url);
      if (entry) return; // 已排队 / 已就绪 / 已失败：失败不重试，避免滚动时反复打网络
      cache.set(url, { state: "pending" });
      waiting.push(url);
      pump();
    },
    subscribe(url, listener) {
      let set = listeners.get(url);
      if (!set) {
        set = new Set();
        listeners.set(url, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) listeners.delete(url);
      };
    },
    dispose() {
      // 只作废在途结果并释放已缓存的地址；实例本身继续可用（StrictMode / 重新挂载）
      epoch += 1;
      for (const entry of cache.values()) {
        if (entry.state === "ready" && entry.objectUrl) revokeObjectUrl(entry.objectUrl);
      }
      cache.clear();
      listeners.clear();
      waiting.length = 0;
    }
  };
}

/**
 * 取图 → 解码时缩放 → 编码成 webp。
 *
 * 失败返回 null（调用方回退成不显示，而不是又退回原图把内存打满）。
 * `createImageBitmap` 的 `resizeQuality` 在 Chromium 上生效；不支持的浏览器只影响清晰度。
 *
 * **`resizeWidth` / `resizeHeight` 必须按原图比例算**，不能两个都传 `maxEdge`：
 * 两个都给等于强制拉伸成正方形，非正方形的图会被压扁（踩过：竖图一眼能看出来）。
 */
async function generateWithBitmap(url: string, maxEdge: number): Promise<Blob | null> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) return null;
  const source = await response.blob();
  if (typeof createImageBitmap !== "function") return null;

  // 先读尺寸（`[0, 0]` 不开解码），算出等比的目标尺寸再交给解码器缩放
  const probe = await createImageBitmap(source);
  const { width: sourceWidth, height: sourceHeight } = probe;
  probe.close();
  if (!sourceWidth || !sourceHeight) return null;

  const scale = Math.min(maxEdge / sourceWidth, maxEdge / sourceHeight, 1);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const bitmap = await createImageBitmap(source, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "medium"
  });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.8));
  } finally {
    bitmap.close();
  }
}
