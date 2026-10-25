/**
 * 遥测查询的 SQL 语句构建
 * （change: 2026-10-25-enhance-telemetry-performance-collection，design D5）。
 *
 * 为什么单独一个模块：本 change 让「聚合」这件事多了一个维度（`groupBy`），而**未分组与分组
 * 的分位数必须同口径**（spec：分组行的 p50/p95 与该事件名整体的对应字段同口径）。把两条路径
 * 收进同一份 SQL 是保证同口径唯一可靠的方式——两份实现必然会漂移。
 *
 * 分位数口径与旧实现逐字一致：`offset = floor(p * (n - 1))`，`OFFSET` 由
 * `ROW_NUMBER() - 1` 表达。旧实现是「每个名字再查一次 `LIMIT 1 OFFSET n`」，现在一次窗口函数
 * 扫描就能给出所有分组的分位数，省掉的正是「行数 × 查询数」这层放大。
 *
 * 时间口径不变：一律认 `received_at`（宿主接收时间），`occurred_at` 只做展示。
 */
import {
  type TelemetryAttributeKey,
  type TelemetryEventName,
  type TelemetryResult
} from "@woohaa3/contracts";
import { attributePresentSql, attributeValueSql } from "./attributes.js";

/** `node:sqlite` 能绑定的参数子集（够用即可，不引它的命名空间类型）。 */
export type SqlParam = null | number | bigint | string;

export type SqlStatement = {
  readonly text: string;
  readonly params: readonly SqlParam[];
};

/** 一次查询的筛选范围。属性必须成对出现（由 `parseTelemetryEventFilter` 在入口保证）。 */
export type EventScope = {
  readonly since: number;
  readonly until: number;
  readonly names?: readonly TelemetryEventName[];
  readonly results?: readonly TelemetryResult[];
  readonly errorCode?: string;
  readonly attributeKey?: TelemetryAttributeKey;
  readonly attributeValue?: string;
};

export type WhereParts = {
  readonly conditions: readonly string[];
  readonly params: readonly SqlParam[];
};

/**
 * 把筛选范围翻成 WHERE 片段。
 *
 * `id < ?` 这种游标条件不在这里：它只属于列表分页，加进聚合会改变聚合口径。
 */
export function buildWhere(scope: EventScope): WhereParts {
  const conditions: string[] = ["received_at >= ?", "received_at <= ?"];
  const params: SqlParam[] = [scope.since, scope.until];

  if (scope.names !== undefined && scope.names.length > 0) {
    conditions.push(`name IN (${scope.names.map(() => "?").join(", ")})`);
    params.push(...scope.names);
  }
  if (scope.results !== undefined && scope.results.length > 0) {
    conditions.push(`result IN (${scope.results.map(() => "?").join(", ")})`);
    params.push(...scope.results);
  }
  if (scope.errorCode !== undefined && scope.errorCode !== "") {
    conditions.push("error_code = ?");
    params.push(scope.errorCode);
  }
  if (scope.attributeKey !== undefined || scope.attributeValue !== undefined) {
    // 只给一半的筛选是"无法回答"的请求：契约层已拒绝，这里再炸一次而不是静默返回全量
    // （静默返回全量会让界面显示"筛选后"的结果其实没筛）。
    if (scope.attributeKey === undefined || scope.attributeValue === undefined) {
      throw new Error("遥测属性筛选必须同时给出键与值");
    }
    conditions.push(`${attributeValueSql(scope.attributeKey)} = ?`);
    params.push(scope.attributeValue);
    conditions.push(attributePresentSql(scope.attributeKey));
  }
  return { conditions, params };
}

/** 分组取值表达式；未分组时是恒为 `NULL` 的字面量，让两层 SQL 只写一次。 */
export function groupExpression(groupBy: TelemetryAttributeKey | undefined): string {
  return groupBy === undefined ? "NULL" : attributeValueSql(groupBy);
}

/**
 * 分组守卫：分组查询只统计「真的带这个键」的行。
 *
 * 不这么做的话，没有 `kind` 的 `perf.startup` 会聚成一个"空组"，在耗时榜上变成一行
 * 既不是某个 kind、也说不清是什么的记录（design D5 要的是可解释的分组）。
 */
export function groupGuard(groupBy: TelemetryAttributeKey | undefined): string {
  return groupBy === undefined ? "" : ` AND ${attributePresentSql(groupBy)}`;
}

/** 窗口内总条数（不受分组丢弃影响；`total` 的口径与事件列表一致）。 */
export function totalStatement(table: string, where: WhereParts): SqlStatement {
  return {
    text: `SELECT COUNT(*) AS total FROM ${table} WHERE ${where.conditions.join(" AND ")}`,
    params: where.params
  };
}

/** 每个（事件名, 分组值, 结果）的计数。 */
export function countsStatement(table: string, where: WhereParts, groupBy?: TelemetryAttributeKey): SqlStatement {
  return {
    text:
      `SELECT name, ${groupExpression(groupBy)} AS grp, result, COUNT(*) AS count FROM ${table}` +
      ` WHERE ${where.conditions.join(" AND ")}${groupGuard(groupBy)}` +
      ` GROUP BY name, grp, result`,
    params: where.params
  };
}

/**
 * 每个（事件名, 分组值）的耗时聚合：样本数、最大值与 p50/p95。
 *
 * `MAX(duration_ms)` 取的是组内最大值；`MAX(CASE WHEN rn = offset THEN duration_ms END)` 取的是
 * 排序后位次等于目标 offset 的那一条。两者都基于同一个窗口分区，所以「同一组的样本」只有一份定义。
 */
export function durationsStatement(
  table: string,
  where: WhereParts,
  groupBy?: TelemetryAttributeKey
): SqlStatement {
  return {
    text:
      `WITH base AS (SELECT name, duration_ms, ${groupExpression(groupBy)} AS grp FROM ${table}` +
      ` WHERE ${where.conditions.join(" AND ")} AND duration_ms IS NOT NULL${groupGuard(groupBy)}),` +
      ` ranked AS (SELECT name, grp, duration_ms,` +
      ` ROW_NUMBER() OVER (PARTITION BY name, grp ORDER BY duration_ms ASC) - 1 AS rn,` +
      ` COUNT(*) OVER (PARTITION BY name, grp) AS n FROM base)` +
      ` SELECT name, grp, MAX(n) AS samples, MAX(duration_ms) AS max,` +
      ` MAX(CASE WHEN rn = ((n - 1) * 50) / 100 THEN duration_ms END) AS p50,` +
      ` MAX(CASE WHEN rn = ((n - 1) * 95) / 100 THEN duration_ms END) AS p95` +
      ` FROM ranked GROUP BY name, grp`,
    params: where.params
  };
}

/** 每个（事件名, 分组值, 错误码）的计数与首次出现时间，按计数降序。 */
export function errorCodesStatement(
  table: string,
  where: WhereParts,
  groupBy?: TelemetryAttributeKey
): SqlStatement {
  return {
    text:
      `SELECT name, ${groupExpression(groupBy)} AS grp, error_code AS code, COUNT(*) AS count,` +
      ` MIN(received_at) AS first_seen FROM ${table}` +
      ` WHERE ${where.conditions.join(" AND ")} AND error_code <> ''${groupGuard(groupBy)}` +
      ` GROUP BY name, grp, error_code ORDER BY count DESC, code ASC`,
    params: where.params
  };
}

/**
 * 时间序列：按桶起点与事件名聚合。
 *
 * 不跟随 `groupBy`：趋势回答的是"这类事件在各时段有多少"，把分组再拆一层会让行数乘上分组
 * 基数，而趋势条的读者只有一个问题——哪几个桶高。
 */
export function seriesStatement(table: string, where: WhereParts, bucketMs: number): SqlStatement {
  return {
    text:
      `SELECT (received_at - (received_at % ?)) AS bucket_at, name, COUNT(*) AS count,` +
      ` SUM(CASE WHEN result IN ('failure', 'rejected', 'cancelled') THEN 1 ELSE 0 END) AS failures` +
      ` FROM ${table} WHERE ${where.conditions.join(" AND ")}` +
      ` GROUP BY bucket_at, name ORDER BY bucket_at ASC, name ASC`,
    params: [bucketMs, ...where.params]
  };
}
