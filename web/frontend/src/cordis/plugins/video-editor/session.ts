/** 视频聚焦会话：解码、取景、历史 override 与迟到回调的生命周期。 */
import { buildCanvasRenderScene } from "@woohaa3/contracts";
import { rasterizeDrawable, defaultRasterCanvasFactory, type RasterCanvas } from "../canvas-runtime/media-raster.js";
import type { VideoElementLike } from "../canvas-runtime/video-frame-session.js";
import type { FocusContentRect } from "../../focus/types.js";
import { nodeImageRect, overviewImageView, createLocalTransitionRunner, type FocusTransitionPort, type SurfaceRect } from "../../focus/media-transition.js";
import { type VideoFocusTarget } from "./targets.js";
import { VIDEO_FOCUS_TEXTURE_MAX_DIMENSION, VIDEO_FOCUS_MIN_UPLOAD_INTERVAL_MS, fitZoomFor, clampZoom, defaultCreateVideo, type VideoFocusViewport, type VideoFocusSessionOptions, type VideoFocusState } from "./session-types.js";
export { VIDEO_FOCUS_TEXTURE_MAX_DIMENSION, VIDEO_FOCUS_MIN_UPLOAD_INTERVAL_MS, fitZoomFor, videoTargetIdentity, resolveVideoFocusTarget } from "./session-types.js";
export type { VideoFocusViewport, VideoFocusSessionOptions, VideoFocusState } from "./session-types.js";

export class VideoFocusSession {
  readonly nodeId: string;
  private readonly options: VideoFocusSessionOptions;
  private readonly video: VideoElementLike;
  private readonly canvas: RasterCanvas;
  private generation = 0;
  /** 是否已执行首次进入放大动画（换源/历史恢复不重复放大）。 */
  private entered = false;
  private readonly minUploadInterval: number;
  private readonly now: () => number;
  private lastUploadedAt = 0;
  private frameHandle: number | null = null;
  private fallbackTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private disposed = false;
  private viewport: VideoFocusViewport = { x: 0, y: 0, zoom: 1 };
  private directView: VideoFocusViewport | null = null;
  /** 进入历史前的 direct 播放位置（返回当前时恢复；不套用到换源后的新当前）。 */
  private directTime: number | null = null;
  private historyUrl: string | null = null;
  private historyPending = false;
  private historyError: string | null = null;
  private loadError: string | null = null;
  private sourceWidth = 0;
  private sourceHeight = 0;
  /** 当前 canonical 直连来源（远端输出改变时可被 `setTarget` 替换）。 */
  private currentTarget: VideoFocusTarget;
  private listeners = new Set<() => void>();
  private revision = 0;
  /** 取景进入/退出过渡：由公共 coordinator 端口（Canvas Runtime scope）驱动。 */
  private readonly transition: FocusTransitionPort;
  private animationGeneration = 0;
  private transitioning = false;
  /** 当前显示源的节点内容矩形（进入动画首帧/退出动画末帧的像素对齐锚点）。 */
  private worldRect: SurfaceRect | null = null;
  /** 进入动画的当前终点（内容矩形变化时用于判断是否需要重新推进）。 */
  private enterDestination: VideoFocusViewport | null = null;
  /** 是否处于「进入」方向动画（内容矩形变化时才需要重排终点；退出动画保持原终点）。 */
  private entering = false;

  constructor(options: VideoFocusSessionOptions) {
    this.options = options;
    this.nodeId = options.nodeId;
    this.currentTarget = options.target;
    this.video = (options.createVideo ?? defaultCreateVideo)();
    this.canvas = (options.createCanvas ?? defaultRasterCanvasFactory)();
    this.minUploadInterval = options.minUploadIntervalMs ?? VIDEO_FOCUS_MIN_UPLOAD_INTERVAL_MS;
    this.now = options.now ?? (() => performance.now());
    this.transition = options.transition ?? createLocalTransitionRunner();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private emit = (): void => {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  };
  revisionState(): number { return this.revision; }

  /** 初次进入：绑定自身输出并暂停；不自动播放。 */
  start(): boolean {
    const { url } = this.currentTarget;
    this.video.src = url;
    this.video.muted = true;
    this.video.loop = false;
    this.video.playsInline = true;
    this.video.preload = "auto";
    this.video.crossOrigin = "anonymous";
    const generation = ++this.generation;
    this.video.addEventListener("loadedmetadata", () => {
      if (!this.isCurrent(generation)) return;
      this.sourceWidth = Number(this.video.videoWidth) || this.sourceWidth;
      this.sourceHeight = Number(this.video.videoHeight) || this.sourceHeight;
      // 不在此处主动 seek 到 0：`src` 刚设置，播放位置本来就是时间零点。多一次 seek 会让
      // 首帧窗口处于 seeking 状态，只取得到空白像素（「放大后视频消失」）。
      this.emit();
    });
    this.video.addEventListener("loadeddata", () => {
      if (!this.isCurrent(generation)) return;
      this.sourceWidth = Number(this.video.videoWidth) || this.sourceWidth;
      this.sourceHeight = Number(this.video.videoHeight) || this.sourceHeight;
      // 首次直连加载：从节点卡片屏幕位置放大推进到适应窗口（换源/历史恢复直接落位）。
      if (this.directView === null && this.historyUrl === null && !this.entered) {
        this.entered = true;
        this.animateEnter();
      } else {
        this.applyFit();
        this.pushProjection();
      }
      this.pumpFrame(generation);
      this.emit();
    });
    this.video.addEventListener("seeked", () => {
      if (!this.isCurrent(generation)) return;
      this.pushProjection();
      this.pumpFrame(generation);
      this.emit();
    });
    // 兜底：`loadeddata` 时若仍在 seek 中，首帧会被 `canPresentFrame` 拒绝；解码推进到可播放
    // 状态后必须补上一次真实帧，否则暂停的聚焦画面会停在空白纹理上（「放大后视频消失」）。
    this.video.addEventListener("canplay", () => {
      if (!this.isCurrent(generation)) return;
      this.pumpFrame(generation);
    });
    this.video.addEventListener("playing", () => {
      if (!this.isCurrent(generation)) return;
      this.pumpFrame(generation);
    });
    this.video.addEventListener("timeupdate", () => { if (this.isCurrent(generation)) this.emit(); });
    this.video.addEventListener("play", () => { if (this.isCurrent(generation)) { this.scheduleFrames(generation); this.emit(); } });
    this.video.addEventListener("pause", () => { if (this.isCurrent(generation)) { this.cancelFrameLoop(); this.emit(); } });
    this.video.addEventListener("error", () => {
      if (!this.isCurrent(generation)) return;
      this.loadError = "视频加载失败";
      this.emit();
    });
    this.applyFit();
    this.pushProjection();
    return true;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  private applyFit(): void {
    const width = this.sourceWidth || this.displaySize().width;
    const height = this.sourceHeight || this.displaySize().height;
    if (width <= 0 || height <= 0) return;
    const zoom = fitZoomFor(width, height, this.options.rect);
    // 首次 fit（或 rect 变化）时承载当前取景；手动缩放后不再强制。
    if (this.directView === null && this.historyUrl === null) this.viewport = { x: 0, y: 0, zoom };
  }

  /** 取景过渡时长（毫秒）：显式注入优先，否则尊重 `prefers-reduced-motion`。 */
  private duration(): number {
    if (this.options.transitionDuration !== undefined) return this.options.transitionDuration;
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420;
  }

  /** 当前显示源的节点内容矩形（进入动画首帧/退出动画末帧锚点）。无画布时保持 null。 */
  private refreshWorldRect(width: number, height: number): void {
    const canvas = this.options.getCanvas();
    if (!canvas) return;
    const node = buildCanvasRenderScene({ canvas }).nodes.find(entry => entry.id === this.nodeId);
    if (node) this.worldRect = nodeImageRect(node, width, height);
  }

  private cancelTransition(): void {
    this.transition.cancel();
    this.animationGeneration += 1;
    this.transitioning = false;
    this.entering = false;
    this.enterDestination = null;
  }

  /** 首次进入：从节点卡片屏幕位置逐帧放大推进到适应窗口（首帧与卡片像素对齐）。 */
  private animateEnter(): void {
    const { width, height } = this.displaySize();
    const destination = { x: 0, y: 0, zoom: fitZoomFor(width, height, this.options.rect) };
    this.refreshWorldRect(width, height);
    const start = this.worldRect
      ? overviewImageView(this.worldRect, width, this.options.rect, this.options.savedViewport)
      : null;
    if (!start) {
      this.applyFit();
      this.pushProjection();
      return;
    }
    this.viewport = start;
    this.pushProjection();
    this.enterDestination = destination;
    this.entering = true;
    void this.animateTo(destination);
  }

  /**
   * 过渡中内容矩形到达：重新落位进入动画终点，而不是等动画结束才按新矩形取景。
   *
   * 首次进入时公共焦点布局（右侧检查器宽度）与首帧解码通常不在同一帧到达：若沿用
   * 「过渡中不改取景」的旧规则，动画会推到一个过宽/过窄的适应值，随后既不重算也无法回退，
   * 表现为放大后画面被推出可视区。这里从当前已呈现取景重新推进到新的适应终点，保持视觉连续。
   */
  private retargetEnterForRect(): void {
    if (!this.entering || !this.transitioning || this.historyUrl !== null) return;
    const { width, height } = this.displaySize();
    if (width <= 0 || height <= 0) return;
    const destination = { x: 0, y: 0, zoom: fitZoomFor(width, height, this.options.rect) };
    if (this.enterDestination
      && Math.abs(this.enterDestination.zoom - destination.zoom) < 1e-6) return;
    this.enterDestination = destination;
    void this.animateTo(destination);
  }

  private async animateTo(destination: VideoFocusViewport): Promise<void> {
    const generation = ++this.animationGeneration;
    this.transitioning = true;
    await this.transition.run({
      key: this.nodeId,
      from: this.viewport,
      to: destination,
      duration: this.duration(),
      apply: (view) => {
        if (this.disposed || generation !== this.animationGeneration) return;
        // 过渡帧不做手动手势范围钳制：概览首帧可能小于手动下限，钳制会破坏像素对齐。
        this.viewport = { x: view.x, y: view.y, zoom: view.zoom };
        this.pushProjection();
      }
    });
    if (!this.disposed && generation === this.animationGeneration) {
      this.transitioning = false;
      this.entering = false;
      this.emit();
    }
  }

  /**
   * 退出前取景动画：从当前取景逐帧缩回节点卡片屏幕位置。
   *
   * 由退出协调器在导航 dispatch 前调用，随后 `dispose()` 清投影并恢复进入前视口，二者视觉连续。
   */
  async animateExit(): Promise<void> {
    this.entering = false;
    this.enterDestination = null;
    if (this.disposed || this.sourceWidth <= 0 || this.sourceHeight <= 0) return;
    const { width, height } = this.displaySize();
    this.refreshWorldRect(width, height);
    if (!this.worldRect) return;
    await this.animateTo(overviewImageView(this.worldRect, width, this.options.rect, this.options.savedViewport));
  }

  /** 更新可用内容矩形（面板 resize / 历史展开）；保持视频比例。 */
  setRect(rect: FocusContentRect): void {
    this.options.rect = rect;
    if (this.displaySize().width <= 0) return;
    // 进入动画进行中：内容矩形通常晚于首帧到达，此时必须重排终点而不是沿用旧适应值
    // （否则放大后取景按旧矩形落位，画面被推出可视区）。退出动画仍不打断。
    if (this.transitioning) {
      this.retargetEnterForRect();
      this.pushProjection();
      this.emit();
      return;
    }
    this.applyFit();
    this.pushProjection();
    this.emit();
  }

  rectState(): FocusContentRect { return { ...this.options.rect }; }

  displaySize(): { width: number; height: number } {
    return { width: this.sourceWidth || 0, height: this.sourceHeight || 0 };
  }

  state(): VideoFocusState {
    const video = this.video;
    const ready = (video as unknown as { readyState?: number }).readyState !== undefined
      ? (video as unknown as { readyState: number }).readyState >= 2 : this.sourceWidth > 0;
    return {
      nodeId: this.nodeId,
      url: this.historyUrl ?? String(video.src ?? ""),
      posterUrl: this.historyUrl ? null : this.currentTarget.posterUrl,
      duration: Number.isFinite(Number(video.duration)) ? Number(video.duration) : 0,
      currentTime: Number(video.currentTime) || 0,
      playing: !(video as unknown as { paused?: boolean }).paused && (video as unknown as { ended?: boolean }).ended !== true,
      muted: Boolean(video.muted),
      ready,
      width: Number(video.videoWidth) || this.sourceWidth,
      height: Number(video.videoHeight) || this.sourceHeight,
      viewport: { ...this.viewport },
      historyUrl: this.historyUrl,
      loading: this.historyPending || (!ready && this.loadError === null),
      error: this.historyError ?? this.loadError
    };
  }

  viewportState(): VideoFocusViewport { return { ...this.viewport }; }

  setViewport(viewport: VideoFocusViewport): void {
    this.viewport = { x: viewport.x, y: viewport.y, zoom: clampZoom(viewport.zoom) };
    this.pushProjection();
  }
  panBy(dx: number, dy: number): void {
    this.viewport = { ...this.viewport, x: this.viewport.x + dx, y: this.viewport.y + dy };
    this.pushProjection();
  }
  zoomAround(factor: number, _center?: { x: number; y: number }): void {
    this.viewport = { ...this.viewport, zoom: clampZoom(this.viewport.zoom * factor) };
    this.pushProjection();
  }
  setActualSize(): void { this.viewport = { ...this.viewport, zoom: 1 }; this.pushProjection(); }
  fitWindow(): void {
    const { width, height } = this.displaySize();
    if (width > 0 && height > 0) this.viewport = { x: 0, y: 0, zoom: fitZoomFor(width, height, this.options.rect) };
    this.pushProjection();
  }

  private pushProjection(): void {
    // Metadata/resize can precede loadeddata. Do not fit the card before animateEnter.
    if (!this.entered) return;
    const video = this.video;
    const width = Number(video.videoWidth) || this.sourceWidth;
    const height = Number(video.videoHeight) || this.sourceHeight;
    if (width <= 0 || height <= 0) { this.options.setProjection(null); return; }
    this.options.setProjection({
      version: "woohaa-video-focus-v1",
      nodeId: this.nodeId,
      viewport: this.viewportState(),
      sourceWidth: width,
      sourceHeight: height
    });
  }

  /**
   * 更新当前 canonical 直连来源（远端输出改变）。
   *
   * 保留帧集合与回执、保存的取景；仅当当前正显示 direct 来源时重载并重新取景/暂停，
   * 不把旧来源的播放位置套到新视频（design D5）。历史预览中只更新 future 直连目标。
   */
  setTarget(target: VideoFocusTarget): void {
    this.currentTarget = target;
    if (this.disposed || this.historyUrl !== null) return;
    this.cancelTransition();
    this.generation += 1;
    const generation = this.generation;
    this.cancelFrameLoop();
    this.directView = null;
    this.directTime = null;
    this.loadError = null;
    this.sourceWidth = 0;
    this.sourceHeight = 0;
    this.safePause();
    const onLoaded = () => {
      this.video.removeEventListener("loadeddata", onLoaded);
      if (!this.isCurrent(generation)) return;
      this.sourceWidth = Number(this.video.videoWidth) || this.sourceWidth;
      this.sourceHeight = Number(this.video.videoHeight) || this.sourceHeight;
      this.viewport = { x: 0, y: 0, zoom: fitZoomFor(this.sourceWidth, this.sourceHeight, this.options.rect) };
      this.pumpFrame(generation);
      this.pushProjection();
      this.emit();
    };
    this.video.addEventListener("loadeddata", onLoaded);
    this.video.src = target.url;
    this.video.currentTime = 0;
    this.emit();
  }

  isHistory(): boolean { return this.historyUrl !== null; }

  /**
   * 安装/清除只读历史 override。
   *
   * 选择旧版本：保存当前现场（取景 + 暂停），换到该条目的受控同源媒体并暂停；清除：恢复当前
   * 来源、取景与暂停并重载上传当前画面。真实帧由 `pumpFrame` 上传（generation 门禁丢弃迟到
   * 的旧来源回调），因此历史视频同样在中央主画布显示。
   */
  setHistoryOverride(override: { url: string } | null): void {
    this.cancelTransition();
    this.generation += 1;
    this.cancelFrameLoop();
    this.historyError = null;
    if (!override) {
      const wasHistory = this.historyUrl !== null;
      this.historyUrl = null;
      this.historyPending = false;
      if (!wasHistory) return;
      const restore = this.directView ?? this.viewport;
      const restoreTime = this.directTime ?? 0;
      this.directView = null;
      this.directTime = null;
      const generation = this.generation;
      const onLoaded = () => {
        this.video.removeEventListener("loadeddata", onLoaded);
        if (!this.isCurrent(generation)) return;
        this.sourceWidth = Number(this.video.videoWidth) || this.sourceWidth;
        this.sourceHeight = Number(this.video.videoHeight) || this.sourceHeight;
        this.viewport = restore;
        if (restoreTime > 0) {
          const onSeeked = () => {
            this.video.removeEventListener("seeked", onSeeked);
            if (!this.isCurrent(generation)) return;
            this.pumpFrame(generation);
            this.pushProjection();
            this.emit();
          };
          this.video.addEventListener("seeked", onSeeked);
          try { this.video.currentTime = restoreTime; } catch { this.pumpFrame(generation); }
        } else {
          this.pumpFrame(generation);
        }
        this.pushProjection();
        this.emit();
      };
      this.video.addEventListener("loadeddata", onLoaded);
      this.safePause();
      this.video.src = this.currentTarget.url;
      this.video.currentTime = 0;
      this.emit();
      return;
    }
    this.historyUrl = override.url;
    this.historyPending = true;
    this.directView = this.directView ?? this.viewport;
    // 保存 current 播放位置（返回当前时恢复；换源后的新当前不套用旧位置）。
    if (this.directTime === null) this.directTime = Number(this.video.currentTime) || 0;
    const generation = this.generation;
    this.safePause();
    this.video.src = override.url;
    this.video.currentTime = 0;
    const onLoaded = () => {
      this.video.removeEventListener("loadeddata", onLoaded);
      if (this.disposed || this.generation !== generation || this.historyUrl !== override.url) return;
      this.historyPending = false;
      this.sourceWidth = Number(this.video.videoWidth) || this.sourceWidth;
      this.sourceHeight = Number(this.video.videoHeight) || this.sourceHeight;
      this.viewport = { x: 0, y: 0, zoom: fitZoomFor(this.sourceWidth, this.sourceHeight, this.options.rect) };
      this.pumpFrame(generation);
      this.pushProjection();
      this.emit();
    };
    this.video.addEventListener("loadeddata", onLoaded);
    this.emit();
  }

  async play(): Promise<void> {
    if (this.disposed) return;
    try {
      const result = this.video.play();
      if (result && typeof (result as Promise<void>).catch === "function") await (result as Promise<void>);
    } catch {
      // 自动播放策略拒绝：保持最后帧，不破坏画布。
    }
    this.scheduleFrames(this.generation);
    this.emit();
  }
  pause(): void {
    this.safePause();
    this.cancelFrameLoop();
    this.emit();
  }
  async seek(time: number): Promise<void> {
    const duration = Number(this.video.duration) || 0;
    const target = Math.min(Math.max(time, 0), Math.max(0, duration));
    await new Promise<void>((resolve) => {
      const generation = this.generation;
      const onSeeked = () => {
        this.video.removeEventListener("seeked", onSeeked);
        if (this.isCurrent(generation)) this.pumpFrame(generation);
        resolve();
      };
      this.video.addEventListener("seeked", onSeeked);
      try { this.video.currentTime = target; } catch { resolve(); }
    });
    this.emit();
  }
  setMuted(muted: boolean): void { this.video.muted = muted; this.emit(); }

  /** 读取当前画面为 PNG Blob（源视频尺寸）；跨域时抛出 SecurityError。 */
  async capture(): Promise<Blob> {
    const width = Number(this.video.videoWidth) || this.sourceWidth;
    const height = Number(this.video.videoHeight) || this.sourceHeight;
    if (!width || !height) throw new Error("视频画面尚未就绪");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建截帧画布");
    context.drawImage(this.video as unknown as CanvasImageSource, 0, 0, width, height);
    context.getImageData(0, 0, 1, 1);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("生成截帧图片失败");
    return blob;
  }

  private safePause(): void {
    try { this.video.pause(); } catch { /* 忽略 */ }
  }

  private scheduleFrames(generation: number): void {
    if (!this.isCurrent(generation)) return;
    const video = this.video;
    if (typeof video.requestVideoFrameCallback === "function") {
      this.frameHandle = video.requestVideoFrameCallback(() => {
        this.frameHandle = null;
        this.pumpFrame(generation);
        if (this.isCurrent(generation) && !(video as unknown as { paused?: boolean }).paused) this.scheduleFrames(generation);
      });
    } else {
      this.fallbackTimer = globalThis.setTimeout?.(() => {
        this.fallbackTimer = null;
        this.pumpFrame(generation);
        if (this.isCurrent(generation) && !(video as unknown as { paused?: boolean }).paused) this.scheduleFrames(generation);
      }, this.minUploadInterval) ?? null;
    }
  }

  /** 上传一帧（最高 60fps）到 Bevy 纹理。 */
  pumpFrame(generation: number): void {
    if (!this.isCurrent(generation)) return;
    // 未解码出可呈现画面时取帧只会得到全透明像素：上传它会覆盖已呈现画面，表现为「放大后
    // 视频消失」。与卡片会话保持一致，先校验 current data 与 seek 状态，并在渲染前复查一次
    // （绘制期间状态仍可能变化）。被拒绝的取帧不占用节流时间窗，seek/帧回调可补上新画面。
    if (!this.canPresentFrame()) return;
    const uploadedAt = this.now();
    // 与卡片预览一致，容忍帧回调的微小抖动，按上传开始时间节流。
    if (uploadedAt - this.lastUploadedAt < Math.max(0, this.minUploadInterval - 1)) return;
    if (!this.canPresentFrame()) return;
    const width = Number(this.video.videoWidth);
    const height = Number(this.video.videoHeight);
    if (!width || !height) return;
    const raster = rasterizeDrawable(this.video as unknown as CanvasImageSource, { width, height }, () => this.canvas, VIDEO_FOCUS_TEXTURE_MAX_DIMENSION);
    if (!raster) return;
    this.options.onTexture({ nodeId: this.nodeId, width: raster.width, height: raster.height, pixels: raster.pixels });
    this.lastUploadedAt = uploadedAt;
  }

  /** 是否已有可呈现的真实帧（`readyState >= HAVE_CURRENT_DATA` 且不在 seek 中）。 */
  private canPresentFrame(): boolean {
    const video = this.video as unknown as { seeking?: boolean; readyState?: number };
    if (video.seeking === true) return false;
    if (video.readyState !== undefined && video.readyState < 2) return false;
    return true;
  }

  private cancelFrameLoop(): void {
    if (this.frameHandle !== null && typeof this.video.cancelVideoFrameCallback === "function") {
      this.video.cancelVideoFrameCallback(this.frameHandle);
    }
    this.frameHandle = null;
    if (this.fallbackTimer !== null) { globalThis.clearTimeout?.(this.fallbackTimer); this.fallbackTimer = null; }
  }

  /** 退出会话：暂停、撤销回调、移除媒体源、清投影/纹理并恢复进入前视口。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transition.cancel();
    this.animationGeneration += 1;
    this.generation += 1;
    this.cancelFrameLoop();
    this.safePause();
    this.video.removeAttribute?.("src");
    try { this.video.load?.(); } catch { /* 忽略 */ }
    this.options.onTexture(null);
    this.options.setProjection(null);
    this.options.restoreViewport(this.options.savedViewport);
    this.listeners.clear();
  }
}
