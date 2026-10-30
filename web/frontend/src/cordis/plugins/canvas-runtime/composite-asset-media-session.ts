import { MediaOperationBoundary } from "./media-operation-boundary.js";
import type { CompositeAssetMediaSource } from "../../../extension-api/composite-assets.js";
/** Scope-owned decoding and texture lifecycle for composite assets.
 * The trusted adapter supplies stable asset references and time mappings.
 * The platform owns same-origin URL checks, budgets, source generations and
 * late-result fencing; it never reads business items or clip definitions.
 */
import type { ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import { mediaTimelineLocalTime } from "@woohaa3/contracts";
import type { BevyRuntime } from "./bevy-runtime.js";
import {
  rasterizeDrawable,
  defaultRasterCanvasFactory,
  type RasterCanvas,
  type RasterCanvasFactory
} from "./media-raster.js";
import { resolveCanonicalMediaUrl } from "../media-preview/media-preview.js";
import { TEXTURE_FALLBACK_TIER, TEXTURE_MAX_DIMENSION } from "./texture-sync.js";
import { isTransientImageFailure, loadImageViaDom, IMAGE_RETRY_DELAYS_MS, IMAGE_RETRY_MAX_ATTEMPTS } from "./image-load.js";
import type { VideoElementLike } from "./video-frame-session.js";
import type { CanvasResourceCoordinator, ResidencyPurpose } from "./residency/index.js";

/**
 * 导出取帧时片场媒体平面的纹理边长上限（change: 2026-10-19-extend-film-set-for-motion-graphics，D5）。
 *
 * 取整个纹理硬上限：导出是用户显式要的成片质量，必须高于日常交互预览。
 * 交互预览仍用 `TEXTURE_FALLBACK_TIER`，避免常驻显存按上限摊开。
 */
export const EXPORT_TEXTURE_MAX_DIMENSION = TEXTURE_MAX_DIMENSION;

/** 同时存在的片场媒体会话上限（decoder 硬上限，与统一准入集合取小）。 */
export const COMPOSITE_ASSET_MEDIA_SESSION_LIMIT = 24;
/** 视频帧上传间隔下限 ≈ 30fps。 */
export const COMPOSITE_ASSET_MEDIA_MIN_UPLOAD_INTERVAL_MS = 1000 / 30;
/**
 * 非目标片场平面让出槽位的轮换间隔（ms）。
 *
 * 候选多于槽位时按间隔逐个换入等待最久的平面；固定截取数组前缀会让第 24 项之后的合法片场
 * 永久缺图/缺视频（design D1/D3、任务 3.4）。
 */
export const COMPOSITE_ASSET_MEDIA_ROTATION_INTERVAL_MS = 1500;
/**
 * 播放态允许的「片场时间 ↔ 元素时间」偏差；超过才 seek。
 *
 * 播放时让解码元素按自身节奏真播、由解码帧回调上传，避免每帧 seek 导致从关键帧重解码
 * （change notes/video-path-optimization：播放态每帧 seek 是片场视频的主要解码开销）。
 */
export const COMPOSITE_ASSET_PLAYBACK_DRIFT_TOLERANCE_SECONDS = 0.2;

export type CompositeAssetMediaSessionsOptions = {
  runtime: BevyRuntime;
  getCanvas: () => ServerCanvas | null;
  getSources: () => readonly CompositeAssetMediaSource[];
  /** 注入：创建隐藏 video 元素（测试用 fake）。 */
  createVideo?: () => VideoElementLike;
  /** 注入：创建帧 canvas。 */
  createCanvas?: RasterCanvasFactory;
  /** 注入：解码图片（测试用 fake）；默认用 DOM Image。 */
  loadImage?: (url: string) => Promise<{ width: number; height: number }>;
  minUploadIntervalMs?: number;
  maxSessions?: number;
  now?: () => number;
  /** 纹理变化后回调（触发一次 scene flush）。 */
  onChange?: () => void;
  /**
   * 页面级资源协调器（change: 2026-10-23，design D1/D3）。
   *
   * 提供时：非当前播放/捕获目标的平面只在协调器准入集合内创建；缺省按 `maxSessions`
   * 本地有界（旧行为）。严格捕获与唯一播放头仍可越过普通准入（有界 output lease 语义）。
   */
  residency?: CanvasResourceCoordinator;
  /** 节点当前准入用途；缺省按 visible。 */
  purposeOf?: (nodeId: string) => ResidencyPurpose | null;
  /**
   * 非目标平面的公平轮换间隔（ms）。
   *
   * 候选多于槽位时每次间隔只让出一个槽给等待最久的平面，避免固定截取数组前缀（任务 3.4），
   * 也避免逐帧换入换出 decoder。
   */
  rotationIntervalMs?: number;
};

export type CompositeAssetMediaSessions = {
  diagnostics?: () => unknown;
  /** 按当前 canonical 画布同步会话（幂等）；返回已就绪的 planeId 集合。 */
  sync(): ReadonlySet<string>;
  /** 片场播放头更新：t 为片场时间（秒），playing 是否推进。暂停且无 seek 时复用纹理。 */
  setMediaTime(nodeId: string, timeSeconds: number, playing: boolean): void;
  /** 该 planeId 是否已有可用纹理。 */
  hasTexture(planeId: string): boolean;
  /**
   * 有界等待该片场的图片纹理与指定时间的所有视频帧就绪
   * （change: 2026-10-08-make-film-set-model-only，任务 4.3）。
   *
   * 先把各视频 seek 到锁定时间，再轮询至 `min(片场时间, 视频时长)` 的帧已上传；超时返回 false，
   * 调用方按稳定失败处理，不用 poster/旧帧冒充。
   */
  waitForTime(
    nodeId: string,
    timeSeconds: number,
    timeoutMs?: number,
    /** Video export needs tighter matching than interactive seeking's 50 ms tolerance. */
    toleranceSeconds?: number
  ): Promise<boolean>;
  /** 释放全部会话（切画布/runtime 重建/dispose）。 */
  dispose(): void;
  /**
   * 导出取帧期间的纹理质量开关（change: 2026-10-19-extend-film-set-for-motion-graphics，D5）。
   *
   * 交互预览用 1024 上限控制常驻显存；导出（浏览器取帧）临时改用 2048，让近景文字/图片平面
   * 在 1080p 成片里不发虚。只影响后续上传的帧尺寸，不改业务内容。
   */
  setExportQuality(enabled: boolean): void;
};

type MediaSession = {
  planeId: string;
  nodeId: string;
  kind: "image" | "video";
  sourceUrl: string;
  generation: number;
  requestGeneration: number;
  requestedTime: number;
  playbackIdentity: string;
  /** 对象局部播放配置（design D4/D5）；缺省即 startTime=0、timeScale=1、loop=false。 */
  playback: import("@woohaa3/contracts").ModelMediaTimeMap | undefined;
  /** 已上传的媒体时间（秒）；暂停且无 seek 时据此复用。 */
  uploadedTime: number | null;
  textureReady: boolean;
  image: { width: number; height: number } | null;
  video: VideoElementLike | null;
  canvas: RasterCanvas | null;
  lastUploadedAt: number;
  seeking: boolean;
  /** 片场播放头是否在推进（真播放态）。 */
  playing: boolean;
  /** 已请求过 `play()`；元素未知 `paused` 时避免重复调用。 */
  playRequested: boolean;
  /** 解码帧回调句柄（播放态上传驱动）。 */
  frameHandle: number | null;
  /** 无解码帧回调时的节流定时器。 */
  frameTimer: ReturnType<typeof globalThis.setTimeout> | null;
  /** 严格取帧（导出/截图）期间锁定：不接受播放态驱动。 */
  timeLocked: boolean;
  disposed: boolean;
};

type PlaneDescriptor = CompositeAssetMediaSource & { url: string };

/** Resolve only stable ready assets. Business content and clip definitions never enter this module. */
export function resolveCompositeAssetMediaDescriptors(canvas: ServerCanvas | null, sources: readonly CompositeAssetMediaSource[]): PlaneDescriptor[] {
  if (!canvas) return [];
  const assets = new Map<string, StoredAsset>(canvas.assets.map(asset => [asset.id, asset]));
  return sources.flatMap(source => {
    const asset = assets.get(source.assetId);
    if (!asset || asset.status !== "ready" || asset.mediaKind !== source.kind) return [];
    // 片场媒体按画布路由：读请求带本次渲染的画布提示。
    const url = resolveCanonicalMediaUrl(asset, canvas.id);
    return url ? [{ ...source, url }] : [];
  });
}

export function createCompositeAssetMediaSessions(
  options: CompositeAssetMediaSessionsOptions
): CompositeAssetMediaSessions {
  const createCanvas = options.createCanvas ?? defaultRasterCanvasFactory;
  const minInterval = options.minUploadIntervalMs ?? COMPOSITE_ASSET_MEDIA_MIN_UPLOAD_INTERVAL_MS;
  // 预算只有一处来源（design D3 / 任务 2.2）：注入 > 页面协调器策略 > 默认常量。
  const maxSessions = Math.max(1, options.maxSessions
    ?? options.residency?.getPolicy().videoSessionLimit ?? COMPOSITE_ASSET_MEDIA_SESSION_LIMIT);
  const rotationInterval = options.rotationIntervalMs ?? COMPOSITE_ASSET_MEDIA_ROTATION_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const residency = options.residency;
  const sessions = new Map<string, MediaSession>();
  const uploads = new MediaOperationBoundary(options.runtime);
  let retryVersion = options.runtime.retryVersion?.() ?? 0;
  let generationSeq = 1;
  let disposed = false;
  /** 导出取帧时的纹理上限（D5）：交互预览 1024，导出 2048。 */
  /** 交互预览按兜底档；导出时升到硬上限（见 `setExportQuality`）。 */
  let maxTextureEdge = TEXTURE_FALLBACK_TIER;
  /** 非目标平面等待开始时间（公平轮换）；不在集合内即清除。 */
  const waitingSince = new Map<string, number>();
  let lastRotationAt = 0;
  /** 当前唯一播放头/聚焦/捕获目标节点（来自 `setMediaTime` 或显式 pin）。 */
  let activeNodeId: string | null = null;
  /**
   * 传输失败的自动重试状态（design D2/D8）。
   *
   * `plane-session` 在每帧 `sync()` 里重建会话，所以「失败就丢会话」等价于每帧重试。
   * 这里按平面记录次数与下次可尝试时间，既不在故障期间逐帧打服务，又不会把健康素材永久
   * 钉成错误；内容失败不进入本表，仍只走显式重试。
   */
  const transientRetry = new Map<string, { attempts: number; nextAt: number }>();

  /**
   * 选出本帧实际创建会话的平面。
   *
   * 顺序：当前播放/聚焦目标 → 协调器准入 → 其余候选（按等待时长公平轮换）。固定截取数组
   * 前 N 项会让第 24 项之后的合法片场永久缺图（design D1/D3、任务 3.4）；这里用「先到先得 +
   * 定期让出一个槽」保证尾部需求最终都能取得资源，同时不逐帧换入换出 decoder。
   */
  const selectDescriptors = (descriptors: readonly PlaneDescriptor[]): PlaneDescriptor[] => {
    // 先准入再创建：未被协调器准入的片场只用占位，当前播放/捕获目标例外（显式操作 pin，
    // 且仍受 maxSessions 有界，design D1/D3）。
    const eligible = residency
      ? descriptors.filter((descriptor) => descriptor.nodeId === activeNodeId || residency.isAdmitted(descriptor.nodeId))
      : [...descriptors];
    if (eligible.length <= maxSessions) {
      waitingSince.clear();
      return eligible;
    }
    const admitted = (descriptor: PlaneDescriptor) =>
      !residency || residency.isAdmitted(descriptor.nodeId);
    const priority = (descriptor: PlaneDescriptor): number => {
      if (descriptor.nodeId === activeNodeId) return 0;
      const purpose = options.purposeOf?.(descriptor.nodeId) ?? (admitted(descriptor) ? "visible" : "warm");
      switch (purpose) {
        case "interactive": return 0;
        case "visible": return 1;
        case "prefetch": return 2;
        case "warm": return 3;
      }
    };
    const at = now();
    const keep = new Set(sessions.keys());
    // 记录等待起点：只在首次进入候选时写，之后保持原始年龄（同级公平）。
    for (const descriptor of eligible) {
      if (keep.has(descriptor.planeId)) waitingSince.delete(descriptor.planeId);
      else if (!waitingSince.has(descriptor.planeId)) waitingSince.set(descriptor.planeId, at);
    }
    for (const planeId of [...waitingSince.keys()]) {
      if (!eligible.some(descriptor => descriptor.planeId === planeId)) waitingSince.delete(planeId);
    }
    const ranked = [...eligible].sort((a, b) => {
      const delta = priority(a) - priority(b);
      if (delta !== 0) return delta;
      // 已在驻留的平面先保留（不逐帧抖动），再按等待年龄最久优先。
      const keepDelta = (keep.has(b.planeId) ? 1 : 0) - (keep.has(a.planeId) ? 1 : 0);
      if (keepDelta !== 0) return keepDelta;
      return (waitingSince.get(a.planeId) ?? at) - (waitingSince.get(b.planeId) ?? at);
    });
    // 新的高优先级平面（播放/捕获目标）可以挤掉最旧的普通槽；目标需求一次全部满足，
    // 普通轮换每帧最多让出一个槽（避免逐帧抖动）。
    const selected: PlaneDescriptor[] = [];
    const rotating = at - lastRotationAt >= rotationInterval;
    let evicted = false;
    for (const descriptor of ranked) {
      if (selected.length < maxSessions) { selected.push(descriptor); continue; }
      if (descriptor.nodeId !== activeNodeId) continue;
      // 目标不在容量内：替换最后一个非目标平面（尾部按年龄排序，最后一个最该让位）。
      let victim = -1;
      for (let index = selected.length - 1; index >= 0; index -= 1) {
        if (selected[index].nodeId !== activeNodeId) { victim = index; break; }
      }
      if (victim < 0) continue;
      waitingSince.set(selected[victim].planeId, at);
      selected[victim] = descriptor;
      evicted = true;
    }
    if (rotating && !evicted) {
      // 定期让出一个非目标槽给等待最久的候选；不推翻当前播放/捕获目标。
      const next = ranked.find(descriptor => !selected.includes(descriptor) && descriptor.nodeId !== activeNodeId);
      if (next) {
        let victim = -1;
        for (let index = selected.length - 1; index >= 0; index -= 1) {
          if (selected[index].nodeId !== activeNodeId) { victim = index; break; }
        }
        if (victim >= 0) {
          waitingSince.set(selected[victim].planeId, at);
          selected[victim] = next;
        }
      }
    }
    if (rotating) lastRotationAt = at;
    for (const descriptor of selected) waitingSince.delete(descriptor.planeId);
    return selected;
  };

  const uploadFrame = (session: MediaSession, drawable: unknown, size: { width: number; height: number }) => {
    if (session.disposed || sessions.get(session.planeId) !== session) return false;
    // 每帧上传 staging 预算（design D3）：额度用尽时本帧不上传，保留待上传状态等下一帧，
    // 不标记失败、不释放会话（严格取帧仍会重试到超时）。严格取帧（`timeLocked`）属交互需求，
    // 优先级最高，不受逐帧额度限制。
    if (!(residency?.spendUploadBytes(size.width * size.height * 4, session.timeLocked) ?? true)) return false;
    const accepted = uploads.run(`plane:${session.planeId}`, session.sourceUrl, session.nodeId, () => {
      const raster = rasterizeDrawable(drawable, size, createCanvas, maxTextureEdge);
      if (!raster) throw new Error("媒体平面预览无法读取像素");
      return options.runtime.setModelMediaTexture(session.planeId, raster.width, raster.height, raster.pixels,
        { sourceKey: session.sourceUrl, nodeId: session.nodeId }) !== false;
    });
    if (!accepted) return false;
    session.lastUploadedAt = now();
    session.textureReady = true;
    options.onChange?.();
    return true;
  };

  const ensureImage = (session: MediaSession) => {
    if (session.image) return;
    const loadImage = options.loadImage ?? loadImageViaDom;
    void loadImage(session.sourceUrl)
      .then((image) => {
        if (session.disposed || sessions.get(session.planeId) !== session) return;
        session.image = { width: image.width, height: image.height };
        // 图片立即上传一次；尺寸信息已在 plane 几何中，纹理只负责像素。
        uploadFrame(session, image, { width: image.width, height: image.height });
      })
      .catch(error => {
        if (session.disposed || sessions.get(session.planeId) !== session) return;
        // 传输失败（媒体服务重启/网关 5xx）不是内容错误：按有界退避重新建会话，避免把健康
        // 素材永久钉成错误，也避免故障期间逐帧打服务（design D2/D8）。
        if (isTransientImageFailure(error)) {
          const previous = transientRetry.get(session.planeId);
          const attempts = (previous?.attempts ?? 0) + 1;
          disposeSession(session);
          sessions.delete(session.planeId);
          if (attempts > IMAGE_RETRY_MAX_ATTEMPTS) return;
          transientRetry.set(session.planeId, {
            attempts,
            nextAt: now() + IMAGE_RETRY_DELAYS_MS[attempts - 1]
          });
          return;
        }
        uploads.run(`plane:${session.planeId}`, session.sourceUrl, session.nodeId, () => { throw error; });
      });
  };

  const ensureVideo = (session: MediaSession) => {
    if (session.video) return;
    const createVideo = options.createVideo ?? defaultCreateVideo;
    const video = createVideo();
    video.src = session.sourceUrl;
    video.muted = true;
    video.loop = false;
    video.playsInline = true;
    // 预取策略：建会话只取元数据；首帧/播放时才取正文（避免打开片场就拉取所有平面视频）。
    video.preload = "metadata";
    video.crossOrigin = "anonymous";
    video.load?.();
    session.video = video;
    session.canvas = createCanvas();
    // 首帧上传：元数据到达即按当前播放头取一次；metadata 预取下不会自动解码，需显式 seek。
    const onReady = () => {
      if (session.disposed || sessions.get(session.planeId) !== session) return;
      session.uploadedTime = null;
      // 只有真正拿到可解码帧（readyState ≥ 2 且有尺寸）才上传；否则显式 seek 让浏览器取目标帧。
      const decodable = (video.readyState === undefined || video.readyState >= 2) && video.videoWidth > 0;
      if (!decodable) {
        if (session.seeking) return;
        session.seeking = true;
        try {
          video.currentTime = session.requestedTime > 0 ? session.requestedTime : 0.001;
        } catch {
          session.seeking = false;
        }
        return;
      }
      uploadVideoAt(session, session.requestedTime);
    };
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("seeked", () => {
      if (session.disposed || sessions.get(session.planeId) !== session) return;
      session.seeking = false;
      // 播放态由元素自行推进：落点帧即当前帧，不再按旧时间点纠正。
      if (session.playing) {
        uploadVideoFrame(session, Number(video.currentTime) || 0);
        return;
      }
      uploadVideoAt(session, session.requestedTime);
    });
  };

  /** 播放态：元素真播 + 解码帧回调驱动上传；漂移超阈值才 seek。 */
  const schedulePlaybackFrame = (session: MediaSession) => {
    const video = session.video;
    if (session.disposed || !session.playing || !video) return;
    if (session.frameHandle !== null || session.frameTimer !== null) return;
    if (typeof video.requestVideoFrameCallback === "function") {
      session.frameHandle = video.requestVideoFrameCallback(() => {
        session.frameHandle = null;
        pumpPlaybackFrame(session);
      });
      return;
    }
    session.frameTimer = globalThis.setTimeout?.(() => pumpPlaybackFrame(session), minInterval) ?? null;
  };

  const pumpPlaybackFrame = (session: MediaSession) => {
    session.frameTimer = null;
    if (session.disposed || !session.playing || sessions.get(session.planeId) !== session) return;
    uploadVideoFrame(session, Number(session.video?.currentTime) || 0);
    schedulePlaybackFrame(session);
  };

  const stopPlayback = (session: MediaSession) => {
    if (!session.playing) return;
    session.playing = false;
    session.playRequested = false;
    if (session.frameHandle !== null) {
      session.video?.cancelVideoFrameCallback?.(session.frameHandle);
      session.frameHandle = null;
    }
    if (session.frameTimer !== null) {
      globalThis.clearTimeout?.(session.frameTimer);
      session.frameTimer = null;
    }
    try {
      session.video?.pause();
    } catch {
      // 元素可能已卸载。
    }
  };

  const startPlayback = (session: MediaSession, target: number) => {
    const video = session.video;
    if (!video || session.disposed || session.timeLocked) return;
    session.playing = true;
    if (Math.abs(target - session.requestedTime) > 0.001) session.requestGeneration += 1;
    session.requestedTime = target;
    // 偏差过大（跳转、循环回绕、暂停后续播）：先硬同步一次，再交给元素推进。
    if (Math.abs((Number(video.currentTime) || 0) - target) > COMPOSITE_ASSET_PLAYBACK_DRIFT_TOLERANCE_SECONDS) {
      session.uploadedTime = null;
      if (!session.seeking) {
        session.seeking = true;
        try {
          video.currentTime = target;
        } catch {
          session.seeking = false;
        }
      }
      return;
    }
    const shouldStart = video.paused === undefined ? !session.playRequested : video.paused;
    if (shouldStart) {
      session.playRequested = true;
      try {
        const result = video.play() as Promise<void> | undefined;
        // play() 可能因自动播放策略被拒；失败保持最后帧，不破坏片场。
        if (result && typeof result.catch === "function") void result.catch(() => undefined);
      } catch {
        // 忽略。
      }
    }
    schedulePlaybackFrame(session);
  };

  const uploadVideoAt = (session: MediaSession, timeSeconds: number) => {
    const video = session.video;
    if (!video) return;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const target = duration > 0 ? Math.min(Math.max(0, timeSeconds), duration) : Math.max(0, timeSeconds);
    if (Math.abs(target - session.requestedTime) > 0.001) session.requestGeneration += 1;
    session.requestedTime = target;
    const requestGeneration = session.requestGeneration;
    if (Math.abs(target - video.currentTime) > 0.02 && !session.seeking) {
      session.seeking = true;
      try {
        video.currentTime = target;
      } catch {
        session.seeking = false;
      }
      // seeked 回调负责上传；部分实现不触发时回退一次。
      globalThis.setTimeout(() => {
        if (session.disposed || session.requestGeneration !== requestGeneration) return;
        session.seeking = false;
        // 播放态由元素驱动，迟到的回退不再纠正时间（否则会把播放头拽回旧时间点）。
        if (session.playing) return;
        if (Math.abs(video.currentTime - session.requestedTime) <= 0.05) uploadVideoFrame(session, session.requestedTime);
        else uploadVideoAt(session, session.requestedTime);
      }, 80);
      return;
    }
    uploadVideoFrame(session, target);
  };

  const uploadVideoFrame = (session: MediaSession, timeSeconds: number) => {
    const video = session.video;
    if (session.disposed || !video || video.seeking || video.videoWidth === 0 || video.videoHeight === 0 || Math.abs(video.currentTime - timeSeconds) > 0.05) return;
    if (session.uploadedTime !== null && Math.abs(session.uploadedTime - timeSeconds) < 1e-4) return;
    const elapsed = now() - session.lastUploadedAt;
    if (elapsed < minInterval) return;
    if (uploadFrame(session, video, { width: video.videoWidth, height: video.videoHeight })) session.uploadedTime = timeSeconds;
  };

  const disposeSession = (session: MediaSession) => {
    session.disposed = true;
    stopPlayback(session);
    session.timeLocked = false;
    uploads.clear(`plane:${session.planeId}`);
    uploads.clear(`plane-session:${session.planeId}`);
    if (session.video) {
      try {
        session.video.pause();
        session.video.removeAttribute?.("src");
      } catch {
        // 元素可能已卸载。
      }
    }
  };

  return {
    diagnostics: () => [...sessions.values()].map(s => ({ nodeId: s.nodeId, planeId: s.planeId, playback: s.playback, identity: s.playbackIdentity, requestedTime: s.requestedTime, uploadedTime: s.uploadedTime, currentTime: s.video?.currentTime, seeking: s.video?.seeking, playing: s.playing, preload: s.video?.preload })),
    sync() {
      if (disposed) return new Set();
      const retry = options.runtime.retryVersion?.() ?? 0;
      if (retry !== retryVersion) {
        retryVersion = retry;
        for (const session of sessions.values()) disposeSession(session);
        sessions.clear();
        transientRetry.clear();
      }
      const canvas = options.getCanvas();
      const descriptors = resolveCompositeAssetMediaDescriptors(canvas, options.getSources());
      const selected = selectDescriptors(descriptors);
      const wanted = new Set(selected.map((descriptor) => descriptor.planeId));
      // 退避到期前的平面不重建会话：故障期间不逐帧打媒体服务（design D2/D8）。
      const nowMs = now();
      for (const [planeId, state] of transientRetry) {
        if (!wanted.has(planeId)) transientRetry.delete(planeId);
        else if (state.nextAt > nowMs) wanted.delete(planeId);
      }
      uploads.retainNodes(new Set(descriptors.map(descriptor => descriptor.nodeId)));
      for (const [planeId, session] of sessions) {
        if (!wanted.has(planeId)) {
          disposeSession(session);
          sessions.delete(planeId);
        }
      }
      for (const descriptor of selected) {
        if (!wanted.has(descriptor.planeId)) continue;
        const bindingPlayback = descriptor.playback;
        const identity = descriptor.sourceIdentity;
        const existing = sessions.get(descriptor.planeId);
        if (existing && existing.sourceUrl === descriptor.url && existing.kind === descriptor.kind) {
          existing.playback = bindingPlayback;
          if (existing.playbackIdentity !== identity) {
            existing.playbackIdentity = identity; existing.requestGeneration += 1;
            existing.uploadedTime = null; existing.seeking = false;
            // 换片段/换绑定：播放身份变化，下一帧由片场播放头重新驱动。
            stopPlayback(existing);
          }
          continue;
        }
        if (existing) {
          disposeSession(existing);
          sessions.delete(descriptor.planeId);
        }
        const session: MediaSession = {
          planeId: descriptor.planeId,
          nodeId: descriptor.nodeId,
          kind: descriptor.kind,
          sourceUrl: descriptor.url,
          generation: generationSeq++,
          playback: bindingPlayback,
          playbackIdentity: identity,
          requestGeneration: 0,
          requestedTime: 0,
          uploadedTime: null,
          textureReady: false,
          image: null,
          video: null,
          canvas: null,
          lastUploadedAt: 0,
          seeking: false,
          playing: false,
          playRequested: false,
          frameHandle: null,
          frameTimer: null,
          timeLocked: false,
          disposed: false
        };
        sessions.set(descriptor.planeId, session);
        if (descriptor.kind === "image") ensureImage(session);
        else uploads.run(`plane-session:${session.planeId}`, session.sourceUrl, session.nodeId, () => ensureVideo(session));
      }
      const ready = new Set<string>();
      for (const [planeId, session] of sessions) {
        if (session.textureReady) ready.add(planeId);
      }
      return ready;
    },

    setMediaTime(nodeId, timeSeconds, playing) {
      if (disposed) return;
      // 当前唯一播放头就是最高优先级目标：它的平面必须能进入会话集合（design D3、任务 3.4）。
      if (activeNodeId !== nodeId) {
        activeNodeId = nodeId;
        waitingSince.clear();
        lastRotationAt = 0;
      }
      const safeTime = Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0;
      for (const session of sessions.values()) {
        if (session.nodeId !== nodeId || session.kind !== "video" || !session.video) continue;
        // 对象局部时间映射（design D4/D5）：仅有显式 playback 时按其 startTime/timeScale/loop；
        // 缺省保持既有语义（直接用片场时间，钳制到视频自身时长）。
        const duration = session.video.duration;
        const mapped = session.playback ? mediaTimelineLocalTime(session.playback, safeTime) : safeTime;
        if (mapped === null) { stopPlayback(session); uploadVideoAt(session, 0); continue; }
        const target = Number.isFinite(duration) && duration > 0 ? Math.min(mapped, duration) : mapped;
        // 播放态交给解码元素真播（每帧 seek 会从关键帧重解码）；暂停/拖动仍按时间点 seek。
        if (playing) { startPlayback(session, target); continue; }
        stopPlayback(session);
        if (session.uploadedTime !== null && Math.abs(session.uploadedTime - target) < 1e-3) {
          continue; // 暂停且无 seek：复用现有纹理。
        }
        uploadVideoAt(session, target);
      }
    },

    hasTexture(planeId) {
      const session = sessions.get(planeId);
      if (!session) return false;
      return session.textureReady;
    },

    async waitForTime(nodeId, timeSeconds, timeoutMs = 2000, toleranceSeconds = 0.05) {
      // 严格输出是该片场的显式需求：先把它的平面提为当前目标并同步一次，确保不因普通
      // 准入集合缺席而误报「无需等待」（design D3/D8、任务 3.5）。仍然受 maxSessions 有界。
      activeNodeId = nodeId;
      this.sync();
      const safeTime = Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0;
      const tolerance = Math.max(0.0001, Math.min(0.05, toleranceSeconds));
      const mediaSessions = [...sessions.values()].filter(session => session.nodeId === nodeId);
      const videoSessions = mediaSessions.filter(session => session.kind === "video");
      // 该片场当前应输出的全部平面（以同一份 descriptor 解析为权威）：只有它们**全部**存在且
      // 就绪才算成功。容量不足时不能因为「现有会话都就绪」就报告成功，那会输出缺对象的结果
      // （design D3/D8、任务 3.5）。
      const expectedPlanes = resolveCompositeAssetMediaDescriptors(options.getCanvas(), options.getSources())
        .filter(descriptor => descriptor.nodeId === nodeId)
        .map(descriptor => descriptor.planeId);
      if (expectedPlanes.length === 0) return true;
      if (expectedPlanes.length > maxSessions) {
        // 单个片场的平面数超过本页会话上限：等待也无法补齐，按稳定容量原因失败。
        return false;
      }
      const missing = expectedPlanes.filter(planeId => !sessions.has(planeId));
      if (missing.length > 0) return false;
      // 严格取帧（导出/截图）：暂停真播放并加锁，避免片场播放头继续驱动元素时间。
      for (const session of videoSessions) { stopPlayback(session); session.timeLocked = true; }
      const unlock = () => { for (const session of videoSessions) session.timeLocked = false; };
      // 每个视频对象按自身 playback 映射到局部时间（design D4/D5）；缺省直接用片场时间。
      const targetOf = (session: MediaSession): number => {
        const local = session.playback ? mediaTimelineLocalTime(session.playback, safeTime) ?? 0 : safeTime;
        const duration = session.video?.duration ?? 0;
        return Number.isFinite(duration) && duration > 0 ? Math.min(local, duration) : local;
      };
      // 先把所有视频 seek 到锁定时间。
      for (const session of videoSessions) {
        if (!session.video) continue;
        const target = targetOf(session);
        if (Math.abs(target - session.video.currentTime) > Math.min(0.02, tolerance)) {
          session.uploadedTime = null;
          try {
            session.video.currentTime = target;
          } catch {
            // 忽略；后续轮询会判定失败。
          }
        }
      }
      const identities = videoSessions.map(session => session.playbackIdentity);
      const deadline = now() + timeoutMs;
      const settled = () =>
        mediaSessions.every(session => !session.disposed && (session.kind !== "image" || session.textureReady)) &&
        videoSessions.every((session) => {
          if (session.disposed) return false;
          if (!session.video) return false;
          const target = targetOf(session);
          return !session.video.seeking && Math.abs(session.video.currentTime - target) <= tolerance
            && session.uploadedTime !== null && Math.abs(session.uploadedTime - target) <= tolerance;
        });
      let outcome: boolean | null = null;
      while (now() < deadline) {
        if (videoSessions.some((session, index) => session.disposed || session.playbackIdentity !== identities[index])) { outcome = false; break; }
        // 主动上传一次目标帧，不依赖 rAF（截图路径可能在被冻结帧内）。
        for (const session of videoSessions) {
          const target = targetOf(session);
          session.lastUploadedAt = 0;
          uploadVideoAt(session, target);
        }
        if (settled()) { outcome = true; break; }
        await new Promise((resolve) => globalThis.setTimeout(resolve, 16));
      }
      const result = outcome ?? settled();
      unlock();
      return result;
    },

    dispose() {
      disposed = true;
      for (const session of sessions.values()) disposeSession(session);
      sessions.clear();
      transientRetry.clear();
    },

    setExportQuality(enabled: boolean) {
      const next = enabled ? EXPORT_TEXTURE_MAX_DIMENSION : TEXTURE_FALLBACK_TIER;
      if (next === maxTextureEdge) return;
      maxTextureEdge = next;
      // 尺寸上限变了：已上传的纹理仍是旧的。
      // - 视频：清掉 uploadedTime，下一次取帧重新上传；
      // - 图片：只上传过一次且不再重载元素，丢弃会话让下一次 sync 按新上限重新光栅化。
      for (const [planeId, session] of [...sessions]) {
        if (session.kind === "image") {
          disposeSession(session);
          sessions.delete(planeId);
          continue;
        }
        session.uploadedTime = null;
      }
    }
  };
}

function defaultCreateVideo(): VideoElementLike {
  return document.createElement("video") as unknown as VideoElementLike;
}


