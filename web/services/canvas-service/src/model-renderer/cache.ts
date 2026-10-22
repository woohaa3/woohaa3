/**
 * 预览结果的有界内容寻址缓存
 * （change: enhance-model-scene-authoring-api，任务 7.4 / design D12）。
 *
 * 键：`sourceHash + sceneVersion + renderVersion + normalizedCaptureOptions`。
 * 有明确字节预算与淘汰策略（LRU），并支持按 sceneVersion/renderVersion 失效。
 * 缓存内容只含可丢弃派生结果（PNG），MUST NOT 进入 Y.Doc。
 */
export type CacheEntry = {
  png: Buffer;
  width: number;
  height: number;
  sceneSignature: string;
  renderVersion: string;
};

export type RenderCacheOptions = {
  /** 总字节预算；默认 32 MiB。 */
  maxBytes?: number;
};

export type RenderCache = {
  get: (key: string) => CacheEntry | undefined;
  set: (key: string, entry: CacheEntry) => void;
  /** 失效某版本（renderer 升级 / scene 版本变更）的全部条目。 */
  invalidateVersion: (renderVersion: string) => void;
  size: () => { entries: number; bytes: number };
};

export function createRenderCache(options: RenderCacheOptions = {}): RenderCache {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const entries = new Map<string, CacheEntry>();
  let bytes = 0;

  const evict = () => {
    while (bytes > maxBytes && entries.size > 0) {
      const oldest = entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const entry = entries.get(oldest);
      if (entry) bytes -= entry.png.length;
      entries.delete(oldest);
    }
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      // LRU：命中后移到队尾。
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    set(key, entry) {
      const existing = entries.get(key);
      if (existing) {
        bytes -= existing.png.length;
        entries.delete(key);
      }
      entries.set(key, entry);
      bytes += entry.png.length;
      evict();
    },
    invalidateVersion(renderVersion) {
      for (const [key, entry] of entries) {
        if (entry.renderVersion !== renderVersion) {
          bytes -= entry.png.length;
          entries.delete(key);
        }
      }
    },
    size: () => ({ entries: entries.size, bytes })
  };
}
