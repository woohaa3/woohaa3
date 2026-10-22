/**
 * Snippet Catalog Service
 * （change: add-prompt-snippet-library，任务 2.3/2.4 / design D8/D9）。
 *
 * feature-owned：统一查询缓存、搜索防抖、筛选、分页、mutation、刷新与 revision conflict
 * 状态。它不是 durable authority（权威在 Canvas Service 目录表），也**不**把目录写入
 * IndexedDB 画布 cache 或 Y.Doc。
 *
 * 所有请求携带 request identity；切换 query、关闭 dialog、删除 material 或 dispose 时
 * 递增 serial，使迟到结果不覆盖当前状态。
 */
import type { CanvasRemoteService, SnippetResult, SnippetTagWithCount } from "@woohaa3/frontend/extension-api";
import type {
  CreatePromptSnippetInput,
  CreatePromptSnippetTagInput,
  PromptSnippet,
  PromptSnippetListQuery,
  PromptSnippetTag,
  UpdatePromptSnippetInput
} from "@woohaa3/contracts";

export type CatalogStatus = "idle" | "loading" | "ready" | "error";

export type CatalogFilter = "all" | "builtIn" | "untagged" | { tagId: string };

export type CatalogState = {
  status: CatalogStatus;
  items: PromptSnippet[];
  total: number;
  nextCursor: string | null;
  loadingMore: boolean;
  error: string | null;
  query: string;
  filter: CatalogFilter;
  activeTagId: string | null;
  /**
   * 侧栏计数（change: align-showcase-reference-ux，任务 3.2）。
   * 与当前查询无关，始终反映目录快照；标签关联数的权威来源是 `listSnippetTags`。
   */
  counts: { all: number; builtIn: number; untagged: number };
};

export type TagState = {
  status: CatalogStatus;
  items: SnippetTagWithCount[];
  error: string | null;
};

export type MutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; error: string };

export type SnippetCatalog = {
  getState(): CatalogState;
  getTagState(): TagState;
  subscribe(listener: () => void): () => void;
  setQuery(query: string): void;
  setFilter(filter: CatalogFilter): void;
  loadMore(): Promise<void>;
  refresh(): Promise<void>;
  loadTags(): Promise<void>;
  createSnippet(input: Omit<CreatePromptSnippetInput, "operationId">): Promise<MutationResult<PromptSnippet>>;
  updateSnippet(input: UpdatePromptSnippetInput): Promise<MutationResult<PromptSnippet>>;
  deleteSnippet(snippetId: string): Promise<MutationResult<null>>;
  createTag(input: Omit<CreatePromptSnippetTagInput, "operationId">): Promise<MutationResult<PromptSnippetTag>>;
  renameTag(input: { tagId: string; expectedRevision: number; name: string }): Promise<MutationResult<PromptSnippetTag>>;
  deleteTag(tagId: string): Promise<MutationResult<null>>;
  dispose(): void;
};

export const DEFAULT_DEBOUNCE_MS = 200;
export const CATALOG_PAGE_SIZE = 30;

let operationSequence = 0;

function nextOperationId(prefix: string): string {
  operationSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${operationSequence}`;
}

export function createSnippetCatalog(options: {
  remote: CanvasRemoteService;
  debounceMs?: number;
}): SnippetCatalog {
  const remote = options.remote;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const listeners = new Set<() => void>();

  let state: CatalogState = {
    status: "idle",
    items: [],
    total: 0,
    nextCursor: null,
    loadingMore: false,
    error: null,
    query: "",
    filter: "all",
    activeTagId: null,
    counts: { all: 0, builtIn: 0, untagged: 0 }
  };
  let tagState: TagState = { status: "idle", items: [], error: null };
  let requestSerial = 0;
  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const setState = (patch: Partial<CatalogState>) => {
    state = { ...state, ...patch };
    emit();
  };
  const setTagState = (patch: Partial<TagState>) => {
    tagState = { ...tagState, ...patch };
    emit();
  };

  const engineQuery = (cursor?: string): PromptSnippetListQuery => {
    const query: PromptSnippetListQuery = { limit: CATALOG_PAGE_SIZE };
    if (state.query) query.query = state.query;
    if (state.filter === "builtIn") query.filter = "builtIn";
    else if (state.filter === "untagged") query.filter = "untagged";
    else if (typeof state.filter === "object") {
      query.filter = "tag";
      query.tagId = state.filter.tagId;
    } else {
      query.filter = "all";
    }
    if (cursor) query.cursor = cursor;
    return query;
  };

  const loadFirstPage = async () => {
    const serial = ++requestSerial;
    setState({ status: "loading", error: null });
    const result = await remote.listSnippets(engineQuery());
    if (disposed || serial !== requestSerial) return;
    if (!result.ok) {
      setState({ status: "error", error: result.error, items: [], total: 0, nextCursor: null });
      return;
    }
    setState({
      status: "ready",
      items: [...result.value.items],
      total: result.value.total,
      nextCursor: result.value.nextCursor,
      error: null
    });
  };

  const loadCounts = async () => {
    if (disposed) return;
    const serial = requestSerial;
    const [all, builtIn, untagged] = await Promise.all([
      remote.listSnippets({ filter: "all", limit: 1 }),
      remote.listSnippets({ filter: "builtIn", limit: 1 }),
      remote.listSnippets({ filter: "untagged", limit: 1 })
    ]);
    if (disposed || serial !== requestSerial) return;
    setState({
      counts: {
        all: all.ok ? all.value.total : state.counts.all,
        builtIn: builtIn.ok ? builtIn.value.total : state.counts.builtIn,
        untagged: untagged.ok ? untagged.value.total : state.counts.untagged
      }
    });
  };

  const loadTags = async () => {
    const serial = requestSerial;
    setTagState({ status: "loading" });
    const result = await remote.listSnippetTags();
    if (disposed || serial !== requestSerial) return;
    if (!result.ok) {
      setTagState({ status: "error", error: result.error });
      return;
    }
    setTagState({ status: "ready", items: result.value, error: null });
  };

  const scheduleReload = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void loadFirstPage();
    }, debounceMs);
  };

  const mapFailure = <T>(result: Extract<SnippetResult<T>, { ok: false }>): MutationResult<T> => ({
    ok: false,
    code: result.code,
    error: result.error
  });

  return {
    getState: () => state,
    getTagState: () => tagState,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setQuery(query) {
      state = { ...state, query };
      emit();
      scheduleReload();
    },
    setFilter(filter) {
      state = { ...state, filter, activeTagId: typeof filter === "object" ? filter.tagId : null };
      emit();
      scheduleReload();
    },
    async loadMore() {
      if (state.status !== "ready" || state.loadingMore || !state.nextCursor) return;
      const serial = requestSerial;
      setState({ loadingMore: true });
      const result = await remote.listSnippets(engineQuery(state.nextCursor));
      if (disposed || serial !== requestSerial) return;
      if (!result.ok) {
        setState({ loadingMore: false, error: result.error });
        return;
      }
      setState({
        items: [...state.items, ...result.value.items],
        total: result.value.total,
        nextCursor: result.value.nextCursor,
        loadingMore: false
      });
    },
    async refresh() {
      await loadFirstPage();
      await Promise.all([loadTags(), loadCounts()]);
    },
    loadTags,
    async createSnippet(input) {
      const result = await remote.createSnippet({ ...input, operationId: nextOperationId("snippet-create") });
      if (!result.ok) return mapFailure(result);
      await loadFirstPage();
      await Promise.all([loadTags(), loadCounts()]);
      return { ok: true, value: result.value };
    },
    async updateSnippet(input) {
      const result = await remote.updateSnippet(input);
      if (!result.ok) return mapFailure(result);
      // 局部替换，避免整页重载丢失滚动位置。
      setState({ items: state.items.map((item) => (item.id === result.value.id ? result.value : item)) });
      await Promise.all([loadTags(), loadCounts()]);
      return { ok: true, value: result.value };
    },
    async deleteSnippet(snippetId) {
      const result = await remote.deleteSnippet(snippetId);
      if (!result.ok) return mapFailure(result);
      setState({ items: state.items.filter((item) => item.id !== snippetId), total: Math.max(0, state.total - 1) });
      await Promise.all([loadTags(), loadCounts()]);
      return { ok: true, value: null };
    },
    async createTag(input) {
      const result = await remote.createSnippetTag({ ...input, operationId: nextOperationId("tag-create") });
      if (!result.ok) return mapFailure(result);
      await loadTags();
      return { ok: true, value: result.value };
    },
    async renameTag(input) {
      const result = await remote.renameSnippetTag(input);
      if (!result.ok) return mapFailure(result);
      await loadTags();
      return { ok: true, value: result.value };
    },
    async deleteTag(tagId) {
      const result = await remote.deleteSnippetTag(tagId);
      if (!result.ok) return mapFailure(result);
      await loadTags();
      return { ok: true, value: null };
    },
    dispose() {
      disposed = true;
      requestSerial += 1;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = null;
      listeners.clear();
    }
  };
}
