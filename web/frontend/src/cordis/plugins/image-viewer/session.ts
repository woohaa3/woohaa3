import { releaseImagePixels } from "../canvas-runtime/image-worker/native-port.js";
/**
 * 图片聚焦查看会话（宿主默认查看器）
 * （change: default-image-focus-viewer）。
 *
 * 图片编辑器扩展缺席时的**只读**原地聚焦：解码原图、按可用内容矩形取景、把同源帧上传为
 * 聚焦纹理并推入 `woohaa-image-focus-v1` 投影。它只持有浏览器本地呈现态，不创建作品版本、
 * 不写 nodeData/Y.Doc，也不加载任何编辑内核。
 *
 * 与视频聚焦同构：进入/退出复用公共 `overviewImageView` + `FocusTransitionPort`（同一时间源），
 * 自动解码失败保留可读错误而不是黑屏。
 */
import { buildCanvasRenderScene, type ServerCanvas } from "@woohaa3/contracts";
import { rasterizeDrawable, defaultRasterCanvasFactory, type RasterCanvasFactory } from "../canvas-runtime/media-raster.js";
import { prepareImageResource } from "../canvas-runtime/image-worker/client.js";
import {
  nodeImageRect,
  overviewImageView,
  type FocusTransitionPort,
  type FocusViewport,
  type SurfaceRect
} from "../../focus/media-transition.js";
import type { FocusContentRect, FocusViewportTarget } from "../../focus/types.js";
import { resolveImageFocusTarget, type ImageFocusTarget } from "../../focus/image-focus-target.js";

/** 聚焦纹理最长边（与图片编辑一致：高于卡片 1024，兼顾高 DPR 与上传成本）。 */
export const IMAGE_VIEWER_TEXTURE_MAX_DIMENSION = 2048;
/** 手动缩放区间（与图片聚焦规格一致的可用范围）。 */
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 12;

export type ImageViewerRuntimePort = {
  /** 推入/清除图片聚焦投影。 */
  setProjection: (projection: import("@woohaa3/contracts").BevyImageFocus | null) => void;
  /** 推入/清除聚焦纹理（同源帧）。 */
  setTexture: (texture: { nodeId: string; width: number; height: number; pixels: import("@woohaa3/contracts").ImagePixelSource } | null) => void;
  /** 编辑器尚未接管画面（加载中）：画布滚轮按普通画布处理。 */
  setPending: (pending: boolean) => void;
};

export type ImageViewerSessionOptions = {
  nodeId: string;
  target: ImageFocusTarget;
  getCanvas: () => ServerCanvas | null;
  /** 当前可用内容矩形（公共聚焦布局投影）；缺省时退回画布表面。 */
  rect: () => FocusContentRect;
  /** 进入前本地视口（退出动画锚点）。 */
  savedViewport: FocusViewport;
  transition: FocusTransitionPort;
  runtime: ImageViewerRuntimePort;
  decode?: (url: string) => Promise<{ width: number; height: number; drawable: CanvasImageSource }>;
  createCanvas?: RasterCanvasFactory;
  /** 进入/退出过渡时长（毫秒）；缺省尊重 `prefers-reduced-motion`。 */
  transitionDuration?: number;
};

export type ImageViewerState = {
  nodeId: string;
  loading: boolean;
  error: string | null;
  width: number;
  height: number;
  viewport: FocusViewport;
  /** 是否已按内容矩形适应窗口（100% 之后为 false）。 */
  fitted: boolean;
};

/** 适应窗口缩放：1 源像素 = zoom CSS px。 */
export function fitZoomFor(sourceWidth: number, sourceHeight: number, rect: { width: number; height: number }): number {
  if (sourceWidth <= 0 || sourceHeight <= 0 || rect.width <= 0 || rect.height <= 0) return 1;
  return clampZoom(Math.min(rect.width / sourceWidth, rect.height / sourceHeight));
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
}


export class ImageViewerSession {
  readonly nodeId: string;
  private readonly options: ImageViewerSessionOptions;
  private readonly decode: ImageViewerSessionOptions["decode"];
  private readonly createCanvas: RasterCanvasFactory;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private generation = 0;
  private disposed = false;
  private decodeAbort?: AbortController;
  private width = 0;
  private height = 0;
  private viewport: FocusViewport = { x: 0, y: 0, zoom: 1 };
  private loading = true;
  private error: string | null = null;
  private entered = false;
  private transitioning = false;
  private animationGeneration = 0;
  /** 内容矩形变化时用于重排进入动画终点。 */
  private enterDestination: FocusViewport | null = null;
  private worldRect: SurfaceRect | null = null;
  private historyUrl: string | null = null;
  private currentTarget: ImageFocusTarget;

  constructor(options: ImageViewerSessionOptions) {
    this.options = options;
    this.nodeId = options.nodeId;
    this.currentTarget = options.target;
    this.decode = options.decode;
    this.createCanvas = options.createCanvas ?? defaultRasterCanvasFactory;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private emit(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
  revisionState(): number { return this.revision; }

  state(): ImageViewerState {
    return {
      nodeId: this.nodeId,
      loading: this.loading,
      error: this.error,
      width: this.width,
      height: this.height,
      viewport: { ...this.viewport },
      fitted: this.enterDestination !== null && Math.abs(this.viewport.zoom - this.enterDestination.zoom) < 1e-6
    };
  }

  viewportState(): FocusViewport { return { ...this.viewport }; }
  rectState(): FocusContentRect { return this.options.rect(); }

  /** 画布输入用的取景目标：只写本地取景，不触发内容变更。 */
  viewportTarget(): FocusViewportTarget {
    return {
      read: () => ({ viewport: { ...this.viewport }, rect: this.options.rect() }),
      write: (viewport) => this.setViewport(viewport)
    };
  }

  /** 进入：解码原图 → 上传聚焦纹理 → 从节点卡片位置推进到适应窗口。 */
  async start(): Promise<void> {
    const generation = ++this.generation;
    this.decodeAbort?.abort();
    this.decodeAbort = new AbortController();
    this.options.runtime.setPending(true);
    let decoded: { width: number; height: number; drawable?: CanvasImageSource };
    let prepared: Awaited<ReturnType<typeof prepareImageResource>> | undefined;
    try {
      if (this.decode) decoded = await this.decode(this.currentTarget.url);
      else {
        prepared = await prepareImageResource(this.currentTarget.url, IMAGE_VIEWER_TEXTURE_MAX_DIMENSION, this.decodeAbort.signal);
        decoded = { width: prepared.sourceWidth, height: prepared.sourceHeight };
      }
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.loading = false;
      this.error = error instanceof Error && error.message !== "" ? error.message : "图片加载失败";
      this.options.runtime.setPending(false);
      this.emit();
      return;
    }
    if (!this.isCurrent(generation)) { releaseImagePixels(prepared?.pixels); return; }
    this.width = decoded.width;
    this.height = decoded.height;
    const raster = prepared ?? rasterizeDrawable(decoded.drawable, { width: this.width, height: this.height }, this.createCanvas, IMAGE_VIEWER_TEXTURE_MAX_DIMENSION);
    if (raster) {
      this.options.runtime.setTexture({ nodeId: this.nodeId, width: raster.width, height: raster.height, pixels: raster.pixels });
    }
    this.loading = false;
    this.entered = true;
    this.options.runtime.setPending(false);
    await this.animateEnter();
    if (!this.isCurrent(generation)) return;
    this.emit();
  }

  /** 当前显示源的节点内容矩形（进入/退出动画的像素锚点）。 */
  private refreshWorldRect(): void {
    const canvas = this.options.getCanvas();
    if (!canvas) return;
    // 与渲染同一份节点几何（分组父级偏移、有效尺寸都已在 Render Scene 解析）。
    const node = buildCanvasRenderScene({ canvas }).nodes.find((entry) => entry.id === this.nodeId);
    if (node) this.worldRect = nodeImageRect(node, this.width, this.height);
  }

  private async animateEnter(): Promise<void> {
    const destination = { x: 0, y: 0, zoom: fitZoomFor(this.width, this.height, this.options.rect()) };
    this.refreshWorldRect();
    const start = this.worldRect
      ? overviewImageView(this.worldRect, this.width, this.options.rect(), this.options.savedViewport)
      : null;
    if (!start) {
      this.viewport = destination;
      this.enterDestination = destination;
      this.pushProjection();
      this.emit();
      return;
    }
    this.viewport = start;
    this.pushProjection();
    this.enterDestination = destination;
    await this.animateTo(destination);
  }

  private async animateTo(destination: FocusViewport): Promise<void> {
    const generation = ++this.animationGeneration;
    this.transitioning = true;
    await this.options.transition.run({
      key: this.nodeId,
      from: this.viewport,
      to: destination,
      duration: this.duration(),
      apply: (view) => {
        if (this.disposed || generation !== this.animationGeneration) return;
        this.viewport = { x: view.x, y: view.y, zoom: view.zoom };
        this.pushProjection();
        this.emit();
      }
    });
    if (!this.disposed && generation === this.animationGeneration) this.transitioning = false;
  }

  /** 退出前取景动画：缩回节点卡片位置；随后由 `dispose` 清投影。 */
  async animateExit(): Promise<void> {
    if (this.disposed || !this.entered || this.width <= 0) return;
    this.refreshWorldRect();
    if (!this.worldRect) return;
    await this.animateTo(overviewImageView(this.worldRect, this.width, this.options.rect(), this.options.savedViewport));
  }

  /** 内容矩形变化（历史 drawer 打开/窗口 resize）：过渡中重排终点，否则重新适应窗口。 */
  setRect(): void {
    // 尚未解码出源尺寸时没有可算的适应值：start() 会用届时最新的 rect 取景。
    if (!this.entered || this.disposed) return;
    if (this.transitioning) {
      const destination = { x: 0, y: 0, zoom: fitZoomFor(this.width, this.height, this.options.rect()) };
      if (this.enterDestination && Math.abs(this.enterDestination.zoom - destination.zoom) < 1e-6) return;
      this.enterDestination = destination;
      void this.animateTo(destination);
      return;
    }
    this.viewport = { x: 0, y: 0, zoom: fitZoomFor(this.width, this.height, this.options.rect()) };
    this.enterDestination = { ...this.viewport };
    this.pushProjection();
    this.emit();
  }

  setViewport(viewport: FocusViewport): void {
    this.viewport = { x: viewport.x, y: viewport.y, zoom: clampZoom(viewport.zoom) };
    this.pushProjection();
    this.emit();
  }
  panBy(dx: number, dy: number): void {
    this.setViewport({ x: this.viewport.x + dx, y: this.viewport.y + dy, zoom: this.viewport.zoom });
  }
  zoomAround(factor: number): void {
    this.setViewport({ x: this.viewport.x, y: this.viewport.y, zoom: this.viewport.zoom * factor });
  }
  /** 100%：1 源像素 = 1 CSS px。 */
  actualSize(): void { this.setViewport({ x: 0, y: 0, zoom: 1 }); }
  fitWindow(): void { this.setViewport({ x: 0, y: 0, zoom: fitZoomFor(this.width, this.height, this.options.rect()) }); }

  /** canonical 输出变化（远端回流/重新生成）：重新解析来源，地址变了才重开。 */
  refreshFromCanonical(): void {
    if (this.historyUrl !== null) return;
    const canvas = this.options.getCanvas();
    const next = resolveImageFocusTarget(canvas, this.nodeId);
    if (!next || next.url === this.currentTarget.url) return;
    this.currentTarget = next;
    void this.start();
  }

  /** 当前是否在只读历史预览（旧版本）。 */
  isHistory(): boolean { return this.historyUrl !== null; }

  /**
   * 安装/清除只读历史预览（历史面板选择旧版本）。
   *
   * 只换呈现来源，保留当前取景；清除时回到 canonical 来源。查看历史不创建版本，也不写
   * nodeData（change: default-image-focus-viewer：编辑器缺席时历史预览同样要有画面）。
   */
  setHistoryOverride(override: { url: string } | null): void {
    if (override === null) {
      if (this.historyUrl === null) return;
      this.historyUrl = null;
      void this.loadFrom(this.currentTarget.url, false);
      return;
    }
    if (this.historyUrl === override.url) return;
    this.historyUrl = override.url;
    void this.loadFrom(override.url, true);
  }

  /** 按给定地址重新解码并上传纹理；`keepViewport` 用于历史切换（保留用户当前取景）。 */
  private async loadFrom(url: string, keepViewport: boolean): Promise<void> {
    const generation = ++this.generation;
    this.decodeAbort?.abort();
    this.decodeAbort = new AbortController();
    this.loading = true;
    this.error = null;
    this.emit();
    let decoded: { width: number; height: number; drawable?: CanvasImageSource };
    let prepared: Awaited<ReturnType<typeof prepareImageResource>> | undefined;
    try {
      if (this.decode) decoded = await this.decode(url);
      else {
        prepared = await prepareImageResource(url, IMAGE_VIEWER_TEXTURE_MAX_DIMENSION, this.decodeAbort.signal);
        decoded = { width: prepared.sourceWidth, height: prepared.sourceHeight };
      }
    } catch (failure) {
      if (!this.isCurrent(generation)) return;
      this.loading = false;
      this.error = failure instanceof Error && failure.message !== "" ? failure.message : "图片加载失败";
      this.emit();
      return;
    }
    if (!this.isCurrent(generation)) { releaseImagePixels(prepared?.pixels); return; }
    this.width = decoded.width;
    this.height = decoded.height;
    const raster = prepared ?? rasterizeDrawable(decoded.drawable, { width: this.width, height: this.height }, this.createCanvas, IMAGE_VIEWER_TEXTURE_MAX_DIMENSION);
    if (raster) {
      this.options.runtime.setTexture({ nodeId: this.nodeId, width: raster.width, height: raster.height, pixels: raster.pixels });
    }
    this.loading = false;
    if (!keepViewport) {
      this.viewport = { x: 0, y: 0, zoom: fitZoomFor(this.width, this.height, this.options.rect()) };
    }
    this.pushProjection();
    this.emit();
  }

  private duration(): number {
    if (this.options.transitionDuration !== undefined) return this.options.transitionDuration;
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420;
  }

  private pushProjection(): void {
    if (this.disposed || !this.entered || this.width <= 0 || this.height <= 0) return;
    this.options.runtime.setProjection({
      version: "woohaa-image-focus-v1",
      nodeId: this.nodeId,
      presentationReady: true,
      viewport: { ...this.viewport },
      sourceWidth: this.width,
      sourceHeight: this.height
    });
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  /** 退出：取消过渡、丢纹理与投影、恢复 pending 默认（不写规范状态）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.decodeAbort?.abort();
    this.generation += 1;
    this.options.transition.cancel();
    this.animationGeneration += 1;
    this.options.runtime.setTexture(null);
    this.options.runtime.setProjection(null);
    this.options.runtime.setPending(false);
    this.listeners.clear();
  }
}
