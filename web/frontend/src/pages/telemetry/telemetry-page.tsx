/**
 * 本机遥测复盘页 `/telemetry`（纯渲染层）
 * （change: 2026-10-20-add-local-client-telemetry，任务 5.2 / design D9/D10）。
 *
 * 分层：本文件与同目录其余模块只做**渲染与派生**，不 import Cordis / Canvas Session，
 * 也不发请求——取数、URL 与 loading/错误态由 `cordis/plugins/telemetry/plugin.tsx` 适配层负责。
 * 这样页面可以用 `renderToStaticMarkup` 直接覆盖五种状态，不必搭一套假运行时。
 *
 * 四段布局（design D9）：异常概览 → 窗口聚合与趋势 → 事件列表（含筛选与游标分页）→ 详情侧栏。
 * 数据密度高是它做成独立页而不是设置弹窗的原因，也因此保留可分享的 URL。
 */
import type {
  TelemetryAnomaly,
  TelemetryEventRecord,
  TelemetryStatus,
  TelemetrySummary
} from "@woohaa3/contracts";
import { Button, IconButton } from "../../shared/ui/index.js";
import { BackIcon, RefreshIcon } from "../../shared/ui/index.js";
import "./telemetry.css";
import { EventDetailPanel } from "./detail-panel.js";
import { EventFilters, EventTable, LoadMoreBar } from "./event-list.js";
import { localTimeZoneName } from "./format.js";
import {
  AnomalyOverview,
  CountTrend,
  DurationRanking,
  TelemetryFooter,
  TelemetryNotices,
  WindowSummaryTable
} from "./overview-panel.js";
import { TelemetryStatePanel } from "./state-panel.js";
import { hasTelemetryFilters, patchTelemetryQuery, type TelemetryQuery } from "./query.js";
import { findEvent, resolveTelemetryViewState, telemetryNotices } from "./model.js";

export type TelemetryPageProps = {
  /** 已应用查询（来自类型化 URL）。 */
  query: TelemetryQuery;
  /** 页面本地筛选（错误码；不进 URL）。 */
  errorCode?: string;
  status: TelemetryStatus | null;
  /** 读取状态/列表失败的安全文案；非空即"遥测服务不可用"。 */
  statusError?: string | null;
  summary: TelemetrySummary | null;
  anomalies: readonly TelemetryAnomaly[];
  events: readonly TelemetryEventRecord[];
  nextCursor?: string;
  /** 首次加载（状态或首页事件还没回来）。 */
  loading: boolean;
  /** 「加载更多」进行中。 */
  eventsLoading: boolean;
  eventsError?: string | null;
  onChangeQuery: (next: TelemetryQuery, options?: { replace?: boolean }) => void;
  onErrorCodeChange: (errorCode: string | undefined) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  /**
   * 返回画布。
   *
   * 复盘页是**整页路由**（应用外壳全屏、没有全局顶栏），所以必须自带返回出口；否则从设置点进来
   * 之后就只剩浏览器后退可走。目标画布由调用方按 URL 里的 `canvasId` 决定。
   */
  onBack: () => void;
  /** 打开设置（"记录已关闭"状态里的开启入口）；缺省时只显示文案。 */
  onOpenSettings?: () => void;
};

export function TelemetryPage({
  query,
  errorCode,
  status,
  statusError,
  summary,
  anomalies,
  events,
  nextCursor,
  loading,
  eventsLoading,
  eventsError,
  onChangeQuery,
  onErrorCodeChange,
  onRefresh,
  onLoadMore,
  onBack,
  onOpenSettings
}: TelemetryPageProps) {
  const view = resolveTelemetryViewState({
    status,
    statusError: statusError ?? null,
    loading,
    hasEvents: events.length > 0,
    filtered: hasTelemetryFilters(query, errorCode ? { errorCode } : {})
  });
  const notices = telemetryNotices(status);
  const selected = findEvent(events, query.eventId);
  // 有可读的记录面才显示筛选与两段聚合：关闭/不可用时"筛什么"没有意义。
  //
  // 由 `view.kind` 推导而不是重读 `status`：两者语义等价（`ready`/`empty` 只在
  // 存储可用且记录开启时出现），但由 view 推导能让下面的分支对 TS 收窄——否则
  // 状态面板会把一个未排除 `ready` 的联合类型当作入参。
  const browse = view.kind === "ready" || view.kind === "empty";

  const changeFilters = (patch: Parameters<typeof patchTelemetryQuery>[1]) => {
    onChangeQuery(patchTelemetryQuery(query, patch));
  };

  const clearFilters = () => {
    onErrorCodeChange(undefined);
    // 只清筛选，**保留 canvasId**：那是返回目标，不是筛选条件。分组也不算筛选，一并清掉
    // （清除筛选的语义是"回到默认视图"，留着分组会让聚合表与事件名口径不一致）。
    onChangeQuery({ window: query.window, ...(query.canvasId ? { canvasId: query.canvasId } : {}) });
  };

  return (
    <section className="telemetry" data-testid="telemetry-page" aria-label="本机遥测复盘">
      <header className="telemetry__header">
        <div className="telemetry__heading">
          <IconButton label="返回画布" size="sm" data-testid="telemetry-back" onClick={onBack}>
            <BackIcon />
          </IconButton>
          <div>
            <h1 className="telemetry__title">本机遥测复盘</h1>
            <p className="telemetry__subtitle">
              只读复盘本机记录的事件、窗口聚合与异常命中；数据不出本机。
              <span className="telemetry__tz">时间按 {localTimeZoneName()} 显示</span>
            </p>
          </div>
        </div>
        <div className="telemetry__header-actions">
          <Button
            tone="ghost"
            icon={<RefreshIcon />}
            onClick={onRefresh}
            loading={loading}
            data-testid="telemetry-refresh"
          >
            刷新
          </Button>
        </div>
      </header>

      <TelemetryNotices notices={notices} />

      {browse ? (
        <div className="telemetry__content">
          <div className="telemetry__main">
            <AnomalyOverview anomalies={anomalies} window={query.window} {...(query.groupBy ? { groupBy: query.groupBy } : {})} />
            <WindowSummaryTable summary={summary} />
            <DurationRanking summary={summary} />
            <CountTrend summary={summary} />

            <section className="telemetry__section" data-testid="telemetry-events-section">
              <header className="telemetry__section-head">
                <h2>事件列表</h2>
                <span className="telemetry__section-hint">最新在前 · 已载入 {events.length} 条</span>
              </header>
              <EventFilters
                window={query.window}
                {...(query.name ? { name: query.name } : {})}
                {...(query.result ? { result: query.result } : {})}
                {...(query.mode ? { mode: query.mode } : {})}
                {...(query.groupBy ? { groupBy: query.groupBy } : {})}
                {...(errorCode ? { errorCode } : {})}
                onWindowChange={(window) => changeFilters({ window })}
                onNameChange={(name) => changeFilters({ name: name ?? "" })}
                onResultChange={(result) => changeFilters({ result: result ?? "" })}
                onModeChange={(mode) => changeFilters({ mode: mode ?? "" })}
                onGroupByChange={(groupBy) => changeFilters({ groupBy: groupBy ?? "" })}
                onErrorCodeApply={(next) => {
                  // 错误码是页面本地筛选：先清游标与选中项，再交给适配层重取。
                  onErrorCodeChange(next);
                  onChangeQuery(patchTelemetryQuery(query, { cursor: "", eventId: "" }), { replace: true });
                }}
                onClear={clearFilters}
              />
              {view.kind === "ready" ? (
                <>
                  <EventTable
                    events={events}
                    {...(query.eventId ? { selectedEventId: query.eventId } : {})}
                    onSelect={(eventId) => onChangeQuery(patchTelemetryQuery(query, { eventId }), { replace: true })}
                  />
                  <LoadMoreBar
                    {...(nextCursor ? { nextCursor } : {})}
                    loading={eventsLoading}
                    {...(eventsError ? { error: eventsError } : {})}
                    onLoadMore={onLoadMore}
                  />
                </>
              ) : (
                <TelemetryStatePanel
                  state={view}
                  onClearFilters={clearFilters}
                  {...(onOpenSettings ? { onOpenSettings } : {})}
                />
              )}
            </section>
          </div>

          {selected ? (
            <EventDetailPanel
              event={selected}
              onClose={() => onChangeQuery(patchTelemetryQuery(query, { eventId: "" }), { replace: true })}
            />
          ) : null}
        </div>
      ) : (
        <TelemetryStatePanel
          state={view}
          onRetry={onRefresh}
          onClearFilters={clearFilters}
          {...(onOpenSettings ? { onOpenSettings } : {})}
        />
      )}

      <TelemetryFooter status={status} />
    </section>
  );
}
