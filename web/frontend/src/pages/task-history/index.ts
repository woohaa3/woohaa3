/**
 * 全局任务历史页面公开入口（change: 2026-10-10-extract-task-history-page，design D1/D4）。
 *
 * 生产宿主与 Showcase 都消费本入口；页面实现与专属样式在此拥有，不经过 Cordis UI 聚合
 * 或旧插件目录转发。页面只依赖注入的只读 client、媒体 resolver、初始查询与导航回调。
 */
import "./task-history.css";

export { TaskHistoryPage } from "./history-page.js";
export type { TaskHistoryPageProps } from "./history-page.js";
export { HistoryDetail, TaskStateBadge } from "./history-detail.js";
export type { HistoryDetailProps } from "./history-detail.js";
export { formatDuration, formatLocalTime, stageLabel } from "./history-format.js";
export type { HistoryFilters, HistoryRow, HistoryTab } from "./history-state.js";
export { EMPTY_HISTORY_FILTERS, recordMatchesFilters } from "./history-state.js";
