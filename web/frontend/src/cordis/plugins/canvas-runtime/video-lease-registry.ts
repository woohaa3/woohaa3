/**
 * 直接视频 registry 与独占 consumer lease
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D10，任务 5.1）。
 *
 * 由 Canvas Runtime scope 唯一持有 canonical **direct** 来源的隐藏解码元素（`HTMLVideoElement`），
 * 卡片与聚焦通过**独占 consumer lease**接管同一来源，而不是各自创建第二个解码器。
 *
 * 关键不变式：
 * - 同一节点同一时刻只有一个 consumer 持有 lease（独占）；接管时保留当前可见帧与 `currentTime`
 *   并暂停，不无条件重置到 0（design D10）；释放后仅新的合法输入可再次播放。
 * - 来源 identity：direct 与 history 使用不同 key，历史来源不能覆盖 canonical 卡片。
 * - 质量请求（`card` / `focus`）只作为给消费方的意图记录，不更换 `src`；真正影响上传尺寸的是
 *   各上传方自己的采样上限（卡片/片场用 `TEXTURE_MAX_DIMENSION = 1024`，聚焦视频编辑器用
 *   `VIDEO_FOCUS_TEXTURE_MAX_DIMENSION = 2048`），本 registry 不读像素也不决定尺寸。
 * - 有界：会话数有上限，超出时回收无 lease、无 pin 的最久未用会话；active focus / capture /
 *   待交接资源通过 pin 保护。
 * - 删除 / 换源 / 设备丢失 / dispose 均幂等释放；迟到的旧 generation 回调不复活旧来源。
 * - 片场内部视频由各自播放头管理，不进入本 registry（不按 extensionId 硬编码业务）。
 *
 * 只持有浏览器本地可丢弃资源，不进入 canonical / Y.Doc。
 */
import type { VideoElementLike } from "./video-frame-session.js";

/** 上传质量命名空间：卡片 / 聚焦（只作为消费方的采样意图，registry 不决定上传尺寸）。 */
export type VideoQuality = "card" | "focus";

/** 来源 identity：direct 与 history 分离（design D10）。 */
export type VideoSourceIdentity = {
  /** canonical 节点 id。 */
  nodeId: string;
  /** 来源种类；`history` 使用独立身份，不覆盖 direct 卡片。 */
  owner: "direct" | "history";
  /** 受控同源 URL（同 nodeId+owner 下换 url 视为换源）。 */
  url: string;
};

export type VideoLeaseState = {
  url: string;
  currentTime: number;
  duration: number;
  playing: boolean;
  muted: boolean;
  ready: boolean;
  /** 元素是否仍在 seek（未就绪时不应上传）。 */
  seeking: boolean;
  width: number;
  height: number;
};

/** 独占 lease：接管期间唯一可对元素执行播放/seek/读取的句柄。 */
export type VideoLease = {
  readonly nodeId: string;
  readonly owner: "direct" | "history";
  /** 当前状态快照（读取真实元素，不缓存）。 */
  state(): VideoLeaseState;
  /**
   * 可呈现帧快照（不暴露原始 DOM 元素给任意 feature；只给可绘制对象与尺寸）。
   * 未就绪/非当前来源返回 null。
   */
  frame(): { drawable: unknown; width: number; height: number } | null;
  /** 播放（自动播放策略拒绝时保持最后帧）。 */
  play(): Promise<void>;
  /** 暂停但保留当前帧。 */
  pause(): void;
  /** seek 到指定秒并等待可呈现。 */
  seek(time: number): Promise<void>;
  /** 请求上传质量（只影响采样上限）。 */
  setQuality(quality: VideoQuality): void;
  /** 当前质量。 */
  quality(): VideoQuality;
  /** 关闭本轮渲染元数据（供 rVFC 帧上传；返回是否仍是当前来源）。 */
  isCurrent(): boolean;
  /** 释放句柄；退出动画结束后调用（归还后仅新 hover 可播放）。 */
  release(): void;
};

export type VideoRegistryOptions = {
  /** 创建隐藏解码元素（测试注入 fake）。 */
  createVideo?: () => VideoElementLike;
  /** 会话数上限（缺省 12）。 */
  maxSessions?: number;
  now?: () => number;
};

type Entry = {
  identity: VideoSourceIdentity;
  generation: number;
  video: VideoElementLike;
  lease: VideoLease | null;
  pinned: Set<string>;
  lastUsed: number;
  quality: VideoQuality;
};

export const VIDEO_REGISTRY_SESSION_LIMIT = 12;

function defaultCreateVideo(): VideoElementLike {
  return document.createElement("video") as unknown as VideoElementLike;
}

function leaseState(video: VideoElementLike): VideoLeaseState {
  const ready = video.readyState !== undefined ? video.readyState >= 2 : Number(video.videoWidth) > 0;
  return {
    url: String(video.src ?? ""),
    currentTime: Number(video.currentTime) || 0,
    duration: Number.isFinite(Number(video.duration)) ? Number(video.duration) : 0,
    playing: !(video as unknown as { paused?: boolean }).paused && (video as unknown as { ended?: boolean }).ended !== true,
    muted: Boolean(video.muted),
    ready,
    seeking: Boolean((video as unknown as { seeking?: boolean }).seeking),
    width: Number(video.videoWidth) || 0,
    height: Number(video.videoHeight) || 0
  };
}

/**
 * 直接视频 registry：独占 consumer lease + 有界会话 + 质量请求。
 *
 * 只管理 canonical direct / history 来源；片场内部视频不进入本 registry。
 */
export class VideoLeaseRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly createVideo: () => VideoElementLike;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private generationCounter = 0;
  private disposed = false;

  constructor(options: VideoRegistryOptions = {}) {
    this.createVideo = options.createVideo ?? defaultCreateVideo;
    this.maxSessions = Math.max(1, options.maxSessions ?? VIDEO_REGISTRY_SESSION_LIMIT);
    this.now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  }

  /** 稳定键：direct/history 分离。 */
  private static key(identity: VideoSourceIdentity): string {
    return `${identity.owner}:${identity.nodeId}`;
  }

  /** 当前活动会话数。 */
  size(): number {
    return this.entries.size;
  }

  /** 当前活动节点（诊断/测试）。 */
  activeNodeIds(): string[] {
    return [...this.entries.values()].map((entry) => entry.identity.nodeId);
  }

  /** 持有 lease 的节点 id。 */
  leasedNodeIds(): string[] {
    return [...this.entries.values()].filter((entry) => entry.lease !== null).map((entry) => entry.identity.nodeId);
  }

  /**
   * 取得某来源的独占 lease；已有其他 consumer 持有则返回 null（不抢占）。
   *
   * 接管时保留当前可见帧与 `currentTime` 并暂停，不无条件重置到 0（design D10）。换源时重建元素。
   */
  acquire(identity: VideoSourceIdentity, quality: VideoQuality = "card", pin?: string): VideoLease | null {
    if (this.disposed) return null;
    const key = VideoLeaseRegistry.key(identity);
    let entry = this.entries.get(key);
    if (!entry || entry.identity.url !== identity.url) {
      if (entry) this.disposeEntry(entry);
      entry = this.createEntry(identity);
      this.entries.set(key, entry);
    }
    if (entry.lease) {
      // 独占：已有 consumer 持有则不抢占（同一 owner 节点）。
      return null;
    }
    entry.quality = quality;
    entry.lastUsed = this.now();
    if (pin) entry.pinned.add(pin);
    const lease = this.makeLease(entry);
    entry.lease = lease;
    this.enforceBudget(key);
    return lease;
  }

  /** 某来源是否已有可用解码会话。 */
  has(nodeId: string, owner: "direct" | "history" = "direct"): boolean {
    return this.entries.has(`${owner}:${nodeId}`);
  }

  /** 显式 pin（active focus / capture / 待交接）。 */
  pin(identity: VideoSourceIdentity, token: string): void {
    this.entries.get(VideoLeaseRegistry.key(identity))?.pinned.add(token);
  }

  unpin(identity: VideoSourceIdentity, token: string): void {
    this.entries.get(VideoLeaseRegistry.key(identity))?.pinned.delete(token);
  }

  /** 丢弃某来源（删除/换源/设备恢复）；无 lease 时立即释放元素。 */
  invalidate(identity: VideoSourceIdentity): void {
    const key = VideoLeaseRegistry.key(identity);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.pinned.add("__invalidated__");
    if (!entry.lease) this.disposeEntry(entry);
  }

  /** 幂等释放全部会话与元素。 */
  dispose(): void {
    this.disposed = true;
    for (const entry of [...this.entries.values()]) this.disposeEntry(entry);
  }

  private createEntry(identity: VideoSourceIdentity): Entry {
    const video = this.createVideo();
    video.src = identity.url;
    video.muted = true;
    video.loop = false;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    return {
      identity,
      generation: ++this.generationCounter,
      video,
      lease: null,
      pinned: new Set(),
      lastUsed: this.now(),
      quality: "card"
    };
  }

  private makeLease(entry: Entry): VideoLease {
    const nodeId = entry.identity.nodeId;
    const owner = entry.identity.owner;
    let released = false;
    const lease: VideoLease = {
      nodeId,
      owner,
      state: () => leaseState(entry.video),
      frame: () => {
        if (released) return null;
        const state = leaseState(entry.video);
        if (!state.ready || state.seeking || state.width <= 0 || state.height <= 0) return null;
        return { drawable: entry.video, width: state.width, height: state.height };
      },
      play: async () => {
        if (released) return;
        try {
          const result = entry.video.play();
          if (result && typeof (result as Promise<void>).catch === "function") await (result as Promise<void>);
        } catch {
          // 自动播放策略拒绝：保持最后帧，不破坏画布。
        }
      },
      pause: () => {
        if (released) return;
        try { entry.video.pause(); } catch { /* 忽略 */ }
      },
      seek: async (time: number) => {
        if (released) return;
        const duration = Number(entry.video.duration) || 0;
        const target = Math.min(Math.max(time, 0), Math.max(0, duration));
        const generation = entry.generation;
        await new Promise<void>((resolve) => {
          const onSeeked = () => {
            entry.video.removeEventListener("seeked", onSeeked);
            resolve();
          };
          entry.video.addEventListener("seeked", onSeeked);
          try { entry.video.currentTime = target; } catch { resolve(); }
          // 元素不派发 seeked（测试 fake）时也结算，避免悬挂。
          if (entry.generation !== generation) resolve();
        });
      },
      setQuality: (quality) => { entry.quality = quality; },
      quality: () => entry.quality,
      isCurrent: () => !released && !this.disposed && this.entries.get(VideoLeaseRegistry.key(entry.identity)) === entry,
      release: () => {
        if (released) return;
        released = true;
        // 归还：暂停并保留最后一帧；仅新的合法 hover/lease 可再次播放。
        try { entry.video.pause(); } catch { /* 忽略 */ }
        if (entry.lease === lease) entry.lease = null;
        // 不刷新 lastUsed：刚归还的会话在 LRU 中保持更早位置，让新会话优先常驻。
        if (entry.pinned.has("__invalidated__")) this.disposeEntry(entry);
      }
    };
    return lease;
  }

  private disposeEntry(entry: Entry): void {
    this.entries.delete(VideoLeaseRegistry.key(entry.identity));
    entry.lease = null;
    try { entry.video.pause(); } catch { /* 元素可能已移除 */ }
    entry.video.removeAttribute?.("src");
    try { entry.video.load?.(); } catch { /* 忽略 */ }
  }

  /**
   * 预算约束：超过会话数上限时回收无 lease、无 pin 的最久未用会话。
   * `protect` 为本次刚使用的 key，永不回收。
   */
  private enforceBudget(protect: string): void {
    while (this.entries.size > this.maxSessions) {
      const victim = this.pickVictim(protect);
      if (!victim) return;
      this.disposeEntry(victim);
    }
  }

  private pickVictim(protect: string): Entry | null {
    let victim: Entry | null = null;
    for (const [key, entry] of this.entries) {
      if (key === protect) continue;
      if (entry.lease || entry.pinned.size > 0) continue;
      if (!victim || entry.lastUsed < victim.lastUsed) victim = entry;
    }
    return victim;
  }
}
