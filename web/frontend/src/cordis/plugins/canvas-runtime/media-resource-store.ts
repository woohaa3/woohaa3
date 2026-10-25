/**
 * Canvas Runtime 有界媒体资源 store
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D8/D9，任务 4.1）。
 *
 * 由 Canvas Runtime scope 唯一持有的**有界**解码资源 owner：以稳定来源 identity 为键共享
 * 已经存在的 CPU 位图，通过 acquire/release lease 与引用计数避免同一来源被多个 consumer
 * （卡片 / 图片聚焦 / 视频聚焦）重复解码；按质量请求（卡片/聚焦尺寸）决定采样上限。
 *
 * 关键不变式：
 * - CPU 位图与 GPU handle **分别**管理：本 store 只拥有 CPU 位图（`ImageBitmap`）与尺寸/字节预算；
 *   GPU 纹理的持有、换尺寸与呈现后回收仍由 `texture-sync` / Rust 侧负责，二者不以尺寸互相代替。
 * - 预算有界：条目数与总字节都有上限，超出时**只**回收无 lease、无 pin 的最久未用条目；
 *   active focus / capture / 待交接资源通过 `pin` 显式保护。
 * - 换源/设备恢复：`invalidateSource` 丢弃该 identity 的缓存并关闭位图；新 acquire 重新解码，
 *   旧表示在被丢弃前不冒充新内容。
 * - dispose：幂等释放全部缓存并关闭所有位图，不悬挂等待者。
 *
 * 只承载浏览器本地可丢弃资源，不进入 canonical / Y.Doc。
 */

/** 稳定来源 identity：同一 canonical 素材的多 consumer 共享同一条目。 */
export type MediaSourceIdentity = import("../../focus/media-resources.js").FocusMediaSource;

/** 一次成功 lease 的到期释放句柄。 */
export type MediaLease = import("../../focus/media-resources.js").FocusMediaLease;

/** 已解码的 CPU 位图表示（CPU 位图与 GPU handle 生命周期分离）。 */
export type MediaBitmap = import("../../focus/media-resources.js").FocusMediaBitmap;

export type MediaDecodeResult =
  | { ok: true; value: MediaBitmap }
  | { ok: false; code: "unresolvable" | "decode-failed" | "stale"; message: string };

/** 解码实现（测试注入）；缺省由调用方注入真实解码。 */
export type MediaDecoder = (source: MediaSourceIdentity) => Promise<MediaDecodeResult>;

export type MediaResourceStoreOptions = {
  decode: MediaDecoder;
  /** 条目数上限（缺省 8）。 */
  maxEntries?: number;
  /** 总字节预算（缺省 128 MiB；按 width×height×4 估算）。 */
  maxBytes?: number;
  /** 关闭位图（缺省调用 `ImageBitmap.close`）。 */
  close?: (bitmap: CanvasImageSource) => void;
  now?: () => number;
};

type Entry = {
  key: string;
  value: MediaBitmap;
  refs: number;
  pinned: Set<string>;
  lastUsed: number;
};

function defaultClose(bitmap: CanvasImageSource): void {
  const close = (bitmap as ImageBitmap).close;
  if (typeof close === "function") {
    try {
      close.call(bitmap);
    } catch {
      // 已关闭/不可关闭：忽略。
    }
  }
}

/** 位图字节估算（RGBA8）。 */
export function estimateBitmapBytes(bitmap: MediaBitmap): number {
  return Math.max(0, Math.round(bitmap.width * bitmap.height * 4));
}

/**
 * 有界媒体资源 store。
 *
 * `acquire` 返回共享位图 lease（同 identity 只解码一次）；`invalidateSource` / `dispose`
 * 释放缓存。预算回收只发生在无 lease、无 pin 的条目上。
 */
export class MediaResourceStore {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<MediaDecodeResult>>();
  private readonly decode: MediaDecoder;
  private readonly close: (bitmap: CanvasImageSource) => void;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(options: MediaResourceStoreOptions) {
    this.decode = options.decode;
    this.close = options.close ?? defaultClose;
    this.maxEntries = Math.max(1, options.maxEntries ?? 8);
    this.maxBytes = Math.max(1, options.maxBytes ?? 128 * 1024 * 1024);
    this.now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  }

  /** 当前缓存的 identity 键（诊断/测试）。 */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  /** 当前缓存条目数。 */
  size(): number {
    return this.entries.size;
  }

  /** 当前估算总字节。 */
  bytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += estimateBitmapBytes(entry.value);
    return total;
  }

  /** 是否存在该 identity 的已解码缓存。 */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** 已解码位图（若缓存）；不改变引用计数。 */
  peek(key: string): MediaBitmap | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    entry.lastUsed = this.now();
    return entry.value;
  }

  /**
   * 取得某来源的共享位图 lease；同 identity 的并发 acquire 只解码一次。
   *
   * 失败（保留原样）返回 null，不改变已有缓存；调用方保留上一合法表示。
   */
  async acquire(source: MediaSourceIdentity, pin?: string): Promise<MediaLease | null> {
    const key = source.key;
    let entry = this.entries.get(key);
    if (!entry) {
      const result = await this.resolve(source);
      if (!result.ok) return null;
      entry = this.entries.get(key);
      if (!entry) {
        // 并发/回收后重建缓存条目。
        entry = { key, value: result.value, refs: 0, pinned: new Set(), lastUsed: this.now() };
        this.entries.set(key, entry);
      }
    }
    entry.refs += 1;
    if (pin) entry.pinned.add(pin);
    entry.lastUsed = this.now();
    this.enforceBudget(key);
    return this.leaseFor(entry, pin);
  }

  /** 显式 pin（active focus / capture / 待交接），不增加引用计数但阻止预算回收。 */
  pin(key: string, token: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.pinned.add(token);
  }

  /** 解除 pin；不存在条目时 no-op。 */
  unpin(key: string, token: string): void {
    this.entries.get(key)?.pinned.delete(token);
  }

  /** 丢弃某来源缓存并在无引用时立即关闭位图（换源/设备恢复）。 */
  invalidateSource(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    // 仍有 lease 引用时延迟到引用归零后关闭（在 release 内处理）。
    if (entry.refs === 0) this.closeEntry(entry);
    else entry.pinned.add("__invalidated__");
  }

  /** 幂等释放全部缓存并关闭所有无引用位图。 */
  dispose(): void {
    for (const entry of this.entries.values()) {
      this.entries.delete(entry.key);
      if (entry.refs === 0) this.closeEntry(entry);
    }
    this.inflight.clear();
  }

  private leaseFor(entry: Entry, pin?: string): MediaLease {
    let released = false;
    return {
      key: entry.key,
      release: () => {
        if (released) return;
        released = true;
        entry.refs = Math.max(0, entry.refs - 1);
        if (pin) entry.pinned.delete(pin);
        // 已被显式失效且再无引用：现在关闭。
        if (entry.refs === 0 && entry.pinned.has("__invalidated__")) this.closeEntry(entry);
      }
    };
  }

  /** 解码并缓存；同 key 并发去重。 */
  private resolve(source: MediaSourceIdentity): Promise<MediaDecodeResult> {
    const existing = this.inflight.get(source.key);
    if (existing) return existing;
    const task = this.decode(source)
      .then((result) => {
        if (result.ok) this.cache(source.key, result.value);
        return result;
      })
      .catch(error => { throw error; })
      .finally(() => {
        if (this.inflight.get(source.key) === task) this.inflight.delete(source.key);
      });
    this.inflight.set(source.key, task);
    return task;
  }

  private cache(key: string, value: MediaBitmap): void {
    const previous = this.entries.get(key);
    if (previous) {
      previous.value = value;
      previous.lastUsed = this.now();
      return;
    }
    this.entries.set(key, { key, value, refs: 0, pinned: new Set(), lastUsed: this.now() });
    this.enforceBudget(key);
  }

  private closeEntry(entry: Entry): void {
    this.entries.delete(entry.key);
    this.close(entry.value.bitmap);
  }

  /**
   * 预算约束：条目数/字节超限时按最久未用回收无 lease、无 pin 的条目。
   * `protect` 为本次刚使用的 key，永不回收。
   */
  private enforceBudget(protect: string): void {
    while (this.entries.size > this.maxEntries || this.bytes() > this.maxBytes) {
      const victim = this.pickVictim(protect);
      if (!victim) return;
      this.closeEntry(victim);
    }
  }

  private pickVictim(protect: string): Entry | null {
    let victim: Entry | null = null;
    for (const entry of this.entries.values()) {
      if (entry.key === protect) continue;
      if (entry.refs > 0 || entry.pinned.size > 0) continue;
      if (!victim || entry.lastUsed < victim.lastUsed) victim = entry;
    }
    return victim;
  }
}
