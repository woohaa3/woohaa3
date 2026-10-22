/**
 * 镜头参考的**版本缓存**（任务 8.5 / design D9）
 * （change: 2026-10-15-add-film-set-shooting-shot-previews）。
 *
 * 按 `(画布, 片场, clipId, 视觉内容身份, 录制 profile)` 定位同版本视频资产，维护状态机
 * `dirty → queued → recording → ready | failed`，并提供派生状态 `superseded`（旧版本，仍可被已
 * 固定的下游消费者使用，但不作为当前版本复用）。
 *
 * 权威归属（design D9「设计实施时明确状态/资产权威归属」）：
 * - **真实资产字节**的权威在媒体服务：上传成功后拿到 `storageKey`；
 * - **运行状态**在会话缓存，默认使用内存 store；可注入其他 `ShotReferenceCacheStore`；
 * - **已完成版本映射**在画布 assets：录制完成立即登记，刷新时回填缓存；
 *   **画布 nodeData 不承载 outputAssetId**；
 * - 下游使用前必须经 `readyAsset` 取到真实 `storageKey`，禁止把预览 ID/纹理句柄当媒体。
 *
 * 关键不变量：
 * - **ready 原子发布**：只有编码、上传并校验后才 `publish`；发布前复核内容身份仍是当前版本，
 *   否则标 `superseded`，不冒充新版本；
 * - **身份去重 / 多消费者共享**：同一 cacheKey 只有一个条目与一次录制，多个消费者共享；
 * - **旧结果防覆盖**：迟到的旧版本结果只写自己的 key，绝不覆盖当前版本的 ready 条目；
 * - **引用保留**：被消费者 `retain` 的条目（含已提交任务）不参与淘汰；
 * - **容量与淘汰**：超出容量时按 LRU 淘汰无消费者的 `ready|superseded|failed` 条目；
 * - **删除清理 / 取消 / 失败重试**：源删除、取消、失败各有明确入口。
 *
 * 纯类：不 import DOM/Zustand/Yjs；持久化经 store 注入，node 可用内存 store 单测。
 */
import { readShotReferenceAssetLink, shotReferenceCacheKeyWithProfile, type StoredAsset } from "@woohaa3/contracts";

/** 版本状态机。`superseded` 表示内容已被更新版本取代。 */
export type ShotReferenceVersionStatus = "dirty" | "queued" | "recording" | "ready" | "failed" | "superseded";

/** 真实视频资产的最小投影（字节权威在媒体服务）。 */
export type ShotReferenceVersionAsset = { storageKey: string; checksum: string; mediaType: string; size: number };

/** 版本定位身份。 */
export type ShotReferenceVersionRef = {
  canvasId: string;
  filmSetNodeId: string;
  clipId: string;
  contentIdentity: string;
  profileKey: string;
};

export type ShotReferenceVersionEntry = {
  cacheKey: string;
  canvasId: string;
  filmSetNodeId: string;
  clipId: string;
  contentIdentity: string;
  profileKey: string;
  status: ShotReferenceVersionStatus;
  asset: ShotReferenceVersionAsset | null;
  updatedAt: string;
};

/** 持久化快照：版本条目 + 每个「画布+片场+镜头」的当前内容身份。 */
export type ShotReferenceCacheState = {
  versions: ShotReferenceVersionEntry[];
  current: [string, string][];
};

export type ShotReferenceCacheStore = {
  load(): ShotReferenceCacheState | null;
  save(state: ShotReferenceCacheState): void;
};

/** 内存 store：默认实现，也用于 node 单测。 */
export function createMemoryShotReferenceCacheStore(initial: ShotReferenceCacheState | null = null): ShotReferenceCacheStore {
  let state = initial;
  return {
    load: () => state,
    save: (next) => {
      state = next;
    }
  };
}

export function shotReferenceVersionKey(ref: ShotReferenceVersionRef): string {
  return shotReferenceCacheKeyWithProfile(ref);
}

/**
 * 用画布上**已登记**的镜头参考资产回填版本缓存（页面刷新/重启后免重录）。
 *
 * 录制完成或下游冻结已把真实视频资产写进权威画布（`asset.upsert`），因此内存缓存丢失不代表需要重录。
 * 只回填 `ready` 视频、且 metadata 带完整 `shotReference` 链接与 checksum 的资产；缺 checksum
 * 的旧条目仍按未就绪处理（服务端会以 `asset-reference-invalid` 拒绝冻结），交给调度器重录。
 * 幂等：同版本已 ready 且 storageKey 相同时跳过。
 */
export function hydrateShotReferenceCacheFromCanvas(
  cache: ShotReferenceVersionCache,
  canvas: { id: string; assets: readonly StoredAsset[] }
): number {
  let hydrated = 0;
  for (const asset of canvas.assets) {
    if (asset.status !== "ready" || asset.mediaKind !== "video") continue;
    const link = readShotReferenceAssetLink(asset.metadata);
    if (!link) continue;
    const metadata = (asset.metadata ?? {}) as Record<string, unknown>;
    const storageKey = metadata.storageKey;
    const checksum = metadata.checksum;
    if (typeof storageKey !== "string" || storageKey === "") continue;
    if (typeof checksum !== "string" || checksum === "") continue;
    const contentType = metadata.contentType;
    const size = metadata.size;
    const ref: ShotReferenceVersionRef = {
      canvasId: canvas.id,
      filmSetNodeId: link.filmSetNodeId,
      clipId: link.clipId,
      contentIdentity: link.contentIdentity,
      profileKey: link.profileKey
    };
    // 已有 ready 条目（本会话录制或先前回填）时不覆盖：缓存是会话内的权威，画布资产可能
    // 落后于刚完成的录制；同一内容版本的新字节仍由录制 `publish` 更新。
    if (cache.entry(ref)?.status === "ready") continue;
    cache.publish(ref, {
      storageKey,
      checksum,
      mediaType: typeof contentType === "string" && contentType !== "" ? contentType : "video/mp4",
      size: typeof size === "number" && Number.isFinite(size) ? size : 0
    });
    hydrated += 1;
  }
  return hydrated;
}

/** 当前版本的定位键（画布+片场+镜头），与内容身份无关。 */
function currentKey(ref: { canvasId: string; filmSetNodeId: string; clipId: string }): string {
  return [ref.canvasId, ref.filmSetNodeId, ref.clipId].join("\u0000");
}

export class ShotReferenceVersionCache {
  private readonly versions = new Map<string, ShotReferenceVersionEntry>();
  private readonly current = new Map<string, string>();
  private readonly consumers = new Map<string, number>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly useOrder = new Map<string, number>();
  private clock = 0;

  constructor(
    private readonly store: ShotReferenceCacheStore = createMemoryShotReferenceCacheStore(),
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly capacity = 24
  ) {
    const persisted = this.store.load();
    if (persisted) {
      for (const entry of persisted.versions) this.versions.set(entry.cacheKey, entry);
      for (const [key, identity] of persisted.current) this.current.set(key, identity);
    }
  }

  /** 标记某「画布+片场+镜头」的当前内容身份，并把旧版本标为 `superseded`。 */
  setCurrent(ref: { canvasId: string; filmSetNodeId: string; clipId: string; contentIdentity: string }): void {
    const key = currentKey(ref);
    if (this.current.get(key) === ref.contentIdentity) return;
    this.current.set(key, ref.contentIdentity);
    for (const entry of this.versions.values()) {
      if (entry.canvasId !== ref.canvasId || entry.filmSetNodeId !== ref.filmSetNodeId || entry.clipId !== ref.clipId) continue;
      if (entry.contentIdentity === ref.contentIdentity) continue;
      if (entry.status === "ready") this.setStatusEntry(entry, "superseded");
    }
    this.persist();
  }

  entry(ref: ShotReferenceVersionRef): ShotReferenceVersionEntry | null {
    const entry = this.versions.get(shotReferenceVersionKey(ref));
    if (!entry) return null;
    this.touch(entry.cacheKey);
    return entry;
  }

  status(ref: ShotReferenceVersionRef): ShotReferenceVersionStatus | null {
    return this.entry(ref)?.status ?? null;
  }

  /** 只有 `ready` 且身份仍是当前版本时才可作为下游参考。 */
  readyAsset(ref: ShotReferenceVersionRef): ShotReferenceVersionAsset | null {
    const entry = this.entry(ref);
    if (!entry || entry.status !== "ready" || !entry.asset) return null;
    // 旧持久化条目可能没有 checksum；缺它会让服务端以 asset-reference-invalid 拒绝整批冻结命令，
    // 所以按「未就绪」处理，重新录制换回可用资产。
    if (!entry.asset.checksum) return null;
    return entry.asset;
  }

  /** 某版本是否已是当前版本的 ready（供下游执行准备阶段快速判断）。 */
  isReadyCurrent(ref: { canvasId: string; filmSetNodeId: string; clipId: string; contentIdentity: string; profileKey: string }): boolean {
    const key = currentKey(ref);
    if (this.current.get(key) !== ref.contentIdentity) return false;
    return this.status(ref) === "ready";
  }

  markQueued(ref: ShotReferenceVersionRef): void {
    this.upsert(ref, "queued");
    this.emit(shotReferenceVersionKey(ref));
  }

  markRecording(ref: ShotReferenceVersionRef): void {
    this.upsert(ref, "recording");
    this.emit(shotReferenceVersionKey(ref));
  }

  markFailed(ref: ShotReferenceVersionRef, _reason?: string): void {
    const entry = this.versions.get(shotReferenceVersionKey(ref));
    if (entry) this.setStatusEntry(entry, "failed");
    else {
      this.upsert(ref, "failed");
      this.emit(shotReferenceVersionKey(ref));
    }
  }

  /** 失败/取消后重试：回到 `queued`，便于调度器再次取件。 */
  retry(ref: ShotReferenceVersionRef): void {
    const entry = this.versions.get(shotReferenceVersionKey(ref));
    if (entry) this.setStatusEntry(entry, "queued");
    else {
      this.upsert(ref, "queued");
      this.emit(shotReferenceVersionKey(ref));
    }
  }

  /** 取消等待/录制：回到 `dirty`，等下一次触发；已 ready 的条目不受影响。 */
  cancel(ref: ShotReferenceVersionRef): void {
    const entry = this.versions.get(shotReferenceVersionKey(ref));
    if (!entry || entry.status === "ready" || entry.status === "superseded") return;
    this.setStatusEntry(entry, "dirty");
  }

  /**
   * **原子发布** ready。仅当该版本仍是当前内容版本时成立；否则记为 `superseded` 并返回 `false`，
   * 迟到的旧结果不会覆盖当前版本，也不会被当成最新版本使用。
   */
  publish(ref: ShotReferenceVersionRef, asset: ShotReferenceVersionAsset): boolean {
    const key = shotReferenceVersionKey(ref);
    const entry = this.upsert(ref, "ready");
    entry.asset = asset;
    entry.updatedAt = this.now();
    const isCurrent = this.current.get(currentKey(ref)) === ref.contentIdentity;
    if (!isCurrent && this.current.has(currentKey(ref))) {
      this.setStatusEntry(entry, "superseded");
      this.persist();
      this.emit(key);
      this.evict();
      return false;
    }
    this.persist();
    this.emit(key);
    this.evict();
    return true;
  }

  /** 多消费者订阅某个版本；`ready` 发布时会通知。返回退订函数。 */
  subscribe(ref: ShotReferenceVersionRef, listener: () => void): () => void {
    const key = shotReferenceVersionKey(ref);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(key);
    };
  }

  /** 保留（引用）某版本，使其不参与淘汰；返回释放函数。 */
  retain(ref: ShotReferenceVersionRef): () => void {
    const key = shotReferenceVersionKey(ref);
    this.consumers.set(key, (this.consumers.get(key) ?? 0) + 1);
    return () => {
      const next = (this.consumers.get(key) ?? 1) - 1;
      if (next <= 0) this.consumers.delete(key);
      else this.consumers.set(key, next);
    };
  }

  /** 源片场/镜头删除清理：移除该源下所有条目（含消费者计数）。 */
  removeBySource(ref: { canvasId: string; filmSetNodeId: string }): void {
    for (const [key, entry] of [...this.versions.entries()]) {
      if (entry.canvasId !== ref.canvasId || entry.filmSetNodeId !== ref.filmSetNodeId) continue;
      this.versions.delete(key);
      this.consumers.delete(key);
      this.useOrder.delete(key);
    }
    for (const key of [...this.current.keys()]) {
      if (key.startsWith(`${ref.canvasId}\u0000${ref.filmSetNodeId}\u0000`)) this.current.delete(key);
    }
    this.persist();
  }

  /** 画布整体删除清理。 */
  removeByCanvas(canvasId: string): void {
    for (const [key, entry] of [...this.versions.entries()]) {
      if (entry.canvasId !== canvasId) continue;
      this.versions.delete(key);
      this.consumers.delete(key);
      this.useOrder.delete(key);
    }
    for (const key of [...this.current.keys()]) {
      if (key.startsWith(`${canvasId}\u0000`)) this.current.delete(key);
    }
    this.persist();
  }

  /** 中断恢复：把遗留的 `queued|recording` 重置为 `dirty`，等调度器重新排队。 */
  recoverInterrupted(): void {
    for (const entry of this.versions.values()) {
      if (entry.status === "queued" || entry.status === "recording") this.setStatusEntry(entry, "dirty");
    }
    this.persist();
  }

  /** 按容量淘汰：优先淘汰 `superseded`，再 `failed`，最后无消费者的 `ready`；LRU。 */
  evict(): void {
    if (this.versions.size <= this.capacity) return;
    const removable = [...this.versions.values()]
      .filter((entry) => !this.consumers.has(entry.cacheKey) && entry.status !== "recording" && entry.status !== "queued" && entry.status !== "dirty")
      .sort((a, b) => {
        const rank = (entry: ShotReferenceVersionEntry) => (entry.status === "superseded" ? 0 : entry.status === "failed" ? 1 : 2);
        const byRank = rank(a) - rank(b);
        if (byRank !== 0) return byRank;
        return (this.useOrder.get(a.cacheKey) ?? 0) - (this.useOrder.get(b.cacheKey) ?? 0);
      });
    for (const entry of removable) {
      if (this.versions.size <= this.capacity) break;
      this.versions.delete(entry.cacheKey);
      this.useOrder.delete(entry.cacheKey);
    }
    this.persist();
  }

  /** 诊断/测试快照。 */
  snapshot(): readonly ShotReferenceVersionEntry[] {
    return [...this.versions.values()];
  }

  private upsert(ref: ShotReferenceVersionRef, status: ShotReferenceVersionStatus): ShotReferenceVersionEntry {
    const key = shotReferenceVersionKey(ref);
    const existing = this.versions.get(key);
    if (existing) {
      existing.status = status;
      existing.canvasId = ref.canvasId;
      existing.filmSetNodeId = ref.filmSetNodeId;
      existing.clipId = ref.clipId;
      existing.contentIdentity = ref.contentIdentity;
      existing.profileKey = ref.profileKey;
      existing.updatedAt = this.now();
      this.touch(key);
      this.persist();
      return existing;
    }
    const entry: ShotReferenceVersionEntry = {
      cacheKey: key,
      canvasId: ref.canvasId,
      filmSetNodeId: ref.filmSetNodeId,
      clipId: ref.clipId,
      contentIdentity: ref.contentIdentity,
      profileKey: ref.profileKey,
      status,
      asset: null,
      updatedAt: this.now()
    };
    this.versions.set(key, entry);
    this.touch(key);
    this.persist();
    return entry;
  }

  private setStatusEntry(entry: ShotReferenceVersionEntry, status: ShotReferenceVersionStatus): void {
    entry.status = status;
    if (status !== "ready") entry.asset = null;
    entry.updatedAt = this.now();
    this.persist();
    this.emit(entry.cacheKey);
  }

  private touch(key: string): void {
    this.useOrder.set(key, this.clock++);
  }

  private emit(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  private persist(): void {
    this.store.save({
      versions: [...this.versions.values()],
      current: [...this.current.entries()]
    });
  }
}
