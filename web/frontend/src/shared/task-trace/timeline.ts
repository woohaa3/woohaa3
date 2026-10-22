/**
 * 生命周期时间线的归并/格式化（change: 生成溯源时间线可读性）。
 *
 * worker 每秒发一条 progress 事件，原样渲染会把「执行中」刷成几十行——那是轮询节奏，
 * 不是生命周期事实。这里把**连续同阶段**的事件归并成一段（保留起止时刻与次数），
 * 只让状态迁移成为独立行。
 *
 * 纯函数、无 React 依赖，便于单测；不改变持久化数据（事件仍然全量落库）。
 */
import type { TaskExecutionEvent } from "@woohaa3/contracts";

export type TimelineRow = {
  /** 该段的首个事件序号（React key 用）。 */
  key: number;
  stage: string;
  kind: "scheduling" | "execution";
  firstAt: string;
  lastAt: string;
  /** 该段包含的事件条数；1 表示单条事件。 */
  count: number;
};

/** 把连续同阶段（阶段 + 类别相同）的事件归并成段，顺序保持事件原始顺序。 */
export function groupTimeline(events: readonly TaskExecutionEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const event of events) {
    const kind = event.kind === "scheduling" ? "scheduling" : "execution";
    const last = rows.at(-1);
    if (last && last.stage === event.stage && last.kind === kind) {
      last.lastAt = event.occurredAt;
      last.count += 1;
      continue;
    }
    rows.push({
      key: event.sequence,
      stage: event.stage,
      kind,
      firstAt: event.occurredAt,
      lastAt: event.occurredAt,
      count: 1
    });
  }
  return rows;
}

/** 时:分:秒（同一段通常在一天内，不重复日期）。 */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** 一段的时间范围：单条只显示时刻，多条显示起止（跨天时在结束前补日期）。 */
export function formatClockRange(row: Pick<TimelineRow, "firstAt" | "lastAt" | "count">): string {
  const first = formatClock(row.firstAt);
  if (row.count <= 1 || row.firstAt === row.lastAt) return first;
  const crossesDay = new Date(row.firstAt).toDateString() !== new Date(row.lastAt).toDateString();
  if (!crossesDay) return `${first} – ${formatClock(row.lastAt)}`;
  const end = new Date(row.lastAt);
  const endLabel = Number.isNaN(end.getTime())
    ? "--:--:--"
    : `${String(end.getMonth() + 1).padStart(2, "0")}/${String(end.getDate()).padStart(2, "0")} ${formatClock(row.lastAt)}`;
  return `${first} – ${endLabel}`;
}
