import { measureVideoPhase, recordVideoTransition } from "../../performance/interaction-phase-profiler.js";
/**
 * 画布视频帧会话
 * （change: enable-video-node-live-preview，design D1–D4/D8；
 *   change: 2026-10-23-scale-canvas-media-residency，design D1/D2/D3/D8）。
 *
 * 浏览器负责解码、Bevy 只负责呈现：为每个有 canonical ready 输出视频的节点维护一个**不可见**
 * `HTMLVideoElement` 会话，把首个可呈现帧与 hover 播放期间的新帧上传为 Bevy 纹理。
 *
 * 边界（design D5）：
 * - 只解析节点**自身** `outputAssetId`，要求 asset `status: ready`、`mediaKind: video`、
 *   稳定 storageKey 与受控同源 URL；不使用 input mapping、任意外链、data/blob/签名 URL；
 * - `posterUrl` 只作为首帧尚未就绪或解码失败时的回退，真实帧可用后必须替换；
 * - 播放状态/currentTime/像素只存在于本会话，不写 Y.Doc/nodeData/history。
 *
 * 有界与迟到防护（design D2/D3/D4/D8；本 change 的任务 3.1–3.3）：
 * - **先选 admitted 集合再创建**：只为准入项建 decoder，不再「先建全部再 prune」；
 * - decoder 名额（默认 12）在创建前分配：先按 hover/聚焦目标，再按准入 purpose 与排队年龄，
 *   片场/普通卡片/聚焦共用同一上限；
 * - 静态首帧名额在**真实帧完成/失败/超时/取消清理**后归还，配置 2 时始终至多 2 个未完成；
 * - 帧上传只在 `minUploadIntervalMs`（默认最高 60fps）节流后发生；
 * - 删除/替换/dispose 时暂停、撤销回调、移除媒体源并阻止迟到结果。
 */
import { MediaOperationBoundary } from "./media-operation-boundary.js";
import type { ServerCanvas } from "@woohaa3/contracts";
import type { BevyRuntime } from "./bevy-runtime.js";
import {
  rasterizeDrawable,
  scaleToMaxDimension,
  defaultRasterCanvasFactory,
  BEVY_TEXTURE_MAX_DIMENSION,
  type RasterCanvas,
  type RasterCanvasFactory
} from "./media-raster.js";
import { resolveNodeVideoSource, defaultCreateVideo, defaultLoadPosterImage } from "./video-source.js";
export { resolveNodeVideoSource } from "./video-source.js";
import { TEXTURE_MAX_DIMENSION } from "./texture-sync.js";
import { NodeResourceLoading, type NodeResourceLoad } from "../../services/node-resource-loading.js";
import { DEFAULT_RESIDENCY_POLICY, canvasStructureKey, type ResidencyPurpose } from "./residency/index.js";
import type { CanvasResourceCoordinator } from "./residency/index.js";
/** 默认最高 60fps；实际更新由视频解码帧回调驱动。 */
export const VIDEO_FRAME_MIN_UPLOAD_INTERVAL_MS = 1000 / 60;
/** 同时存在的视频会话上限（design D4；与集中策略默认一致）。 */
export const VIDEO_SESSION_LIMIT = DEFAULT_RESIDENCY_POLICY.videoSessionLimit;
/** 静态首帧并发解码上限。 */
export const VIDEO_STATIC_DECODE_LIMIT = DEFAULT_RESIDENCY_POLICY.videoFirstFrameConcurrency;
/** 首帧 seek 目标（design D2）：`min(0.1s, duration / 2)`。 */
export const VIDEO_FIRST_FRAME_SEEK_SECONDS = 0.1;
/** 首帧等待上限：超过即按超时结算名额并保留 poster（design D2/D8）。 */
export const VIDEO_FIRST_FRAME_TIMEOUT_MS = 4000;
/** 隐藏解码元素的稳定接口（生产由 `document.createElement("video")` 提供，测试注入 fake）。 */
export type VideoElementLike = {
  src: string;
  muted: boolean;
  loop: boolean;
  playsInline: boolean;
  preload: string;
  crossOrigin: string | null;
  currentTime: number;
  readonly seeking?: boolean;
  /** 元素是否处于暂停；存在时用于避免重复 `play()` 与感知被浏览器暂停。 */
  readonly paused?: boolean;
  readonly readyState?: number;
  readonly duration: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  play(): unknown;
  pause(): void;
  load?(): void;
  removeAttribute?(name: string): void;
  addEventListener(type: string, handler: (event: unknown) => void): void;
  removeEventListener(type: string, handler: (event: unknown) => void): void;
  requestVideoFrameCallback?(callback: (now: number, metadata?: unknown) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
};
export type PosterImage = { naturalWidth?: number; naturalHeight?: number; width: number; height: number };
export type VideoFrameSessionOptions = {
  runtime: BevyRuntime;
  getCanvas: () => ServerCanvas | null;
  /** 用户是否偏好减少动态效果（design D3）：为 true 时只上传静态真帧，不自动播放。 */
  isReducedMotion?: () => boolean;
  /** 聚焦工作区接管共享纹理时暂停卡片解码上传；退出后恢复 canonical 帧。 */
  isSuspended?: () => boolean;
  /** 当前被聚焦预览替换纹理的节点；仅该视频需要退出恢复。 */
  getFocusTextureNodeId?: () => string | null;
  /** 注入：创建隐藏 video 元素（测试用 fake）。 */
  createVideo?: () => VideoElementLike;
  /** 注入：创建帧 canvas。 */
  createCanvas?: RasterCanvasFactory;
  /** 注入：解码 poster 图片（测试用 fake）；默认用 DOM Image。 */
  loadPosterImage?: (url: string) => Promise<PosterImage>;
  /** 上传间隔下限（ms）。 */
  minUploadIntervalMs?: number;
  /** 会话数量上限。 */
  maxSessions?: number;
  /** 静态首帧并发上限。 */
  maxStaticDecodes?: number;
  now?: () => number;
  /** 纹理/播放状态变化后回调（触发一次 scene flush / E2E 镜像）。 */
  onChange?: () => void;
  /**
   * 页面级资源协调器（change: 2026-10-23，design D1）。
   *
   * 提供时：decoder 与首帧工作经 `video-session` / `video-frame` 通道准入，
   * 需求用途来自协调器投影；缺省时按 `maxSessions`/`maxStaticDecodes` 本地有界（旧行为）。
   */
  residency?: CanvasResourceCoordinator;
  /** 该节点当前的准入用途；缺省按 visible。 */
  purposeOf?: (nodeId: string) => ResidencyPurpose | null;
  /** 首帧等待上限（ms）。 */
  firstFrameTimeoutMs?: number;
};
export type VideoFrameSessions = {
  /** 按当前 canonical 画布同步会话（幂等）。 */
  sync(): void;
  /** 设置当前 hovered 的视频节点；传 null 暂停全部。 */
  setHovered(nodeId: string | null): void;
  /** 当前正在播放的节点 id（最多一个）。 */
  playingNodeId(): string | null;
  /** 暂停所有会话但保留最后帧。 */
  pauseAll(): void;
  /** 该节点是否已有可用的真实帧纹理。 */
  hasRealFrame(nodeId: string): boolean;
  /** 首帧解码或播放缓冲中；只存在于浏览器呈现状态。 */
  isLoading?(nodeId: string): boolean;
  /** 当前活动会话的节点 id（供 E2E / 排障观察）。 */
  activeNodeIds(): string[];
  /** 诊断：首帧名额的真实占用（含 draining）。 */
  diagnostics?(): { sessions: number; staticActive: number; staticPending: number; created: number; disposed: number };
  dispose(): void;
};
type Session = {
  nodeId: string;
  sourceUrl: string;
  posterUrl: string | null;
  /** source generation：换源/重建后旧回调据此丢弃（design D2/D4）。 */
  generation: number;
  video: VideoElementLike;
  canvas: RasterCanvas;
  hasRealFrame: boolean;
  hasPosterTexture: boolean;
  load: NodeResourceLoad;
  state: "idle" | "playing";
  lastUploadedAt: number;
  /** 静态首帧是否已请求（避免重复排队）。 */
  staticRequested: boolean;
  frameCallbackHandle: number | null;
  fallbackTimer: ReturnType<typeof globalThis.setTimeout> | null;
  posterSettled: boolean;
  detached: boolean;
};
type StaticTask = { run: () => void; nodeId: string };
export function createVideoFrameSessions(options: VideoFrameSessionOptions): VideoFrameSessions {
  const createVideo = options.createVideo ?? defaultCreateVideo;
  const createCanvas = options.createCanvas ?? defaultRasterCanvasFactory;
  const loadPosterImage = options.loadPosterImage ?? defaultLoadPosterImage;
  const now = options.now ?? (() => performance.now());
  const minUploadInterval = options.minUploadIntervalMs ?? VIDEO_FRAME_MIN_UPLOAD_INTERVAL_MS;
  // 集中策略是唯一预算来源（design D3 / 任务 2.2）：显式注入优先，其次读页面协调器的策略，
  // 最后才回落到默认常量。否则注入更小的 `videoSessionLimit` 只影响投影而不限制 decoder，
  // 「所有媒体 owner 接同一页总预算」就不成立。
  const maxSessions = Math.max(1, options.maxSessions
    ?? options.residency?.getPolicy().videoSessionLimit ?? VIDEO_SESSION_LIMIT);
  const maxStaticDecodes = Math.max(1, options.maxStaticDecodes
    ?? options.residency?.getPolicy().videoFirstFrameConcurrency ?? VIDEO_STATIC_DECODE_LIMIT);
  const firstFrameTimeout = options.firstFrameTimeoutMs ?? VIDEO_FIRST_FRAME_TIMEOUT_MS;
  const residency = options.residency;
  const sessions = new Map<string, Session>();
  const uploads = new MediaOperationBoundary(options.runtime);
  let retryVersion = options.runtime.retryVersion?.() ?? 0;
  /** 首帧等待队列：只有真正完成/失败/超时/取消清理后才腾出名额。 */
  const staticQueue: StaticTask[] = [];
  /** 已占用首帧名额的节点 → 超时句柄；数量即真实在途数。 */
  const staticActive = new Map<string, ReturnType<typeof globalThis.setTimeout> | null>();
  let hovered: string | null = null;
  let generationCounter = 0;
  let disposed = false;
  let wasSuspended = false;
  let createdCount = 0;
  let disposedCount = 0;
  const overriddenTextures = new Set<string>();
  const pendingRestores = new Map<string, Session>();
  /** 视频绑定 memo（design D7 / 任务 7.1）：静止帧不重新解析全量节点视频来源。 */
  let boundCanvas: ServerCanvas | null = null;
  let boundStructure = "";
  let boundSources: Map<string, { url: string; posterUrl: string | null }> | null = null;
  const notify = () => options.onChange?.();
  const loading = new NodeResourceLoading(notify, "video-first-frame");
  const purposeOf = (nodeId: string): ResidencyPurpose => options.purposeOf?.(nodeId) ?? "visible";

  /** 首帧名额：只有显式 release 才归还（完成/失败/超时/清理）。 */
  const releaseStatic = (nodeId: string) => {
    const handle = staticActive.get(nodeId);
    if (handle === undefined) return;
    if (handle !== null) globalThis.clearTimeout?.(handle);
    staticActive.delete(nodeId);
    pumpStatic();
  };
  const runStatic = (nodeId: string, task: () => void) => {
    staticQueue.push({ nodeId, run: task });
    pumpStatic();
  };
  function pumpStatic(): void {
    while (staticActive.size < maxStaticDecodes && staticQueue.length > 0) {
      const next = staticQueue.shift()!;
      // 名额先登记，再置超时：超时同样结算（不允许「函数已返回但帧永远没来」长期占用）。
      staticActive.set(next.nodeId, null);
      const timer = globalThis.setTimeout?.(() => {
        if (!staticActive.has(next.nodeId)) return;
        releaseStatic(next.nodeId);
      }, firstFrameTimeout) ?? null;
      staticActive.set(next.nodeId, timer);
      try {
        next.run();
      } catch {
        releaseStatic(next.nodeId);
      }
    }
  }
  const cancelFrameHandle = (session: Session) => {
    if (session.frameCallbackHandle !== null) {
      session.video.cancelVideoFrameCallback?.(session.frameCallbackHandle);
      session.frameCallbackHandle = null;
    }
    if (session.fallbackTimer !== null) {
      globalThis.clearTimeout?.(session.fallbackTimer);
      session.fallbackTimer = null;
    }
  };
  const detachSession = (session: Session) => measureVideoPhase("session-detach", session.nodeId, () => {
    if (session.detached) return;
    session.detached = true;
    disposedCount += 1;
    pendingRestores.delete(session.nodeId);
    uploads.clear(`video:${session.nodeId}`);
    uploads.clear(`poster:${session.nodeId}`);
    uploads.clear(`decode-video:${session.nodeId}`);
    loading.remove(session.load);
    session.state = "idle";
    cancelFrameHandle(session);
    releaseStatic(session.nodeId);
    residency?.cancel(`video-session:${session.nodeId}`);
    residency?.cancel(`video-frame:${session.nodeId}`);
    try {
      measureVideoPhase("pause-call", session.nodeId, () => session.video.pause());
    } catch {
      /* 元素可能已被移除 */
    }
    session.video.removeAttribute?.("src");
    try {
      measureVideoPhase("load-call", session.nodeId, () => session.video.load?.());
    } catch {
      /* 忽略 */
    }
  });
  /** 会话仍然有效（未被替换/移除/dispose）且 source generation 未过期。 */
  const isCurrent = (session: Session, sourceGeneration: number): boolean =>
    !disposed && !session.detached && sessions.get(session.nodeId) === session && session.generation === sourceGeneration;
  /** 绘制并上传一帧真实画面；返回是否成功上传。 */
  const uploadRealFrame = (session: Session, sourceGeneration: number): boolean => measureVideoPhase("frame-upload", session.nodeId, () => {
    if (!isCurrent(session, sourceGeneration) || options.isSuspended?.()) return false;
    const { videoWidth, videoHeight, seeking, readyState } = session.video;
    if (!videoWidth || !videoHeight || seeking || (readyState !== undefined && readyState < 2)) return false;
    // 每帧上传 staging 预算（design D3）：额度用尽时本帧不上传，也不标记为资源失败；
    // 调用方保留 poster/在途状态，下一帧帧前导重置额度后继续（首帧名额因此照常按
    // 成功/失败/超时/清理归还，不会因预算延后而泄漏或提前释放）。
    // 播放/悬停（`playing`）是当前交互需求，按 D3「交互优先」不受逐帧额度限制。
    if (!(residency?.spendUploadBytes(videoWidth * videoHeight * 4, session.state === "playing") ?? true)) return false;
    const uploadedAt = now();
    const accepted = uploads.run(`video:${session.nodeId}`, session.sourceUrl, session.nodeId, () => {
      const raster = measureVideoPhase("frame-raster", session.nodeId, () => rasterizeDrawable(
      session.video,
      { width: videoWidth, height: videoHeight },
      () => session.canvas,
      TEXTURE_MAX_DIMENSION,
      session.nodeId
    ));
      if (!raster) throw new Error("视频预览无法读取像素");
      return measureVideoPhase("texture-submit", session.nodeId, () => options.runtime.setTexture(session.nodeId, raster.width, raster.height, raster.pixels,
        { sourceKey: session.sourceUrl })) !== false;
    });
    if (!accepted) { loading.setLoading(session.load, false, "error"); return false; }
    session.hasRealFrame = true;
    loading.setLoading(session.load, false);
    session.lastUploadedAt = uploadedAt;
    return true;
  });

  const uploadPosterFallback = (session: Session, sourceGeneration: number) => {
    if (session.hasRealFrame || session.posterSettled) return;
    session.posterSettled = true;
    const posterUrl = session.posterUrl;
    if (!posterUrl) return;
    void loadPosterImage(posterUrl)
      .then((image) => {
        if (!isCurrent(session, sourceGeneration) || session.hasRealFrame) return;
        if (options.isSuspended?.()) {
          session.posterSettled = false;
          return;
        }
        // 每帧上传 staging 预算（design D3）：额度用尽就留到下一帧再试。必须在进入上传边界
        // **之前**判定，否则 `false` 会被当成资源失败而永久跳过该封面。
        const { width, height } = scaleToMaxDimension(
          image.naturalWidth || image.width,
          image.naturalHeight || image.height,
          Math.min(TEXTURE_MAX_DIMENSION, BEVY_TEXTURE_MAX_DIMENSION)
        );
        if (!(residency?.spendUploadBytes(width * height * 4) ?? true)) {
          session.posterSettled = false;
          return;
        }
        uploads.run(`poster:${session.nodeId}`, posterUrl, session.nodeId, () => {
          const raster = rasterizeDrawable(
          image,
          { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height },
          () => session.canvas,
          TEXTURE_MAX_DIMENSION
        );
          if (!raster) throw new Error("视频封面无法读取像素");
          const accepted = options.runtime.setTexture(session.nodeId, raster.width, raster.height, raster.pixels,
            { sourceKey: posterUrl, preserveFailure: true }) !== false;
          if (accepted) { session.hasPosterTexture = true; notify(); }
          return accepted;
        });
      })
      .catch(error => {
        if (isCurrent(session, sourceGeneration)) uploads.run(`poster:${session.nodeId}`, posterUrl, session.nodeId, () => { throw error; });
      });
  };

  /**
   * seek 到首帧可呈现位置并解码上传（design D2）。
   *
   * 名额在 `runStatic` 取得，并且只有在**帧回调真正执行完**（成功上传 / 帧不可用 / 元素失败 /
   * 超时）后才 `releaseStatic`；不再于启动函数返回时释放（原缺陷：配置 2 仍可发出 12 次
   * 未完成 seek，任务 3.2）。
   */
  const ensureFirstFrame = (session: Session, sourceGeneration: number) => {
    if (session.staticRequested) return;
    session.staticRequested = true;
    runStatic(session.nodeId, () => {
      if (!isCurrent(session, sourceGeneration)) { releaseStatic(session.nodeId); return; }
      const video = session.video;
      const duration = Number(video.duration);
      const target = Number.isFinite(duration) && duration > 0 ? Math.min(VIDEO_FIRST_FRAME_SEEK_SECONDS, duration / 2) : 0;
      try {
        video.currentTime = target;
      } catch {
        /* seek 可能不可用 */
      }
      const settle = (uploaded: boolean) => {
        releaseStatic(session.nodeId);
        if (uploaded) { notify(); return; }
        if (!isCurrent(session, sourceGeneration)) return;
        // 帧尚不可呈现：保留 poster，并让下一次合法需求（hover/重试）重新排队。
        session.staticRequested = false;
        session.posterSettled = false;
        uploadPosterFallback(session, sourceGeneration);
      };
      if (typeof video.requestVideoFrameCallback === "function") {
        const handle = video.requestVideoFrameCallback(() => {
          if (session.frameCallbackHandle === handle) session.frameCallbackHandle = null;
          settle(uploadRealFrame(session, sourceGeneration));
        });
        session.frameCallbackHandle = handle;
      } else {
        session.fallbackTimer = globalThis.setTimeout?.(() => {
          session.fallbackTimer = null;
          settle(uploadRealFrame(session, sourceGeneration));
        }, 0) ?? null;
      }
    });
  };
  const stopPlayback = (session: Session) => measureVideoPhase("stop-playback", session.nodeId, () => {
    if (session.state === "idle") return;
    session.state = "idle";
    if (session.hasRealFrame) loading.setLoading(session.load, false);
    cancelFrameHandle(session);
    try {
      measureVideoPhase("pause-call", session.nodeId, () => session.video.pause());
    } catch {
      /* 忽略 */
    }
  });

  const scheduleNextFrame = (session: Session, sourceGeneration: number) => {
    if (!isCurrent(session, sourceGeneration) || session.state !== "playing") return;
    const video = session.video;
    if (typeof video.requestVideoFrameCallback === "function") {
      const handle = video.requestVideoFrameCallback(() => {
        session.frameCallbackHandle = null;
        pumpFrame(session, sourceGeneration);
      });
      session.frameCallbackHandle = handle;
    } else {
      session.fallbackTimer = globalThis.setTimeout?.(() => {
        session.fallbackTimer = null;
        pumpFrame(session, sourceGeneration);
      }, minUploadInterval) ?? null;
    }
  };

  const pumpFrame = (session: Session, sourceGeneration: number) => {
    if (!isCurrent(session, sourceGeneration) || session.state !== "playing") return;
    // 允许 1ms 的帧回调抖动，避免稳定 60fps 来源因微小误差隔帧上传。
    if (now() - session.lastUploadedAt >= Math.max(0, minUploadInterval - 1)) {
      if (uploadRealFrame(session, sourceGeneration)) notify();
    }
    scheduleNextFrame(session, sourceGeneration);
  };

  const startPlayback = (session: Session, sourceGeneration: number) => {
    if (!isCurrent(session, sourceGeneration) || session.state === "playing" || options.isSuspended?.()) return;
    session.state = "playing";
    // 只有播放（hover/恢复）才允许全量缓冲；建会话时的 metadata 预取在此升级。
    if (session.video.preload !== "auto") session.video.preload = "auto";
    let playResult: unknown;
    try {
      playResult = measureVideoPhase("play-call", session.nodeId, () => session.video.play());
    } catch {
      playResult = undefined;
    }
    // play() 可能因自动播放策略被拒；失败保持最后帧，不破坏画布（design D8）。
    if (playResult && typeof (playResult as Promise<void>).catch === "function") {
      void (playResult as Promise<void>).catch(() => {
        if (session.state === "playing") {
          stopPlayback(session);
          notify();
        }
      });
    }
    scheduleNextFrame(session, sourceGeneration);
    notify();
  };

  const createSession = (nodeId: string, url: string, posterUrl: string | null): Session => {
    const video = createVideo();
    video.src = url;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    // 预取策略：建会话只取元数据，避免一进画布就为每个视频节点拉取正文；hover/播放时才升级为 auto。
    video.preload = "metadata";
    video.crossOrigin = "anonymous";
    createdCount += 1;
    const session: Session = {
      nodeId,
      sourceUrl: url,
      posterUrl,
      generation: ++generationCounter,
      video,
      canvas: createCanvas(),
      hasRealFrame: false,
      hasPosterTexture: false,
      load: loading.track(nodeId, url),
      state: "idle",
      lastUploadedAt: 0,
      staticRequested: false,
      frameCallbackHandle: null,
      fallbackTimer: null,
      posterSettled: false,
      detached: false
    };
    // 元数据到达就显式 seek 一次：只取首帧所需数据即可上传，无需等整段缓冲。
    // 只有真正需要真帧的目标（无 poster 的卡片、hover/聚焦）才占首帧名额（任务 3.3）。
    const wantsRealFrame = () => nodeId === hovered || !posterUrl || overriddenTextures.has(nodeId);
    const requestFirstFrame = () => {
      if (!isCurrent(session, session.generation) || session.hasRealFrame || session.state === "playing") return;
      if (!wantsRealFrame()) { uploadPosterFallback(session, session.generation); return; }
      uploads.clear(`decode-video:${session.nodeId}`);
      ensureFirstFrame(session, session.generation);
    };
    video.addEventListener("loadedmetadata", requestFirstFrame);
    video.addEventListener("loadeddata", requestFirstFrame);
    video.addEventListener("waiting", () => {
      if (!isCurrent(session, session.generation) || session.state !== "playing") return;
      loading.setLoading(session.load, true);
    });
    video.addEventListener("error", () => {
      if (!isCurrent(session, session.generation)) return;
      loading.setLoading(session.load, false, "error");
      // 解码失败同样终结真实在途名额（不靠超时兜底）。
      releaseStatic(session.nodeId);
      session.staticRequested = false;
      uploads.run(`decode-video:${session.nodeId}`, session.sourceUrl, session.nodeId, () => { throw new Error("视频解码失败"); });
    });
    return session;
  };

  /**
   * 选出本帧实际创建的 decoder 集合。
   *
   * 顺序：hover（当前播放目标）→ interactive 用途 → 其余按 purpose/文档顺序。
   * 名额由 `maxSessions` 约束；未选中的节点只用 poster/占位（design D1/D3）。
   *
   * 协调器提供的准入集合是**需求上界**，这里的 `maxSessions` 是 decoder 硬上限：两者取小，
   * 因此 1000 个可见视频也不会创建 1000 个播放器（任务 3.1）。
   */
  const admitted = (next: Map<string, { url: string; posterUrl: string | null }>): string[] => {
    const order = new Map<string, number>();
    let index = 0;
    for (const nodeId of next.keys()) order.set(nodeId, index++);
    return [...next.keys()]
      .filter((nodeId) => !residency || residency.isAdmitted(nodeId))
      .sort((a, b) => {
        const hoverDelta = (a === hovered ? 0 : 1) - (b === hovered ? 0 : 1);
        if (hoverDelta !== 0) return hoverDelta;
        const purposeDelta = purposeRank(purposeOf(a)) - purposeRank(purposeOf(b));
        if (purposeDelta !== 0) return purposeDelta;
        // 同优先级保留文档顺序（稳定、可复现）。
        return (order.get(a) ?? 0) - (order.get(b) ?? 0);
      })
      .slice(0, maxSessions);
  };

  return {
    sync() {
      if (disposed) return;
      const retry = options.runtime.retryVersion?.() ?? 0;
      const retrying = retry !== retryVersion;
      retryVersion = retry;
      const suspended = options.isSuspended?.() ?? false;
      const resuming = wasSuspended && !suspended;
      if (suspended !== wasSuspended) recordVideoTransition(suspended ? "focus-suspend" : "focus-resume", sessions.size);
      wasSuspended = suspended;
      if (suspended) {
        for (const session of sessions.values()) stopPlayback(session);
        hovered = null;
      }
      const canvas = measureVideoPhase("canvas-projection", null, () => options.getCanvas());
      if (!canvas) {
        for (const session of sessions.values()) detachSession(session);
        sessions.clear();
        hovered = null;
        return;
      }
    const next = new Map<string, { url: string; posterUrl: string | null }>();
      // 需求集合 memo（design D7 / 任务 7.1）：画布身份与结构指纹都没变时复用上一帧解析结果，
      // 静止帧不重新解析全量节点视频来源。
      const structure = `${canvasStructureKey(canvas)}|${canvas.id}`;
      if (canvas !== boundCanvas || structure !== boundStructure || !boundSources) {
        for (const node of canvas.document.nodes) {
          if (node.type !== "video") continue;
          const resolved = resolveNodeVideoSource(canvas, node.id);
          if (resolved) next.set(node.id, resolved);
        }
        boundCanvas = canvas;
        boundStructure = structure;
        boundSources = next;
      } else {
        for (const [nodeId, source] of boundSources) next.set(nodeId, source);
      }

      // 先算准入集合，再创建：未准入节点不创建 decoder（不再 create-all/prune-later）。
      const admittedIds = new Set(admitted(next));
      uploads.retainNodes(new Set(next.keys()));
      for (const [nodeId, session] of sessions) {
        const want = next.get(nodeId);
        if (!want || want.url !== session.sourceUrl || !admittedIds.has(nodeId)) {
          detachSession(session);
          sessions.delete(nodeId);
          if (hovered === nodeId) hovered = null;
        }
      }

      for (const nodeId of admittedIds) {
        if (sessions.has(nodeId)) continue;
        const { url, posterUrl } = next.get(nodeId)!;
        const session = uploads.run(`video-session:${nodeId}`, url, nodeId, () => measureVideoPhase("session-create", nodeId, () => createSession(nodeId, url, posterUrl)));
        if (!session) continue;
        sessions.set(nodeId, session);
        // 普通静态卡片优先 poster：有 poster 时不抢首帧名额（design D3 / 任务 3.3）。
        if (posterUrl) uploadPosterFallback(session, session.generation);
        // 只有真正需要真帧的目标（hover/聚焦/无 poster）才取首帧。
        if (!posterUrl && nodeId === hovered) ensureFirstFrame(session, session.generation);
      }
      const overridden = options.getFocusTextureNodeId?.();
      if (overridden && sessions.has(overridden)) overriddenTextures.add(overridden);
      for (const nodeId of overriddenTextures) if (!sessions.has(nodeId)) overriddenTextures.delete(nodeId);

      // 只恢复被聚焦覆盖的纹理或尚未取得的首帧；图片聚焦不使视频纹理失效。
      if (resuming || retrying) {
        for (const session of sessions.values()) {
          if (!retrying && (session.hasRealFrame || session.hasPosterTexture) && !overriddenTextures.has(session.nodeId)) continue;
          pendingRestores.set(session.nodeId, session);
        }
        overriddenTextures.clear();
      }

      // 一帧最多恢复一个视频；暂停期间保留队列，退出后继续。
      if (!suspended && pendingRestores.size) {
        const [nodeId, session] = pendingRestores.entries().next().value!;
        pendingRestores.delete(nodeId);
        if (isCurrent(session, session.generation)) measureVideoPhase("restore-frames", nodeId, () => {
          if (uploadRealFrame(session, session.generation)) notify();
          else { session.posterSettled = false; uploadPosterFallback(session, session.generation); }
        });
      }

      if (hovered) {
        const session = sessions.get(hovered);
        if (session) startPlayback(session, session.generation);
      }
    },

    setHovered(nodeId: string | null) {
      if (options.isSuspended?.()) nodeId = null;
      if (disposed || nodeId === hovered) return;
      if (hovered !== null) {
        const previous = sessions.get(hovered);
        if (previous) stopPlayback(previous);
      }
      hovered = nodeId;
      if (nodeId === null) {
        notify();
        return;
      }
      // hover 是交互需求：没有会话时（例如刚被预算裁掉）按当前画布重新选准入集合。
      if (!sessions.has(nodeId)) this.sync();
      // 减少动态效果：不自动播放，保留真实静态帧（design D3）。
      if (options.isReducedMotion?.()) return;
      const session = sessions.get(nodeId);
      if (session) startPlayback(session, session.generation);
    },

    playingNodeId() {
      for (const [nodeId, session] of sessions) if (session.state === "playing") return nodeId;
      return null;
    },

    pauseAll() {
      for (const session of sessions.values()) stopPlayback(session);
      hovered = null;
      notify();
    },

    hasRealFrame(nodeId: string) {
      return sessions.get(nodeId)?.hasRealFrame ?? false;
    },

    isLoading: loading.isLoading,

    activeNodeIds() {
      return [...sessions.keys()];
    },

    diagnostics() {
      return {
        sessions: sessions.size,
        staticActive: staticActive.size,
        staticPending: staticQueue.length,
        created: createdCount,
        disposed: disposedCount
      };
    },

    dispose() {
      disposed = true;
      for (const session of sessions.values()) detachSession(session);
      sessions.clear();
      loading.clear();
      staticQueue.length = 0;
      for (const nodeId of [...staticActive.keys()]) releaseStatic(nodeId);
      hovered = null;
    }
  };
}

function purposeRank(purpose: ResidencyPurpose): number {
  switch (purpose) {
    case "interactive": return 0;
    case "visible": return 1;
    case "prefetch": return 2;
    case "warm": return 3;
  }
}
