/**
 * 生成溯源/任务详情的纯展示/格式化辅助
 * （自 `pages/task-monitor/format.ts` 迁入，change: 生成溯源改为画布内浮窗）。
 *
 * 权威实现只在此处：独立任务监控页与画布内「生成溯源」浮窗共用同一份格式化语义。
 * 无 React/DOM 依赖，可独立测试。所有时间按浏览器本地时区显示并带时区名；actor/阶段耗时
 * 缺失显示「未知」，绝不猜测。
 */
import type { TaskExecutionActor, TaskExecutionSource, TaskExecutionState, TaskExecutionTiming } from "@woohaa3/contracts";

/** 页面用的状态中文标签（状态文字不只依赖颜色）；页面与浮窗共用同一份。 */
export const TASK_STATE_LABELS: Record<TaskExecutionState, string> = {
  queued: "排队",
  pending: "待执行",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消"
};

export const STATE_LABELS = TASK_STATE_LABELS;

export function stateLabel(state: TaskExecutionState): string {
  return STATE_LABELS[state] ?? state;
}

export function sourceLabel(source: TaskExecutionSource | undefined): string {
  if (source === "canvas") return "画布";
  if (source === "extension") return "插件";
  return "未知来源";
}

/** 可信 actor 展示：缺失来源显示「未知」，不反填查看者。 */
export function actorLabel(actor: TaskExecutionActor | undefined): string {
  if (!actor || actor.unknown || (!actor.subject && !actor.displayName)) return "未知";
  return actor.displayName ?? actor.subject ?? "未知";
}

/** 本地时间（带时区名；缺失显示「未知」）。 */
export function formatLocalTime(iso: string | undefined): string {
  if (!iso) return "未知";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "未知";
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

export function localTimeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区";
  } catch {
    return "本地时区";
  }
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "未知";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

/**
 * 在途耗时（基于 observedAt 的本地 1 秒递增校正）。
 *
 * 终态冻结（不增长）；进行中取后端 totalMs 与本地经过时间较大者，避免时钟偏差回退。
 */
export function effectiveTotalMs(timing: TaskExecutionTiming | undefined, state: TaskExecutionState, nowMs: number): number | undefined {
  if (!timing) return undefined;
  const base = timing.totalMs;
  const observed = Date.parse(timing.observedAt);
  if (isTerminal(state)) return base;
  if (base === undefined) return undefined;
  if (!Number.isFinite(observed)) return base;
  const delta = Math.max(0, nowMs - observed);
  return base + delta;
}

export function isTerminal(state: TaskExecutionState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

/** 已知 stage → 可读阶段名；未知 stage 回退安全原名。 */
const STAGE_LABELS: Record<string, string> = {
  "worker.enqueued": "已入队",
  "worker.claimed": "已领取",
  "provider.started": "调用 Provider",
  "provider.progress": "执行中",
  "provider.completed": "Provider 完成",
  "pptask.created": "已创建",
  "pptask.submitting": "提交中",
  "pptask.submitted": "已提交",
  "pptask.accepted": "已受理",
  "pptask.running": "执行中",
  "pptask.progress": "执行中",
  "pptask.succeeded": "成功",
  "pptask.failed": "失败",
  "pptask.cancelled": "已取消",
  "pptask.recovered": "重启后补记",
  "worker.task-failed": "任务失败"
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

/** 复制到剪贴板；不支持时返回 false（调用方显示失败反馈）。 */
export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** 时间快捷项：应用时固定为绝对 [from, to]（本地时区解释，存 ISO UTC）。 */
export type TimeShortcut = { id: string; label: string; hours: number };

export const TIME_SHORTCUTS: readonly TimeShortcut[] = [
  { id: "last-24h", label: "最近 24 小时", hours: 24 },
  { id: "last-7d", label: "最近 7 天", hours: 24 * 7 },
  { id: "last-30d", label: "最近 30 天", hours: 24 * 30 }
];

export function shortcutRange(shortcut: TimeShortcut, now: Date = new Date()): { from: string; to: string } {
  return {
    from: new Date(now.getTime() - shortcut.hours * 3_600_000).toISOString(),
    to: now.toISOString()
  };
}

/** datetime-local 值按浏览器本地时区解释为 ISO UTC。 */
export function localDateTimeToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function isoToLocalDateTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
