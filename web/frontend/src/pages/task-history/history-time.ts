/**
 * 历史查询/时间工具（change: 2026-10-06-improve-task-history-experience，任务 3.2）。
 *
 * 详情请求错误提取与时间快捷项：把浏览器本地时间/快捷范围固定成绝对 ISO UTC，刷新与
 * 分享不改变绝对范围。纯函数，可独立测试。
 */

/** 时间快捷项：最近 N 小时/天；应用时固定为绝对 [from, to]。 */
export type HistoryTimeShortcut = {
  id: string;
  label: string;
  /** 相对“现在”的窗口（小时）。 */
  hours: number;
};

export const HISTORY_TIME_SHORTCUTS: readonly HistoryTimeShortcut[] = [
  { id: "last-24h", label: "最近 24 小时", hours: 24 },
  { id: "last-7d", label: "最近 7 天", hours: 24 * 7 },
  { id: "last-30d", label: "最近 30 天", hours: 24 * 30 }
];

/** 把 datetime-local 值按浏览器本地时区解释为 ISO UTC；非法返回 undefined。 */
export function localDateTimeToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/** ISO UTC → datetime-local 输入值（本地时区）。 */
export function isoToLocalDateTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 当前本地时区名（用于明示范围语义）。 */
export function localTimeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区";
  } catch {
    return "本地时区";
  }
}

/** 计算快捷项的绝对 ISO 范围（to = now，from = now - hours）。 */
export function shortcutRange(shortcut: HistoryTimeShortcut, now: Date = new Date()): { from: string; to: string } {
  return {
    from: new Date(now.getTime() - shortcut.hours * 3_600_000).toISOString(),
    to: now.toISOString()
  };
}

/** 校验范围（from 不晚于 to）；非法返回 false。 */
export function isValidRange(from: string | undefined, to: string | undefined): boolean {
  if (!from || !to) return true;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= end;
}
