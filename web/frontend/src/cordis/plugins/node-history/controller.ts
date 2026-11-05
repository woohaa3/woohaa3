/**
 * 节点生成历史 feature 客户端状态
 * （change: add-canvas-node-generation-history，任务 3.2 / 3.3 / 3.4 / design D4）。
 *
 * 拥有单个打开面板的瞬时状态：canvasId/nodeId 标识、分页、选中、applying、error、以及
 * 权威回流后的 current 标记。**不写 Y.Doc / CanvasCommand**；恢复动作只调用受控 API，
 * 当前标记等待权威 output identity / source hash 回流确认（不做固定延时）。
 *
 * 用 request generation 丢弃迟到响应，防止旧请求覆盖新面板状态。
 */
import { mergeNodeExecutionPresentation, type CanvasOperationRecord, type NodeExecutionPresentation, type NodeGenerationHistoryListItem, type NodeGenerationHistoryDetail } from "@woohaa3/contracts";

/**
 * 固定「当前版本」首项身份
 * （change: 2026-08-10-image-focus...，任务 8.1 / design D8）。
 *
 * 独立于历史 entryId；不参与 repository cursor/total/容量，不因新历史插入而移位。
 * 有未保存草稿/未归档内容时携带相应状态。
 */
export const CURRENT_PRESENTATION_ID = "__current__";

export type NodeHistoryCurrentPresentation = {
  kind: "current";
  /** 是否有未保存草稿（图片草稿 / 模型未归档内容）。 */
  draftState: "saved" | "unsaved" | "saving" | "history-pending" | "error";
  /** 当前内容的摘要预览（无历史时为「当前暂无输出」）。 */
  hasOutput: boolean;
  /** 匹配的已归档条目（若有），用于显示时间/来源；不伪造 entryId。 */
  archivedEntryId: string | null;
};

export type NodeHistorySelectionId = typeof CURRENT_PRESENTATION_ID | string;

export type NodeHistoryPanelState = {
  canvasId: string;
  nodeId: string;
  kind: NodeGenerationHistoryListItem["kind"];
  status: "loading" | "ready" | "empty" | "error";
  error: string | null;
  items: NodeGenerationHistoryListItem[];
  operations: readonly CanvasOperationRecord[];
  presentations: NodeExecutionPresentation[];
  nextCursor: string | null;
  loadingMore: boolean;
  /** 固定当前首项；始终存在（即使无历史）。 */
  current: NodeHistoryCurrentPresentation;
  selectedEntryId: NodeHistorySelectionId | null;
  /** 正在恢复的 entryId（busy 门禁）。 */
  applyingEntryId: string | null;
  /** 已接受但尚未回流确认的 entryId（applying 状态）。 */
  pendingCurrentEntryId: string | null;
  applyError: string | null;
  /** 清空历史的进行中/结果（不影响 apply 门禁）。 */
  clearing: boolean;
  clearError: string | null;
  /** 当前客户端是否支持清空（缺少实现时不显示入口）。 */
  canClear: boolean;
  /** 详情缓存（选中时按需读取）。 */
  detail: NodeGenerationHistoryDetail | null;
};

export type NodeHistoryClient = {
  list(input: { canvasId: string; nodeId: string; cursor?: string; limit?: number }): Promise<
    { ok: true; items: NodeGenerationHistoryListItem[]; nextCursor: string | null } | { ok: false; code: string; error: string }
  >;
  detail(input: { canvasId: string; nodeId: string; entryId: string }): Promise<
    { ok: true; detail: NodeGenerationHistoryDetail } | { ok: false; code: string; error: string }
  >;
  apply(input: { canvasId: string; nodeId: string; entryId: string; expectedCurrentIdentity?: string }): Promise<
    { ok: true } | { ok: false; code: string; error: string }
  >;
  /**
   * 清空该节点全部历史（显式写操作）。只删历史索引，不改画布内容。
   * 客户端未提供时面板不显示清空入口。
   */
  clear?(input: { canvasId: string; nodeId: string }): Promise<
    { ok: true; removed: number } | { ok: false; code: string; error: string }
  >;
  previewUrl(input: { canvasId: string; nodeId: string; entryId: string; variant: "preview" | "poster" }): string;
};

const PAGE_SIZE = 20;

export class NodeHistoryController {
  private listeners = new Set<() => void>();
  private state: NodeHistoryPanelState | null = null;
  private generation = 0;
  private targetGeneration = 0;
  private refreshGeneration = 0;

  constructor(private readonly client: NodeHistoryClient) {}

  getState = (): NodeHistoryPanelState | null => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 打开面板：加载首页。重复打开同一节点是幂等的（沿用已有状态）。 */
  async open(input: { canvasId: string; nodeId: string; kind: NodeGenerationHistoryListItem["kind"]; writable: boolean }): Promise<void> {
    if (this.state && this.state.canvasId === input.canvasId && this.state.nodeId === input.nodeId) return;
    ++this.generation;
    const targetGeneration = ++this.targetGeneration;
    this.state = {
      canvasId: input.canvasId,
      nodeId: input.nodeId,
      kind: input.kind,
      status: "loading",
      error: null,
      items: [],
      operations: [],
      presentations: [],
      nextCursor: null,
      loadingMore: false,
      current: { kind: "current", draftState: "saved", hasOutput: true, archivedEntryId: null },
      selectedEntryId: CURRENT_PRESENTATION_ID,
      applyingEntryId: null,
      pendingCurrentEntryId: null,
      applyError: null,
      clearing: false,
      clearError: null,
      canClear: this.client.clear !== undefined,
      detail: null
    };
    this.emit();
    await this.loadFirstPage(targetGeneration);
  }

  /**
   * 更新固定当前首项状态（由宿主根据草稿/保存状态与权威回流注入）。
   * 不改 entryId、不参与 cursor/total。
   */
  setCurrentPresentation(input: Partial<Omit<NodeHistoryCurrentPresentation, "kind">>): void {
    if (!this.state) return;
    this.state = { ...this.state, current: { ...this.state.current, ...input, kind: "current" } };
    this.emit();
  }

  /** 活动只来自原 owner；不将回合结束推断为作品成功。 */
  setOperations(records: readonly CanvasOperationRecord[]): void {
    if (!this.state) return;
    this.state = { ...this.state, operations: records.filter(record => record.canvasId === this.state!.canvasId && record.nodeId === this.state!.nodeId) };
    this.emit();
  }

  includeHistory(item: NodeGenerationHistoryListItem): void {
    if (!this.state || this.state.items.some(entry => entry.entryId === item.entryId)) return;
    this.state = { ...this.state, items: [...this.state.items, item] };
    this.emit();
  }

  async refresh(): Promise<void> {
    if (!this.state) return;
    await this.refreshCurrent(this.targetGeneration);
  }

  close(): void {
    this.generation += 1;
    this.targetGeneration += 1;
    this.state = null;
    this.emit();
  }

  /** 目标节点切换 / 删除时清理（旧请求不能覆盖新面板）。 */
  syncValidTarget(validNodeIds: ReadonlySet<string>): void {
    if (!this.state) return;
    if (!validNodeIds.has(this.state.nodeId)) this.close();
  }

  async loadMore(): Promise<void> {
    const state = this.state;
    if (!state || state.loadingMore || !state.nextCursor || state.status !== "ready") return;
    const generation = this.targetGeneration;
    this.state = { ...state, loadingMore: true };
    this.emit();
    const result = await this.client.list({
      canvasId: state.canvasId,
      nodeId: state.nodeId,
      cursor: state.nextCursor,
      limit: PAGE_SIZE
    }).catch(() => ({ ok: false as const, code: "unavailable", error: "历史读取失败，请重试" }));
    if (generation !== this.targetGeneration || !this.state) return;
    if (!result.ok) {
      this.state = { ...this.state, loadingMore: false, error: result.error, status: "error" };
      this.emit();
      return;
    }
    const merged = dedupeById([...this.state.items, ...result.items]);
    this.state = { ...this.state, items: merged, nextCursor: result.nextCursor, loadingMore: false };
    this.emit();
  }

  /** 选择条目：按需读取完整详情。选择固定首项不读取详情（恢复当前现场由宿主处理）。 */
  async select(entryId: NodeHistorySelectionId): Promise<void> {
    const state = this.state;
    if (!state) return;
    if (entryId.startsWith("operation:")) {
      ++this.generation;
      const item = state.presentations.find(item => item.presentationId === entryId);
      this.state = { ...state, selectedEntryId: entryId, detail: null, error: item ? null : "该记录已失效" };
      this.emit();
      if (item?.entryId) await this.loadSelectedDetail(item.entryId, entryId);
      return;
    }
    if (entryId === CURRENT_PRESENTATION_ID) {
      // 点击首项：清除旧 override / 恢复当前草稿与 direct 由订阅者处理；这里只更新选中。
      const generation = ++this.generation;
      this.state = { ...state, selectedEntryId: CURRENT_PRESENTATION_ID, detail: null, applyError: null };
      this.emit();
      void generation;
      return;
    }
    const generation = ++this.generation;
    this.state = { ...state, selectedEntryId: entryId, detail: null, applyError: null };
    this.emit();
    const result = await this.client.detail({ canvasId: state.canvasId, nodeId: state.nodeId, entryId });
    if (generation !== this.generation || !this.state) return;
    this.state = result.ok ? { ...this.state, detail: result.detail } : { ...this.state, error: result.error };
    this.emit();
  }

  /** 活动转归档后读取详情；保留原选择身份。 */
  private async loadSelectedDetail(entryId: string, selectionId: string): Promise<void> {
    const state = this.state;
    if (!state) return;
    const generation = this.generation, targetGeneration = this.targetGeneration;
    const result = await this.client.detail({ canvasId: state.canvasId, nodeId: state.nodeId, entryId })
      .catch(() => ({ ok: false as const, code: "unavailable", error: "详情读取失败，请重试" }));
    if (generation !== this.generation || targetGeneration !== this.targetGeneration || !this.state || this.state.canvasId !== state.canvasId || this.state.nodeId !== state.nodeId
      || this.state.selectedEntryId !== selectionId) return;
    this.state = result.ok ? { ...this.state, detail: result.detail } : { ...this.state, error: result.error };
    this.emit();
  }

  async apply(entryId: string, expectedCurrentIdentity?: string): Promise<{ ok: boolean; code?: string; error?: string }> {
    const state = this.state;
    if (!state) return { ok: false, code: "closed", error: "面板已关闭" };
    if (state.applyingEntryId !== null) return { ok: false, code: "busy", error: "正在恢复" };
    const item = state.items.find(item => item.entryId === entryId);
    if (item && (!item.recoverable || (item.outcome ?? "succeeded") !== "succeeded")) return { ok: false, code: "unrecoverable", error: "该记录没有可恢复作品" };
    if (state.current.draftState !== "saved") return { ok: false, code: "unsaved-draft", error: "请先保存当前草稿" };
    const generation = ++this.generation;
    this.state = { ...state, applyingEntryId: entryId, pendingCurrentEntryId: entryId, applyError: null };
    this.emit();
    const result = await this.client.apply({
      canvasId: state.canvasId,
      nodeId: state.nodeId,
      entryId,
      ...(expectedCurrentIdentity !== undefined ? { expectedCurrentIdentity } : {})
    });
    if (!this.state || this.state.canvasId !== state.canvasId || this.state.nodeId !== state.nodeId) return { ok: false, code: "closed", error: "面板已关闭" };
    if (!result.ok) {
      if (generation !== this.generation) {
        // 期间的列表回流已接管状态：只清掉自己留下的 applying，不覆盖新的错误/选中。
        if (this.state.applyingEntryId === entryId) {
          this.state = { ...this.state, applyingEntryId: null, pendingCurrentEntryId: null };
          this.emit();
        }
        return { ok: false, code: "superseded", error: "请求已被取代" };
      }
      this.state = { ...this.state, applyingEntryId: null, pendingCurrentEntryId: null, applyError: result.error };
      this.emit();
      return { ok: false, code: result.code, error: result.error };
    }
    // 服务端 200 即权威恢复完成：立即把条目标为当前并结束 applying。
    // 若继续等列表回流才清 pending，回流失败或 current 判定不一致时面板会一直停在「恢复中」。
    // 之后的 reconcile/list 仍会以服务端为准纠正这一乐观投影。
    this.state = {
      ...this.state,
      applyingEntryId: null,
      pendingCurrentEntryId: null,
      applyError: null,
      items: this.state.items.map((item) =>
        item.entryId === entryId
          ? { ...item, current: true }
          : item.current ? { ...item, current: false } : item
      )
    };
    this.emit();
    return { ok: true };
  }

  /**
   * 清空该节点全部历史版本（显式写操作）。
   *
   * 只删历史索引：不动画布内容、当前输出与 Media 对象。成功后就地收敛为「无历史」，
   * 清掉选中详情与恢复错误；服务端拒绝（进行中生成/未结算会话）保留列表并显示原因。
   */
  async clear(): Promise<{ ok: boolean; code?: string; error?: string }> {
    const state = this.state;
    if (!state) return { ok: false, code: "closed", error: "面板已关闭" };
    if (!this.client.clear) return { ok: false, code: "unsupported", error: "当前会话不支持清空历史" };
    if (state.clearing) return { ok: false, code: "busy", error: "正在清空" };
    const generation = ++this.generation;
    this.state = { ...state, clearing: true, clearError: null };
    this.emit();
    const result = await this.client.clear({ canvasId: state.canvasId, nodeId: state.nodeId });
    if (generation !== this.generation || !this.state) return { ok: false, code: "closed", error: "面板已关闭" };
    if (!result.ok) {
      this.state = { ...this.state, clearing: false, clearError: result.error };
      this.emit();
      return { ok: false, code: result.code, error: result.error };
    }
    this.state = {
      ...this.state,
      clearing: false,
      clearError: null,
      items: [],
      nextCursor: null,
      status: "empty",
      selectedEntryId: CURRENT_PRESENTATION_ID,
      detail: null,
      applyError: null,
      pendingCurrentEntryId: null,
      applyingEntryId: null
    };
    this.emit();
    return { ok: true };
  }

  /**
   * 权威画布回流：重算当前标记并清除 applying。
   *
   * 服务端列表已按权威 output identity / source hash 计算 `current`；回流后重新拉取首页
   * （仅在仍有 pending/applying 或需要刷新时）。绝不依赖固定延时。
   */
  reconcile(canvas: unknown | null): void {
    const state = this.state;
    if (!state || !canvas) return;
    if (state.pendingCurrentEntryId === null && state.applyingEntryId === null) return;
    void this.refresh();
  }

  private async refreshCurrent(generation: number): Promise<void> {
    const state = this.state;
    if (!state) return;
    const refreshGeneration = ++this.refreshGeneration;
    const result = await this.client.list({ canvasId: state.canvasId, nodeId: state.nodeId, limit: PAGE_SIZE })
      .catch(() => ({ ok: false as const, code: "unavailable", error: "历史读取失败，请重试" }));
    if (generation !== this.targetGeneration || refreshGeneration !== this.refreshGeneration || !this.state) return;
    if (!result.ok) { this.state = { ...this.state, error: result.error }; this.emit(); return; }
    const pending = this.state.pendingCurrentEntryId;
    const confirmed = pending !== null && result.items.some((item) => item.entryId === pending && item.current);
    this.state = {
      ...this.state,
      error: null,
      items: dedupeById([...result.items, ...this.state.items.map(item => ({ ...item, current: false }))]),
      nextCursor: this.state.status === "loading" ? result.nextCursor : this.state.nextCursor,
      status: result.items.length === 0 && this.state.items.length === 0 ? "empty" : "ready",
      ...(confirmed || pending === null
        ? { pendingCurrentEntryId: null, applyingEntryId: null }
        : {})
    };
    this.emit();
  }

  private async loadFirstPage(generation: number): Promise<void> {
    const state = this.state;
    if (!state) return;
    const refreshGeneration = ++this.refreshGeneration;
    const result = await this.client.list({ canvasId: state.canvasId, nodeId: state.nodeId, limit: PAGE_SIZE })
      .catch(() => ({ ok: false as const, code: "unavailable", error: "历史读取失败，请重试" }));
    if (generation !== this.targetGeneration || refreshGeneration !== this.refreshGeneration || !this.state) return;
    if (!result.ok) {
      this.state = { ...this.state, status: "error", error: result.error };
      this.emit();
      return;
    }
    this.state = {
      ...this.state,
      items: dedupeById([...result.items, ...this.state.items]),
      nextCursor: result.nextCursor,
      status: result.items.length === 0 ? "empty" : "ready"
    };
    this.emit();
  }

  private emit(): void {
    if (this.state) {
      const old = this.state.presentations;
      const presentations = mergeNodeExecutionPresentation(this.state.operations, this.state.items);
      this.state = { ...this.state, presentations };
      const selected = presentations.find(item => item.presentationId === this.state!.selectedEntryId);
      if (selected?.entryId && !old.some(item => item.presentationId === selected.presentationId && item.entryId === selected.entryId)) {
        void this.loadSelectedDetail(selected.entryId, selected.presentationId);
      }
    }
    for (const listener of this.listeners) listener();
  }
}

function dedupeById(items: readonly NodeGenerationHistoryListItem[]): NodeGenerationHistoryListItem[] {
  const seen = new Set<string>();
  const out: NodeGenerationHistoryListItem[] = [];
  for (const item of items) {
    if (seen.has(item.entryId)) continue;
    seen.add(item.entryId);
    out.push(item);
  }
  return out;
}
