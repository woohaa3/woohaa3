/**
 * PhotoCraft 独立开发宿主的 A/B 双文档装配
 * （change: 2026-10-22-complete-photocraft-webui-editing，任务 4.5 / design D5/D11）。
 *
 * 只用于验证**共享核心**的跨文档行为：两个独立内核实例、一个工作区级剪贴板、同一时刻只有
 * 活动文档接收输入与发布预览。它不是产品外壳：没有最近文件、账号、云存储或标签持久化。
 *
 * 关键约束与正式宿主一致：
 * - 剪贴板属于**本工作区**（这里的 `DevWorkspace` 实例），不是内核全局状态；
 * - 副本是自包含字节，源文档关闭后仍可粘贴；
 * - 切换文档前必须先结算活动草稿（由控制器门禁回答）。
 */
import { EditorWorkspaceController, type EditorViewModel } from "@woohaa3/photocraft-editor";

export type DevDocumentSlot = "A" | "B";

export type SlotState = {
  slot: DevDocumentSlot;
  /** 文档名（导入时记录）。 */
  name: string;
  /** 已打开（内核里有文档）。 */
  open: boolean;
  /** 修订号（UI 显示）。 */
  revision: number;
  /** 内容指纹（跨文档粘贴的基线对照）。 */
  contentHash: string | null;
  dirty: boolean;
};

export type WorkspaceState = {
  active: DevDocumentSlot;
  slots: SlotState[];
  clipboard: { bytes: number; digest: string; layers: number } | null;
  message: string | null;
};

/** 一个工作区内的 A/B 文档与共享剪贴板。 */
export class DevWorkspace {
  private readonly controllers: Record<DevDocumentSlot, EditorWorkspaceController>;
  private readonly names: Record<DevDocumentSlot, string> = { A: "", B: "" };
  private activeSlot: DevDocumentSlot = "A";
  private clipboard: { bytes: Uint8Array; digest: string; layers: number } | null = null;
  private message: string | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshotCache: WorkspaceState | null = null;

  constructor(controllers: Record<DevDocumentSlot, EditorWorkspaceController>) {
    this.controllers = controllers;
    // 两个实例都订阅：非活动文档的变化（例如迟到结果）也要反映到状态栏。
    for (const controller of Object.values(controllers)) {
      controller.subscribe(() => this.publish());
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): WorkspaceState {
    this.snapshotCache ??= this.build();
    return this.snapshotCache;
  }

  controller(slot: DevDocumentSlot): EditorWorkspaceController {
    return this.controllers[slot];
  }

  active(): EditorWorkspaceController {
    return this.controllers[this.activeSlot];
  }

  activeSlotName(): DevDocumentSlot {
    return this.activeSlot;
  }

  /**
   * 切换活动文档；有未结算草稿或正在保存时拒绝（与正式宿主共用同一个权威判据）。
   *
   * 用控制器自己的 `pendingDraftFailure()`/`isSaving()`，不在这里另列草稿种类：否则出现
   * 「保存会拒绝、切文档却放行」这类不一致（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.3）。
   */
  activate(slot: DevDocumentSlot): boolean {
    if (slot === this.activeSlot) return true;
    const target = this.controllers[slot];
    if (!target.editor()) {
      this.setMessage(`${slot} 还没有打开文档`);
      return false;
    }
    const current = this.active();
    const draft = current.pendingDraftFailure();
    if (draft) {
      this.setMessage(`请先结算当前草稿再切换文档：${draft.message}`);
      return false;
    }
    if (current.isSaving()) {
      this.setMessage("文档正在保存，请等待完成后再切换文档");
      return false;
    }
    this.activeSlot = slot;
    this.setMessage(null);
    return true;
  }

  setDocumentName(slot: DevDocumentSlot, name: string): void {
    this.names[slot] = name;
    this.publish();
  }

  /** 槽位的文档名（含扩展名）；未打开时返回空串。保存/导出据此推导交付文件名。 */
  documentName(slot: DevDocumentSlot): string {
    return this.names[slot] ?? "";
  }

  /** 复制活动文档的所选图层到工作区剪贴板（自包含字节）。 */
  copy(layers?: readonly number[]): boolean {
    const controller = this.active();
    const result = controller.copyLayers(layers);
    if (!result.ok) {
      this.setMessage(result.message);
      return false;
    }
    const preview = controller.currentView().document;
    const selected = preview ? preview.layers.filter((layer) => layer.selected || layer.active).map((layer) => layer.id) : [];
    const bytes = result.value;
    // 摘要与层数从载荷本身读取（不解码像素）。
    const inspected = controller.inspectLayerTransfer(bytes);
    this.clipboard = {
      bytes,
      digest: inspected.ok && typeof (inspected.value as { digest?: unknown }).digest === "string"
        ? String((inspected.value as { digest: string }).digest)
        : "unknown",
      layers: inspected.ok && typeof (inspected.value as { layers?: unknown }).layers === "number"
        ? Number((inspected.value as { layers: number }).layers)
        : selected.length
    };
    this.setMessage(`已复制 ${this.clipboard.layers} 层到工作区剪贴板`);
    return true;
  }

  /** 粘贴工作区剪贴板到活动文档（原位或居中）。 */
  paste(inPlace: boolean): boolean {
    if (!this.clipboard) {
      this.setMessage("工作区剪贴板为空：先在任一文档复制图层");
      return false;
    }
    const controller = this.active();
    const check = controller.canPasteLayers(this.clipboard.bytes);
    if (check.ok && (check.value as { ok?: unknown }).ok === false) {
      this.setMessage(String((check.value as { reason?: unknown }).reason ?? "目标文档不接受该载荷"));
      return false;
    }
    const document = controller.currentView().document;
    const center: [number, number] | undefined = document ? [document.width / 2, document.height / 2] : undefined;
    const result = controller.pasteLayers(this.clipboard.bytes, { inPlace, ...(center ? { center } : {}) });
    if (!result.ok) {
      this.setMessage(result.message);
      return false;
    }
    this.setMessage(inPlace ? "已原位粘贴到活动文档" : "已粘贴到活动文档可见中心");
    return true;
  }

  clearMessage(): void {
    this.setMessage(null);
  }

  currentMessage(): string | null {
    return this.message;
  }

  private setMessage(message: string | null): void {
    this.message = message;
    this.publish();
  }

  private publish(): void {
    this.snapshotCache = null;
    for (const listener of this.listeners) listener();
  }

  private build(): WorkspaceState {
    return {
      active: this.activeSlot,
      slots: (["A", "B"] as const).map((slot) => this.slotState(slot)),
      clipboard: this.clipboard ? { bytes: this.clipboard.bytes.length, digest: this.clipboard.digest, layers: this.clipboard.layers } : null,
      message: this.message
    };
  }

  private slotState(slot: DevDocumentSlot): SlotState {
    const controller = this.controllers[slot];
    const view: EditorViewModel = controller.currentView();
    const document = view.document;
    const hash = controller.editor()?.contentHash();
    return {
      slot,
      name: this.names[slot] || (document ? "未命名" : ""),
      open: document !== null,
      revision: document?.revision ?? 0,
      contentHash: hash?.ok ? hash.value : null,
      dirty: controller.isDirty()
    };
  }
}
