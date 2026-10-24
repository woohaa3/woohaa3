/**
 * 独立文件文档呈现（宿主适配层，无 DOM）
 * （change: 2026-10-21-add-photocraft-document-workspace，design D1/D3/D4）。
 *
 * 独立文件没有画布节点身份：本类只持有文档自身的内容来源、取景与预览发布，**不**推入 Bevy
 * 节点投影、不伪造 nodeId、不操纵底层画布。呈现由编辑 feature 的不透明背景层经
 * `renderCanvasBackground` 画出（透明像素由 CSS 棋盘格承接），因此同一份编辑器界面可以
 * 同时服务节点文档与文件文档。
 *
 * 内容编辑、撤销与净变化仍由内核与 `ProjectSession` 承载；本类只是文件文档的呈现会话。
 */
import type { EditorPreview, DetailFrame } from "@woohaa3/photocraft-editor";
import { fitZoomFor } from "@woohaa3/photocraft-editor";
import type { ImageProjectDocument } from "@woohaa3/contracts";
import type { ImageFocusViewport } from "./focus-session.js";
import { ProjectSession } from "./project-session.js";
import type { DocumentRect, EditorDocumentView } from "./document-view.js";

export type FileDocumentKind = "image" | "project";

export type FileDocumentInput = {
  initiallyUnsaved?:boolean;
  /** 工作区分配的不透明文档 id。 */
  documentId: string;
  fileName: string;
  kind: FileDocumentKind;
  /** 已归一化的图片字节（`image`）或工程字节（`project`）。 */
  bytes: Uint8Array;
  rect: DocumentRect;
  /** 初始取景；缺省按适合窗口。 */
  viewport?: ImageFocusViewport;
  /** 解码图片以获得源尺寸（`image` 来源；测试注入）。 */
  decodeImage?: (bytes: Uint8Array) => Promise<{ width: number; height: number } | null>;
};

/** 取景容器：文件文档不需要节点标识，只持有纯二维取景与源尺寸。 */
class FileFocusView {
  sourceWidth = 0;
  sourceHeight = 0;
  private viewport: ImageFocusViewport = { x: 0, y: 0, zoom: 1 };
  private fitZoom = 1;

  constructor(viewport?: ImageFocusViewport) {
    if (viewport) this.viewport = { ...viewport };
  }

  viewportState(): ImageFocusViewport {
    return { ...this.viewport };
  }

  setViewport(viewport: ImageFocusViewport): void {
    if (![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) || viewport.zoom <= 0) return;
    this.viewport = { ...viewport };
  }

  setFitZoom(fitZoom: number): void {
    const safe = Number.isFinite(fitZoom) && fitZoom > 0 ? fitZoom : 1;
    this.fitZoom = safe;
    this.viewport = { ...this.viewport, zoom: safe };
  }

  currentFitZoom(): number {
    return this.fitZoom;
  }

  adoptSourceSize(width: number, height: number): void {
    if (Number.isFinite(width) && width > 0) this.sourceWidth = width;
    if (Number.isFinite(height) && height > 0) this.sourceHeight = height;
  }
}

/**
 * 一个独立文件文档的呈现会话。
 *
 * 生命周期与 tab 一致：打开时创建、关闭时 `dispose()`。异步解码与预览按 `generation` 隔离，
 * 释放后到达的结果不得写入。
 */
export class FileDocumentWorkspace implements EditorDocumentView {
  readonly documentId: string;
  readonly nodeId = null;
  readonly fileName: string;
  readonly kind: FileDocumentKind;
  readonly focus: FileFocusView;
  readonly project: ProjectSession;

  private rect: DocumentRect;
  private bytes: Uint8Array;
  private preview: EditorPreview | null = null;
  private previewSize: { width: number; height: number } | null = null;
  private details: DetailFrame | null = null;
  private ready = false;
  private error: string | null = null;
  private disposed = false;
  private revision = 0;
  private contentRevision = 0;
  private generation = 0;
  private readonly decodeImage: ((bytes: Uint8Array) => Promise<{ width: number; height: number } | null>) | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(input: FileDocumentInput) {
    this.documentId = input.documentId;
    this.fileName = input.fileName;
    this.kind = input.kind;
    this.bytes = input.bytes;
    this.rect = input.rect;
    this.decodeImage = input.decodeImage;
    this.focus = new FileFocusView(input.viewport);
    if (input.viewport) this.focus.setViewport(input.viewport);
    // 文件文档没有节点身份与旧标注转换：`nodeId` 只是 ProjectSession 的内部标签
    // （它不参与上传、回执或节点写入，见 project-session）。
    this.project = new ProjectSession({
      initiallyUnsaved:input.initiallyUnsaved,
      nodeId: `file-document:${input.documentId}`,
      baseAssetId: `file-asset:${input.documentId}`,
      baseStorageKey: "",
      sourceWidth: 0,
      sourceHeight: 0,
      edit: null
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  revisionState(): number {
    return this.revision;
  }

  contentRevisionState(): number {
    return this.contentRevision;
  }

  isPresentationReady(): boolean {
    return this.ready;
  }

  isTransitioning(): boolean {
    return false;
  }

  isReadOnlyPreview(): boolean {
    return false;
  }

  /** 文件文档没有节点版本历史：永远没有历史 override。 */
  historyOverrideState(): { url: string } | null {
    return null;
  }

  /** 文件文档没有节点版本历史：安装/清除历史 override 都是无操作。 */
  setHistoryOverride(override: { url: string } | null): void {
    void override;
  }

  previewStatus(): string | null {
    return this.error;
  }

  projectDocument(): ImageProjectDocument | null {
    // 独立文件的工程来源就是它自己打开的字节；不伪装成节点携带的工程定义。
    return null;
  }

  baseAsset(): unknown {
    return null;
  }

  /** 原始字节（打开编辑器、保存工程与导出时复用，不重新读取）。 */
  sourceBytes(): Uint8Array {
    return this.bytes;
  }

  /** 当前呈现用的预览（RGBA，同一修订）；未打开内核时为 null。 */
  previewState(): { preview: EditorPreview; width: number; height: number } | null {
    const size = this.previewSize;
    return this.preview && size ? { preview: this.preview, width: size.width, height: size.height } : null;
  }

  detailState(): DetailFrame | null {
    return this.details;
  }

  /**
   * 初始化呈现：图片文件解码得到源尺寸并建立适合窗口取景；工程文件等待内核打开后由
   * `setEditorPreview` 提供尺寸（在此之前显示打开中）。
   */
  async start(): Promise<boolean> {
    const generation = ++this.generation;
    if (this.kind === "project") {
      this.ready = true;
      this.emit();
      return true;
    }
    const decoded = this.decodeImage ? await this.decodeImage(this.bytes).catch(() => null) : null;
    if (this.disposed || generation !== this.generation) return false;
    if (!decoded) {
      this.error = "图片无法读取，请重新打开";
      this.ready = true;
      this.emit();
      return false;
    }
    this.focus.adoptSourceSize(decoded.width, decoded.height);
    this.applyFit();
    this.ready = true;
    this.emit();
    return true;
  }

  setRect(rect: DocumentRect): void {
    this.rect = rect;
    if (this.focus.sourceWidth > 0 && this.focus.sourceHeight > 0) this.applyFit();
    this.emit();
  }

  /** 面板显隐/布局变化时保留当前取景（文件文档没有节点锚点，不需要中心补偿）。 */
  preserveNextLayoutViewport(): void {
    // 文件文档的取景完全属于自己：面板变化只影响可用区域，不移动文档中心。
  }

  setViewport(viewport: ImageFocusViewport): void {
    this.focus.setViewport(viewport);
    this.emit();
  }

  setEditorPreview(preview: EditorPreview | null, size?: { width: number; height: number }): void {
    if (this.disposed) return;
    this.preview = preview;
    if (preview && size) {
      this.previewSize = { width: size.width, height: size.height };
      const changed = this.focus.sourceWidth !== size.width || this.focus.sourceHeight !== size.height;
      this.focus.adoptSourceSize(size.width, size.height);
      if (changed) this.applyFit();
    }
    if (!preview) this.previewSize = null;
    this.emit();
  }

  setEditorDetails(frame: DetailFrame | null): void {
    if (this.disposed) return;
    this.details = frame;
    this.emit();
  }

  detailViewportSize(): { width: number; height: number } {
    return { width: this.rect.width, height: this.rect.height };
  }

  /** 内容被权威替换（例如宿主重新加载工程）：递增内容代际，旧回调作废。 */
  beginContentReplacement(): number {
    this.contentRevision += 1;
    this.preview = null;
    this.previewSize = null;
    this.details = null;
    this.generation += 1;
    this.emit();
    return this.contentRevision;
  }

  displaySize(): { width: number; height: number } {
    return this.previewSize ?? { width: this.focus.sourceWidth, height: this.focus.sourceHeight };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.preview = null;
    this.previewSize = null;
    this.details = null;
    this.listeners.clear();
  }

  private applyFit(): void {
    const { sourceWidth, sourceHeight } = this.focus;
    if (sourceWidth <= 0 || sourceHeight <= 0) return;
    this.focus.setFitZoom(fitZoomFor(sourceWidth, sourceHeight, this.rect));
  }
}
