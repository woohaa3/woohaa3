/**
 * 全局任务历史页（change: split-web-runtime-services，任务 6.5 / 6.6 / 6.7；
 *   change: 2026-10-06-improve-task-history-experience，任务 3.1–3.4、4.1–4.3、5.1–5.5）。
 *
 * 唯一数据源是 Task Service 的 history read model（design D11）：不从 Canvas Y.Doc 拼装。
 * 页面**只读**，不含 submit/cancel 权限。
 *
 * 阶段一：draft/applied 筛选分离、多状态与全条件查询、cursor 分页、真实增量订阅与断线恢复、
 * 「有 N 条新任务」缓冲、按状态组织详情（见 `history-detail`）、响应式布局与局部反馈。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskExecutionDetail, TaskHistoryCandidates } from "@woohaa3/contracts";
import {
  TaskHistoryError,
  type TaskHistoryClient,
  type TaskHistoryConnectionStatus
} from "../../shared/task-history/client.js";
import {
  EMPTY_HISTORY_FILTERS,
  addBufferedTaskKeys,
  adjacentTaskKeys,
  mergeHistoryRecord,
  tabToStates,
  type HistoryFilters,
  type HistoryRow,
  type HistoryTab
} from "./history-state.js";
import {
  HISTORY_TIME_SHORTCUTS,
  isoToLocalDateTime,
  isValidRange,
  localDateTimeToIso,
  localTimeZoneName,
  shortcutRange
} from "./history-time.js";
import { copyToClipboard, filterTags } from "./history-format.js";
import { HistoryDetail } from "./history-detail.js";
import { HistoryRowView } from "./history-row.js";
import { HistoryToolbar } from "./history-toolbar.js";

export type TaskHistoryPageProps = {
  client: TaskHistoryClient;
  /** 跳转到画布节点（宿主注入；缺省时禁用跳转）。 */
  onOpenCanvas?: (input: { canvasId: string; nodeId: string }) => void;
  /** 由稳定 storageKey 构造受控同源媒体 URL（由 Media Remote 注入）。 */
  resolveMediaUrl: (storageKey: string, canvasId?: string) => string;
  pageSize?: number;
  /** 复制适配（宿主/Showcase 注入）；缺省用系统 clipboard。 */
  copyText?: (value: string) => Promise<boolean | void>;
  /** URL 恢复的初始查询/选中（由 Router 注入）。 */
  initialQuery?: HistoryFilters & { tab?: HistoryTab };
  initialTaskKey?: string;
  /** URL 恢复的当前页 opaque cursor。 */
  initialCursor?: string;
  /** 外部（Back/Forward）location token；变化时从 URL 重建状态。 */
  locationToken?: string;
  /** 查询/选中/翻页变化时上报（宿主写 URL）。 */
  onLocationChange?: (location: { filters: HistoryFilters; tab: HistoryTab; taskKey?: string; cursor?: string }) => void;
  /** 布局覆盖（Showcase 验收用）；缺省按容器宽度自动降级。 */
  detailLayout?: "auto" | "side" | "overlay" | "fullscreen";
};

export function TaskHistoryPage({
  client,
  onOpenCanvas,
  resolveMediaUrl,
  pageSize = 20,
  copyText = copyToClipboard,
  initialQuery,
  initialTaskKey,
  initialCursor,
  locationToken,
  onLocationChange,
  detailLayout = "auto"
}: TaskHistoryPageProps) {
  const history = client;
  if (!history) throw new Error("TaskHistoryPage 需要注入 client（Task Remote）");
  const [tab, setTab] = useState<HistoryTab>(initialQuery?.tab ?? "all");
  const [draft, setDraft] = useState<HistoryFilters>(() => ({ ...EMPTY_HISTORY_FILTERS, ...(initialQuery ?? {}) }));
  const [applied, setApplied] = useState<HistoryFilters>(() => ({ ...EMPTY_HISTORY_FILTERS, ...(initialQuery ?? {}) }));
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([initialCursor]);
  const [pageIndex, setPageIndex] = useState(initialCursor ? 1 : 0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [watermark, setWatermark] = useState(0);
  const [newTaskKeys, setNewTaskKeys] = useState<string[]>([]);
  const [connection, setConnection] = useState<TaskHistoryConnectionStatus>({ state: "connecting" });
  const [detail, setDetail] = useState<TaskExecutionDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<TaskHistoryCandidates>({ providers: [], models: [], plugins: [] });
  const [draftDirty, setDraftDirty] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const generationRef = useRef(0);
  const detailGenerationRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const selectedTaskKeyRef = useRef<string | null>(initialTaskKey ?? null);
  const selfNavigationRef = useRef(false);
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const cursorStackRef = useRef(cursorStack);
  cursorStackRef.current = cursorStack;
  const pageIndexRef = useRef(pageIndex);
  pageIndexRef.current = pageIndex;

  const notifyLocation = useCallback(
    (filters: HistoryFilters, nextTab: HistoryTab, taskKey?: string | null, cursor?: string) => {
      selfNavigationRef.current = true;
      onLocationChange?.({
        filters,
        tab: nextTab,
        ...(taskKey ? { taskKey } : {}),
        ...(cursor ? { cursor } : {})
      });
    },
    [onLocationChange]
  );

  const buildQuery = useCallback(
    (filters: HistoryFilters, nextTab: HistoryTab, cursor?: string) => {
      const states = tabToStates(nextTab);
      return {
        ...(states ? { states } : {}),
        ...(filters.providerId ? { providerId: filters.providerId } : {}),
        ...(filters.modelType ? { modelType: filters.modelType } : {}),
        ...(filters.modelKey ? { modelKey: filters.modelKey } : {}),
        ...(filters.canvasId ? { canvasId: filters.canvasId } : {}),
        ...(filters.nodeId ? { nodeId: filters.nodeId } : {}),
        ...(filters.taskKey ? { taskKey: filters.taskKey } : {}),
        ...(filters.source ? { source: filters.source } : {}),
        ...(filters.extensionId ? { extensionId: filters.extensionId } : {}),
        ...(filters.from ? { from: filters.from } : {}),
        ...(filters.to ? { to: filters.to } : {}),
        limit: pageSize,
        ...(cursor ? { cursor } : {})
      };
    },
    [pageSize]
  );

  const loadPage = useCallback(
    async (filters: HistoryFilters, nextTab: HistoryTab, cursor: string | undefined, mode: "initial" | "refresh") => {
      const generation = ++generationRef.current;
      listAbortRef.current?.abort();
      const controller = new AbortController();
      listAbortRef.current = controller;
      if (mode === "refresh") setRefreshing(true);
      else setLoading(true);
      try {
        const page = await history.list(buildQuery(filters, nextTab, cursor), controller.signal);
        if (generation !== generationRef.current) return;
        setRows(page.items);
        setNextCursor(page.nextCursor);
        setWatermark(page.watermark);
        setListError(null);
        setHasLoaded(true);
      } catch (error) {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        // page cursor 失效：重置到第一页（不把错误伪装成空列表）。
        if (error instanceof TaskHistoryError && (error.code === "cursor-mismatch" || error.code === "invalid-cursor")) {
          setCursorStack([undefined]);
          setPageIndex(0);
          setListError(`${error.message}，已回到第一页`);
        } else {
          setListError(error instanceof Error ? error.message : "历史加载失败");
        }
      } finally {
        if (generation === generationRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [history, buildQuery]
  );

  // 初始加载（一次；后续由 apply/refresh/翻页显式触发）。
  useEffect(() => {
    void loadPage(appliedRef.current, tabRef.current, cursorStackRef.current[pageIndexRef.current], "initial");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 筛选候选：只读、含历史下线模型；不启动 Canvas。
  useEffect(() => {
    let active = true;
    void history
      .candidates({})
      .then((value) => {
        if (active) setCandidates(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [history]);

  const reloadDetail = useCallback(
    async (taskKey: string) => {
      const generation = ++detailGenerationRef.current;
      setDetailError(null);
      try {
        const result = await history.detail(taskKey);
        if (generation !== detailGenerationRef.current || selectedTaskKeyRef.current !== taskKey) return;
        if (result.ok) setDetail(result.detail);
        else {
          setDetail(null);
          setDetailError(result.code === "task-not-found" ? "该执行记录不存在或已超过保留期" : result.message);
        }
      } catch (error) {
        if (generation !== detailGenerationRef.current || selectedTaskKeyRef.current !== taskKey) return;
        setDetail(null);
        setDetailError(error instanceof Error ? error.message : "详情加载失败");
      }
    },
    [history]
  );

  const openDetail = useCallback(
    async (taskKey: string) => {
      selectedTaskKeyRef.current = taskKey;
      notifyLocation(appliedRef.current, tabRef.current, taskKey);
      await reloadDetail(taskKey);
    },
    [notifyLocation, reloadDetail]
  );

  const closeDetail = useCallback(() => {
    selectedTaskKeyRef.current = null;
    detailGenerationRef.current += 1;
    setDetail(null);
    setDetailError(null);
    notifyLocation(appliedRef.current, tabRef.current, null);
  }, [notifyLocation]);

  // Back/Forward 或外部 location 变化：从 URL 恢复状态并重读（同一 scope 复用）。
  useEffect(() => {
    if (locationToken === undefined) return;
    if (selfNavigationRef.current) {
      selfNavigationRef.current = false;
      return;
    }
    const restoredFilters: HistoryFilters = { ...EMPTY_HISTORY_FILTERS, ...(initialQuery ?? {}) };
    const restoredTab: HistoryTab = initialQuery?.tab ?? "all";
    setApplied(restoredFilters);
    setDraft(restoredFilters);
    setTab(restoredTab);
    setCursorStack([initialCursor]);
    setPageIndex(initialCursor ? 1 : 0);
    setNewTaskKeys([]);
    selectedTaskKeyRef.current = initialTaskKey ?? null;
    if (initialTaskKey) void reloadDetail(initialTaskKey);
    else {
      detailGenerationRef.current += 1;
      setDetail(null);
      setDetailError(null);
    }
    void loadPage(restoredFilters, restoredTab, initialCursor, "refresh");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationToken]);

  // 增量订阅：按完整谓词合并；新任务进入去重缓冲；断线/失效由 Remote 处理。
  useEffect(() => {
    if (!hasLoaded) return undefined;
    const unsubscribe = history.subscribe({
      cursor: watermark,
      onRecord: (record) => {
        setRows((previous) => {
          const result = mergeHistoryRecord(previous, record, appliedRef.current);
          if (result.isNew) setNewTaskKeys((buffer) => addBufferedTaskKeys(buffer, record.taskKey));
          return result.rows;
        });
        // 选中详情的 summary 变化 → 有界重取完整详情（含 timeline）。
        if (selectedTaskKeyRef.current && selectedTaskKeyRef.current === record.taskKey) {
          void reloadDetail(record.taskKey);
        }
      },
      onStatus: (status) => setConnection(status),
      onResync: () => {
        void loadPage(appliedRef.current, tabRef.current, cursorStackRef.current[pageIndexRef.current], "refresh");
      },
      onError: () => undefined
    });
    return unsubscribe;
    // watermark 变化会重建订阅（resync/换页后从新水位接续）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, hasLoaded, watermark]);

  const applyQuery = useCallback(
    (filters: HistoryFilters, nextTab: HistoryTab) => {
      if (!isValidRange(filters.from, filters.to)) {
        setRangeError("起始时间不能晚于结束时间");
        return;
      }
      setRangeError(null);
      setApplied(filters);
      setTab(nextTab);
      setDraft(filters);
      setCursorStack([undefined]);
      setPageIndex(0);
      setNewTaskKeys([]);
      notifyLocation(filters, nextTab, selectedTaskKeyRef.current);
      void loadPage(filters, nextTab, undefined, hasLoadedRef.current ? "refresh" : "initial");
    },
    [loadPage, notifyLocation]
  );
  const hasLoadedRef = useRef(hasLoaded);
  hasLoadedRef.current = hasLoaded;

  const refresh = useCallback(() => {
    const filters = appliedRef.current;
    if (!isValidRange(filters.from, filters.to)) {
      setRangeError("起始时间不能晚于结束时间");
      return;
    }
    const cursor = cursorStackRef.current[pageIndexRef.current];
    notifyLocation(filters, tabRef.current, selectedTaskKeyRef.current, cursor);
    setNewTaskKeys([]);
    void loadPage(filters, tabRef.current, cursor, "refresh");
  }, [loadPage, notifyLocation]);

  const goPage = useCallback(
    (target: number, cursor: string | undefined) => {
      setPageIndex(target);
      notifyLocation(appliedRef.current, tabRef.current, selectedTaskKeyRef.current, cursor);
      void loadPage(appliedRef.current, tabRef.current, cursor, "refresh");
    },
    [loadPage, notifyLocation]
  );

  const goLatest = useCallback(() => {
    setCursorStack([undefined]);
    setPageIndex(0);
    setNewTaskKeys([]);
    void loadPage(appliedRef.current, tabRef.current, undefined, "refresh");
  }, [loadPage]);

  const appliedTags = useMemo(() => filterTags(applied), [applied]);
  const adjacent = useMemo(() => adjacentTaskKeys(rows, detail?.taskKey), [rows, detail?.taskKey]);
  const zone = localTimeZoneName();

  const updateDraft = (patch: Partial<HistoryFilters>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setDraftDirty(true);
  };
  const removeTag = (id: keyof HistoryFilters) => applyQuery({ ...applied, [id]: EMPTY_HISTORY_FILTERS[id] }, tab);
  const clearAll = () => applyQuery({ ...EMPTY_HISTORY_FILTERS }, tab);
  const selectShortcut = (shortcut: (typeof HISTORY_TIME_SHORTCUTS)[number]) => {
    const range = shortcutRange(shortcut);
    updateDraft({ from: isoToLocalDateTime(range.from), to: isoToLocalDateTime(range.to) });
  };
  const applyDraft = () => {
    applyQuery({ ...draft, from: localDateTimeToIso(draft.from) ?? "", to: localDateTimeToIso(draft.to) ?? "" }, tab);
    setDraftDirty(false);
  };

  const layoutClass = detailLayout === "auto" ? "" : ` task-history--detail-${detailLayout}`;

  return (
    <div className={`task-history${layoutClass}`} data-testid="task-history-page">
      <HistoryToolbar
        draft={draft}
        tab={tab}
        zone={zone}
        connection={connection}
        candidates={candidates}
        appliedTags={appliedTags}
        draftDirty={draftDirty}
        rangeError={rangeError}
        newTaskCount={newTaskKeys.length}
        refreshing={refreshing}
        onTabChange={(next) => applyQuery(applied, next)}
        onDraftChange={updateDraft}
        onApplyDraft={applyDraft}
        onShortcut={selectShortcut}
        onRemoveTag={removeTag}
        onClearAll={clearAll}
        onRefresh={refresh}
        onGoLatest={goLatest}
      />

      {listError ? (
        <p className={`task-history__error${hasLoaded ? " task-history__error--stale" : ""}`} role="alert">
          <span>{hasLoaded ? `${listError}（当前显示上次成功查询结果）` : listError}</span>
          <button type="button" onClick={refresh}>
            重试
          </button>
        </p>
      ) : null}

      <div className="task-history__table-wrap">
        <table className="task-history__table" aria-busy={refreshing || undefined}>
          <thead>
            <tr>
              <th scope="col">任务</th>
              <th scope="col">来源</th>
              <th scope="col">状态</th>
              <th scope="col">结果 / 异常</th>
              <th scope="col">时间</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && !hasLoaded
              ? [0, 1, 2].map((index) => (
                  <tr key={`skeleton-${index}`} aria-hidden="true">
                    <td colSpan={6}>
                      <span className="task-history__skeleton-row" />
                    </td>
                  </tr>
                ))
              : null}
            {(!loading || hasLoaded) &&
              rows.map((row) => (
                <HistoryRowView
                  key={row.taskKey}
                  row={row}
                  selected={detail?.taskKey === row.taskKey}
                  onOpen={() => void openDetail(row.taskKey)}
                  onOpenCanvas={onOpenCanvas}
                  onCopy={copyText}
                  resolveMediaUrl={resolveMediaUrl}
                />
              ))}
            {!loading && hasLoaded && rows.length === 0 ? (
              appliedTags.length > 0 || tab !== "all" ? (
                <tr>
                  <td colSpan={6} className="task-history__empty">
                    没有匹配的执行记录
                    <button type="button" onClick={clearAll}>
                      清除筛选条件
                    </button>
                  </td>
                </tr>
              ) : (
                <tr>
                  <td colSpan={6} className="task-history__empty">暂无执行记录</td>
                </tr>
              )
            ) : null}
          </tbody>
        </table>
      </div>

      <footer className="task-history__pager">
        <button type="button" disabled={pageIndex === 0} onClick={() => goPage(Math.max(0, pageIndex - 1), cursorStackRef.current[Math.max(0, pageIndex - 1)])}>
          上一页
        </button>
        <span>第 {pageIndex + 1} 页</span>
        <button
          type="button"
          disabled={!nextCursor}
          onClick={() => {
            const target = pageIndex + 1;
            setCursorStack((stack) => {
              const next = [...stack];
              next[target] = nextCursor;
              return next;
            });
            goPage(target, nextCursor);
          }}
        >
          下一页
        </button>
        {refreshing ? <span className="task-history__busy">加载中…</span> : null}
      </footer>

      {detail || detailError ? (
        <HistoryDetail
          detail={detail}
          error={detailError}
          layout={detailLayout}
          resolveMediaUrl={resolveMediaUrl}
          copyText={copyText}
          onClose={closeDetail}
          onOpenCanvas={onOpenCanvas}
          previousTaskKey={adjacent.previous}
          nextTaskKey={adjacent.next}
          onSelect={(taskKey) => void openDetail(taskKey)}
        />
      ) : null}
    </div>
  );
}



export { formatDuration, formatLocalTime, stageLabel } from "./history-format.js";
export { HistoryDetail, TaskStateBadge } from "./history-detail.js";
export type { HistoryDetailProps } from "./history-detail.js";
export type { HistoryFilters, HistoryRow, HistoryTab } from "./history-state.js";
export { recordMatchesFilters } from "./history-state.js";
