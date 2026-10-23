import { createFeatureSessions } from "./features/sessions.js";
import type { WorkspaceFeatureContext, VectorDocumentToken } from "./features/workspace-context.js";
import { yieldEditorTask } from "./yield-editor-task.js";
/**
 * React 图像编辑器工作区控制器
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.2/3.4/4.1/4.3 / design D1/D3/D6）。
 *
 * 把「按需加载内核 → 打开图片/工程 → 命令分派 → 冻结导出 → 上传写回」串成一条可测的流程，
 * 与 React 组件分离：
 * - wasm 只在**显式进入编辑**时加载（`loadEditor`）；
 * - React 的所有操作都经过 `dispatch()`，命令白名单由内核复核；
 * - 每次写操作后 `refresh()` 从内核重新取状态与命令表，组件只渲染视图模型；
 * - 冻结导出的成对产物交给 `saveImageProject` 复核摘要并写回；
 * - 保存成功才推进基线；失败保留现场并可重试（design D7）。
 *
 * 控制器不接触 DOM：组件把事件转成方法调用，把视图模型渲染成界面。
 */
import type { PhotocraftCommand, PhotocraftContentState } from "@woohaa3/photocraft-protocol";
import type { TextGeometry, TextGeometryRequest } from "./text-geometry.js";
import { freezeProjectArtifacts, type ArtifactDigest, type ProjectExportArtifacts } from "./editor-artifacts.js";
import { exportCompositionArtifacts, type CompositionExportResult } from "./features/composition/export.js";
import type { EditorAssetPort, EditorEditingOwner, EditorFileDeliveryResult, EditorFilePort } from "./ports.js";
import type { EditorDocumentSession, EditorSaveOutcome, EditorSavePort } from "./session.js";
import {
  loadEditor,
  type EditorFailure,
  type EditorHandle,
  type EditorPreview,
  type EditorPreviewRegion,
  type EditorResult
} from "./editor-wasm.js";
import { decodeEditorState, indexRenderableCommands, type EditorViewModel } from "./editor-view-model.js";
import { BrushLibraryController, type BrushLibraryStorage } from "./brush-library-state.js";

/** React 消费的只读快照。 */
export type EditorSnapshot = {
  state: EditorWorkspaceState;
  view: EditorViewModel;
  commands: ReadonlyMap<string, PhotocraftCommand>;
};

/** 工作区阶段（UI 直接据此渲染）。 */
export type EditorWorkspacePhase =
  | "idle"
  | "loading-module"
  | "opening"
  | "editing"
  | "freezing"
  | "saving"
  | "saved"
  | "unavailable"
  | "failed";

export type EditorWorkspaceState = {
  phase: EditorWorkspacePhase;
  message: string | null;
  dirty: boolean;
  retriable: boolean;
};

export type EditorWorkspaceOptions = {
  /** 可信 owner：只在控制器空闲时提供；宿主据此校验命名弹窗归属。 */
  dialogOwner?: () => EditorEditingOwner | null;
  /** 文档草稿/基线会话（宿主实现，见 session.ts）。 */
  session: EditorDocumentSession;
  /** 保存端口：上传、请求身份与权威回执对账归宿主适配包。 */
  save: EditorSavePort;
  /**
   * 本地文件交付端口（change: 2026-10-21-add-photocraft-document-workspace，D5）。
   *
   * 提供时启用独立文件保存/导出；不经节点上传与 edit-complete，也不要求 nodeId。
   */
  fileDelivery?: EditorFilePort;
  /** 加载内核（缺省走 wasm glue；测试注入替身）。 */
  load?: () => Promise<EditorResult<EditorHandle>>;
  /**
   * 静态资源地址（字体等）。宿主按根路径/子路径部署时注入；缺省按根路径解析。
   * 只在默认 wasm 加载器注册固定字体时使用。
   */
  assetUrl?: EditorAssetPort;
  /** 真正让出主线程；测试可注入受控调度。 */
  yieldTask?: () => Promise<void>;
  /** 摘要实现（测试注入；缺省 `crypto.subtle`）。 */
  digest?: ArtifactDigest;
  /**
   * 笔刷库持久化端口（change: 2026-10-22-complete-photocraft-webui-editing，任务 2.5 / design D4）。
   *
   * 提供时预设保存／导入后写入本机存储；缺省只在会话内保留（提示未持久化）。
   */
  brushStorage?: BrushLibraryStorage;
  onState?: (state: EditorWorkspaceState) => void;
  onViewModel?: (view: EditorViewModel, commands: Map<string, unknown>) => void;
  /**
   * 宿主文档身份（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.3）。
   *
   * 控制器不能从视图里推出「这份文档是哪一份」：关闭后重开同一节点可以又是修订 1、
   * 内容 hash 也相同。宿主因此提供 `documentId`，并在重建/权威内容替换时递增 `generation`；
   * 域内计划用这个组合判定归属，避免把旧计划的报告当成新文档的结果。
   */
  documentId?: string | null;
  /** 宿主文档代际（缺省 0；重新打开或权威替换内容时由宿主递增）。 */
  documentGeneration?: () => number;
};

/** 子文档只在父文档工作区内编辑，不产生宿主保存回执。 */
class SmartChildSession implements EditorDocumentSession {
  private baseline: string | null = null;
  private current: string | null = null;

  isDirty(): boolean { return this.baseline !== null && this.current !== this.baseline; }
  beginFreeze(): void {}
  resumeEditing(): void {}
  beginSave(): void {}
  commitBaseline(contentHash: string): void { this.baseline = contentHash; this.current = contentHash; }
  failSave(): void {}
  establishBaseline(): void { if (this.current !== null) this.baseline = this.current; }
  applyContentState(state: PhotocraftContentState): void {
    this.current = state.documentContentHash;
    if (this.baseline === null) this.baseline = this.current;
  }
}

export class EditorWorkspaceController {
  private readonly options: EditorWorkspaceOptions;
  private state: EditorWorkspaceState = { phase: "idle", message: null, dirty: false, retriable: false };
  readonly features = createFeatureSessions(() => this.workspaceFeatureContext());

  private workspaceFeatureContext(): WorkspaceFeatureContext {
    const controller = this;
    return {
      get handle() { return controller.handle; },
      get view() { return controller.view; },
      get phase() { return controller.currentState().phase; },
      get pendingArtifacts() { return controller.pendingArtifacts !== null; },
      get owner() { return { documentId: controller.documentId, generation: controller.observedGeneration() }; },
      get saving() {
        return controller.isSaving();
      },
      get selectionModifyActive() { return controller.selectionModifyActive; },
      set selectionModifyActive(value) { controller.selectionModifyActive = value; },
      get retouchActive() { return controller.retouchActive; },
      set retouchActive(value) { controller.retouchActive = value; },
      get filterActive() { return controller.filterActive; },
      set filterActive(value) { controller.filterActive = value; },
      get composeActive() { return controller.composeActive; },
      set composeActive(value) { controller.composeActive = value; },
      afterWrite: (...args) => controller.afterWrite(...args),
      fail: (...args) => controller.fail(...args),
      unavailable: (...args) => controller.unavailable(...args),
      hasActiveDraft: (...args) => controller.hasActiveDraft(...args),
      blockingDraft: (...args) => controller.blockingDraft(...args),
      frozen: () => controller.frozenGate(),
      documentGeneration: () => controller.generation,
      blockingDraftExceptVector: (...args) => controller.blockingDraftExceptVector(...args),
      vectorToken: (...args) => controller.vectorToken(...args),
      writesFrozen: () => controller.writesFrozen(),
    };
  }

  private handle: EditorHandle | null = null;
  /** 宿主文档 id（未接宿主时为 null）。 */
  private readonly documentId: string | null;
  /**
   * 文档归属代际：每次在本控制器里重新载入文档、或宿主报告代际变化时递增。
   *
   * 它比「修订 + 内容指纹」更强：关闭后重新打开同一节点可能又是修订 1、内容指纹也相同，
   * 那时只有代际能说明「这份计划来自已经销毁的文档」。
   */
  private contentGeneration = 0;
  /** 最近一次读到的宿主代际，用于发现宿主的重建/内容替换。 */
  private lastHostGeneration = 0;
  private view: EditorViewModel = { hasDocument: false, document: null, sessionActiveIndex: null };
  private frozen: ProjectExportArtifacts | null = null;
  /** 最近一次冻结但尚未权威确认的产物（重试复用，不重新冻结）。 */
  private pendingArtifacts: ProjectExportArtifacts | null = null;
  private saving: Promise<EditorSaveOutcome> | null = null;
  private generation = 0;
  private strokeActive = false;
  private transformActive = false;
  private textActive = false;
  private adjustmentActive = false;
  private propertiesActive = false;
  private selectionModifyActive = false;
  private retouchActive = false;
  private filterActive = false;
  private composeActive = false;
  private smartChildActive = false;
  /** 矢量域登记的未结算草稿（形状拖绘/钢笔未完成/锚点拖动）。 */
  private vectorDraftActive = false;
  private canvasToolDraftActive = false;
  private smartChild: EditorWorkspaceController | null = null;
  private smartChildProject: Uint8Array | null = null;
  private readonly placedAssetIds = new Set<string>();
  private commandIndex: Map<string, PhotocraftCommand> = new Map();
  /** 快照缓存：`useSyncExternalStore` 要求未变化时返回同一引用，否则会无限重渲染。 */
  private snapshotCache: EditorSnapshot | null = null;
  private readonly listeners = new Set<(snapshot: EditorSnapshot) => void>();
  /** 笔刷库控制器：与文档同一生命周期，但库内容与文档内容互不影响。 */
  private readonly brushes: BrushLibraryController;

  constructor(options: EditorWorkspaceOptions) {
    this.options = options;
    this.documentId = options.documentId ?? null;
    this.lastHostGeneration = options.documentGeneration?.() ?? 0;
    this.contentGeneration = this.lastHostGeneration;
    this.brushes = new BrushLibraryController(() => this.handle, options.brushStorage ?? null);
  }

  /**
   * 宿主报告的文档代际是否已变化（重开同一节点、权威内容替换）。
   *
   * 每次取上下文都会读一次：宿主递增后，当前控制器持有的计划立即失效，不需要宿主再调一个
   * 通知接口。返回 true 时同时把本地代际推上去，之后的计划以新代际为基线。
   */
  private observedGeneration(): number {
    const host = this.options.documentGeneration?.() ?? 0;
    if (host !== this.lastHostGeneration) {
      this.lastHostGeneration = host;
      this.contentGeneration += 1;
    }
    return this.contentGeneration;
  }

  /** 笔刷库控制器（预设选择、保存、ABR 导入与真实笔迹预览）。 */
  brushLibrary(): BrushLibraryController {
    return this.brushes;
  }

  /** 订阅状态/视图变化（React 用 `useSyncExternalStore` 消费）。 */
  subscribe(listener: (snapshot: EditorSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 当前快照：阶段、视图模型与可渲染命令表。
   *
   * **必须**在状态未变时返回同一引用：React 的 `useSyncExternalStore` 会反复调用 `getSnapshot`，
   * 每次返回新对象会被判定为「一直在变化」，触发 `Maximum update depth exceeded`。
   */
  snapshot(): EditorSnapshot {
    this.snapshotCache ??= { state: this.currentState(), view: this.view, commands: this.commandIndex };
    return this.snapshotCache;
  }

  dialogOwner() {
    if (!this.handle || this.hasActiveDraft() || this.saving || this.pendingArtifacts
      || this.state.phase === "saving" || this.state.phase === "freezing") return null;
    return this.options.dialogOwner?.() ?? null;
  }

  currentState(): EditorWorkspaceState {
    return { ...this.state };
  }

  /** 内核句柄（未加载时为 null）。 */
  editor(): EditorHandle | null {
    return this.handle;
  }

  /**
   * 文档代际（change: 2026-10-22-add-photocraft-painting-color-workflows，任务 3.3）。
   *
   * 打开/关闭/`dispose()` 时递增；域会话拿异步结果落地前比较它，避免把上一份文档的采样色、
   * 预设列表写到后来打开的另一份文档上。
   */
  documentGeneration(): number {
    return this.generation;
  }

  /** 最近一次视图模型。 */
  currentView(): EditorViewModel {
    return this.view;
  }

  /**
   * 当前文档归属（宿主文档 id + 代际）
   * （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.3）。
   *
   * 域内计划、面板预览都用它当归属键：只看名称/尺寸/修订会漏掉「同尺寸同修订的另一份文档」，
   * 也认不出关闭后重开的同一节点。
   */
  documentOwner(): { documentId: string | null; generation: number } {
    return { documentId: this.documentId, generation: this.observedGeneration() };
  }

  /** 最近一次冻结的成对产物（保存失败后仍可重试）。 */
  frozenArtifacts(): ProjectExportArtifacts | null {
    return this.frozen;
  }

  /** 是否配置了本地文件交付端口（独立文件文档的保存/导出）。 */
  canDeliverFiles(): boolean {
    return typeof this.options.fileDelivery === "function";
  }

  /**
   * 冻结当前修订的成对产物（不写回、不上传）。
   *
   * “添加到画布”需要先取得同一修订的工程与 PNG 再成对发布；与节点保存共用同一冻结与
   * 摘要校验，且重试复用同一冻结结果（change: 2026-10-21-add-photocraft-document-workspace，D5）。
   */
  async freezeForPublish(): Promise<EditorResult<ProjectExportArtifacts>> {
    const draft = this.blockingDraft();
    if (draft && draft.code.endsWith("-active")) return draft;
    const handle = this.handle;
    if (!handle) return { ok: false, code: "no-document", message: "编辑器尚未就绪" };
    const generation = this.generation;
    const revision = this.view.document?.revision;
    if (!this.pendingArtifacts || this.pendingArtifacts.revision !== revision) {
      const frozen = await freezeProjectArtifacts(handle, this.options.digest);
      if (generation !== this.generation) return { ok: false, code: "closed", message: "编辑会话已结束" };
      if (!frozen.ok) return frozen;
      this.frozen = frozen.value;
      this.pendingArtifacts = frozen.value;
    }
    return { ok: true, value: this.pendingArtifacts };
  }

  /**
   * 独立文件交付：冻结当前修订，把工程或 PNG 经宿主的本地文件端口交出。
   *
   * 与节点保存共用同一冻结与摘要校验（同一修订的成对产物），但**不**上传 Canvas、不产生
   * 节点历史、不要求 nodeId。只有宿主确认已写入磁盘（`written`）才推进本地基线；
   * 仅发起下载（`download-started`）保留未保存状态，取消/失败保留现场（design D5）。
   */
  async deliverFile(kind: "project" | "png", options: { fileName?: string } = {}): Promise<EditorFileDeliveryResult> {
    const deliver = this.options.fileDelivery;
    if (!deliver) return { ok: false, status: "failed", message: "当前宿主不支持本地文件保存" };
    if (this.propertiesActive) return { ok: false, status: "failed", message: "请先确认或取消图层属性编辑" };
    if (this.adjustmentActive) return { ok: false, status: "failed", message: "请先确认或取消调整参数编辑" };
    if (this.textActive) return { ok: false, status: "failed", message: "请先确认或取消文字编辑" };
    if (this.transformActive) return { ok: false, status: "failed", message: "请先确认或取消自由变换" };
    if (this.strokeActive) return { ok: false, status: "failed", message: "请先结束当前笔迹再导出" };
    const handle = this.handle;
    if (!handle) return { ok: false, status: "failed", message: "编辑器尚未就绪" };
    const generation = this.generation;
    const revision = this.view.document?.revision;
    if (!this.pendingArtifacts || this.pendingArtifacts.revision !== revision) {
      const frozen = await freezeProjectArtifacts(handle, this.options.digest);
      if (generation !== this.generation) return { ok: false, status: "failed", message: "编辑会话已结束" };
      if (!frozen.ok) return { ok: false, status: "failed", message: frozen.message };
      this.frozen = frozen.value;
      this.pendingArtifacts = frozen.value;
    }
    const artifacts = this.pendingArtifacts;
    const isProject = kind === "project";
    const result = await deliver({
      fileName: options.fileName ?? (isProject ? "photocraft.pcraft" : "photocraft.png"),
      contentType: isProject ? artifacts.projectSummary.contentType : "image/png",
      bytes: isProject ? artifacts.project : artifacts.output
    });
    if (generation !== this.generation) return { ok: false, status: "failed", message: "编辑会话已结束" };
    if (result.ok && result.status === "written" && isProject) {
      // 只有可信写入才推进本地基线；导出的 PNG 不代表工程已保存。
      this.options.session.commitBaseline(artifacts.documentContentHash);
      this.pendingArtifacts = null;
    }
    return result;
  }

  /** 加载内核（幂等）。 */
  async ensureEditor(): Promise<EditorResult<EditorHandle>> {
    if (this.handle) return { ok: true, value: this.handle };
    this.setState("loading-module", null);
    const load = this.options.load ?? (() => loadEditor(undefined, this.options.assetUrl ? { assetUrl: this.options.assetUrl } : {}));
    const generation = this.generation;
    const loaded = await load();
    if (generation !== this.generation) { if (loaded.ok) loaded.value.closeDocument(); return { ok: false, code: "closed", message: "编辑会话已结束" }; }
    if (!loaded.ok) {
      this.setState("unavailable", loaded.message);
      return loaded;
    }
    this.handle = loaded.value;
    // 库与文档分离：进入可写编辑后先恢复本机库（坏快照保留默认库）。
    void this.brushes.restore();
    return loaded;
  }

  /** 打开图片（纯媒体或 v1 标注 → 工程）。 */
  async openImage(input: { name: string; assetId: string; bytes: Uint8Array }): Promise<EditorResult<EditorViewModel>> {
    if (this.propertiesActive) return this.propertiesPending();
    if (this.adjustmentActive) return this.adjustmentPending();
    if (this.textActive) return this.textPending();
    const generation = this.generation;
    const loaded = await this.ensureEditor();
    if (!loaded.ok) return loaded;
    if (generation !== this.generation) return this.unavailable();
    this.setState("opening", null);
    await (this.options.yieldTask ?? yieldEditorTask)();
    if (generation !== this.generation) return this.unavailable();
    const opened = loaded.value.openImage(input.name, input.assetId, input.bytes);
    if (!opened.ok) return this.fail(opened);
    return this.afterOpen(loaded.value, generation, false);
  }

  /** 打开 `.pcraft` 工程字节。 */
  async openProject(input: { bytes: Uint8Array; baseAssetId: string }): Promise<EditorResult<EditorViewModel>> {
    if (this.propertiesActive) return this.propertiesPending();
    if (this.adjustmentActive) return this.adjustmentPending();
    if (this.textActive) return this.textPending();
    const generation = this.generation;
    const loaded = await this.ensureEditor();
    if (!loaded.ok) return loaded;
    if (generation !== this.generation) return this.unavailable();
    this.setState("opening", null);
    await (this.options.yieldTask ?? yieldEditorTask)();
    if (generation !== this.generation) return this.unavailable();
    const opened = loaded.value.openProject(input.bytes, input.baseAssetId);
    if (!opened.ok) return this.fail(opened);
    // 已核验工程的实际加载内容是本地净变化基线，兼容旧版本的像素指纹。
    // 保存并发核验仍使用 baselineDocument 和 editBegin 捕获的权威身份。
    return this.afterOpen(loaded.value, generation, true);
  }

  /** 内部字节转层，供旧标注转换使用；不提供用户图片置入入口。 */
  async placeImage(input: {
    name: string;
    assetId: string;
    bytes: Uint8Array;
    params?: unknown;
    retainSource?: boolean;
  }): Promise<EditorResult<EditorViewModel>> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    if (this.propertiesActive) return this.propertiesPending();
    if (this.adjustmentActive) return this.adjustmentPending();
    if (this.textActive) return this.textPending();
    if (this.transformActive) return this.transformPending();
    if (this.strokeActive) return { ok: false, code: "stroke-active", message: "请先结束当前笔迹" };
    if (this.pendingArtifacts || this.saving) return { ok: false, code: "frozen", message: "请先重试确认上次保存结果" };
    const placed = handle.placeImage(input.name, input.assetId, input.bytes, input.params ?? null);
    if (!placed.ok) return this.fail(placed);
    if (input.retainSource !== false) this.placedAssetIds.add(input.assetId);
    return this.afterWrite();
  }

  /**
   * 分派一条命令。
   *
   * 命令白名单在内核里复核；`frozen` 期间拒绝写入（冻结在同步导出内完成，这里只挡界面竞态）。
   */
  dispatch(id: string, params: unknown = null): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const blocked = this.blockingDraft();
    if (blocked) return blocked;
    const frozen = this.frozenGate();
    if (frozen) return frozen;
    const result = handle.execute(id, params);
    if (!result.ok) return this.fail(result);
    return this.afterWrite();
  }

  /**
   * 是否处在冻结窗口（保存/导出已取走成对产物，尚未结算）。
   *
   * 所有内容写入口都必须先看这个判定，否则冻结期间仍能改文档，交出与当前修订不符的产物
   * （change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.3：矢量命令走同一门禁）。
   */
  writesFrozen(): boolean {
    return this.pendingArtifacts !== null || this.state.phase === "freezing" || this.state.phase === "saving";
  }

  /** 临时笔迹不发布内容状态，只有提交才同步修订与净变化。 */
  beginStroke(params: unknown): EditorResult<void> {
    if (!this.handle) return this.unavailable();
    if (this.propertiesActive) return this.propertiesPending();
    if (this.adjustmentActive) return this.adjustmentPending();
    if (this.textActive) return this.textPending();
    if (this.transformActive) return this.transformPending();
    if (this.strokeActive || this.saving || this.pendingArtifacts || this.state.phase === "freezing" || this.state.phase === "saving") {
      return { ok: false, code: "stroke-unavailable", message: "当前不能开始绘制" };
    }
    const result = this.handle.beginStroke(params);
    this.strokeActive = result.ok;
    return result;
  }

  appendStroke(points: unknown): EditorResult<void> {
    if (!this.handle || !this.strokeActive) return this.unavailable();
    return this.handle.appendStroke(points);
  }

  takeStrokeDamage():EditorResult<EditorPreviewRegion[]> {
    // 修饰笔迹也走同一条局部预览通道：`strokeActive` 只由 `beginStroke` 置位，修饰笔迹
    // （`beginRetouch`）不会置位。若不认 `retouchActive`，局部预览会一直拿到
    // `unavailable`，真实 UI 里表现为「提交成功、也是一步历史，但画面不重绘」。
    return this.handle && (this.strokeActive || this.retouchActive)
      ? this.handle.takeStrokeDamage()
      : this.unavailable();
  }

  commitStroke(): EditorResult<EditorViewModel> {
    if (!this.handle || !this.strokeActive) return this.unavailable();
    this.strokeActive = false;
    const result = this.handle.commitStroke();
    if (!result.ok) { this.handle.cancelStroke(); return this.fail(result); }
    return this.afterWrite();
  }

  cancelStroke(): void {
    if (this.strokeActive) this.handle?.cancelStroke();
    this.strokeActive = false;
  }

  hasTransform(): boolean { return this.transformActive; }
  hasText(): boolean { return this.textActive; }
  hasAdjustment(): boolean { return this.adjustmentActive; }
  importContourPresets(bytes:Uint8Array) {return this.handle?.importContourPresets(bytes)??this.unavailable();}
  patternLibrary() {return this.handle?.patternLibrary()??this.unavailable();}
  importPatternPresets(bytes:Uint8Array) {return this.handle?.importPatternPresets(bytes)??this.unavailable();}
  renamePatternPreset(key:string,name:string) {return this.handle?.renamePatternPreset(key,name)??this.unavailable();}
  deletePatternPreset(key:string) {return this.handle?.deletePatternPreset(key)??this.unavailable();}
  exportPatternPresets(key?:string) {return this.handle?.exportPatternPresets(key)??this.unavailable();}
  patternLibrarySnapshot() {return this.handle?.patternLibrarySnapshot()??this.unavailable();}
  restorePatternLibrary(bytes:Uint8Array) {return this.handle?.restorePatternLibrary(bytes)??this.unavailable();}
  exportContourPreset(contour:unknown) {return this.handle?.exportContourPreset(contour)??this.unavailable();}
  hasLayerProperties():boolean {return this.propertiesActive;}
  beginLayerProperties(layer:number):EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    if (this.propertiesActive || this.adjustmentActive || this.textActive || this.strokeActive || this.transformActive || this.saving
      || this.pendingArtifacts || this.state.phase==="freezing" || this.state.phase==="saving") return this.propertiesPending();
    const result=this.handle.beginLayerProperties(layer);this.propertiesActive=result.ok;return result;
  }
  previewLayerProperties(params:unknown):EditorResult<unknown> {
    return this.handle && this.propertiesActive ? this.handle.previewLayerProperties(params) : this.unavailable();
  }
  stylePositionFrame(index:number) {
    return this.handle && this.propertiesActive ? this.handle.stylePositionFrame(index) : this.unavailable();
  }
  commitLayerProperties():EditorResult<EditorViewModel> {
    if (!this.handle || !this.propertiesActive) return this.unavailable();
    const result=this.handle.commitLayerProperties();
    if (!result.ok) return result;
    this.propertiesActive=false;return this.afterWrite();
  }
  cancelLayerProperties():void {
    if (this.propertiesActive) this.handle?.cancelLayerProperties();
    this.propertiesActive=false;
  }
  private propertiesPending():EditorFailure {
    return {ok:false,code:"properties-active",message:"请先确认或取消图层属性编辑"};
  }
  curveGeometry(points: readonly [number,number][]): EditorResult<number[]> {
    return this.handle ? this.handle.curveGeometry(points) : this.unavailable();
  }

  beginAdjustment(layer: number): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    if (this.propertiesActive || this.adjustmentActive || this.textActive || this.strokeActive || this.transformActive || this.saving
      || this.pendingArtifacts || this.state.phase === "freezing" || this.state.phase === "saving") return this.adjustmentPending();
    const result=this.handle.beginAdjustment(layer);
    this.adjustmentActive=result.ok;
    return result;
  }

  previewAdjustment(params: unknown): EditorResult<unknown> {
    return this.handle && this.adjustmentActive ? this.handle.previewAdjustment(params) : this.unavailable();
  }

  commitAdjustment(): EditorResult<EditorViewModel> {
    if (!this.handle || !this.adjustmentActive) return this.unavailable();
    const result=this.handle.commitAdjustment();
    if (!result.ok) return result;
    this.adjustmentActive=false;
    return this.afterWrite();
  }

  cancelAdjustment(): void {
    if (this.adjustmentActive) this.handle?.cancelAdjustment();
    this.adjustmentActive=false;
  }

  private adjustmentPending(): EditorFailure {
    return {ok:false,code:"adjustment-active",message:"请先确认或取消调整参数编辑"};
  }

  beginText(params: unknown): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    if (this.propertiesActive || this.adjustmentActive || this.textActive || this.strokeActive || this.transformActive || this.saving || this.pendingArtifacts
      || this.state.phase === "freezing" || this.state.phase === "saving") return this.textPending();
    const result=this.handle.beginText(params);
    this.textActive=result.ok;
    return result;
  }

  previewText(params: unknown): EditorResult<unknown> {
    return this.handle && this.textActive ? this.handle.previewText(params) : this.unavailable();
  }

  textGeometry(params: TextGeometryRequest): EditorResult<TextGeometry> {
    return this.handle && this.textActive ? this.handle.textGeometry(params) : this.unavailable();
  }

  commitText(): EditorResult<EditorViewModel> {
    if (!this.handle || !this.textActive) return this.unavailable();
    const result=this.handle.commitText();
    if (!result.ok) return result;
    this.textActive=false;
    return this.afterWrite();
  }

  cancelText(): void {
    if (this.textActive) this.handle?.cancelText();
    this.textActive=false;
  }

  private textPending(): EditorFailure {
    return {ok:false,code:"text-active",message:"请先确认或取消文字编辑"};
  }

  beginTransform(selectionOnly = false): EditorResult<void> {
    if (!this.handle) return this.unavailable();
    if (this.propertiesActive || this.adjustmentActive || this.textActive || this.strokeActive || this.transformActive || this.saving || this.pendingArtifacts
      || this.state.phase === "freezing" || this.state.phase === "saving") return this.transformPending();
    const result = selectionOnly ? this.handle.beginTransform(true) : this.handle.beginTransform();
    this.transformActive = result.ok;
    return result;
  }

  beginMove(params: { x: number; y: number; autoSelect: boolean; duplicate: boolean }): EditorResult<boolean> {
    if (!this.handle) return this.unavailable();
    if (this.propertiesActive || this.adjustmentActive || this.textActive || this.strokeActive || this.transformActive || this.saving || this.pendingArtifacts
      || this.state.phase === "freezing" || this.state.phase === "saving") return this.transformPending();
    const result = this.handle.beginMove(params);
    if (!result.ok) { this.afterWrite(); return result; }
    this.transformActive = result.value;
    const refreshed = this.afterWrite();
    if (!refreshed.ok) { this.cancelTransform(); return refreshed; }
    return result;
  }

  previewTransform(matrix: readonly number[]): EditorResult<void> {
    if (!this.handle || !this.transformActive) return this.unavailable();
    return this.handle.previewTransform(matrix);
  }

  commitTransform(): EditorResult<EditorViewModel> {
    if (!this.handle || !this.transformActive) return this.unavailable();
    const result = this.handle.commitTransform();
    if (!result.ok) return result;
    this.transformActive = false;
    return this.afterWrite();
  }

  cancelTransform(): void {
    if (this.transformActive) this.handle?.cancelTransform();
    this.transformActive = false;
  }

  private transformPending(): EditorFailure {
    return { ok: false, code: "transform-active", message: "请先确认或取消自由变换" };
  }

  /** 撤销。 */
  undo(): EditorResult<EditorViewModel> { return this.dispatch("edit.undo"); }

  /**
   * P2：导出所选图层为跨文档载荷（源文档关闭后仍有效）。
   *
   * 载荷是自包含字节；控制器不缓存它——工作区剪贴板由**宿主/工作区**持有，
   * 因此不同工作区不会串剪贴板。
   */
  copyLayers(layers?: readonly number[]): EditorResult<Uint8Array> {
    if (!this.handle) return this.unavailable();
    if (this.strokeActive || this.retouchActive || this.smartChildActive) {
      return { ok: false, code: "gesture-active", message: "请先结束当前操作" };
    }
    return this.handle.exportLayerTransfer(layers && layers.length ? { layers } : {});
  }

  /** P2：载荷摘要与结构（不解码像素）。 */
  inspectLayerTransfer(bytes: Uint8Array): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    return this.handle.inspectLayerTransfer(bytes);
  }

  /** P2：目标候选文档预检（不改任何状态）。 */
  canPasteLayers(bytes: Uint8Array): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    return this.handle.canPasteLayerTransfer(bytes);
  }

  /** P2：原子粘贴（`inPlace` 保持源坐标，否则居中到可见中心）。 */
  pasteLayers(bytes: Uint8Array, options: { inPlace?: boolean; center?: [number, number] } = {}): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    if (this.blockingDraft()) return this.blockingDraft() as EditorFailure;
    if (this.pendingArtifacts || this.saving || this.state.phase === "freezing" || this.state.phase === "saving") {
      return { ok: false, code: "frozen", message: "导出期间不接受内容修改" };
    }
    const result = handle.pasteLayerTransfer(bytes, {
      placement: options.inPlace ? "inPlace" : "center",
      ...(options.center ? { center: options.center } : {})
    });
    if (!result.ok) return this.fail(result);
    return this.afterWrite();
  }

  /** P2：置入前预检（真实解码类型与尺寸）。 */
  inspectPlace(bytes: Uint8Array): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    return this.handle.inspectPlaceAsset(bytes);
  }

  /** P2：置入当前文档（像素层或嵌入智能对象）。 */
  placeAsset(input: { name: string; bytes: Uint8Array; assetId?: string; mode?: "pixel" | "smartObject" }): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const blocked = this.blockingDraft();
    if (blocked) return blocked;
    if (this.pendingArtifacts || this.saving) return { ok: false, code: "frozen", message: "请先重试确认上次保存结果" };
    const result = handle.placeAsset(input.bytes, {
      name: input.name,
      ...(input.assetId ? { assetId: input.assetId } : {}),
      ...(input.mode ? { mode: input.mode } : {})
    });
    if (!result.ok) return this.fail(result);
    if (input.assetId) this.placedAssetIds.add(input.assetId);
    return this.afterWrite();
  }

  // ------------------------------------------------------------------ P3 PSD

  /** PSD 兼容矩阵（与内核同一份声明）。 */
  psdMatrix(): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    return this.handle.psdMatrix();
  }

  /** PSD 头部预检（不替换文档）。 */
  inspectPsd(bytes: Uint8Array): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    return this.handle.inspectPsd(bytes);
  }

  /** 导入 PSD：默认拒绝不可编辑结构；`flat` 显式选择扁平副本。 */
  async openPsd(input: { bytes: Uint8Array; flat?: boolean }): Promise<EditorResult<EditorViewModel>> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const blocked = this.blockingDraft();
    if (blocked) return blocked;
    const result = handle.importPsd(input.bytes, input.flat ?? false);
    if (!result.ok) return this.fail(result);
    return this.afterOpen(handle, this.generation, false);
  }

  /** PSD 导出预检：逐层损失报告。 */
  inspectPsdExport(): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    return this.handle.inspectPsdExport();
  }

  /** PSD 导出：只产生文件字节与报告，不推进工程保存基线。 */
  exportPsd(options: { rasterizeLossy?: boolean } = {}): EditorResult<{ bytes: Uint8Array; report: unknown }> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    if (this.hasActiveDraft()) return { ok: false, code: "gesture-active", message: "请先结算当前草稿再导出" };
    const bytes = handle.exportPsd(options.rasterizeLossy ?? false);
    if (!bytes.ok) return this.fail(bytes);
    const report = handle.lastPsdExportReport();
    return { ok: true, value: { bytes: bytes.value, report: report.ok ? report.value : null } };
  }

  // ------------------------------------------------------------ P4 智能对象

  beginSmartChild(layer: number): EditorResult<unknown> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    if (this.hasActiveDraft()) return { ok: false, code: "gesture-active", message: "请先结算当前草稿" };
    const result = handle.beginSmartChild(layer);
    if (result.ok) {
      this.smartChildActive = true;
      const value = result.value as { project?: unknown };
      if (typeof value?.project === "string") {
        try {
          const binary = globalThis.atob(value.project);
          this.smartChildProject = Uint8Array.from(binary, (character) => character.charCodeAt(0));
          this.smartChild?.dispose();
          this.smartChild = this.createSmartChildController();
          void this.smartChild.openProject({ bytes: this.smartChildProject, baseAssetId: "photocraft-smart-child" });
        } catch {
          this.smartChildProject = null;
        }
      }
      this.setState(this.state.phase, this.state.message, this.state.dirty, this.state.retriable);
    }
    return result;
  }

  updateSmartParent(attemptId: string, child: Uint8Array): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    // 父子回写是内容替换：父文档有自己的未结算草稿/保存阶段时不能写入。
    const blocked = this.blockingDraft();
    if (blocked) return blocked;
    if (this.isSaving()) return { ok: false, code: "frozen", message: "正在保存，请等待保存完成后再写回" };
    // 父子回写同样是文档写入：未结算草稿（含矢量手势）必须先结算，
    // 否则会用半截状态覆盖父文档（change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.3）。

    const result = handle.updateSmartParent(attemptId, child);
    if (!result.ok) return this.fail(result);
    const written = this.afterWrite();
    if (!written.ok) return written;
    this.smartChildActive = false;
    return written;
  }

  /**
   * 用真正子文档编辑器当前的工程字节回写父文档。
   *
   * 子文档有未结算草稿时导出的工程**不含**这部分几何，因此先拒绝而不是「成功」地丢掉
   * 半截操作（change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.3）。
   */
  updateSmartParentFromChild(attemptId: string): EditorResult<EditorViewModel> {
    const child = this.smartChild;
    if (!child) return { ok: false, code: "smart-child-unavailable", message: "子文档编辑器尚未就绪" };
    // 子文档自己的草稿也必须先结算：半笔草稿不能变成父文档里的智能对象内容。
    if (child.hasActiveDraft()) return { ok: false, code: "draft-active", message: "请先完成或取消子文档中的草稿" };
    if (child.isSaving()) return { ok: false, code: "frozen", message: "子文档正在保存，请等待完成后再写回" };
    const project = child.exportProjectBytes();
    if (!project.ok) return project as EditorResult<EditorViewModel>;
    return this.updateSmartParent(attemptId, project.value);
  }

  /** 当前打开的智能对象子文档编辑器。 */
  smartChildController(): EditorWorkspaceController | null { return this.smartChild; }

  /** 导出当前文档工程，供父子文档边界使用。 */
  exportProjectBytes(): EditorResult<Uint8Array> {
    if (!this.handle) return this.unavailable();
    return this.handle.saveProject();
  }

  private createSmartChildController(): EditorWorkspaceController {
    return new EditorWorkspaceController({
      ...this.options,
      session: new SmartChildSession(),
      save: async () => ({ ok: true, status: "completed" }),
      fileDelivery: undefined,
      onState: undefined,
      onViewModel: undefined,
      // 子文档是另一份内容：不能沿用父文档的归属 id，否则子文档里的模式计划会被
      // 当成父文档的计划，父子回写时更难判断来源（任务 3.3）。
      documentId: this.documentId ? `${this.documentId}#smart-child` : null,
      // 子文档没有宿主条目代际，归属只靠控制器自己的载入代际。
      documentGeneration: () => 0
    });
  }

  reloadSmartChild(): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    return this.handle.reloadSmartChild();
  }

  exportSmartChild(): EditorResult<Uint8Array> {
    if (!this.handle) return this.unavailable();
    return this.handle.exportSmartChild();
  }

  detachSmartChild(): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const result = handle.detachSmartChild();
    if (!result.ok) return this.fail(result);
    this.smartChildActive = false;
    return this.afterWrite();
  }

  closeSmartChild(): void {
    if (!this.handle) return;
    this.handle.closeSmartChild();
    this.smartChildActive = false;
    this.smartChild?.dispose();
    this.smartChild = null;
    this.smartChildProject = null;
    this.setState(this.state.phase, this.state.message, this.state.dirty, this.state.retriable);
  }

  smartChildState(): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    return this.handle.smartChildState();
  }

  hasSmartChild(): boolean {
    return this.smartChildActive;
  }

  convertToSmartObject(layers?: readonly number[]): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const blocked = this.blockingDraft();
    if (blocked) return blocked;
    const targets = layers ?? (this.view.document ? this.view.document.layers.filter((layer) => layer.selected || layer.active).map((layer) => layer.id) : []);
    const result = handle.convertToSmartObject(targets);
    if (!result.ok) return this.fail(result);
    return this.afterWrite();
  }

  duplicateSmartObject(layers: readonly number[], independent: boolean): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const blocked = this.blockingDraft();
    if (blocked) return blocked;
    const result = handle.duplicateSmartObject(layers, independent);
    if (!result.ok) return this.fail(result);
    return this.afterWrite();
  }

  replaceSmartContents(layer: number, bytes: Uint8Array): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const blocked = this.blockingDraft();
    if (blocked) return blocked;
    const result = handle.replaceSmartContents(layer, bytes);
    if (!result.ok) return this.fail(result);
    return this.afterWrite();
  }

  rasterizeSmartObject(layer: number): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const blocked = this.blockingDraft();
    if (blocked) return blocked;
    const result = handle.rasterizeSmartObject(layer);
    if (!result.ok) return this.fail(result);
    return this.afterWrite();
  }

  // -------------------------------------------------------- P5 调色与选区

  /** 直方图（只读；结果带 `generation`，调用方丢弃过期响应）。 */
  histogram(params: { source?: "layer" | "composite"; channel?: "rgb" | "luminance" } = {}): EditorResult<unknown> { return this.features.adjustments.histogram(params); }

  beginSelectionModify(params: { operation: "expand" | "contract" | "smooth" | "border" | "feather"; radius: number }): EditorResult<unknown> { return this.features.selections.beginSelectionModify(params); }

  updateSelectionModify(params: { radius: number }): EditorResult<unknown> { return this.features.selections.updateSelectionModify(params); }

  commitSelectionModify(): EditorResult<EditorViewModel> { return this.features.selections.commitSelectionModify(); }

  cancelSelectionModify(): void { return this.features.selections.cancelSelectionModify(); }

  prepareRefineEdge(params: Record<string, unknown>): EditorResult<unknown> { return this.features.selections.prepareRefineEdge(params); }

  // -------------------------------------------------------- P6 修饰与滤镜

  beginRetouch(id: string, params: unknown): EditorResult<unknown> { return this.features.retouch.beginRetouch(id, params); }

  appendRetouch(points: unknown): EditorResult<unknown> { return this.features.retouch.appendRetouch(points); }

  commitRetouch(): EditorResult<EditorViewModel> { return this.features.retouch.commitRetouch(); }

  cancelRetouch(): void { return this.features.retouch.cancelRetouch(); }

  hasRetouch(): boolean { return this.features.retouch.hasRetouch(); }

  beginFilter(id: string, params: unknown): EditorResult<unknown> { return this.features.filters.beginFilter(id, params); }

  updateFilter(params: unknown): EditorResult<unknown> { return this.features.filters.updateFilter(params); }

  commitFilter(): EditorResult<EditorViewModel> { return this.features.filters.commitFilter(); }

  cancelFilter(): void { return this.features.filters.cancelFilter(); }

  hasFilter(): boolean { return this.features.filters.hasFilter(); }

  // -------------------------------------------------------- P7 构图与矢量

  beginCompose(id: string, params: unknown): EditorResult<unknown> { return this.features.composition.beginCompose(id, params); }

  updateCompose(params: unknown): EditorResult<unknown> { return this.features.composition.updateCompose(params); }

  commitCompose(): EditorResult<EditorViewModel> { return this.features.composition.commitCompose(); }

  cancelCompose(): void { return this.features.composition.cancelCompose(); }

  hasCompose(): boolean { return this.features.composition.hasCompose(); }

  /**
   * 画板 / 切片导出（U56）。
   *
   * 范围与命名来自内核计划，字节由内核编码，落盘走宿主的文件交付端口；任一产物失败即整体
   * 失败并返回原因。没有宿主端口时明确拒绝，不假装导出成功。
   */
  exportCompositionArtifacts(kind: "slices" | "artboards"): Promise<EditorResult<CompositionExportResult>> {
    const draft = this.blockingDraft();
    if (draft && draft.code.endsWith("-active")) return Promise.resolve(draft as never);
    return exportCompositionArtifacts(this.features.composition, kind, this.options.fileDelivery);
  }

  viewAids(): EditorResult<unknown> { return this.features.views.viewAids(); }

  /** 视图辅助（标尺/网格/参考线/吸附）：不进文档内容或历史。 */
  setViewAids(params: Record<string, unknown>): EditorResult<unknown> { return this.features.views.setViewAids(params); }

  /** 源坐标吸附（`tolerance` 是屏幕像素，按 `zoom` 换算）。 */
  snapPoint(point: [number, number], zoom: number, tolerance = 6): EditorResult<unknown> { return this.features.views.snapPoint(point, zoom, tolerance); }

  /** 图层列表过滤（只影响列表；`by` 是 U63 的主条件，`mode` 配合 `by: "mode"`）。 */
  filterLayers(params: { name?: string; kinds?: string[]; by?: "kind" | "name" | "mode"; mode?: string; onlySelected?: boolean }): EditorResult<unknown> { return this.features.layers.filterLayers(params); }

  /** 文字排版参数（行距/字距/字偶距/基线偏移）。 */
  applyTypography(params: Record<string, unknown>): EditorResult<EditorViewModel> { return this.features.type.applyTypography(params); }

  /** 矢量命令（形状/路径/矢量蒙版/路径转选区）。 */
  /** 矢量命令（形状/路径/矢量蒙版/路径转选区）。`token` 由手势开始时捕获，用于丢弃晚到写入。 */
  vectorCommand(id: string, params: unknown, token?: VectorDocumentToken): EditorResult<EditorViewModel> { return this.features.vectors.vectorCommand(id, params, token); }

  /** 当前文档代际令牌：矢量手势开始与提交共用，换文档后旧手势不再写入。 */
  token(): VectorDocumentToken { return this.vectorToken(); }

  /** 参考线/标尺（视图数据）。 */
  guideCommand(id: string, params: unknown): EditorResult<EditorViewModel> { return this.features.views.guideCommand(id, params); }

  vectorSnapshot(): EditorResult<unknown> { return this.features.vectors.vectorSnapshot(); }

  /** 字体是否真实可用（缺字体明确报告，不伪造）。 */
  checkFont(font: string): EditorResult<unknown> { return this.features.type.checkFont(font); }

  /** 是否有任何活动草稿（新入口的统一门禁）。 */
  hasActiveDraft(): boolean {
    return this.propertiesActive || this.adjustmentActive || this.textActive || this.transformActive
      || this.strokeActive || this.selectionModifyActive || this.retouchActive || this.filterActive
      || this.composeActive || this.vectorDraftActive || this.canvasToolDraftActive;
  }

  /**
   * 是否正在冻结/保存（含尚未得到权威回执的产物）。
   *
   * 与 `hasActiveDraft()` 分开：草稿需要用户先结算，保存需要等待回执。两者对「切标签/关闭/
   * 重复保存」都是必须拒绝的理由，但拒绝文案不同，因此不合并成一个布尔。
   */
  isSaving(): boolean {
    return Boolean(this.saving || this.pendingArtifacts
      || this.state.phase === "freezing" || this.state.phase === "saving");
  }

  /**
   * 未结算草稿的拒绝原因（保存、切标签、关闭共用同一权威）。
   *
   * 与 `save()`/`dispatch()` 内部用的是同一个 `blockingDraft()`：宿主不需要自己再列一遍草稿
   * 种类，也不会因为漏了某个域而出现「保存会拒绝、切标签却放行」的不一致
   * （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.3）。
   */
  pendingDraftFailure(): EditorFailure | null {
    return this.blockingDraft();
  }

  /**
   * 登记/清除矢量草稿（形状拖绘、钢笔未完成路径、锚点拖动）。
   *
   * 矢量草稿由 `features/vectors` 的归约器持有，但保存、切标签、关闭与父子回写必须能看见它；
   * 因此这里只登记一个原因字符串，不复制手势状态
   * （change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.3）。
   */
  setVectorDraft(active: boolean): void {
    if (this.vectorDraftActive === active) return;
    this.vectorDraftActive = active;
    // 门禁变化要反映到快照（切标签按钮与保存按钮据此禁用）。
    this.setState(this.state.phase, this.state.message, this.isDirty(), this.state.retriable);
  }

  /** 尚未交给内核的画布工具草稿也阻止保存、切文档和关闭。 */
  setCanvasToolDraft(active: boolean): void {
    if (this.canvasToolDraftActive === active) return;
    this.canvasToolDraftActive = active;
    this.setState(this.state.phase, this.state.message, this.isDirty(), this.state.retriable);
  }

  /** 当前矢量草稿是否未结算。 */
  hasVectorDraft(): boolean {
    return this.vectorDraftActive;
  }

  /**
   * 当前文档代际令牌（change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.3）。
   *
   * 手势开始时捕获、提交时回传：会话已 dispose 或换文档后，晚到的矢量命令被丢弃，
   * 不会写入后来活动文档（与 `generation` + 活动文档索引共同判定）。
   */
  vectorToken(): VectorDocumentToken {
    return { generation: this.generation, session: this.view.sessionActiveIndex };
  }

  /**
   * 排除「当前正在提交的矢量草稿」后的门禁。
   *
   * 矢量手势的草稿由域内归约器持有（React 状态），而它提交时又必须经过
   * `blockingDraft()`。若不加区分，草稿会拦住自己的提交。这里只放行矢量自身，
   * 其它草稿（属性/调整/文字/变换/笔迹/修饰/滤镜/构图）照常拦截。
   */
  blockingDraftExceptVector(): EditorFailure | null {
    return this.blockingDraft(true);
  }

  /** 门禁失败原因（供新入口直接复用统一文案）。`skipVectorDraft` 只在矢量自身提交时使用。 */
  private blockingDraft(skipVectorDraft = false): EditorFailure | null {
    if (this.propertiesActive) return this.propertiesPending();
    if (this.adjustmentActive) return this.adjustmentPending();
    if (this.textActive) return this.textPending();
    if (this.transformActive) return this.transformPending();
    if (this.strokeActive) return { ok: false, code: "stroke-active", message: "请先结束当前笔迹" };
    if (this.selectionModifyActive) return { ok: false, code: "selection-modify-active", message: "请先确认或取消选区修改" };
    if (this.retouchActive) return { ok: false, code: "retouch-active", message: "请先结束或取消当前修饰笔迹" };
    if (this.filterActive) return { ok: false, code: "filter-active", message: "请先确认或取消滤镜草稿" };
    if (this.composeActive) return { ok: false, code: "compose-active", message: "请先确认或取消构图修改" };
    if (this.canvasToolDraftActive) return { ok: false, code: "gesture-active", message: "请先完成或取消当前画布工具操作" };
    if (this.vectorDraftActive && !skipVectorDraft) return { ok: false, code: "vector-active", message: "请先完成或取消当前矢量操作" };
    return null;
  }

  /**
   * 导出/保存期的写入门（change: 2026-10-22-add-photocraft-painting-color-workflows，任务 3.3）。
   *
   * 与 `dispatch()` 曾经的内联判断逐字一致，现在抽成方法并对外暴露给域会话，避免「域里直连
   * 内核的写入口只查草稿门」这条旁路。冻结在同步导出内完成，这里只挡界面竞态。
   */
  private frozenGate(): EditorFailure | null {
    if (this.pendingArtifacts || this.state.phase === "freezing" || this.state.phase === "saving") {
      return { ok: false, code: "frozen", message: "导出期间不接受内容修改" };
    }
    return null;
  }
  /** 重做。 */
  redo(): EditorResult<EditorViewModel> { return this.dispatch("edit.redo"); }

  /** 合成预览像素（画布元素直接绘制）。 */
  sampleColor(x: number, y: number): EditorResult<string | null> {
    if (!this.handle) return this.unavailable();
    if (this.propertiesActive || this.adjustmentActive || this.textActive || this.strokeActive || this.transformActive) return {ok:false,code:"gesture-active",message:"请先结束当前操作"};
    return this.handle.sampleColor(x,y);
  }

  layerThumbnail(layer: number, mask: boolean): EditorResult<EditorPreview> {
    return this.handle ? this.handle.layerThumbnail(layer,mask) : this.unavailable();
  }

  render(maxSide: number): EditorResult<EditorPreview> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const preview = handle.renderPreview(maxSide);
    if (!preview.ok) {
      this.setState("failed", preview.message, this.isDirty());
      return preview;
    }
    return preview;
  }

  /** 细节读取失败由调用者保留基础预览，不将可重试的局部失败升级成文档故障。 */
  renderRegion(region: EditorPreviewRegion): EditorResult<EditorPreview> {
    return this.handle ? this.handle.renderRegion(region) : this.unavailable();
  }

  isDirty(): boolean {
    return this.options.session.isDirty();
  }

  /**
   * 冻结当前修订并写回：冻结 → 成对产物复核 → 上传 → edit-complete。
   *
   * 成功后推进基线；失败保留现场并返回可重试标记（design D7）。
   */
  save(): Promise<EditorSaveOutcome> {
    if (this.saving) return this.saving;
    const generation = this.generation;
    const operation = this.performSave().catch((error) => generation === this.generation
      ? this.failSave("complete-failed", error instanceof Error ? error.message : "保存失败，请重试", true)
      : this.closedSave());
    this.saving = operation;
    void operation.finally(() => { if (this.saving === operation) this.saving = null; });
    return operation;
  }

  private async performSave(): Promise<EditorSaveOutcome> {
    const generation = this.generation;
    const handle = this.handle;
    const session = this.options.session;
    if (!handle) return { ok: false, code: "invalid-artifacts", message: "编辑器尚未就绪", retriable: false };
    const draft = this.blockingDraft();
    if (draft) return { ok: false, code: "freeze-failed", message: draft.message, retriable: true };
    const revision = this.view.document?.revision;
    this.setState("freezing", null, this.isDirty());
    session.beginFreeze();
    if (!this.pendingArtifacts || this.pendingArtifacts.revision !== revision) {
      const frozen = await freezeProjectArtifacts(handle, this.options.digest);
      if (generation !== this.generation) return this.closedSave();
      if (!frozen.ok) {
        session.resumeEditing();
        return this.failSave("freeze-failed", frozen.message, true);
      }
      this.frozen = frozen.value;
      this.pendingArtifacts = frozen.value;
    }
    session.beginSave();
    this.setState("saving", null, true);
    const saveGeneration = this.generation;
    const outcome = await this.options.save({
      artifacts: this.pendingArtifacts,
      sourceAssetIds: [...this.placedAssetIds],
      isCurrent: () => saveGeneration === generation && this.generation === generation
    });
    if (generation !== this.generation) return this.closedSave();
    if (outcome.ok) {
      const contentHash = this.pendingArtifacts.documentContentHash;
      this.pendingArtifacts = null;
      // 内容的权威身份由宿主持有；这里只交回同一修订的文档内容 hash 推进基线。
      session.commitBaseline(contentHash);
      this.setState("saved", null, false);
    } else {
      if (outcome.code === "conflict" || !outcome.retriable) this.pendingArtifacts = null;
      session.failSave(outcome.message);
      this.setState("failed", outcome.message, this.isDirty(), outcome.retriable);
    }
    return outcome;
  }

  /** 释放：丢弃内核句柄与冻结产物（退出后不再写回）。 */
  dispose(): void {
    this.cancelLayerProperties();
    this.cancelAdjustment();
    this.cancelText();
    this.cancelStroke();
    this.cancelTransform();
    this.cancelSelectionModify();
    this.cancelRetouch();
    this.cancelFilter();
    this.cancelCompose();
    // 矢量草稿是纯界面状态（尚未落任何命令），释放时直接清除登记，不额外写文档。
    this.vectorDraftActive = false;
    this.canvasToolDraftActive = false;
    this.closeSmartChild();
    this.generation++;
    this.saving = null;
    this.handle?.closeDocument();
    this.handle = null;
    this.smartChild?.dispose();
    this.smartChild = null;
    this.smartChildProject = null;
    this.frozen = null;
    this.pendingArtifacts = null;
    this.placedAssetIds.clear();
    this.commandIndex.clear();
    this.brushes.refresh(null);
    this.view = { hasDocument: false, document: null, sessionActiveIndex: null };
    this.setState("idle", null, false);
  }

  /** 初始化阶段分任务执行；完成前不发布半成品编辑状态。 */
  private async afterOpen(handle: EditorHandle, generation: number, baseline: boolean): Promise<EditorResult<EditorViewModel>> {
    const yieldTask = this.options.yieldTask ?? yieldEditorTask;
    const current = () => generation === this.generation && this.handle === handle;
    await yieldTask();
    if (!current()) return this.unavailable();
    const state = handle.state();
    if (!state.ok) return this.fail(state);
    const view = decodeEditorState(state.value);
    if (!view) return this.fail({ ok: false, code: "invalid-message", message: "内核状态结构非法" });
    await yieldTask();
    if (!current()) return this.unavailable();
    const commands = handle.commands();
    const allowed = commands.ok ? indexRenderableCommands(commands.value) : new Map<string, PhotocraftCommand>();
    await yieldTask();
    if (!current()) return this.unavailable();
    this.view = view;
    this.commandIndex = allowed;
    // 文档被换进来了：即使修订号与内容指纹碰巧和上一份相同，上一份文档的计划也已失效。
    this.contentGeneration += 1;
    this.syncSession(view);
    if (baseline) this.options.session.establishBaseline();
    this.options.onViewModel?.(view, allowed);
    this.setState("editing", null, this.isDirty());
    return { ok: true, value: view };
  }

  /** 写操作后重新取内核状态与命令表，并同步会话内容状态。 */
  private afterWrite(establishBaseline = false): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const state = handle.state();
    if (!state.ok) return this.fail(state);
    const view = decodeEditorState(state.value);
    if (!view) return this.fail({ ok: false, code: "invalid-message", message: "内核状态结构非法" });
    this.view = view;
    const commands = handle.commands();
    const allowed = commands.ok ? indexRenderableCommands(commands.value) : new Map<string, PhotocraftCommand>();
    this.commandIndex = allowed;
    this.syncSession(view);
    if (establishBaseline) this.options.session.establishBaseline();
    this.options.onViewModel?.(view, allowed);
    this.setState("editing", null, this.isDirty());
    return { ok: true, value: view };
  }

  /** 把内核视图折算成会话需要的轻量内容状态。 */
  private syncSession(view: EditorViewModel): void {
    if (!view.hasDocument || !view.document) return;
    const handle = this.handle;
    if (!handle) return;
    const hash = handle.contentHash();
    if (!hash.ok) return;
    const activeIndex = view.document.activeLayerId === null
      ? 0
      : Math.max(0, view.document.layers.findIndex((layer) => layer.id === view.document!.activeLayerId));
    const state: PhotocraftContentState = {
      canvasWidth: view.document.width,
      canvasHeight: view.document.height,
      layerCount: view.document.layers.length,
      activeLayerIndex: activeIndex,
      documentContentHash: hash.value,
      revision: view.document.revision,
      dirty: this.options.session.isDirty(),
      frozen: this.state.phase === "freezing"
    };
    this.options.session.applyContentState(state);
  }

  private closedSave(): EditorSaveOutcome { return { ok: false, code: "complete-failed", message: "编辑会话已结束", retriable: false }; }

  private unavailable(): EditorFailure {
    return { ok: false, code: "no-document", message: "编辑器尚未加载" };
  }

  private fail<T>(failure: EditorFailure): EditorResult<T> {
    this.setState("failed", failure.message, true);
    return failure;
  }

  private failSave(code: string, message: string, retriable: boolean): EditorSaveOutcome {
    this.options.session.failSave(message);
    this.setState("failed", message, this.isDirty(), retriable);
    return { ok: false, code, message, retriable };
  }

  private setState(
    phase: EditorWorkspacePhase,
    message: string | null,
    dirty = this.state.dirty,
    retriable = phase === "failed"
  ): EditorWorkspaceState {
    this.state = { phase, message, dirty, retriable };
    // 状态/视图已变：作废快照缓存，让订阅者拿到新的引用（未变化时复用同一引用）。
    this.snapshotCache = null;
    this.options.onState?.(this.currentState());
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
    return this.currentState();
  }
}

/**
 * 是否应当向用户提供「在编辑器中打开」入口。
 *
 * 编辑器始终可用（内核随应用打包，没有独立产物要解析），因此只取决于工程可编辑与写权限。
 */
export function shouldOfferProjectEditor(input: { project: { canOpenProject(): boolean }; writable?: boolean }): boolean {
  if (input.writable === false) return false;
  return input.project.canOpenProject();
}
