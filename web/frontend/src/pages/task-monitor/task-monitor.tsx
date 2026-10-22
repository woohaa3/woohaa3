/**
 * /admin/tasks 全局任务监控页
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 8.4/8.5/8.7 / design D9/D11）。
 *
 * 只读管理面：页首全局状态计数与最近成功时间；筛选工具栏（草稿与已应用条件分离，Enter/应用
 * 一次提交）；有界任务列表；宽屏详情侧栏（`layout="auto"` 由 CSS 在窄窗口降级为覆盖）。
 *
 * 实时：5 秒轮询、页面隐藏暂停、断线保留快照并标记陈旧；在途耗时按 observedAt 本地递增，
 * 终态冻结。刷新不覆盖未应用草稿、选中详情、页游标或焦点。app-scoped，不启动 CanvasSession/
 * WASM/Canvas 插件。
 *
 * 展示子组件、详情侧栏与草稿模型分别见 `./list-panels.js`、`./detail-panel.js`、`./monitor-model.js`
 * （规模门禁 ≤500 行拆分）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskHistoryQuery, TaskInspectionSnapshot } from "@woohaa3/contracts";
import { Button } from "../../shared/ui/index.js";
import { LocateIcon, RefreshIcon } from "../../shared/ui/index.js";
import type { TaskMonitorRemote } from "./remote.js";
import { formatLocalTime, localTimeZoneName } from "./format.js";
import {
  draftFromQuery,
  draftTags,
  emptyDraft,
  hasFilters,
  queryFromDraft,
  type DraftState
} from "./monitor-model.js";
import { StateCounts, TaskTable, Toolbar, neighbour } from "./list-panels.js";
import { DetailPanel } from "./detail-panel.js";
import "./task-monitor.css";

export type TaskMonitorPageProps = {
  remote: TaskMonitorRemote;
  /** 已应用查询（来自类型化 URL）。 */
  appliedQuery: TaskHistoryQuery;
  selectedTaskKey?: string;
  /** 更新 URL/应用查询（宿主 Router；replace 不新增 back entry）。 */
  onQueryChange: (next: { query: TaskHistoryQuery; taskKey?: string; replace?: boolean }) => void;
  /** 打开画布（仍需该画布 read；此处只提交导航意图）。 */
  onOpenCanvas?: (input: { canvasId: string; nodeId?: string }) => void;
  resolveMediaUrl?: (storageKey: string, canvasId?: string) => string;
  /** 只读：本页不提供取消/重试。 */
  pollIntervalMs?: number;
  pageSize?: number;
};

const POLL_INTERVAL_MS = 5_000;
const DEFAULT_PAGE_SIZE = 100;

export function TaskMonitorPage({
  remote,
  appliedQuery,
  selectedTaskKey,
  onQueryChange,
  onOpenCanvas,
  resolveMediaUrl,
  pollIntervalMs = POLL_INTERVAL_MS,
  pageSize = DEFAULT_PAGE_SIZE
}: TaskMonitorPageProps) {
  const [snapshot, setSnapshot] = useState<TaskInspectionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<{ code: string; message: string } | null>(null);
  const [staleSince, setStaleSince] = useState<string | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>(() => draftFromQuery(appliedQuery));
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [detail, setDetail] = useState<TaskInspectionSnapshot["items"][number] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const generation = useRef(0);
  const listScrollTop = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  /** 打开详情时聚焦的触发元素（行内「查看详情」按钮）；关闭后把焦点还给它（任务 8.7）。 */
  const detailTriggerRef = useRef<HTMLElement | null>(null);

  // 已应用查询变化（Back/Forward/URL）时同步草稿；草稿本身不触发请求。
  const appliedKey = useMemo(() => JSON.stringify(appliedQuery), [appliedQuery]);
  useEffect(() => {
    setDraft(draftFromQuery(appliedQuery));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedKey]);

  const load = useCallback(
    async (query: TaskHistoryQuery) => {
      const gen = ++generation.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      setListError(null);
      const outcome = await remote.snapshot({ query, limit: pageSize, signal: controller.signal });
      if (gen !== generation.current) return;
      setLoading(false);
      if (!outcome.ok) {
        if (outcome.code === "aborted") return;
        setListError({ code: outcome.code, message: outcome.error });
        // 网络/服务失败：保留合法快照并标记陈旧，不显示为空。
        if (snapshot) setStaleSince(lastSuccessAt ?? new Date().toISOString());
        return;
      }
      setSnapshot(outcome.value);
      setStaleSince(null);
      setLastSuccessAt(outcome.value.observedAt);
    },
    // snapshot 只用于断线保留判断，不参与请求身份。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [remote, pageSize, lastSuccessAt]
  );

  // 应用查询变化时读取（初始 + Back/Forward）。
  useEffect(() => {
    void load(appliedQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedKey, load]);

  // 5 秒轮询；页面隐藏暂停。
  useEffect(() => {
    if (pollIntervalMs <= 0) return;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load(appliedQuery);
    };
    const timer = setInterval(tick, pollIntervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load(appliedQuery);
    };
    document.addEventListener?.("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener?.("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedKey, load, pollIntervalMs]);

  // 在途耗时本地 1 秒递增（终态冻结）。
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  // 选中详情独立读取（可不在当前列表页）。
  useEffect(() => {
    if (!selectedTaskKey) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    void remote.detail({ taskKey: selectedTaskKey }).then((outcome) => {
      if (cancelled) return;
      setDetailLoading(false);
      if (!outcome.ok) {
        setDetail(null);
        setDetailError(outcome.code === "not-found" ? "任务不存在或已超过保留期" : outcome.error);
        return;
      }
      setDetail(outcome.value);
    });
    return () => {
      cancelled = true;
    };
  }, [remote, selectedTaskKey]);

  const apply = (next: Partial<DraftState>, replace = false) => {
    const merged = { ...draft, ...next };
    setDraft(merged);
    onQueryChange({ query: queryFromDraft(merged), replace });
  };

  const clearAll = () => {
    const empty = emptyDraft();
    setDraft(empty);
    onQueryChange({ query: queryFromDraft(empty), replace: true });
  };

  const removeTag = (key: keyof DraftState) => {
    // 从**已应用**条件移除并回到第一页；未应用草稿一并丢弃，避免顺带提交其它编辑。
    const next = { ...appliedState, [key]: "" };
    next.cursor = "";
    setDraft(next);
    onQueryChange({ query: queryFromDraft(next), replace: true });
  };

  const items = snapshot?.items ?? [];
  const stateCounts = snapshot?.stateCounts;
  // 「已应用条件」标签来自**已应用**查询而不是草稿：草稿改变只显示未应用提示，不提前生成
  // 标签，也不改变列表（design/task-monitoring「区分筛选草稿与已应用条件」）。
  const appliedState = draftFromQuery(appliedQuery);
  const appliedTags = draftTags(appliedState);
  // 两侧都经 `queryFromDraft` 归一化（键顺序/空值一致），避免 URL 解码顺序造成误报「未应用」。
  const draftDirty = JSON.stringify(queryFromDraft(draft)) !== JSON.stringify(queryFromDraft(appliedState));
  // 来路画布：从画布进入监控时 `openTaskInspection` 已把 canvasId（及 nodeId）记进既有查询字段，
  // 不新增契约；页首据此提供一次「返回画布」，不必先打开某条详情。
  const originCanvasId = appliedQuery.canvasId;

  const selectTask = (taskKey: string | undefined, replace = false) => {
    if (typeof document !== "undefined") {
      const list = document.querySelector<HTMLElement>("[data-testid='task-monitor-list']");
      if (list) listScrollTop.current = list.scrollTop;
      // 记录打开详情的触发元素，关闭后把焦点还给它（keyboard/focus-return，任务 8.7）。
      if (taskKey) {
        const active = document.activeElement;
        if (active instanceof HTMLElement) detailTriggerRef.current = active;
      }
    }
    onQueryChange({ query: appliedQuery, ...(taskKey ? { taskKey } : {}), replace });
  };

  // 详情关闭（选中项清空）时恢复焦点到触发行；元素已被重渲染移除时静默跳过。
  useEffect(() => {
    if (selectedTaskKey !== undefined) return;
    const trigger = detailTriggerRef.current;
    detailTriggerRef.current = null;
    if (trigger && trigger.isConnected) trigger.focus();
  }, [selectedTaskKey]);

  return (
    <section className="task-monitor" aria-label="任务监控">
      <header className="task-monitor__header">
        <div>
          <h1 className="task-monitor__title">任务监控</h1>
          <p className="task-monitor__observed" aria-live="polite">
            {lastSuccessAt ? `最近成功 ${formatLocalTime(lastSuccessAt)}（${localTimeZoneName()}）` : "尚未同步"}
            {staleSince ? " · 数据可能已陈旧" : ""}
          </p>
        </div>
        <div className="task-monitor__header-actions">
          {onOpenCanvas && originCanvasId ? (
            <>
              {/* 与「刷新」相邻：保留一个文本空格作为行内间隔（不新增容器/样式）。 */}
              <Button
                tone="ghost"
                icon={<LocateIcon />}
                onClick={() => onOpenCanvas({ canvasId: originCanvasId, ...(appliedQuery.nodeId ? { nodeId: appliedQuery.nodeId } : {}) })}
              >
                返回画布
              </Button>
              {" "}
            </>
          ) : null}
          <Button tone="ghost" icon={<RefreshIcon />} onClick={() => void load(appliedQuery)} loading={loading}>
            刷新
          </Button>
        </div>
      </header>

      <StateCounts counts={stateCounts} active={draft.state} onSelect={(state) => apply({ state: draft.state === state ? "" : state }, true)} />

      <Toolbar
        draft={draft}
        draftDirty={draftDirty}
        onDraft={(next) => setDraft((prev) => ({ ...prev, ...next }))}
        onApply={() => apply({}, false)}
        onClearAll={clearAll}
        appliedTags={appliedTags}
        onRemoveTag={removeTag}
      />

      {listError ? (
        <p role="alert" className="task-monitor__error">
          {listError.code === "unauthorized"
            ? "需要登录后查看监控"
            : listError.code === "forbidden"
              ? "缺少 tasks.inspect 权限"
              : listError.code === "unavailable"
                ? "监控服务暂时不可用"
                : `查询失败：${listError.message}`}
        </p>
      ) : null}

      {loading && !snapshot ? (
        <div className="task-monitor__skeleton" role="status" aria-live="polite">
          <span className="visually-hidden">正在加载任务</span>
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="task-monitor__skeleton-row" aria-hidden="true" />
          ))}
        </div>
      ) : items.length === 0 && listError ? null : items.length === 0 ? (
        <div className="task-monitor__empty">
          {hasFilters(appliedState) ? (
            <>
              <p>没有匹配当前条件的任务</p>
              <Button tone="ghost" onClick={clearAll}>
                清除条件
              </Button>
            </>
          ) : (
            <p>暂无执行记录</p>
          )}
        </div>
      ) : (
        <div className="task-monitor__body">
          <TaskTable
            items={items}
            selectedTaskKey={selectedTaskKey}
            nowMs={nowMs}
            onSelect={(taskKey) => selectTask(taskKey)}
            {...(onOpenCanvas ? { onOpenCanvas } : {})}
          />
          {detail || detailError || detailLoading || selectedTaskKey ? (
            <DetailPanel
              detail={detail}
              error={detailError}
              loading={detailLoading}
              nowMs={nowMs}
              resolveMediaUrl={resolveMediaUrl}
              onClose={() => selectTask(undefined, true)}
              onOpenCanvas={onOpenCanvas}
              onNavigate={(delta) => {
                const index = items.findIndex((item) => item.taskKey === selectedTaskKey);
                const next = items[index + delta];
                if (next) selectTask(next.taskKey);
              }}
              previousTaskKey={neighbour(items, selectedTaskKey, -1)}
              nextTaskKey={neighbour(items, selectedTaskKey, 1)}
            />
          ) : null}
        </div>
      )}

      <div className="task-monitor__footer">
        <span aria-live="polite" className="visually-hidden">
          {loading ? "正在刷新任务列表" : `当前显示 ${items.length} 条`}
        </span>
        {snapshot?.nextCursor ? (
          <Button tone="ghost" onClick={() => apply({ cursor: snapshot.nextCursor! }, false)}>
            下一页
          </Button>
        ) : null}
        {appliedQuery.cursor ? (
          <Button tone="ghost" onClick={() => apply({ cursor: "" }, true)}>
            回到最新
          </Button>
        ) : null}
      </div>
    </section>
  );
}
