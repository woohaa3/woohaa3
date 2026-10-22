/**
 * 遥测复盘页的纯展示/格式化辅助
 * （change: 2026-10-20-add-local-client-telemetry，任务 5.2 / design D5/D6/D9）。
 *
 * 无 React/DOM 依赖，可独立测试。三条口径：
 * - 时间一律按**浏览器本地时区**显示并带时区名：本机复盘是"我这边刚才发生了什么"，
 *   显示 UTC 会让人自己去换算出事时刻；
 * - 缺失值显示「未知」或「—」，绝不猜测（没有耗时样本不等于 0ms）；
 * - 标签表集中在这里，页面与详情共用同一份命名，避免两处叫法不一致。
 */
import {
  TELEMETRY_WINDOW_MS,
  type TelemetryAnomalyRuleId,
  type TelemetryAnomalySeverity,
  type TelemetryBucket,
  type TelemetryEventName,
  type TelemetryResult,
  type TelemetryWindow
} from "@woohaa3/contracts";

export const WINDOW_LABELS: Readonly<Record<TelemetryWindow, string>> = {
  "1h": "最近 1 小时",
  "6h": "最近 6 小时",
  "24h": "最近 24 小时",
  "7d": "最近 7 天"
};

/** 窗口短标签（分段控件用；长标签在窄窗口会换行）。 */
export const WINDOW_SHORT_LABELS: Readonly<Record<TelemetryWindow, string>> = {
  "1h": "1 小时",
  "6h": "6 小时",
  "24h": "24 小时",
  "7d": "7 天"
};

export const BUCKET_LABELS: Readonly<Record<TelemetryBucket, string>> = {
  "1m": "每分钟",
  "5m": "每 5 分钟",
  "1h": "每小时"
};

export const EVENT_NAME_LABELS: Readonly<Record<TelemetryEventName, string>> = {
  "canvas.open": "画布打开",
  "canvas.save": "画布保存",
  "canvas.edit": "画布编辑",
  "sync.connect": "同步连接",
  "sync.reconcile": "同步对账",
  "local.validation": "本地校验",
  "task.terminal": "任务终态"
};

export const RESULT_LABELS: Readonly<Record<TelemetryResult, string>> = {
  success: "成功",
  failure: "失败",
  cancelled: "已取消",
  rejected: "被拒绝"
};

export const RULE_LABELS: Readonly<Record<TelemetryAnomalyRuleId, string>> = {
  "failure-rate-spike": "失败率突增",
  "new-error-code": "新错误码",
  "latency-regression": "耗时回归",
  "event-silence": "事件静默"
};

export const SEVERITY_LABELS: Readonly<Record<TelemetryAnomalySeverity, string>> = {
  info: "提示",
  warn: "警告",
  error: "严重"
};

export function eventNameLabel(name: TelemetryEventName): string {
  return EVENT_NAME_LABELS[name] ?? name;
}

export function resultLabel(result: TelemetryResult): string {
  return RESULT_LABELS[result] ?? result;
}

export function ruleLabel(ruleId: TelemetryAnomalyRuleId): string {
  return RULE_LABELS[ruleId] ?? ruleId;
}

export function severityLabel(severity: TelemetryAnomalySeverity): string {
  return SEVERITY_LABELS[severity] ?? severity;
}

/** 本地时间（epoch ms → 本地时区字符串；缺失/非法显示「未知」）。 */
export function formatLocalTime(epochMs: number | undefined): string {
  if (epochMs === undefined || !Number.isFinite(epochMs) || epochMs <= 0) return "未知";
  return new Date(epochMs).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

/** 趋势横轴的时间刻度：短窗口显示时分，长窗口显示月日。 */
export function formatBucketTime(at: number, window: TelemetryWindow): string {
  if (!Number.isFinite(at) || at <= 0) return "未知";
  const date = new Date(at);
  const options: Intl.DateTimeFormatOptions =
    TELEMETRY_WINDOW_MS[window] <= TELEMETRY_WINDOW_MS["6h"]
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : { month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false };
  return date.toLocaleString(undefined, options);
}

export function localTimeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区";
  } catch {
    return "本地时区";
  }
}

/** 耗时（毫秒）：无样本显示「—」，<1s 用 ms，<60s 用 s。 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

/** 比率（0..1）→ 百分比；分母为 0 时显示「—」（不是 0%）。 */
export function formatPercent(ratio: number | undefined, fractionDigits = 1): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
}

/** 字节数；页面显示数据库占用，单位要能一眼看懂量级。 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "未知";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/** 计数（千分位；大数一眼可读）。 */
export function formatCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString();
}

/** 一个数字的相对比值（趋势条宽度用；最大值缺失时返回 0）。 */
export function ratioToMax(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/**
 * 异常证据值的展示口径：不同规则的 `observed`/`baseline` 是不同量纲（比率 / 毫秒 / 计数）。
 *
 * 把量纲判断集中在这里，页面就不必在 JSX 里分支——也让"同一条规则的证据怎么读"只有一处定义。
 */
export function formatAnomalyValue(ruleId: TelemetryAnomalyRuleId, value: number): string {
  if (!Number.isFinite(value)) return "未知";
  if (ruleId === "failure-rate-spike") return formatPercent(value);
  if (ruleId === "latency-regression") return formatDuration(value);
  return formatCount(value);
}
