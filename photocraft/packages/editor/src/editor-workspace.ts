import type {HistogramReadout} from "./histogram-data.js";
import type {PixelGridRegion,PixelGridSegment} from "./pixel-grid-data.js";
import type {InfoRequest,InfoReadout} from "./info-readout.js";
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
import {EXPORT_FORMATS, type EditorAssetPort, type EditorEditingOwner, type EditorExportOptions, type EditorFileDeliveryResult, type EditorFilePort } from "./ports.js";
import type { EditorDocumentSession, EditorSaveOutcome, EditorSavePort } from "./session.js";
import {
  loadEditor,
  type CloneSourceList,
  type CloneSourceOverlay,
  type CloneSourceSlot,
  type EditorFailure,
  type EditorHandle,
  type EditorPreview,
  type EditorPreviewRegion,
  type EditorResult
} from "./editor-wasm.js";
export type { CloneSourceList, CloneSourceOverlay, CloneSourceSlot };
import { decodeEditorState, indexRenderableCommands, type EditorViewModel } from "./editor-view-model.js";

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
  /**
   * 宿主上报的真实保存进度（0–100）；没有可测量的宿主时缺省。
   *
   * 只在 `phase === "saving"` 有意义。编辑器从不估算：宿主不调用 `onProgress` 时这里保持缺省，
   * 界面继续只显示「保存中」。
   */
  savePercent?: number;
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
  onState?: (state: EditorWorkspaceState) => void;
  onViewModel?: (view: EditorViewModel, commands: Map<string, unknown>) => void;
};

export class EditorWorkspaceController {
  private readonly options: EditorWorkspaceOptions;
  private state: EditorWorkspaceState = { phase: "idle", message: null, dirty: false, retriable: false };
  /** 当前保存上报的真实进度；`undefined` 表示宿主没有提供可测进度。 */
  private savePercent: number | undefined;
  private handle: EditorHandle | null = null;
  private view: EditorViewModel = { hasDocument: false, document: null, sessionActiveIndex: null };
  private frozen: ProjectExportArtifacts | null = null;
  /** 最近一次冻结但尚未权威确认的产物（重试复用，不重新冻结）。 */
  private pendingArtifacts: ProjectExportArtifacts | null = null;
  private saving: Promise<EditorSaveOutcome> | null = null;
  private generation = 0;
  private strokeActive = false;
  private transformActive = false;
  private textActive = false;
  private textCheckpointed = false;
  private adjustmentActive = false;
  private rotationActive=false;
  private propertiesActive = false;
  private readonly placedAssetIds = new Set<string>();
  private commandIndex: Map<string, PhotocraftCommand> = new Map();
  /** 快照缓存：`useSyncExternalStore` 要求未变化时返回同一引用，否则会无限重渲染。 */
  private snapshotCache: EditorSnapshot | null = null;
  private readonly listeners = new Set<(snapshot: EditorSnapshot) => void>();

  constructor(options: EditorWorkspaceOptions) {
    this.options = options;
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
    if (!this.handle || this.strokeActive || this.transformActive || this.textActive || this.propertiesActive
      || this.adjustmentActive || this.saving || this.pendingArtifacts
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

  /** 最近一次视图模型。 */
  currentView(): EditorViewModel {
    return this.view;
  }

  canDuplicateDocument():boolean {return this.view.hasDocument && this.state.phase==="editing" && this.canDispatchCommands() && this.handle?.canDuplicateProject()===true;}
  duplicateDocument(name:string):EditorResult<Uint8Array> {
    if(!this.handle)return this.unavailable();
    if(!this.view.hasDocument || this.state.phase!=="editing" || !this.canDispatchCommands())return {ok:false,code:"gesture-active",message:"请先结束当前编辑或保存，再复制文档"};
    return this.handle.duplicateProject(name);
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
    if (this.rotationActive || this.propertiesActive) return { ok: false, code: "properties-active", message: this.rotationActive?"请先确认或取消画布旋转":"请先确认或取消图层属性编辑" };
    if (this.adjustmentActive) return { ok: false, code: "adjustment-active", message: "请先确认或取消调整参数编辑" };
    if (this.textActive) return { ok: false, code: "text-active", message: "请先确认或取消文字编辑" };
    if (this.transformActive) return { ok: false, code: "transform-active", message: "请先确认或取消自由变换" };
    if (this.strokeActive) return { ok: false, code: "stroke-active", message: "请先结束当前笔迹" };
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
  /**
   * 按所选格式与控制导出当前修订（I045）。
   *
   * 与 `deliverFile` 的区别：这里只导出**扁平图像**，不推进工程保存基线（导出的 JPEG 不代表
   * 工程已保存）。编码由内核完成，字节走同一单文件交付端口。
   */
  async exportImage(options:EditorExportOptions):Promise<EditorFileDeliveryResult> {
    const deliver=this.options.fileDelivery;
    if(!deliver)return {ok:false,status:"failed",message:"当前宿主不支持本地文件导出"};
    if(this.rotationActive||this.propertiesActive)return {ok:false,status:"failed",message:"请先确认或取消图层属性编辑"};
    if(this.adjustmentActive)return {ok:false,status:"failed",message:"请先确认或取消调整参数编辑"};
    if(this.textActive&&!this.textCheckpointed)return {ok:false,status:"failed",message:"请先确认或取消文字编辑"};
    if(this.transformActive)return {ok:false,status:"failed",message:"请先确认或取消自由变换"};
    if(this.strokeActive)return {ok:false,status:"failed",message:"请先结束当前笔迹再导出"};
    const handle=this.handle;
    if(!handle)return {ok:false,status:"failed",message:"编辑器尚未就绪"};
    if(this.saving||this.state.phase==="freezing"||this.state.phase==="saving")return {ok:false,status:"failed",message:"保存正在进行，请稍候"};
    const generation=this.generation;
    const format=EXPORT_FORMATS[options.format];
    if(!format)return {ok:false,status:"failed",message:"不支持的导出格式"};
    this.setState("freezing",null,this.isDirty());
    try {
      const result=handle.exportImage(options);
      if(generation!==this.generation)return {ok:false,status:"failed",message:"编辑会话已结束"};
      if(!result.ok)return {ok:false,status:"failed",message:result.message};
      this.setState("saving",null,this.isDirty());
      const base=(this.view.document?.name??"photocraft").replace(/\.[^.]+$/,"")||"photocraft";
      return await deliver({fileName:`${base}.${format.extension}`,contentType:format.contentType,bytes:result.value.output});
    } catch(error) {
      return {ok:false,status:"failed",message:error instanceof Error?error.message:"导出失败，请重试"};
    } finally {
      if(generation===this.generation)this.setState("editing",null,this.isDirty());
    }
  }

  async deliverFile(kind: "project" | "png", options: { fileName?: string } = {}): Promise<EditorFileDeliveryResult> {    const deliver = this.options.fileDelivery;
    if (!deliver) return { ok: false, status: "failed", message: "当前宿主不支持本地文件保存" };
    if (this.rotationActive || this.propertiesActive) return { ok: false, status: "failed", message: this.rotationActive?"请先确认或取消画布旋转":"请先确认或取消图层属性编辑" };
    if (this.adjustmentActive) return { ok: false, status: "failed", message: "请先确认或取消调整参数编辑" };
    if (this.textActive && !this.textCheckpointed) return { ok: false, status: "failed", message: "请先确认或取消文字编辑" };
    if (this.transformActive) return { ok: false, status: "failed", message: "请先确认或取消自由变换" };
    if (this.strokeActive) return { ok: false, status: "failed", message: "请先结束当前笔迹再导出" };
    const handle = this.handle;
    if (!handle) return { ok: false, status: "failed", message: "编辑器尚未就绪" };
    if(this.saving || this.state.phase==="freezing" || this.state.phase==="saving") return {ok:false,status:"failed",message:"保存正在进行，请稍候"};
    const generation = this.generation;
    this.setState("freezing",null,this.isDirty());
    try {
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
    this.setState("saving",null,this.isDirty());
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
    } catch(error) {return {ok:false,status:"failed",message:error instanceof Error?error.message:"保存失败，请重试"};}
    finally {if(generation===this.generation) this.setState("editing",null,this.isDirty());}
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
    return loaded;
  }

  /** 打开图片（纯媒体或 v1 标注 → 工程）。 */
  async openImage(input: { name: string; assetId: string; bytes: Uint8Array }): Promise<EditorResult<EditorViewModel>> {
    if (this.rotationActive || this.propertiesActive) return this.propertiesPending();
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
    if (this.rotationActive || this.propertiesActive) return this.propertiesPending();
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
    if (this.rotationActive || this.propertiesActive) return this.propertiesPending();
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
    if (this.rotationActive || this.propertiesActive) return this.propertiesPending();
    if (this.adjustmentActive) return this.adjustmentPending();
    if (this.textActive) return this.textPending();
    if (this.transformActive) return this.transformPending();
    if (this.pendingArtifacts || this.state.phase === "freezing" || this.state.phase === "saving") {
      return { ok: false, code: "frozen", message: "导出期间不接受内容修改" };
    }
    if (this.strokeActive) return { ok: false, code: "stroke-active", message: "请先结束当前笔迹" };
    const result = handle.execute(id, params);
    if (!result.ok) return this.fail(result);
    return this.afterWrite();
  }

  /** Search results retain native UTF-8 ranges; the dialog never maps them to DOM text offsets. */
  findReplaceText(params:unknown):EditorResult<Record<string,unknown>> {
    if(!this.handle || !this.canDispatchCommands())return {ok:false,code:"gesture-active",message:"请先结束当前编辑或保存"};
    const result=this.handle.execute("edit.findAndReplaceText",params);
    if(!result.ok)return this.fail(result);
    const refreshed=this.afterWrite();if(!refreshed.ok)return refreshed;
    try {const value=typeof result.value==="string"?JSON.parse(result.value):result.value;
      if(!value || typeof value!=="object" || Array.isArray(value))throw new Error();
      return {ok:true,value:value as Record<string,unknown>};
    }catch{return {ok:false,code:"invalid-state",message:"无法读取查找替换结果"};}
  }

  /** Read-only document metadata (XMP + camera EXIF); never a document write. */
  fileInfo(): EditorResult<Record<string, unknown>> {
    if(!this.handle || !this.canDispatchCommands()) return {ok:false,code:"gesture-active",message:"请先结束当前编辑或保存"};
    const result=this.handle.execute("file.fileInfo",null);
    if(!result.ok)return this.fail(result);
    try{const value=typeof result.value==="string"?JSON.parse(result.value):result.value;
      if(!value || typeof value!=="object" || Array.isArray(value))throw new Error();
      return {ok:true,value:value as Record<string,unknown>};
    }catch{return {ok:false,code:"invalid-state",message:"无法读取文件信息"};}
  }

  /** Spelling ranges stay native character indices; no DOM offset conversion. */
  checkSpelling(params:unknown):EditorResult<Record<string,unknown>> {
    if(!this.handle || !this.canDispatchCommands())return {ok:false,code:"gesture-active",message:"请先结束当前编辑或保存"};
    const result=this.handle.execute("edit.checkSpelling",params);
    if(!result.ok)return this.fail(result);
    const refreshed=this.afterWrite();if(!refreshed.ok)return refreshed;
    try {const value=typeof result.value==="string"?JSON.parse(result.value):result.value;
      if(!value || typeof value!=="object" || Array.isArray(value))throw new Error();
      return {ok:true,value:value as Record<string,unknown>};
    }catch{return {ok:false,code:"invalid-state",message:"无法读取拼写检查结果"};}
  }

  /** 拾取的命中值与刷新后的视图分开返回，空白不能复用上次活动层。 */
  pickLayerAt(params:{x:number;y:number;target:"layer"|"group";mode?:"add"|"replace";select?:boolean}):EditorResult<number|null> {
    if(!this.handle || !this.canDispatchCommands()) return {ok:false,code:"gesture-active",message:"请先结束当前操作"};
    const picked=this.handle.execute("layer.pickAt",params);
    if(!picked.ok) return this.fail(picked);
    const refreshed=this.afterWrite();if(!refreshed.ok) return refreshed;
    try {
      const value=typeof picked.value==="string"?JSON.parse(picked.value):picked.value;
      return {ok:true,value:typeof value?.layer==="number"?value.layer:null};
    } catch {return {ok:false,code:"invalid-state",message:"无法读取图层命中结果"};}
  }

  /** 跨文档内存操作预检；不修改状态，也不结束任何草稿或冻结结果。 */
  canDispatchCommands():boolean {
    return !!this.handle && !this.rotationActive && !this.propertiesActive && !this.adjustmentActive && !this.textActive && !this.transformActive && !this.strokeActive
      && !this.saving && !this.pendingArtifacts && this.state.phase!=="freezing" && this.state.phase!=="saving";
  }

  /** 临时笔迹不发布内容状态，只有提交才同步修订与净变化。 */
  beginStroke(params: unknown): EditorResult<void> {
    if (!this.handle) return this.unavailable();
    if (this.rotationActive || this.propertiesActive) return this.propertiesPending();
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

  strokeWantsTime():boolean {return this.strokeActive && (this.handle?.strokeWantsTime()??false);}

  takeStrokeDamage():EditorResult<EditorPreviewRegion[]> {
    return this.handle&&this.strokeActive ? this.handle.takeStrokeDamage() : this.unavailable();
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

  hasImageRotation():boolean {return this.rotationActive;}
  hasStroke():boolean {return this.strokeActive;}
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
  /**
   * 图层重排的画布预览（I218）。
   *
   * 候选只影响预览合成：不写正式文档、历史或指纹；释放时的 `layer.moveTo` 才是唯一提交。
   */
  beginReorderPreview():EditorResult<unknown> {
    if(!this.handle) return this.unavailable();
    if(!this.handle.beginReorderPreview) return {ok:false,code:"unsupported",message:"当前编辑内核未提供图层重排预览"};
    return this.handle.beginReorderPreview();
  }
  previewReorder(params:unknown):EditorResult<unknown> {
    if(!this.handle||!this.handle.previewReorder) return {ok:false,code:"unsupported",message:"当前编辑内核未提供图层重排预览"};
    return this.handle.previewReorder(params);
  }
  endReorderPreview():EditorResult<boolean> {
    if(!this.handle||!this.handle.endReorderPreview) return {ok:true,value:false};
    return this.handle.endReorderPreview();
  }
  /** 克隆源面板：读取为只读；写命令只改会话预设，不推进文档内容身份。 */
  cloneSources() {return this.handle?.cloneSourceList()??this.unavailable();}
  /**
   * 画笔预设（I058/I132/I136）。
   *
   * 预设属于会话状态：不推进文档内容身份或历史。读取走只读命令，写入走 `brush.presets.*`
   * 与 `brush.defineFromSelection`，由内核复核选区与像素目标。
   */
  brushPresets():EditorResult<unknown> {
    return this.handle ? this.handle.execute("brush.presets.list", {full:false}) : this.unavailable();
  }
  /**
   * 新建文档的命名预设与最近设置（I064）。
   *
   * 两者都由固定引擎的 `document.*` 命令持有；编辑器只读列表，写入走同一命令。
   * `file.new` 本身是唯一的建文档入口，且只在宿主允许工作时可用。
   */
  documentPresets():EditorResult<unknown> {
    return this.handle ? this.handle.execute("document.presets.list", null) : this.unavailable();
  }
  documentPresetSave(name:string,settings:Record<string,unknown>):EditorResult<unknown> {
    return this.documentPresetWrite("document.presets.save",{name,settings});
  }
  documentPresetDelete(name:string):EditorResult<unknown> {
    return this.documentPresetWrite("document.presets.delete",{name});
  }
  recentDocuments():EditorResult<unknown> {
    return this.handle ? this.handle.execute("document.recent.list", null) : this.unavailable();
  }
  addRecentDocument(settings:Record<string,unknown>):EditorResult<unknown> {
    return this.documentPresetWrite("document.recent.add",{settings});
  }
  /** 新建文档：真正的写入口，仍由内核校验尺寸/模式/位深与资源预算。 */
  newDocument(settings:Record<string,unknown>):EditorResult<EditorViewModel> {
    return this.dispatch("file.new",settings);
  }
  private documentPresetWrite(id:string,params:unknown):EditorResult<unknown> {
    const handle=this.handle;
    if(!handle)return this.unavailable();
    if(!this.canDispatchCommands())return {ok:false,code:"gesture-active",message:"请先结束当前编辑或保存"};
    const result=handle.execute(id,params);
    if(!result.ok)return this.fail(result);
    return result;
  }  saveBrushPreset(name:string):EditorResult<unknown> {return this.brushPresetWrite("brush.presets.save",{name});}
  updateBrushPreset(name?:string):EditorResult<unknown> {return this.brushPresetWrite("brush.presets.update",name===undefined?{}:{name});}
  deleteBrushPreset(name:string):EditorResult<unknown> {return this.brushPresetWrite("brush.presets.delete",{name});}
  setBrushPreset(name:string):EditorResult<unknown> {return this.brushPresetWrite("tools.setBrush",{preset:name});}
  defineBrushFromSelection(name:string):EditorResult<unknown> {return this.brushPresetWrite("brush.defineFromSelection",{name});}
  private brushPresetWrite(id:string,params:unknown):EditorResult<unknown> {
    const handle=this.handle;
    if(!handle)return this.unavailable();
    if(!this.canDispatchCommands())return {ok:false,code:"gesture-active",message:"请先结束当前编辑或保存"};
    const result=handle.execute(id,params);
    if(!result.ok)return this.fail(result);
    this.refreshPresetViews();
    return result;
  }
  cloneSourceSelect(index:number) {
    if(!this.handle) return this.unavailable();
    if(this.strokeActive || this.transformActive || this.textActive || this.propertiesActive || this.adjustmentActive) return this.clonePending();
    const result=this.handle.cloneSourceSelect(index);
    if(result.ok)this.refreshPresetViews();
    return result;
  }
  cloneSourceSet(params:unknown) {
    if(!this.handle) return this.unavailable();
    if(this.strokeActive || this.transformActive || this.textActive || this.propertiesActive || this.adjustmentActive) return this.clonePending();
    const result=this.handle.cloneSourceSet(params);
    if(result.ok)this.refreshPresetViews();
    return result;
  }
  cloneSourceResetTransform(index:number) {
    if(!this.handle) return this.unavailable();
    if(this.strokeActive || this.transformActive || this.textActive || this.propertiesActive || this.adjustmentActive) return this.clonePending();
    const result=this.handle.cloneSourceResetTransform(index);
    if(result.ok)this.refreshPresetViews();
    return result;
  }
  cloneSourceOverlay(params:unknown) {
    if(!this.handle) return this.unavailable();
    const result=this.handle.cloneSourceOverlay(params);
    if(result.ok)this.refreshPresetViews();
    return result;
  }
  /** 克隆源变更只影响会话预设：重新发布视图，但不推进保存基线或内容修订。 */
  private refreshPresetViews():void {
    const refreshed=this.afterWrite();if(!refreshed.ok)return;
  }
  private clonePending():EditorFailure {
    return {ok:false,code:"gesture-active",message:"请先结束当前操作再修改克隆源"};
  }  hasLayerProperties():boolean {return this.propertiesActive;}
  beginLayerProperties(layer:number):EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    if (this.rotationActive || this.propertiesActive || this.adjustmentActive || this.textActive || this.strokeActive || this.transformActive || this.saving
      || this.pendingArtifacts || this.state.phase==="freezing" || this.state.phase==="saving") return this.propertiesPending();
    const result=this.handle.beginLayerProperties(layer);this.propertiesActive=result.ok;return result;
  }
  beginLayerVisibility(layer:number):EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    if (this.rotationActive || this.propertiesActive || this.adjustmentActive || this.textActive || this.strokeActive || this.transformActive || this.saving
      || this.pendingArtifacts || this.state.phase==="freezing" || this.state.phase==="saving") return this.propertiesPending();
    const result=this.handle.beginLayerVisibility(layer);this.propertiesActive=result.ok;return result;
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
    return {ok:false,code:this.rotationActive?"rotation-active":"properties-active",message:this.rotationActive?"请先确认或取消画布旋转":"请先确认或取消图层属性编辑"};
  }
  curveGeometry(points: readonly [number,number][]): EditorResult<number[]> {
    return this.handle ? this.handle.curveGeometry(points) : this.unavailable();
  }

  beginImageRotation():EditorResult<unknown> {
    if(!this.handle || !this.canDispatchCommands())return this.propertiesPending();
    const result=this.handle.beginImageRotation();this.rotationActive=result.ok;return result;
  }
  previewImageRotation(params:unknown):EditorResult<unknown> {return this.handle && this.rotationActive?this.handle.previewImageRotation(params):this.unavailable();}
  commitImageRotation():EditorResult<EditorViewModel> {
    if(!this.handle || !this.rotationActive)return this.unavailable();const result=this.handle.commitImageRotation();if(!result.ok)return result;this.rotationActive=false;return this.afterWrite();
  }
  cancelImageRotation():void {if(this.rotationActive)this.handle?.cancelImageRotation();this.rotationActive=false;}

  clipboardBounds():EditorResult<[number,number,number,number]|null> {return this.handle?this.handle.clipboardBounds():this.unavailable();}
  histogram():EditorResult<HistogramReadout> {return this.handle?this.handle.histogram():this.unavailable();}
  pixelGrid(params:PixelGridRegion):EditorResult<PixelGridSegment[]> {return this.handle?this.handle.pixelGrid(params):this.unavailable();}
  infoReadout(params:InfoRequest):EditorResult<InfoReadout> {return this.handle?this.handle.infoReadout(params):this.unavailable();}
  setPerformancePreferences(historyStates:number,memoryUsageMb:number):EditorResult<EditorViewModel> {
    if(!this.handle || !this.canDispatchCommands())return {ok:false,code:"gesture-active",message:"请先结束当前操作，再调整性能偏好"};
    const result=this.handle.setPerformancePreferences(historyStates,memoryUsageMb);if(!result.ok)return result;return this.afterWrite();
  }
  setHistoryLimit(limit:number):EditorResult<EditorViewModel> {
    if(!this.handle || !this.canDispatchCommands())return {ok:false,code:"gesture-active",message:"请先结束当前操作，再调整历史状态数量"};
    const result=this.handle.setHistoryLimit(limit);if(!result.ok)return result;return this.afterWrite();
  }

  beginAdjustment(layer: number): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    if (this.rotationActive || this.propertiesActive || this.adjustmentActive || this.textActive || this.strokeActive || this.transformActive || this.saving
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
    if (this.rotationActive || this.propertiesActive || this.adjustmentActive || this.textActive || this.strokeActive || this.transformActive || this.saving || this.pendingArtifacts
      || this.state.phase === "freezing" || this.state.phase === "saving") return this.textPending();
    const result=this.handle.beginText(params);
    this.textActive=result.ok;this.textCheckpointed=false;
    return result;
  }

  previewText(params: unknown): EditorResult<unknown> {
    if(!this.handle || !this.textActive || this.saving || this.state.phase==="saving" || this.state.phase==="freezing") return this.unavailable();
    this.textCheckpointed=false;
    return this.handle.previewText(params);
  }

  textGeometry(params: TextGeometryRequest): EditorResult<TextGeometry> {
    return this.handle && this.textActive ? this.handle.textGeometry(params) : this.unavailable();
  }

  checkpointText():EditorResult<unknown> {
    if(!this.handle || !this.textActive || this.saving || this.state.phase==="saving" || this.state.phase==="freezing") return this.unavailable();
    const result=this.handle.checkpointText();if(!result.ok) return result;
    const refreshed=this.afterWrite();if(!refreshed.ok) return refreshed;
    this.textCheckpointed=true;return result;
  }

  commitText(): EditorResult<EditorViewModel> {
    if (!this.handle || !this.textActive || this.saving || this.state.phase==="saving" || this.state.phase==="freezing") return this.unavailable();
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
    if (this.rotationActive || this.propertiesActive || this.adjustmentActive || this.textActive || this.strokeActive || this.transformActive || this.saving || this.pendingArtifacts
      || this.state.phase === "freezing" || this.state.phase === "saving") return this.transformPending();
    const result = selectionOnly ? this.handle.beginTransform(true) : this.handle.beginTransform();
    this.transformActive = result.ok;
    return result;
  }

  beginMove(params: { x: number; y: number; autoSelect: boolean; duplicate: boolean; wholeLayer?: boolean; selectedPixels?: boolean }): EditorResult<boolean> {
    if (!this.handle) return this.unavailable();
    if (this.rotationActive || this.propertiesActive || this.adjustmentActive || this.textActive || this.strokeActive || this.transformActive || this.saving || this.pendingArtifacts
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

  /** 重做。 */
  redo(): EditorResult<EditorViewModel> { return this.dispatch("edit.redo"); }

  /** 合成预览像素（画布元素直接绘制）。 */
  selectionContains(x:number,y:number):EditorResult<boolean> {
    if(!this.handle) return this.unavailable();return this.handle.selectionContains(x,y);
  }

  moveHoverAt(params:{x:number;y:number;target:"layer"|"group"}) {return this.handle&&this.canDispatchCommands()?this.handle.moveHoverAt(params):{ok:false as const,code:"gesture-active",message:"请先结束当前操作"};}

  fontPreview(family:string,size:number,scale:number):EditorResult<EditorPreview> {return this.handle?this.handle.fontPreview(family,size,scale):this.unavailable();}

  missingFonts():EditorResult<string[]> {return this.handle?this.handle.missingFonts():this.unavailable();}

  sampleColor(x: number, y: number,options?:{size:number;sampleLayer:string}): EditorResult<string | null> {
    if (!this.handle) return this.unavailable();
    if (this.rotationActive || this.propertiesActive || this.adjustmentActive || this.textActive || this.strokeActive || this.transformActive) return {ok:false,code:"gesture-active",message:"请先结束当前操作"};
    return this.handle.sampleColor(x,y,options);
  }

  layerThumbnail(layer: number, mask: boolean): EditorResult<EditorPreview> {
    return this.handle ? this.handle.layerThumbnail(layer,mask) : this.unavailable();
  }

  navigatorPreview():EditorResult<EditorPreview> {return this.handle?this.handle.renderPreview(256):this.unavailable();}

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
   * 只读当前画笔设置，供画笔设置面板回填。
   *
   * 走只读端口而不是命令分派：它不是编辑动作，也不应出现在「绘画期间没有额外命令」的断言里。
   * 老内核没有该端口时回退到 `brush.get` 命令。
   */
  currentBrush():EditorResult<unknown> {
    if(!this.handle) return this.unavailable();
    if(this.handle.brushGet) return this.handle.brushGet();
    return this.handle.execute("brush.get", null);
  }
  /** 深合并画笔设置（`tools.setBrush`）；只改会话工具状态，不写文档或历史。 */
  setBrushDynamics(patch:Record<string,unknown>):EditorResult<unknown> {
    return this.brushPresetWrite("tools.setBrush",patch);
  }

  /** 宿主是否提供了本地文件交付端口（导出与另存的前提）。 */
  hasFileDelivery(): boolean {
    return !!this.options.fileDelivery;
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
    if (this.rotationActive || this.propertiesActive) return {...this.propertiesPending(),code:"freeze-failed",retriable:true};
    if (this.adjustmentActive) return { ...this.adjustmentPending(), code: "freeze-failed", retriable: true };
    if (this.textActive && !this.textCheckpointed) return { ...this.textPending(), code: "freeze-failed", retriable: true };
    if (this.transformActive) return { ...this.transformPending(), code: "freeze-failed", retriable: true };
    if (this.strokeActive) return { ok: false, code: "freeze-failed", message: "请先结束当前笔迹再保存", retriable: true };
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
    this.savePercent = undefined;
    this.setState("saving", null, true);
    const saveGeneration = this.generation;
    const reportProgress = (percent: number) => {
      // 只接受真实上报：有限、整数化、单调、0–100，过期代际或已离开 saving 时丢弃。
      if (saveGeneration !== this.generation || this.state.phase !== "saving") return;
      if (!Number.isFinite(percent)) return;
      const next = Math.min(100, Math.max(0, Math.round(percent)));
      if (this.savePercent !== undefined && next <= this.savePercent) return;
      this.savePercent = next;
      this.setState("saving", null, true);
    };
    const outcome = await this.options.save({
      artifacts: this.pendingArtifacts,
      sourceAssetIds: [...this.placedAssetIds],
      isCurrent: () => saveGeneration === generation && this.generation === generation,
      onProgress: reportProgress
    });
    if (generation !== this.generation) return this.closedSave();
    // 保存阶段结束后不再保留进度：成功/失败都回到不带百分比的稳定状态。
    this.savePercent = undefined;
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
    this.cancelImageRotation();
    this.cancelLayerProperties();
    this.cancelAdjustment();
    this.cancelText();
    this.cancelStroke();
    this.cancelTransform();
    this.generation++;
    this.saving = null;
    this.handle?.closeDocument();
    this.handle = null;
    this.frozen = null;
    this.pendingArtifacts = null;
    this.placedAssetIds.clear();
    this.commandIndex.clear();
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
    this.state = { phase, message, dirty, retriable, ...(phase === "saving" && this.savePercent !== undefined ? { savePercent: this.savePercent } : {}) };
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
