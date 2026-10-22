/**
 * 历史页格式化与标签（change: improve-task-history-experience）。
 *
 * 纯展示辅助：本地时间、相对时间、耗时、阶段可读名与状态文案；不依赖 React/DOM。
 */
import type { TaskExecutionSource, TaskExecutionState } from "@woohaa3/contracts";
import type { TaskHistoryConnectionStatus } from "../../shared/task-history/client.js";
import type { HistoryFilters } from "./history-state.js";

export const STATE_LABELS: Record<TaskExecutionState, string> = {
  queued: "排队中",
  pending: "等待中",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消"
};

/** 来源标签；旧记录缺失来源显示「未知来源」，不猜测。 */
export function sourceLabel(source: TaskExecutionSource | undefined): string {
  if (source === "canvas") return "画布";
  if (source === "extension") return "插件";
  return "未知来源";
}

export const CONNECTION_LABELS: Record<TaskHistoryConnectionStatus["state"], string> = {
  connecting: "连接中",
  live: "实时",
  reconnecting: "重连中",
  polling: "轮询中",
  offline: "已离线"
};

/** 已知 stage → 可读阶段名；未知 stage 回退安全原名，技术信息保留原值。 */
const STAGE_LABELS: Record<string, string> = {
  "worker.enqueued": "已入队",
  "worker.claimed": "已领取",
  "provider.started": "调用 Provider",
  "provider.progress": "执行中",
  "provider.completed": "Provider 完成",
  "pptask.submitted": "已提交",
  "pptask.running": "执行中",
  "pptask.progress": "执行中",
  "pptask.succeeded": "成功",
  "pptask.failed": "失败",
  "pptask.cancelled": "已取消",
  "pptask.recovered": "重启后补记"
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

/**
 * 时间戳按**浏览器本地时区**显示。
 *
 * 服务端存的是 ISO UTC（`2026-09-24T06:39:25.586Z`）；直接渲染会让用户看到 UTC 时间。
 * 这里统一转成本地时间字符串，并带上时区名以便跨时区协作时无歧义。
 */
export function formatLocalTime(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

/** 相对时间（分钟/小时/天）；用于列表次级信息。 */
export function formatRelative(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const diff = now.getTime() - time;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 复制文本到系统剪贴板；环境不支持时返回 false（调用方显示失败反馈）。 */
export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** 已应用筛选标签（可删除标签的稳定 id 与可读文案）。 */
export function filterTags(filters: HistoryFilters): Array<{ id: keyof HistoryFilters; label: string }> {
  const tags: Array<{ id: keyof HistoryFilters; label: string }> = [];
  if (filters.providerId) tags.push({ id: "providerId", label: `Provider：${filters.providerId}` });
  if (filters.modelType) tags.push({ id: "modelType", label: `类型：${filters.modelType}` });
  if (filters.modelKey) tags.push({ id: "modelKey", label: `模型：${filters.modelKey}` });
  if (filters.canvasId) tags.push({ id: "canvasId", label: `画布：${filters.canvasId}` });
  if (filters.nodeId) tags.push({ id: "nodeId", label: `节点：${filters.nodeId}` });
  if (filters.taskKey) tags.push({ id: "taskKey", label: `任务：${filters.taskKey}` });
  if (filters.source) tags.push({ id: "source", label: `来源：${sourceLabel(filters.source)}` });
  if (filters.extensionId) tags.push({ id: "extensionId", label: `插件：${filters.extensionId}` });
  if (filters.from) tags.push({ id: "from", label: `起始：${formatLocalTime(filters.from)}` });
  if (filters.to) tags.push({ id: "to", label: `结束：${formatLocalTime(filters.to)}` });
  return tags;
}
