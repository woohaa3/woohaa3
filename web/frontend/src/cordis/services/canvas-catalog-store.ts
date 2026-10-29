/**
 * Canvas Catalog Store
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 2.2 / 2.3 / design D2）。
 *
 * App scope 目录读模型：list/get/create、缓存失效、并发请求去旧结果与 dispose 后不发布迟到
 * 结果（`requestSerial` + `disposed`）。不创建任何画布运行资源。
 */
import type {
  CanvasCatalogCreateResult,
  CanvasCatalogDeleteResult,
  CanvasCatalogListResult,
  CanvasCatalogRemote,
  CanvasCatalogService,
  CanvasCatalogState,
  CanvasCatalogSummaryResult,
  CanvasSummary
} from "../contract/canvas-catalog.js";

export const CANVAS_CATALOG_PAGE_SIZE = 20;

export type CanvasCatalogStoreOptions = {
  remote: CanvasCatalogRemote;
  /** 页大小（测试可注入）。 */
  pageSize?: number;
};

export class CanvasCatalogStore implements CanvasCatalogService {
  private readonly remote: CanvasCatalogRemote;
  private readonly pageSize: number;
  private readonly listeners = new Set<() => void>();
  private state: CanvasCatalogState;
  private requestSerial = 0;
  private disposed = false;

  constructor(options: CanvasCatalogStoreOptions) {
    this.remote = options.remote;
    this.pageSize = options.pageSize ?? CANVAS_CATALOG_PAGE_SIZE;
    this.state = {
      status: "idle",
      entries: [],
      total: 0,
      offset: 0,
      limit: this.pageSize,
      loadingMore: false,
      error: null
    };
  }

  getState = (): CanvasCatalogState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async load(force = false): Promise<CanvasCatalogListResult> {
    if (!force && this.state.status === "ready") {
      return {
        ok: true,
        entries: this.state.entries,
        total: this.state.total,
        offset: this.state.offset,
        limit: this.state.limit
      };
    }
    const serial = ++this.requestSerial;
    this.patch({ status: "loading", error: null });
    const result = await this.remote.list({ offset: 0, limit: this.pageSize });
    if (this.isStale(serial)) return result;
    if (!result.ok) {
      this.patch({ status: "error", error: result.error, entries: [], total: 0, offset: 0 });
      return result;
    }
    this.patch({
      status: "ready",
      entries: result.entries,
      total: result.total,
      offset: result.offset,
      limit: result.limit,
      error: null
    });
    return result;
  }

  async loadMore(): Promise<void> {
    if (this.state.status !== "ready" || this.state.loadingMore) return;
    const nextOffset = this.state.offset + this.state.entries.length;
    if (nextOffset >= this.state.total) return;
    const serial = this.requestSerial;
    this.patch({ loadingMore: true });
    const result = await this.remote.list({ offset: nextOffset, limit: this.pageSize });
    if (this.isStale(serial)) return;
    if (!result.ok) {
      this.patch({ loadingMore: false, error: result.error });
      return;
    }
    const merged = mergeEntries(this.state.entries, result.entries);
    this.patch({
      entries: merged,
      total: result.total,
      loadingMore: false,
      error: null
    });
  }

  async create(input: { title?: string } = {}): Promise<CanvasCatalogCreateResult> {
    const result = await this.remote.create(input.title ? { title: input.title } : {});
    if (!result.ok) return result;
    // 创建成功后失效并刷新目录，使新画布立即可发现。
    this.invalidate();
    await this.load(true);
    return result;
  }

  /**
   * 删除画布：成功后才失效并刷新目录。
   *
   * 失败**不**清空列表（画布仍然存在），错误原样交给调用方展示。版本号缺省取当前快照里的
   * 条目：删除入口长在目录行上，调用方自然知道是哪一条；条目不在当前页时必须显式给出。
   */
  async delete(canvasId: string, expectedRevision?: number): Promise<CanvasCatalogDeleteResult> {
    const revision = expectedRevision ?? this.state.entries.find((entry) => entry.id === canvasId)?.revision;
    if (revision === undefined) {
      return { ok: false, code: "CANVAS_NOT_FOUND", error: "画布不在当前目录里，无法删除" };
    }
    const result = await this.remote.delete(canvasId, revision);
    if (!result.ok) return result;
    this.invalidate();
    await this.load(true);
    return { ok: true };
  }

  async get(canvasId: string): Promise<CanvasCatalogSummaryResult> {
    return this.remote.get(canvasId);
  }

  invalidate(): void {
    this.requestSerial += 1;
    this.patch({ status: "idle", error: null });
  }

  dispose(): void {
    this.disposed = true;
    this.requestSerial += 1;
    // 复位为 idle 且不再广播：dispose 后 getState 不应停留在 loading，也不发布迟到结果。
    this.state = {
      status: "idle",
      entries: [],
      total: 0,
      offset: 0,
      limit: this.pageSize,
      loadingMore: false,
      error: null
    };
    this.listeners.clear();
  }

  private patch(patch: Partial<CanvasCatalogState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private isStale(serial: number): boolean {
    return this.disposed || serial !== this.requestSerial;
  }
}

/** 合并分页条目，按 id 去重并保留首次出现顺序。 */
function mergeEntries(current: CanvasSummary[], incoming: CanvasSummary[]): CanvasSummary[] {
  const seen = new Set(current.map((entry) => entry.id));
  const merged = [...current];
  for (const entry of incoming) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}
