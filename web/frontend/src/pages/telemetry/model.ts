/**
 * 遥测复盘页的只读模型：状态判定、聚合派生与分页合并
 * （change: 2026-10-20-add-local-client-telemetry，任务 5.2 / design D5/D6/D9/D11）。
 *
 * 页面必须把**五种状态分开**（design D9 + spec「遥测复盘界面 SHALL 区分空态、关闭与不可用」）：
 * 没有记录 / 本地记录已关闭 / 本地存储不可用 / 无丢弃但有数据 / 服务不可用。合并成一句
 * "暂无数据"会让用户在最需要线索的时候失去线索——"没记到"和"没在记"是两件完全不同的事。
 *
 * 本模块不依赖 React/DOM，可独立测试。
 */
import type {
  TelemetryAnomaly,
  TelemetryAnomalySeverity,
  TelemetryBucket,
  TelemetryEventPage,
  TelemetryEventRecord,
  TelemetrySeriesPoint,
  TelemetryStatus,
  TelemetrySummaryRow,
  TelemetryWindow
} from "@woohaa3/contracts";

/** 页面的六种呈现状态（`ready` 之外每一种都有专属文案，互不合并）。 */
export type TelemetryViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "service-unavailable"; readonly message: string }
  | { readonly kind: "store-unavailable"; readonly storePath?: string }
  | { readonly kind: "disabled" }
  | { readonly kind: "empty"; readonly filtered: boolean }
  | { readonly kind: "ready" };

/**
 * 判定当前应显示哪一种状态。
 *
 * 优先级：请求失败 → 未取得状态（加载中）→ 存储不可用 → 记录已关闭 → 首页事件加载中 →
 * 空态 → 就绪。
 * 「存储不可用」优先于「记录已关闭」：前者是故障（要给人路径去处理），后者是用户自己关的。
 */
export function resolveTelemetryViewState(input: {
  status: TelemetryStatus | null;
  /** 读取 `status`/列表失败的安全文案（非空即服务不可用）。 */
  statusError?: string | null;
  /** 首次加载中：状态已到但首页事件还没回来时不能显示"还没有本机记录"。 */
  loading?: boolean;
  hasEvents: boolean;
  filtered: boolean;
}): TelemetryViewState {
  if (input.statusError) return { kind: "service-unavailable", message: input.statusError };
  if (!input.status) return { kind: "loading" };
  if (input.status.store === "unavailable") {
    return {
      kind: "store-unavailable",
      ...(input.status.storePath ? { storePath: input.status.storePath } : {})
    };
  }
  if (!input.status.enabled) return { kind: "disabled" };
  if (input.loading === true) return { kind: "loading" };
  if (!input.hasEvents) return { kind: "empty", filtered: input.filtered };
  return { kind: "ready" };
}

/** 顶部提示（与状态无关，独立展示：有丢弃就要说，导出开着也要说）。 */
export type TelemetryNotice =
  | { readonly kind: "export-enabled"; readonly destinations: readonly string[] }
  /**
   * 开关开着、但实际发不出去。
   *
   * 这是最容易让人困惑的一种状态：「我明明打开了外部上报，服务端一条都没有」。两种成因要分开说，
   * 因为修法不同——
   * - `no-export`：**没有任何出口注册**。上报出口由「服务端接入」扩展在激活时注册，
   *   那个扩展默认关闭；没启用它，开关后面就是空的。
   * - `no-provider-available`：出口在，但自述不可用（未连接服务端 / 未登录）。
   */
  | { readonly kind: "export-unrouted"; readonly reason: "no-export" | "no-provider-available" }
  | {
      readonly kind: "dropped";
      readonly droppedOverflow: number;
      readonly droppedInvalid: number;
      readonly writeErrors: number;
      readonly queued: number;
    };

export function telemetryNotices(status: TelemetryStatus | null): TelemetryNotice[] {
  if (!status) return [];
  const notices: TelemetryNotice[] = [];
  if (status.exportEnabled) {
    if (status.exports.length === 0) {
      notices.push({ kind: "export-unrouted", reason: "no-export" });
    } else if (status.exports.every((entry) => !entry.available)) {
      notices.push({ kind: "export-unrouted", reason: "no-provider-available" });
    } else {
      notices.push({
        kind: "export-enabled",
        destinations: status.exports.map((entry) => entry.label ?? entry.exportId)
      });
    }
  }
  if (status.droppedOverflow > 0 || status.droppedInvalid > 0 || status.writeErrors > 0 || status.queued > 0) {
    notices.push({
      kind: "dropped",
      droppedOverflow: status.droppedOverflow,
      droppedInvalid: status.droppedInvalid,
      writeErrors: status.writeErrors,
      queued: status.queued
    });
  }
  return notices;
}

const SEVERITY_RANK: Readonly<Record<TelemetryAnomalySeverity, number>> = {
  error: 0,
  warn: 1,
  info: 2
};

/** 异常排序：严重度优先（error→warn→info），同级按样本数降序。 */
export function sortAnomalies(anomalies: readonly TelemetryAnomaly[]): TelemetryAnomaly[] {
  return [...anomalies].sort((left, right) => {
    const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (bySeverity !== 0) return bySeverity;
    return right.samples - left.samples;
  });
}

/** 失败率 = (failure + rejected) / count；无样本返回 `undefined`（不伪装成 0%）。 */
export function failureRate(row: Pick<TelemetrySummaryRow, "count" | "results">): number | undefined {
  if (row.count <= 0) return undefined;
  return ((row.results.failure ?? 0) + (row.results.rejected ?? 0)) / row.count;
}

/** 聚合表排序：计数降序，同计数按事件名稳定排序（避免刷新时行序跳动）。 */
export function sortSummaryRows(rows: readonly TelemetrySummaryRow[]): TelemetrySummaryRow[] {
  return [...rows].sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    return (
      compareText(left.name, right.name) || compareText(left.attributeValue ?? "", right.attributeValue ?? "")
    );
  });
}

/**
 * 耗时榜排序：p95 降序，缺样本的排最后。
 *
 * 为什么不用计数排序：复盘问的是"哪一类最卡"，计数高只说明发生得多。为什么缺样本要排最后
 * 而不是当 0ms：把"没测到"排在"很快"前面（或混在一起）都会让人误读。
 */
export function rankByDuration(rows: readonly TelemetrySummaryRow[]): TelemetrySummaryRow[] {
  return [...rows].sort((left, right) => {
    const leftP95 = left.durationP95;
    const rightP95 = right.durationP95;
    if (leftP95 === undefined && rightP95 === undefined) return compareSummaryKey(left, right);
    if (leftP95 === undefined) return 1;
    if (rightP95 === undefined) return -1;
    if (rightP95 !== leftP95) return rightP95 - leftP95;
    return compareSummaryKey(left, right);
  });
}

function compareSummaryKey(left: TelemetrySummaryRow, right: TelemetrySummaryRow): number {
  return compareText(left.name, right.name) || compareText(left.attributeValue ?? "", right.attributeValue ?? "");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 一个桶的合计（趋势用）：把按事件名拆开的点合并成时间轴。 */
export type TelemetryBucketTotal = { readonly at: number; readonly count: number; readonly failures: number };

export function bucketTotals(series: readonly TelemetrySeriesPoint[]): TelemetryBucketTotal[] {
  const byBucket = new Map<number, { count: number; failures: number }>();
  for (const point of series) {
    const current = byBucket.get(point.at) ?? { count: 0, failures: 0 };
    current.count += point.count;
    current.failures += point.failures;
    byBucket.set(point.at, current);
  }
  return [...byBucket.entries()]
    .map(([at, value]) => ({ at, count: value.count, failures: value.failures }))
    .sort((left, right) => left.at - right.at);
}

/** 趋势条宽度基准：取最大计数（没有点时返回 0）。 */
export function bucketPeak(totals: readonly TelemetryBucketTotal[]): number {
  return totals.reduce((max, entry) => Math.max(max, entry.count), 0);
}

/** 聚合表的空判定：没有行即没有可聚合的事实。 */
export function isEmptySummary(rows: readonly TelemetrySummaryRow[]): boolean {
  return rows.length === 0;
}

/** 分页合并结果（「加载更多」追加；重复 id 去重，宿主重放同一游标不会把行显示两遍）。 */
export type TelemetryEventMerge = {
  readonly events: TelemetryEventRecord[];
  readonly nextCursor?: string;
};

export function mergeEventPage(
  current: readonly TelemetryEventRecord[],
  page: TelemetryEventPage
): TelemetryEventMerge {
  const seen = new Set(current.map((event) => event.id));
  const appended = page.events.filter((event) => !seen.has(event.id));
  return {
    events: [...current, ...appended],
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
  };
}

/** 选中事件：`eventId` 是 URL 里的字符串，记录 id 是数字；不在当前已载入页时返回 `undefined`。 */
export function findEvent(
  events: readonly TelemetryEventRecord[],
  eventId: string | undefined
): TelemetryEventRecord | undefined {
  if (!eventId) return undefined;
  const numeric = Number.parseInt(eventId, 10);
  if (!Number.isFinite(numeric)) return undefined;
  return events.find((event) => event.id === numeric);
}

/** 页面页脚的一行口径说明（窗口 + 分桶 + 计数）。 */
export function summaryCaption(input: {
  window: TelemetryWindow;
  bucket: TelemetryBucket;
  total: number;
}): string {
  return `窗口 ${input.window} · 分桶 ${input.bucket} · 共 ${input.total.toLocaleString()} 条`;
}
