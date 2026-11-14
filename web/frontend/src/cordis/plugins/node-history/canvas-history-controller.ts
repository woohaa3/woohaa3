/**
 * 画布级生成历史 feature 客户端状态
 * （change: add-canvas-generation-history-dialog）。
 *
 * 拥有「全部生成历史」弹窗的瞬时状态：筛选、分页、选中、加载更多与错误。与节点级
 * `NodeHistoryController` 刻意分离：它浏览整张画布的多个节点，且是**只读**的，不暴露
 * 任何恢复（apply）动作，也不写 Y.Doc / CanvasCommand。
 *
 * 用 request generation 丢弃迟到响应，防止旧筛选/旧分页覆盖新状态。
 */
import type {
  CanvasGenerationHistoryListItem,
  NodeGenerationKind,
  NodeHistoryKindCounts
} from "@woohaa3/contracts";

export type CanvasHistoryFilter = "all" | NodeGenerationKind;

/** 画布级浏览客户端：只读列表；节点历史 client 是其超集，可直接传入。 */
export type CanvasHistoryClient = {
  listCanvas(input: {
    summary?: boolean; summaryNodeId?: string;
    canvasId: string;
    cursor?: string;
    limit?: number;
    kind?: string;
  }): Promise<
    | { ok: true; items: CanvasGenerationHistoryListItem[]; nextCursor: string | null; total: number; kindCounts: NodeHistoryKindCounts }
    | { ok: false; code: string; error: string }
  >;
};

export type CanvasHistoryState = {
  canvasId: string;
  filter: CanvasHistoryFilter;
  status: "loading" | "ready" | "empty" | "error";
  error: string | null;
  items: CanvasGenerationHistoryListItem[];
  nextCursor: string | null;
  loadingMore: boolean;
  total: number;
  kindCounts: NodeHistoryKindCounts;
  selectedEntryId: string | null;
};

const PAGE_SIZE = 20;

const EMPTY_COUNTS: NodeHistoryKindCounts = { text: 0, image: 0, video: 0, audio: 0, motion: 0, model: 0 };

export class CanvasHistoryController {
  private listeners = new Set<() => void>();
  private state: CanvasHistoryState | null = null;
  private generation = 0;

  constructor(private readonly client: CanvasHistoryClient) {}

  getState = (): CanvasHistoryState | null => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 打开弹窗：加载首页。重复打开同一画布是幂等的（沿用已有状态）。 */
  async open(input: { canvasId: string }): Promise<void> {
    if (this.state && this.state.canvasId === input.canvasId) return;
    const generation = ++this.generation;
    this.state = {
      canvasId: input.canvasId,
      filter: "all",
      status: "loading",
      error: null,
      items: [],
      nextCursor: null,
      loadingMore: false,
      total: 0,
      kindCounts: { ...EMPTY_COUNTS },
      selectedEntryId: null
    };
    this.emit();
    await this.loadFirstPage(generation);
  }

  /** 关闭弹窗：清除本地状态；不发命令、不触碰 selection。 */
  close(): void {
    this.generation += 1;
    this.state = null;
    this.emit();
  }

  /** 切换内容种类筛选：重新加载首页并丢弃迟到响应。 */
  async setFilter(filter: CanvasHistoryFilter): Promise<void> {
    const state = this.state;
    if (!state || state.filter === filter) return;
    const generation = ++this.generation;
    this.state = { ...state, filter, status: "loading", error: null, items: [], nextCursor: null, loadingMore: false, selectedEntryId: null };
    this.emit();
    await this.loadFirstPage(generation);
  }

  /** 重试当前筛选的首页。 */
  async retry(): Promise<void> {
    const state = this.state;
    if (!state) return;
    const generation = ++this.generation;
    this.state = { ...state, status: "loading", error: null };
    this.emit();
    await this.loadFirstPage(generation);
  }

  async loadMore(): Promise<void> {
    const state = this.state;
    if (!state || state.loadingMore || !state.nextCursor || state.status !== "ready") return;
    const generation = ++this.generation;
    this.state = { ...state, loadingMore: true, error: null };
    this.emit();
    const result = await this.read({
      canvasId: state.canvasId,
      cursor: state.nextCursor,
      limit: PAGE_SIZE,
      ...(state.filter === "all" ? {} : { kind: state.filter })
    });
    if (generation !== this.generation || !this.state) return;
    if (!result.ok) {
      this.state = { ...this.state, loadingMore: false, error: result.error };
      this.emit();
      return;
    }
    const merged = dedupeById([...this.state.items, ...result.items]);
    this.state = {
      ...this.state,
      items: merged,
      error: null,
      nextCursor: result.nextCursor,
      loadingMore: false,
      total: result.total,
      kindCounts: result.kindCounts
    };
    this.emit();
  }

  /** 选中条目（只读预览）；不写入任何规范状态。 */
  select(entryId: string): void {
    const state = this.state;
    if (!state) return;
    this.state = { ...state, selectedEntryId: entryId };
    this.emit();
  }

  private async loadFirstPage(generation: number): Promise<void> {
    const state = this.state;
    if (!state) return;
    const result = await this.read({
      canvasId: state.canvasId,
      limit: PAGE_SIZE,
      ...(state.filter === "all" ? {} : { kind: state.filter })
    });
    if (generation !== this.generation || !this.state) return;
    if (!result.ok) {
      this.state = { ...this.state, status: "error", error: result.error };
      this.emit();
      return;
    }
    this.state = {
      ...this.state,
      items: result.items,
      nextCursor: result.nextCursor,
      total: result.total,
      kindCounts: result.kindCounts,
      status: result.items.length === 0 ? "empty" : "ready"
    };
    this.emit();
  }

  private async read(input: Parameters<CanvasHistoryClient["listCanvas"]>[0]): ReturnType<CanvasHistoryClient["listCanvas"]> {
    try { return await this.client.listCanvas(input); }
    catch (error) { return { ok: false, code: "transport", error: error instanceof Error ? error.message : "生成历史读取失败，请重试。" }; }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function dedupeById(items: readonly CanvasGenerationHistoryListItem[]): CanvasGenerationHistoryListItem[] {
  const seen = new Set<string>();
  const out: CanvasGenerationHistoryListItem[] = [];
  for (const item of items) {
    if (seen.has(item.entryId)) continue;
    seen.add(item.entryId);
    out.push(item);
  }
  return out;
}
