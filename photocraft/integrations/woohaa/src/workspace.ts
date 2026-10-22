/**
 * 图片聚焦工作区控制器
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 3.3/3.6/4.3/4.4/5.2/5.6；
 *   change: 2026-10-16-integrate-photocraft-image-editing 删掉旧标注编辑器后只保留聚焦与工程两条职责）。
 *
 * 拥有一次图片聚焦会话：进入时解析稳定原图、加载原图并驱动瞬时投影；退出时恢复进入前视口。
 * 内容编辑与净变化不再由本控制器持有：界面是 React 编辑器的，内容状态由 `ProjectSession`
 * 与内核承载。
 *
 * DOM 无关部分（取景、原图加载、历史只读预览）与 React 组件分离，便于测试。
 */
import {
  buildCanvasRenderScene,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import { createImageFocusLoader, type LoadedImage } from "./loader.js";
import type { EditorPreview } from "@woohaa3/photocraft-editor";
import type { ImageFocusViewport } from "./focus-session.js";
import { ImageFocusSession } from "./focus-session.js";
import type { ProjectSession } from "./project-session.js";
import type { EditorDocumentView } from "./document-view.js";
import { nodeImageRect, overviewImageView, createLocalTransitionRunner, interpolateViewport, type FocusTransitionPort } from "@woohaa3/frontend/plugin-api";
import { fitZoomFor, type SurfaceRect } from "@woohaa3/photocraft-editor";

export type WorkspaceRect = SurfaceRect;

export { resolveImageFocusTarget } from "./workspace-target.js";
export type { ImageFocusTarget } from "./workspace-target.js";
import { workspaceDisplayAsset, workspaceProject, readAssetDimension, type ImageFocusTarget } from "./workspace-target.js";

export type ImageWorkspaceListener = () => void;

export type ImageWorkspaceOptions = {
  nodeId: string;
  target: ImageFocusTarget;
  getCanvas?: () => ServerCanvas | null;
  /** 可用内容矩形（CSS px）；缺省按视口测量。 */
  rect: WorkspaceRect;
  /** 推入/清除瞬时图片聚焦投影。 */
  setProjection: (projection: import("@woohaa3/contracts").BevyImageFocus | null) => void;
  /** 进入前本地视口（退出恢复）。 */
  savedViewport: { x: number; y: number; zoom: number };
  /** 退出时恢复进入前视口。 */
  restoreViewport: (viewport: { x: number; y: number; zoom: number }) => void;
  transitionDuration?: number;
  onTexture?: (image: LoadedImage | EditorPreview | null) => void;
  onDetails?:(frame:import("@woohaa3/photocraft-editor").DetailFrame|null)=>void;
  /** 解码实现（测试注入）。 */
  decode?: (url: string) => Promise<{ bitmap: CanvasImageSource; width: number; height: number } | null>;
  /**
   * 公共取景过渡端口（Canvas Runtime scope 的 coordinator；design D6/D7）。
   * 缺省使用最小等价本地实现；feature MUST NOT 自带独立计时器。
   */
  transition?: FocusTransitionPort;
  /**
   * 复用既有工程会话（独立文件成功发布为节点时保留其撤销、基线与保存身份）
   * （change: 2026-10-21-add-photocraft-document-workspace，design D5）。
   */
  project?: ProjectSession;
  /**
   * 覆盖基底资产（发布后的节点以自己的输出资产为底，
   * change: 2026-10-21-add-photocraft-document-workspace，design D5）。
   */
  baseAsset?: StoredAsset;
  /** 内容替换/释放后是否恢复进入前视口（文件原位绑定节点时不恢复）。 */
  restoreViewportOnDispose?: boolean;
};

export class ImageFocusWorkspace implements EditorDocumentView {
  readonly nodeId: string;
  /** 编辑手势、进入/退出动画与图片呈现共用的取景与源尺寸。 */
  readonly focus: ImageFocusSession;
  /** 工程会话（task 3.2/3.3）：内容、净变化与只读/失败原因都由它承载。 */
  project: ProjectSession;
  private target: ImageFocusTarget;
  private displayAsset: StoredAsset;
  private readonly options: ImageWorkspaceOptions;
  private readonly listeners = new Set<ImageWorkspaceListener>();
  private readonly loader: ReturnType<typeof createImageFocusLoader>;
  private rect: WorkspaceRect;
  private loaded: LoadedImage | null = null;
  private editorPreview: EditorPreview | null = null;
  private editorSize: { width: number; height: number } | null = null;
  /** 是否已用已知来源尺寸（元数据/卡片）建立并启动了进入过渡（原图后台解码升级）。 */
  private seeded = false;
  /** 首次发布前必须同时建立源尺寸与节点原位取景。 */
  private projectionReady = false;
  private loadError: string | null = null;
  private disposed = false;
  private transitioning = false;
  private enteringProgress: number | null = null;
  private presentationReady = false;
  private animationGeneration = 0;
  private readonly transition: FocusTransitionPort;
  private worldRect: SurfaceRect | null = null;
  private directView: import("./focus-session.js").ImageFocusViewport | null = null;
  private layoutAnchor: {rect:WorkspaceRect;view:ImageFocusViewport} | null = null;
  private historyGeneration = 0;
  private historyPending = false;
  private historyError: string | null = null;
  private historyImage: LoadedImage | null = null;
  private readonly historyLoader: ReturnType<typeof createImageFocusLoader>;
  /** 单调递增变更版本：供 React overlay 用 useSyncExternalStore 在任意 emit 后重排。 */
  private revision = 0;
  private contentRevision = 0;
  /** 只读历史预览 override（任务 8.3/8.4）。 */
  private historyOverride: { url: string } | null = null;

  constructor(options: ImageWorkspaceOptions) {
    this.options = options;
    this.nodeId = options.nodeId;
    this.target = options.target;
    // 入场始终沿用节点当前输出；稳定原图只作为工程打开/转换的来源。
    this.displayAsset = workspaceDisplayAsset(options.target);
    this.rect = options.rect;
    // 原图与工程内容都按当前画布路由；历史预览 URL 自带画布归属，不需要提示。
    this.loader = createImageFocusLoader({ ...(options.decode ? { decode: options.decode } : {}), canvasId: options.target.canvas.id });
    this.historyLoader = createImageFocusLoader(options.decode ? { decode: options.decode } : {});
    this.transition = options.transition ?? createLocalTransitionRunner();
    // 取景会话以稳定原图 identity 创建；无原图（不可编辑）时以当前输出 identity 占位。
    this.focus = new ImageFocusSession({
      nodeId: options.nodeId,
      baseAssetId: options.target.edit ? options.target.edit.baseAssetId : options.target.asset.id,
      baseStorageKey: typeof options.target.asset.metadata?.storageKey === "string" ? options.target.asset.metadata.storageKey : "",
      sourceWidth: readAssetDimension(this.displayAsset, "width") ?? options.target.project?.sourceWidth ?? options.target.edit?.sourceWidth ?? 0,
      sourceHeight: readAssetDimension(this.displayAsset, "height") ?? options.target.project?.sourceHeight ?? options.target.edit?.sourceHeight ?? 0
    });
    this.project = options.project ?? workspaceProject(options.target);
  }

  subscribe = (listener: ImageWorkspaceListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit = (): void => {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  };

  /** 当前变更版本（React overlay 的 useSyncExternalStore 快照；每次 emit 递增）。 */
  revisionState(): number {
    return this.revision;
  }

  /** 加载当前输出并初始化取景/投影。返回是否成功。 */
  async start(): Promise<boolean> {
    const contentRevision = this.contentRevision;
    const asset = this.displayAsset;
    // 已有卡片纹理 + 已知来源尺寸（元数据）时：立即用既有纹理建立首帧并启动公共过渡，
    // 原图解码在后台升级采样质量（design D8/D9，任务 4.3）。decode 完成不再是动画启动条件。
    const seeded = this.seedFromKnownSize();
    const result = await this.loader.load(asset, this.nodeId);
    if (this.disposed || contentRevision !== this.contentRevision) return false;
    if (!result.ok) {
      if (result.code === "stale") return false;
      this.loadError = result.message;
      if (!seeded) this.presentationReady = true;
      this.emit();
      // 已有合法卡片表现时保留查看，不因原图失败撤销进入（design D8）。
      return seeded;
    }
    this.loaded = result.value;
    // 以解码得到的真实尺寸校正取景会话（首次进入无 imageEdit 时）。
    const { width: sourceWidth, height: sourceHeight } = this.displaySize();
    this.focus.adoptSourceSize(sourceWidth, sourceHeight);
    // 超出内核资源上限的图片由内核在打开时明确拒绝（错误回到面板显示），这里不再自建只读态。
    const fit = fitZoomFor(sourceWidth, sourceHeight, this.rect);
    const beforeDecode = this.focus.viewportState();
    this.focus.setFitZoom(fit);
    const destination = { x: 0, y: 0, zoom: fit };
    if (seeded) this.focus.setViewport(beforeDecode);
    const scene = buildCanvasRenderScene({ canvas: this.target.canvas });
    const node = scene.nodes.find(node => node.id === this.nodeId);
    if (node) this.worldRect = nodeImageRect(node, sourceWidth, sourceHeight);
    if (!seeded && !this.historyOverride && this.worldRect) {
      this.focus.setViewport(overviewImageView(this.worldRect, sourceWidth, this.rect, this.options.savedViewport));
      this.transitioning = true;
    } else if (!seeded && !this.historyOverride) {
      this.presentationReady = true;
    }
    // 先发布合法取景，再升级纹理。编辑预览可能比原图解码更早到达，不能先暴露 fit 终点。
    this.projectionReady = true;
    this.pushProjection();
    this.options.onTexture?.(this.historyImage ?? this.editorPreview ?? this.loaded);
    if (!seeded && !this.historyOverride && this.worldRect) void this.animateTo(destination, true);
    return true;
  }

  /**
   * 用已知来源尺寸（资产元数据）立即建立进入首帧并启动公共过渡（design D8/D9，任务 4.3）。
   *
   * 返回是否已成功起跑（无可用尺寸或卡片锚点时返回 false，回落到等待解码）。首帧与卡片像素
   * 对齐，不出现全区不透明加载层；原图/高清纹理之后才替换采样。
   */
  private seedFromKnownSize(): boolean {
    if (this.seeded) return true;
    const width = this.focus.sourceWidth;
    const height = this.focus.sourceHeight;
    if (width <= 0 || height <= 0) return false;
    const scene = buildCanvasRenderScene({ canvas: this.target.canvas });
    const node = scene.nodes.find(candidate => candidate.id === this.nodeId);
    if (!node) return false;
    this.worldRect = nodeImageRect(node, width, height);
    const fit = fitZoomFor(width, height, this.rect);
    this.focus.setFitZoom(fit);
    this.focus.setViewport(overviewImageView(this.worldRect, width, this.rect, this.options.savedViewport));
    this.seeded = true;
    this.projectionReady = true;
    this.transitioning = true;
    this.pushProjection();
    void this.animateTo({ x: 0, y: 0, zoom: fit }, true);
    return true;
  }

  /** 恢复版本后替换编辑内容；保留同一聚焦取景，不重新播放进入动画。 */
  async replaceContent(target: ImageFocusTarget): Promise<void> {
    if (this.disposed || target.nodeId !== this.nodeId) return;
    const view = this.directView ?? this.focus.viewportState();
    this.transition.cancel();
    this.animationGeneration += 1;
    this.transitioning = false;
    this.presentationReady = true;
    this.projectionReady = true;
    this.layoutAnchor = null;
    this.historyGeneration += 1;
    this.historyLoader.release();
    this.historyOverride = null;
    this.historyImage = null;
    this.historyPending = false;
    this.historyError = null;
    this.directView = null;
    this.editorPreview = null;
    this.editorSize = null;
    this.loaded = null;
    this.loadError = null;
    this.loader.release();
    this.options.onDetails?.(null);
    this.target = target;
    this.displayAsset = workspaceDisplayAsset(target);
    this.project = workspaceProject(target);
    const contentRevision = ++this.contentRevision;
    this.focus.adoptSourceSize(
      readAssetDimension(this.displayAsset, "width") ?? target.project?.canvasWidth ?? target.edit?.sourceWidth ?? this.focus.sourceWidth,
      readAssetDimension(this.displayAsset, "height") ?? target.project?.canvasHeight ?? target.edit?.sourceHeight ?? this.focus.sourceHeight);
    this.focus.setFitZoom(fitZoomFor(this.focus.sourceWidth, this.focus.sourceHeight, this.rect));
    this.focus.setViewport(view);
    this.pushProjection();
    const result = await this.loader.load(this.displayAsset, this.nodeId);
    if (this.disposed || contentRevision !== this.contentRevision) return;
    if (!result.ok) {
      this.loadError = result.message;
      this.emit();
      return;
    }
    this.loaded = result.value;
    if (!this.editorPreview) this.focus.adoptSourceSize(result.value.width, result.value.height);
    if (!this.historyOverride) {
      const viewport = this.focus.viewportState();
      const size = this.displaySize();
      this.focus.setFitZoom(fitZoomFor(size.width, size.height, this.rect));
      this.focus.setViewport(viewport);
      this.options.onTexture?.(this.editorPreview ?? this.loaded);
      this.pushProjection();
    }
  }

  /** 只有内容替换才重开编辑内核；取景及历史预览不改变此版本。 */
  contentRevisionState(): number { return this.contentRevision; }

  /** 更新可用内容矩形（面板 resize / 历史展开）。 */
  setRect(rect: WorkspaceRect): void {
    const anchor=this.layoutAnchor;
    this.layoutAnchor=null;
    this.rect = rect;
    const size = this.displaySize();
    if (size.width > 0 && size.height > 0) {
      const view = this.focus.viewportState();
      const fitted = Math.abs(view.zoom - this.focus.currentFitZoom()) < 1e-6;
      this.focus.setFitZoom(fitZoomFor(size.width, size.height, rect));
      if (anchor) this.focus.setViewport({...anchor.view,
        x:anchor.view.x+anchor.rect.x+anchor.rect.width/2-rect.x-rect.width/2,
        y:anchor.view.y+anchor.rect.y+anchor.rect.height/2-rect.y-rect.height/2});
      else if (this.transitioning && this.enteringProgress === 0 && this.worldRect) {
        // 布局先于首个动画回调落地时，立即把起点换算到新内容区域，避免一帧偏移。
        this.focus.setViewport(overviewImageView(this.worldRect, size.width, rect, this.options.savedViewport));
      } else if (!fitted || this.transitioning) this.focus.setViewport(view);
    }
    this.pushProjection();
    this.emit();
  }

  rectState(): WorkspaceRect {
    return { ...this.rect };
  }

  /** 面板显隐只改变可用区域；补偿中心变化，维持图片屏幕位置与缩放。 */
  preserveNextLayoutViewport():void {
    if (this.disposed || this.transitioning) return;
    this.layoutAnchor ??= {rect:{...this.rect},view:this.focus.viewportState()};
  }

  loadedImage(): LoadedImage | null {
    return this.loaded;
  }

  /** 编辑与聚焦动画共用这一份取景；过渡中不接受编辑手势。 */
  setViewport(viewport: ImageFocusViewport): void {
    if (this.disposed || this.transitioning || ![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) || viewport.zoom <= 0) return;
    this.layoutAnchor=null;
    this.focus.setViewport(viewport);
    this.pushProjection();
  }

  /** 编辑结果只更新原节点纹理，不创建另一张图片或重置进入动画。 */
  setEditorPreview(preview: EditorPreview | null, size?: { width: number; height: number }): void {
    if (this.disposed) return;
    const previous = this.displaySize();
    this.editorPreview = preview;
    this.editorSize = preview && size ? size : null;
    if (this.historyOverride) return;
    // 先到的编辑预览只缓存；等待入场原位取景，避免提前显示最终位置一帧。
    if (!this.projectionReady) return;
    const current = this.displaySize();
    if (current.width !== previous.width || current.height !== previous.height) {
      const viewport = this.focus.viewportState();
      const fitted = Math.abs(viewport.zoom - this.focus.currentFitZoom()) < 1e-6;
      this.focus.setFitZoom(fitZoomFor(current.width, current.height, this.rect));
      if (!fitted || this.transitioning) this.focus.setViewport(viewport);
    }
    this.options.onTexture?.(preview ?? this.loaded);
    this.pushProjection();
  }

  setEditorDetails(frame:import("@woohaa3/photocraft-editor").DetailFrame|null):void {
    this.options.onDetails?.(!this.disposed && this.projectionReady && !this.transitioning && !this.historyOverride?frame:null);
  }

  detailViewportSize():{width:number;height:number} {return {width:this.rect.width,height:this.rect.height};}

  /** 进入本次聚焦时的工程定义（无工程时为 null）。 */
  projectDocument(): import("@woohaa3/contracts").ImageProjectDocument | null {
    return this.target.project;
  }

  /** 当前图片的基底资产（工程/标注/纯媒体共用）。 */
  baseAsset(): unknown {
    return this.target.asset;
  }

  /**
   * 安装/清除只读历史预览 override
   * （change: 图片聚焦编辑，任务 8.3/8.4 / design D8）。
   *
   * 选择旧版本时在同一工作区安装该条目的只读媒体（不解码为可编辑原图）；点击首项清除，
   * 恢复当前草稿。override 活动时禁用写工具。
   */
  setHistoryOverride(override: { url: string } | null): void {
    this.options.onDetails?.(null);
    this.transition.cancel();
    this.animationGeneration += 1;
    this.transitioning = false;
    this.historyOverride = override;
    this.historyPending = override !== null;
    this.historyError = null;
    const generation = ++this.historyGeneration;
    if (!override) {
      this.historyLoader.release();
      this.historyImage = null;
      const direct = this.directView ?? this.focus.viewportState();
      const size = this.displaySize();
      this.focus.setFitZoom(fitZoomFor(size.width, size.height, this.rect));
      this.focus.setViewport(direct);
      this.directView = null;
      this.options.onTexture?.(this.editorPreview ?? this.loaded);
      this.pushProjection();
      this.emit();
      return;
    }
    if (!this.directView) this.directView = this.focus.viewportState();
    this.emit();
    void this.historyLoader.loadHistoryPreview(override.url, override.url).then(result => {
      if (this.disposed || generation !== this.historyGeneration) return;
      this.historyPending = false;
      if (!result.ok) { this.historyError = result.message; this.emit(); return; }
      this.historyImage = result.value;
      this.focus.setViewport({ x: 0, y: 0, zoom: fitZoomFor(result.value.width, result.value.height, this.rect) });
      this.options.onTexture?.(result.value);
      this.pushProjection();
    });
  }

  previewStatus(): string | null {
    if (!this.loaded) return this.loadError ?? "正在加载图片…";
    return this.historyPending ? "正在加载历史版本…" : this.historyError;
  }

  displaySize(): { width: number; height: number } {
    const image = this.historyImage ?? this.editorSize ?? this.loaded;
    return { width: image?.width ?? this.focus.sourceWidth, height: image?.height ?? this.focus.sourceHeight };
  }
  isTransitioning(): boolean { return this.transitioning; }
  /** 工具界面只在进入动画完成后显示；内核与布局可提前准备。 */
  isPresentationReady(): boolean { return this.presentationReady; }
  private duration(): number {
    return this.options.transitionDuration ?? (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420);
  }
  private async animateTo(destination: ImageFocusViewport, fitDestination = false): Promise<void> {
    this.options.onDetails?.(null);
    const generation = ++this.animationGeneration;
    this.transitioning = true;
    this.enteringProgress = fitDestination ? 0 : null;
    const completed = await this.transition.run({
      key: this.nodeId,
      from: this.focus.viewportState(),
      to: destination,
      duration: this.duration() / 2,
      apply: (view, progress) => {
        this.enteringProgress = fitDestination ? progress : null;
        // 布局可晚于进入首帧到达；仍从原节点插值到最新内容矩形，不另起动画。
        const next = fitDestination && this.worldRect
          ? interpolateViewport(
              overviewImageView(this.worldRect, this.displaySize().width, this.rect, this.options.savedViewport),
              { ...destination, zoom: this.focus.currentFitZoom() }, progress)
          : view;
        this.focus.setViewport(next);
        this.pushProjection();
      }
    });
    if (!this.disposed && generation === this.animationGeneration) {
      this.enteringProgress = null;
      this.transitioning = false;
      if (completed && fitDestination) this.presentationReady = true;
      this.pushProjection();
    }
  }
  async animateExit(): Promise<void> {
    if (this.disposed || !this.loaded || !this.worldRect) return;
    if (this.historyOverride) this.setHistoryOverride(null);
    const canvas = this.options.getCanvas?.();
    if (canvas) {
      const node = buildCanvasRenderScene({ canvas }).nodes.find(node => node.id === this.nodeId);
      if (node) this.worldRect = nodeImageRect(node, this.displaySize().width, this.displaySize().height);
    }
    await this.animateTo(overviewImageView(this.worldRect, this.displaySize().width, this.rect, this.options.savedViewport));
  }

  historyOverrideState(): { url: string } | null {
    return this.historyOverride;
  }

  /** 是否处于只读历史预览（禁用写工具）。 */
  isReadOnlyPreview(): boolean {
    return this.historyOverride !== null;
  }

  loadErrorMessage(): string | null {
    return this.loadError;
  }

  /** 推入当前瞬时投影（供 Bevy 取景/可见性）。 */
  pushProjection(): void {
    if (!this.projectionReady) return;
    const { width, height } = this.displaySize();
    if (width <= 0 || height <= 0) {
      this.options.setProjection(null);
      return;
    }
    this.options.setProjection({
      version: "woohaa-image-focus-v1",
      nodeId: this.nodeId,
      presentationReady: this.presentationReady,
      viewport: this.focus.viewportState(),
      sourceWidth: width,
      sourceHeight: height
    });
    this.emit();
  }

  /** 退出会话：释放原图与投影并恢复进入前视口（不动内容，保存由调用方编排）。 */
  dispose(): void {
    this.options.onDetails?.(null);
    if (this.disposed) return;
    this.disposed = true;
    this.transition.cancel();
    this.historyGeneration += 1;
    this.historyLoader.release();
    this.loader.release();
    this.options.onTexture?.(null);
    this.loaded = null;
    this.editorPreview = null;
    this.editorSize = null;
    this.options.setProjection(null);
    this.options.restoreViewport(this.options.savedViewport);
    this.listeners.clear();
  }
}
