/**
 * 遥测窗口聚合（change: 2026-10-20-add-local-client-telemetry，design D5；
 * change: 2026-10-25-enhance-telemetry-performance-collection 增加属性分组）。
 *
 * 与 `store.ts` 分文件是因为**职责不同**：那边管事务、保留、分页这些"库的形状"，这边只做
 * 「一组 SQL 语句 → 一份聚合结果」的翻译。SQL 文本本身在 `queries.ts`，这里不拼 SQL。
 *
 * 两条必须一起守的口径：
 * - **分组与未分组的分位数同源**：两条路径读同一份 `durationsStatement`，所以
 *   「`perf.interaction` 整体 p95」与「按 `kind` 拆开后各组的 p95」不会因为实现不同而对不上；
 * - **`total` 是窗口内总条数**，不是分组行的条数之和：分组会丢弃不带该属性的行（`perf.startup`
 *   没有 `kind`），若 `total` 也跟着变小，页脚的"已落库 N 条"就会与事件列表矛盾。
 */
import type {
  TelemetryAttributeKey,
  TelemetryBucket,
  TelemetryEventName,
  TelemetryResult,
  TelemetrySeriesPoint,
  TelemetrySummaryRow
} from "@woohaa3/contracts";
import {
  buildWhere,
  countsStatement,
  durationsStatement,
  errorCodesStatement,
  seriesStatement,
  totalStatement,
  type EventScope,
  type SqlParam,
  type SqlStatement
} from "./queries.js";

/** 只需要"能执行一条只读 SQL"的接口；不暴露连接本身，聚合代码无从写库。 */
export type SqlRunner = {
  all<T>(sql: string, ...params: SqlParam[]): T[];
};

/** 一个事件名（或「事件名 × 属性值」组）在某个时间范围内的聚合。 */
export type NameWindowStats = {
  readonly name: TelemetryEventName;
  /** 分组行的分组成员；只在按属性分组查询时出现。 */
  readonly attributeValue?: string;
  readonly count: number;
  /** `failure` + `rejected`：异常规则里的"失败率"口径（`cancelled` 不算失败）。 */
  readonly failures: number;
  /** 带耗时的样本数；分位数只在样本内取位。 */
  readonly durationSamples: number;
  readonly durationP50?: number;
  readonly durationP95?: number;
  readonly durationMax?: number;
  /** 按出现次数排序的错误码；只在请求了 `withErrorCodes` 时有值。 */
  readonly errorCodes?: readonly ErrorCodeStats[];
};

export type ErrorCodeStats = {
  readonly name: TelemetryEventName;
  readonly code: string;
  readonly count: number;
  /** 该错误码在窗口内最早出现的时间；`new-error-code` 的"首次出现"证据。 */
  readonly firstSeenAt: number;
};

export type StoredSummary = {
  readonly total: number;
  readonly rows: readonly TelemetrySummaryRow[];
  readonly series: readonly TelemetrySeriesPoint[];
};

/** 属性筛选（成对出现）与分组的公共口径；两个读面共用，避免一处改了另一处忘。 */
export type AttributeScope = EventScope;

export type SummaryQuery = {
  readonly since: number;
  readonly until: number;
  readonly bucket: TelemetryBucket;
  readonly groupBy?: TelemetryAttributeKey;
  /** 属性筛选：只聚合该属性取值相等的事件（构建模式分离就靠它）。 */
  readonly attributeKey?: TelemetryAttributeKey;
  readonly attributeValue?: string;
};

export type RangeStatsQuery = {
  readonly since: number;
  readonly until: number;
  /** 分位数只在异常规则里需要；`event-silence` 的第三个窗口只要计数，跳过可省一次窗口函数扫描。 */
  readonly withDurations?: boolean;
  readonly withErrorCodes?: boolean;
  /** 按属性分组（`latency-regression` 的分组口径）；缺省按事件名。 */
  readonly groupBy?: TelemetryAttributeKey;
  readonly attributeKey?: TelemetryAttributeKey;
  readonly attributeValue?: string;
};

/** 一条分组聚合在读取阶段的原始行（属性值为 `null` 表示未分组）。 */
type GroupEntry = {
  readonly name: string;
  readonly grp: string | null;
  count: number;
  readonly results: Record<TelemetryResult, number>;
};

/** 窗口聚合：每行一个事件名，或「事件名 × 属性值」组。 */
export function selectSummary(runner: SqlRunner, table: string, input: SummaryQuery): StoredSummary {
  const where = buildWhere(input);
  const { groupBy } = input;

  const byGroup = new Map<string, GroupEntry>();
  for (const row of runner.all<{ name: string; grp: string | null; result: string; count: number }>(
    ...args(countsStatement(table, where, groupBy))
  )) {
    // 分组查询里 `grp` 恒非空（SQL 侧有守卫）；未分组时它是 `NULL`。
    const key = groupKey(row.name, row.grp);
    const entry = byGroup.get(key) ?? { name: row.name, grp: row.grp, count: 0, results: emptyResultCounts() };
    const count = Number(row.count);
    entry.count += count;
    // `result` 已由归一保证是四个值之一；坏文件里的意外值只忽略，不让整页失败。
    if (isTelemetryResultKey(row.result)) entry.results[row.result] += count;
    byGroup.set(key, entry);
  }

  // `total` 单独查：分组会丢弃不带该属性的行（`perf.startup` 没有 `kind`），若拿分组行相加，
  // "已落库 N 条"就会与事件列表矛盾。它必须是窗口内的总条数。
  const total = Number(runner.all<{ total: number }>(...args(totalStatement(table, where)))[0]?.total ?? 0);

  const errorCodes = runner.all<{ name: string; grp: string | null; code: string; count: number; first_seen: number }>(
    ...args(errorCodesStatement(table, where, groupBy))
  );
  const durations = new Map(
    runner
      .all<DurationRow>(...args(durationsStatement(table, where, groupBy)))
      .map((row) => [groupKey(row.name, row.grp), row])
  );

  const rows: TelemetrySummaryRow[] = [...byGroup.entries()].map(([key, entry]) => {
    const duration = durations.get(key);
    const samples = Number(duration?.samples ?? 0);
    return {
      name: entry.name as TelemetryEventName,
      // 未分组时不写这个键：`undefined` 出现在 JSON 里会让界面误判"这行是分组的"。
      ...(entry.grp === null ? {} : { attributeValue: entry.grp }),
      count: entry.count,
      results: entry.results,
      ...(samples > 0
        ? {
            durationP50: Number(duration?.p50 ?? 0),
            durationP95: Number(duration?.p95 ?? 0),
            durationMax: Number(duration?.max ?? 0)
          }
        : {}),
      durationSamples: samples,
      topErrorCodes: topErrorCodes(errorCodes.filter((row) => groupKey(row.name, row.grp) === key))
    };
  });
  // 最活跃的组在前面，便于复盘时先看问题最多的那一类；同计数按名字与分组值稳定排序。
  rows.sort(compareSummaryRows);

  const series = runner.all<{ bucket_at: number; name: string; count: number; failures: number }>(
    ...args(seriesStatement(table, where, bucketMs(input.bucket)))
  );
  return {
    total,
    rows,
    series: series.map((row) => ({
      at: Number(row.bucket_at),
      name: row.name as TelemetryEventName,
      count: Number(row.count),
      failures: Number(row.failures)
    }))
  };
}

/**
 * 一段时间范围内每个事件名（或分组）的聚合，供异常规则使用。
 *
 * 与 `selectSummary` 分开是因为异常要看三个相邻窗口、且只需要 p95（不要 p50/错误码列表），
 * 按需查询比先算完整聚合再丢弃更省。两者共用同一份 SQL 构建器，所以口径不会分叉。
 */
export function selectRangeStats(
  runner: SqlRunner,
  table: string,
  query: RangeStatsQuery
): readonly NameWindowStats[] {
  const where = buildWhere(query);
  const { groupBy } = query;

  const byGroup = new Map<string, { name: string; grp: string | null; count: number; failures: number }>();
  for (const row of runner.all<{ name: string; grp: string | null; result: string; count: number }>(
    ...args(countsStatement(table, where, groupBy))
  )) {
    const key = groupKey(row.name, row.grp);
    const entry = byGroup.get(key) ?? { name: row.name, grp: row.grp, count: 0, failures: 0 };
    const count = Number(row.count);
    entry.count += count;
    if (row.result === "failure" || row.result === "rejected") entry.failures += count;
    byGroup.set(key, entry);
  }

  const durationByGroup = new Map<string, DurationRow>();
  if (query.withDurations) {
    for (const row of runner.all<DurationRow>(...args(durationsStatement(table, where, groupBy)))) {
      durationByGroup.set(groupKey(row.name, row.grp), row);
    }
  }

  const errorCodes = query.withErrorCodes
    ? runner.all<{ name: string; grp: string | null; code: string; count: number; first_seen: number }>(
        ...args(errorCodesStatement(table, where, groupBy))
      )
    : [];

  return [...byGroup.entries()]
    .map(([key, entry]): NameWindowStats => {
      const duration = durationByGroup.get(key);
      const samples = Number(duration?.samples ?? 0);
      return {
        name: entry.name as TelemetryEventName,
        ...(entry.grp === null ? {} : { attributeValue: entry.grp }),
        count: entry.count,
        failures: entry.failures,
        durationSamples: samples,
        ...(query.withDurations && samples > 0
          ? {
              durationP50: Number(duration?.p50 ?? 0),
              durationP95: Number(duration?.p95 ?? 0),
              durationMax: Number(duration?.max ?? 0)
            }
          : {}),
        ...(query.withErrorCodes
          ? {
              errorCodes: errorCodes
                .filter((row) => groupKey(row.name, row.grp) === key)
                .map((row) => ({
                  name: row.name as TelemetryEventName,
                  code: row.code,
                  count: Number(row.count),
                  firstSeenAt: Number(row.first_seen)
                }))
            }
          : {})
      };
    })
    .sort(
      (left, right) =>
        compareText(left.name, right.name) || compareText(left.attributeValue ?? "", right.attributeValue ?? "")
    );
}

type DurationRow = {
  name: string;
  grp: string | null;
  samples: number;
  max: number | null;
  p50: number | null;
  p95: number | null;
};

/** 与契约的 `TELEMETRY_BUCKET_MS` 同源；这里再收敛一次，防止坏值让 SQL 除零。 */
const BUCKET_MS: Readonly<Record<TelemetryBucket, number>> = { "1m": 60_000, "5m": 300_000, "1h": 3_600_000 };

function bucketMs(bucket: TelemetryBucket): number {
  return BUCKET_MS[bucket] ?? BUCKET_MS["1h"];
}

/** 把 `{text, params}` 摊成 `all` 的位置参数形状（避免每个调用点各写一遍展开）。 */
function args(statement: SqlStatement): [string, ...SqlParam[]] {
  return [statement.text, ...statement.params];
}

/** 分组行的键：未分组时只有名字，分组时是「名字 + 取值」。 */
function groupKey(name: string, group: string | null): string {
  return group === null ? name : `${name}\u0000${group}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSummaryRows(left: TelemetrySummaryRow, right: TelemetrySummaryRow): number {
  return (
    right.count - left.count ||
    compareText(left.name, right.name) ||
    compareText(left.attributeValue ?? "", right.attributeValue ?? "")
  );
}

function emptyResultCounts(): Record<TelemetryResult, number> {
  return { success: 0, failure: 0, cancelled: 0, rejected: 0 };
}

function isTelemetryResultKey(value: string): value is TelemetryResult {
  return value === "success" || value === "failure" || value === "cancelled" || value === "rejected";
}

function topErrorCodes(
  rows: readonly { readonly code: string; readonly count: number }[],
  limit = 5
): readonly { code: string; count: number }[] {
  return [...rows]
    .sort((left, right) => right.count - left.count || compareText(left.code, right.code))
    .slice(0, limit)
    .map((row) => ({ code: row.code, count: row.count }));
}
