/**
 * 文档工作区会话（宿主适配层，无 DOM）
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 1.2–1.4/3.2 / design D1/D3/D5）。
 *
 * 把核心 `EditorDocumentRegistry`（身份、顺序、代际、门禁）与宿主资源绑在一起：每个文档条目
 * 持有一个呈现（节点 `ImageFocusWorkspace` 或独立文件 `FileDocumentWorkspace`）、一个编辑器
 * 控制器与自己的保存 attempt。工作区只把**当前活动文档**绑定到呈现与输入；后台文档保留内容、
 * 撤销与草稿，但不发布预览。
 *
 * 关键约束：
 * - 异步结果按 `(documentId, documentGeneration)` 归属；发布呈现时再核对活动代际；
 * - 切换不保存、不建版本；关闭/离开才结算；
 * - 达到上限拒绝新打开；关闭后旧回调不得复活条目。
 *
 * 本模块不 import 宿主私有实现；节点解析、字节加载与交付端口由插件注入。
 */
import type { ImageProjectDocument } from "@woohaa3/contracts";
import type { EditorDocumentRegistry, EditorDocumentEntry, EditorDocumentStatus } from "@woohaa3/photocraft-editor";
import type { EditorWorkspaceController } from "./editor-workspace.js";
import type { DocumentDirtyState, EditorDocumentView } from "./document-view.js";
import { FileDocumentWorkspace, type FileDocumentKind } from "./file-document-workspace.js";
import { ImageFocusWorkspace } from "./workspace.js";
import { resolveImageFocusTarget } from "./workspace-target.js";

/** 一个打开文档的宿主资源。 */
export type DocumentResource =
  | {
      kind: "node";
      documentId: string;
      nodeId: string;
      /** 节点呈现（原节点由 Bevy 呈现）。 */
      view: ImageFocusWorkspace;
      controller: EditorWorkspaceController | null;
      /** 节点文档的会话身份（edit-begin/complete 用）。 */
      sessionId: string;
      requestId: string | null;
      /**
       * 进入本次编辑会话的 `editBegin` 回执（保存前等待它给出权威基线）。
       *
       * 打开文档时就发起（与旧单文档行为一致），切换 tab 不重建、不重发；
       * 保存成功换新 sessionId 后重新发起（change: 2026-10-21，design D5）。
       */
      begin: Promise<EditSessionBaseline> | null;
      /** 是否曾成功建立编辑会话（失败时切回不重复 begin 同 requestId）。 */
      begun: boolean;
      /**
       * 呈现是否已初始化（入场过渡/原图解码只做一次）。
       *
       * tab 往返与“恢复入口”只把已有呈现重新绑定到导航，不重放 overview 入场
       * （change: 2026-10-21，design D4）。
       */
      started?: boolean;
    }
  | {
      kind: "file";
      documentId: string;
      view: FileDocumentWorkspace;
      controller: EditorWorkspaceController | null;
      /** 稳定本地保存操作身份（重试复用，不重复写版本）。 */
      operationId: string;
      /** 呈现是否已初始化（tab 往返不重放解码）。 */
      started?: boolean;
    };

/** `editBegin` 的最小回执（只保留保存需要的权威基线）。 */
export type EditSessionBaseline =
  | { ok: true; baselineContentIdentity: string }
  | { ok: false; message: string };

export type DocumentWorkspaceDeps = {
  /** 当前工作画布 id（节点身份与上传都带它）。 */
  canvasId: () => string;
  /** 打开节点呈现（构造 `ImageFocusWorkspace`，由插件注入侧效）。 */
  createNodeView: (nodeId: string, entry: EditorDocumentEntry) => ImageFocusWorkspace | null;
  /** 创建编辑器控制器（注入保存依赖与 dialog owner）。 */
  createController: (resource: DocumentResource, entry: EditorDocumentEntry) => EditorWorkspaceController | null;
  /** 解码图片以获得源尺寸（文件文档）。 */
  decodeImage?: (bytes: Uint8Array) => Promise<{ width: number; height: number } | null>;
  /** 呈现矩形来源（内容矩形）。 */
  rect: () => { x: number; y: number; width: number; height: number };
  /** 通知呈现已变化（tab 状态、活动视图）。 */
  onChange?: () => void;
};

export type OpenNodeInput = { nodeId: string; name: string; writable: boolean; detail?: string | null };
export type OpenFileInput = { fileName: string; bytes: Uint8Array; kind: FileDocumentKind };

export type DocumentOpenOutcome =
  | { ok: true; documentId: string; created: boolean }
  | { ok: false; reason: string };

export type DocumentCloseOutcome =
  | { ok: true; nextActiveId: string | null }
  | { ok: false; reason: string };

export class DocumentWorkspaceSession {
  readonly registry: EditorDocumentRegistry;
  private readonly resources = new Map<string, DocumentResource>();
  private readonly deps: DocumentWorkspaceDeps;
  private activeDocumentId: string | null = null;
  /** 活动呈现代际：每次活动文档改变递增，迟到发布据此丢弃。 */
  private activationGeneration = 0;
  private disposed = false;

  constructor(registry: EditorDocumentRegistry, deps: DocumentWorkspaceDeps) {
    this.registry = registry;
    this.deps = deps;
  }

  /** 当前活动文档 id（无活动文档为 null）。 */
  activeId(): string | null {
    return this.activeDocumentId;
  }

  /** 当前活动代际（发布呈现时核对）。 */
  activation(): number {
    return this.activationGeneration;
  }

  /** 活动文档的资源（无则 null）。 */
  active(): DocumentResource | null {
    return this.activeDocumentId ? this.resources.get(this.activeDocumentId) ?? null : null;
  }

  resource(documentId: string): DocumentResource | null {
    return this.resources.get(documentId) ?? null;
  }

  /**
   * 按呈现或控制器反查资源（A2：保存必须落到发起保存的文档）。
   *
   * 「应用到节点」由面板带着自己的 `view`/`controller` 发起；多标签下如果保存改取
   * `active()`，切过 tab 之后就会写错节点或静默写空。
   */
  findByView(view: unknown): DocumentResource | null {
    for (const resource of this.resources.values()) {
      if (resource.view === view) return resource;
    }
    return null;
  }

  findByController(controller: unknown): DocumentResource | null {
    if (!controller) return null;
    for (const resource of this.resources.values()) {
      if (resource.controller === controller) return resource;
    }
    return null;
  }

  /** 按节点身份反查资源（历史预览要作用于面板所属节点，而不是碰巧活动的文档）。 */
  findByNode(nodeId: string): DocumentResource | null {
    for (const resource of this.resources.values()) {
      if (resource.kind === "node" && resource.nodeId === nodeId) return resource;
    }
    return null;
  }

  /** 已打开文档数（上限判定用）。 */
  size(): number {
    return this.resources.size;
  }

  /**
   * 打开或激活节点文档。
   *
   * 同一 `(canvasId,nodeId)` 复用条目与资源（不重建内核、不丢撤销）；节点当前不可编辑时仍
   * 返回原因而不是静默创建可写文档。
   */
  openNode(input: OpenNodeInput): DocumentOpenOutcome {
    if (this.disposed) return { ok: false, reason: "工作区已释放" };
    const blocking = this.refreshActiveGate();
    if (blocking) return { ok: false, reason: blocking };
    const canvasId = this.deps.canvasId();
    const existing = this.registry.findByNode(canvasId, input.nodeId);
    if (existing) {
      // 复用条目时也必须走同一个激活门禁，不能因为「文档已经开着」就绕过草稿检查。
      const activated = this.activate(existing.id);
      if (!activated.ok) return { ok: false, reason: activated.reason };
      return { ok: true, documentId: existing.id, created: false };
    }
    const opened = this.registry.open({ kind: "node", canvasId, nodeId: input.nodeId, name: input.name, writable: input.writable, ...(input.detail === undefined ? {} : { detail: input.detail }) });
    if (!opened.ok) return { ok: false, reason: opened.reason };
    const entry = this.registry.entry(opened.id);
    const view = this.deps.createNodeView(input.nodeId, entry ?? { id: opened.id } as EditorDocumentEntry);
    if (!view) {
      // 目标不可呈现：不留下空 tab（失败不释放其它文档）。
      this.registry.close(opened.id);
      return { ok: false, reason: "图片尚不可编辑，当前版本仍可查看" };
    }
    const resource: DocumentResource = {
      kind: "node",
      documentId: opened.id,
      nodeId: input.nodeId,
      view,
      controller: null,
      sessionId: `image-edit:${canvasId}:${input.nodeId}`,
      requestId: null,
      begin: null,
      begun: false
    };
    this.resources.set(opened.id, resource);
    this.attachController(resource);
    this.setActive(opened.id);
    return { ok: true, documentId: opened.id, created: true };
  }

  /**
   * 打开独立文件文档。
   *
   * 每次显式打开都是新条目（同一文件重复打开也各自独立；文件名不参与身份）。
   */
  openFile(input: OpenFileInput): DocumentOpenOutcome {
    if (this.disposed) return { ok: false, reason: "工作区已释放" };
    // 新文件打开后立即成为活动文档：因此也要先离开当前文档的门禁。
    const blocking = this.refreshActiveGate();
    if (blocking) return { ok: false, reason: blocking };
    const opened = this.registry.open({ kind: "file", fileName: input.fileName });
    if (!opened.ok) return { ok: false, reason: opened.reason };
    const view = new FileDocumentWorkspace({
      documentId: opened.id,
      fileName: input.fileName,
      kind: input.kind,
      bytes: input.bytes,
      rect: this.deps.rect(),
      ...(this.deps.decodeImage ? { decodeImage: this.deps.decodeImage } : {})
    });
    const resource: DocumentResource = {
      kind: "file",
      documentId: opened.id,
      view,
      controller: null,
      operationId: `publish:${opened.id}`
    };
    this.resources.set(opened.id, resource);
    this.attachController(resource);
    this.setActive(opened.id);
    return { ok: true, documentId: opened.id, created: true };
  }

  /** 激活已打开文档；门禁由 registry 拒绝，返回原因给 UI。 */
  activate(documentId: string): DocumentCloseOutcome {
    if (documentId !== this.activeDocumentId) {
      // 离开当前文档前先结算它的草稿/保存：控制器自己最清楚现在是不是半笔草稿。
      // 同时把结果写回注册表，避免上一次的门禁原因留在这里挡住后续切换
      // （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.3）。
      const blocking = this.refreshActiveGate();
      if (blocking) return { ok: false, reason: blocking };
    }
    const result = this.registry.activate(documentId);
    if (!result.ok) return { ok: false, reason: result.reason };
    if (result.changed) this.setActive(documentId);
    return { ok: true, nextActiveId: this.registry.activeId() };
  }

  /**
   * 按当前活动控制器刷新注册表门禁，返回拒绝原因。
   *
   * 门禁的唯一判据是控制器的未结算草稿/保存阶段；每次切换前重新求值，所以草稿结算后不会
   * 留下过期的拒绝。
   */
  private refreshActiveGate(): string | null {
    const id = this.activeDocumentId;
    if (!id) return null;
    const active = this.active();
    const reason = active?.controller ? pendingDraftOf(active.controller) : null;
    this.registry.setGate(id, reason);
    return reason;
  }

  /**
   * 关闭文档：释放控制器与呈现。
   *
   * 调用方负责先完成保存结算（dirty 时不得直接关闭）；这里只做资源释放与相邻项激活。
   * 唯一例外是未结算草稿/保存阶段：那是「还没到能做保存决定」的状态，直接关闭会丢工作，
   * 因此在这里也拒绝（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.3）。
   */
  close(documentId: string): DocumentCloseOutcome {
    const resource = this.resources.get(documentId);
    const blocking = resource?.controller ? pendingDraftOf(resource.controller) : null;
    if (blocking) return { ok: false, reason: blocking };
    const result = this.registry.close(documentId);
    if (!result.ok) return { ok: false, reason: result.reason };
    if (resource) {
      resource.controller?.dispose();
      resource.view.dispose();
      this.resources.delete(documentId);
    }
    if (this.activeDocumentId === documentId || !this.registry.activeId()) {
      this.setActive(this.registry.activeId());
    }
    this.deps.onChange?.();
    return { ok: true, nextActiveId: result.nextActiveId };
  }

  /**
   * 独立文件成功发布为节点后原位绑定：保留 id/顺序/代际与控制器（撤销历史随文档保留）。
   *
   * 节点呈现由调用方创建（插件的 `createNodeView`），因为它需要画布/投影端口；这里只替换
   * 条目来源与资源绑定。目标节点已被另一条目打开时，旧条目被移除（资源由调用方释放）。
   */
  rebindFileToNode(documentId: string, input: { nodeId: string; name?: string; view: ImageFocusWorkspace }): boolean {
    const resource = this.resources.get(documentId);
    if (!resource || resource.kind !== "file") return false;
    const entry = this.registry.entry(documentId);
    if (!entry) return false;
    const previousNodeDocument = this.registry.findByNode(this.deps.canvasId(), input.nodeId);
    // 发布目标节点若已被另一条目打开，先关闭那一条（避免同一节点两个 tab）。
    if (previousNodeDocument && previousNodeDocument.id !== documentId) {
      this.resources.get(previousNodeDocument.id)?.controller?.dispose();
      this.resources.get(previousNodeDocument.id)?.view.dispose();
      this.resources.delete(previousNodeDocument.id);
    }
    const rebound = this.registry.rebindToNode(documentId, { canvasId: this.deps.canvasId(), nodeId: input.nodeId, ...(input.name ? { name: input.name } : {}) });
    if (!rebound) return false;
    const controller = resource.controller;
    resource.view.dispose();
    this.resources.set(documentId, {
      kind: "node",
      documentId,
      nodeId: input.nodeId,
      view: input.view,
      controller,
      sessionId: `image-edit:${this.deps.canvasId()}:${input.nodeId}`,
      requestId: null,
      begin: null,
      begun: false
    });
    this.deps.onChange?.();
    return true;
  }

  /** 文档当前是否可写回目的地（节点失效/只读画布为 false）。 */
  setWritable(documentId: string, writable: boolean): void {
    this.registry.update(documentId, { writable });
  }

  /** 文档状态与失败原因（后台失败标在所属文档）。 */
  setStatus(documentId: string, status: EditorDocumentStatus, message: string | null = null): void {
    const current = this.registry.entry(documentId);
    if (!current) return;
    if (current.status === status && current.message === message) return;
    this.registry.update(documentId, { status, message });
    this.deps.onChange?.();
  }

  /** 节点文档重新打开内容（历史恢复/权威刷新）：递增内容代际，旧结果作废。 */
  beginContentReplacement(documentId: string): number | null {
    const resource = this.resources.get(documentId);
    if (!resource) return null;
    const generation = this.registry.bumpGeneration(documentId);
    if (resource.kind === "file") resource.view.beginContentReplacement();
    return generation;
  }

  /**
   * 关系统计（记录资源边界与文档说明）。
   */
  metrics(): { documents: number; nodeDocuments: number; fileDocuments: number; activeDocumentId: string | null } {
    let nodeDocuments = 0;
    let fileDocuments = 0;
    for (const resource of this.resources.values()) {
      if (resource.kind === "node") nodeDocuments += 1;
      else fileDocuments += 1;
    }
    return { documents: this.resources.size, nodeDocuments, fileDocuments, activeDocumentId: this.activeDocumentId };
  }

  /** 文档的净变化/草稿状态（关闭与离开结算先用它判断）。 */
  dirtyState(documentId: string): DocumentDirtyState | null {
    const resource = this.resources.get(documentId);
    const entry = this.registry.entry(documentId);
    if (!resource || !entry) return null;
    const controller = resource.controller;
    const pendingDraft = controller ? pendingDraftOf(controller) : null;
    const phase = controller ? controller.currentState().phase : "idle";
    const message = controller ? controller.currentState().message : null;
    return { dirty: controller?.isDirty() ?? false, pendingDraft, phase, message };
  }

  /** 页面释放：释放全部控制器与呈现（调用方须先完成结算）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activationGeneration += 1;
    for (const resource of this.resources.values()) {
      resource.controller?.dispose();
      resource.view.dispose();
    }
    this.resources.clear();
    this.registry.clear();
    this.activeDocumentId = null;
  }

  private attachController(resource: DocumentResource): void {
    const entry = this.registry.entry(resource.documentId);
    if (!entry) return;
    resource.controller = this.deps.createController(resource, entry);
  }

  /** 设置活动文档：递增活动代际，供异步发布核对。 */
  private setActive(documentId: string | null): void {
    this.activeDocumentId = documentId;
    this.activationGeneration += 1;
    // 只保留一个活动呈现：文件文档取景不需要节点投影。
    this.deps.onChange?.();
  }
}

/** 当前未确认的受控草稿原因（切换/关闭门禁）。 */
export function pendingDraftOf(controller: EditorWorkspaceController): string | null {
  // 单一权威：控制器内部的 `blockingDraft()` 覆盖全部草稿种类与保存阶段，且与保存/写入路径
  // 完全一致，宿主不需要自己再列一遍。只有结构性测试替身缺这个方法时才退回旧的四项查询，
  // 不在这里为新草稿种类补第二份清单（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.3）。
  const draft = controller.pendingDraftFailure?.();
  if (draft) return draft.message;
  if (controller.isSaving?.()) return "文档正在保存，请等待完成后再切换或关闭";
  if (controller.hasLayerProperties?.()) return "请先确认或取消图层属性编辑";
  if (controller.hasAdjustment?.()) return "请先确认或取消调整参数编辑";
  if (controller.hasText?.()) return "请先确认或取消文字编辑";
  if (controller.hasTransform?.()) return "请先确认或取消自由变换";
  // 选区草稿（U17–U24）的判定与文案归本域自己：宿主只问"有没有必须先结算的"，
  // 不在这里重复实现草稿状态机，也不猜内核里的归属。
  const selectionDraft = controller.features?.selections?.unsettledDraftReason?.();
  if (selectionDraft) return selectionDraft;
  // 矢量草稿（形状拖绘中/钢笔未完成/锚点拖动）同样必须先结算：
  // 否则关闭或离开会在半截手势里丢掉刚画的内容
  // （change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.3）。
  if (controller.hasVectorDraft()) return "请先完成或取消当前矢量操作";
  return null;
}

/** 文档打开的呈现（节点/文件共用接口）。 */
export function viewOf(resource: DocumentResource): EditorDocumentView {
  return resource.view;
}

/** 节点文档的工程定义（文件文档为 null）。 */
export function projectDocumentOf(resource: DocumentResource): ImageProjectDocument | null {
  return resource.kind === "node" ? resource.view.projectDocument() : null;
}

/**
 * 节点的可编辑目标是否存在（用于 tab 重新打开时的目标校验）。
 *
 * 独立文件不需要画布节点；节点文档在节点被删除/资产不可用时返回 null。
 */
export function resolveNodeDocumentTarget(canvas: Parameters<typeof resolveImageFocusTarget>[0], nodeId: string) {
  return resolveImageFocusTarget(canvas, nodeId);
}
