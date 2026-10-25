/**
 * 异常读面的窗口装配
 * （change: 2026-10-20-add-local-client-telemetry，design D6；
 * change: 2026-10-25-enhance-telemetry-performance-collection 增加分组口径）。
 *
 * 为什么从 `service.ts` 拆出来：这里做的事是**纯编排**——查三个相邻窗口、把存储行整理成
 * 「同一把键的当前/基线/更早三份统计」，再交给纯函数规则。它不含开关、队列、出口、保留策略，
 * 与那个文件的其余职责（写入管线与公开读面）没有共享状态，混在一起只会让两边都变长。
 *
 * 一条不变量：`groupBy` 必须在**三个窗口上同时生效**。当前按 `kind` 分、基线按事件名汇总，
 * 会让「pan 变慢」被「zoom 不变」摊平，从而得出"没有回归"的假结论。
 *
 * 另一条：分组的键包含属性值。同一个事件名下 `kind=pan` 与 `kind=zoom` 是两条独立基线；
 * 只用事件名当键会把两组样本混在一对分位数里。
 */
import type { TelemetryAnomaly, TelemetryAttributeKey, TelemetryEventName, TelemetryWindow } from "@woohaa3/contracts";
import { TELEMETRY_WINDOW_MS } from "@woohaa3/contracts";
import { evaluateTelemetryAnomalies, type AnomalyWindowStats } from "./anomaly.js";
import type { NameWindowStats, SqliteTelemetryStore } from "./storage/sqlite/store.js";

/** 空窗口的聚合：名字只出现在一侧时用它补零，让规则函数不必处理 undefined。 */
const EMPTY_WINDOW_STATS: AnomalyWindowStats = { count: 0, failures: 0, durationSamples: 0 };

export type AnomalyWindowQuery = {
  readonly window: TelemetryWindow;
  /** 与 `since` 同一个"现在"：三个窗口的边界都由它反推，避免跨调用之间的时间漂移。 */
  readonly until: number;
  /** 保留期下界：更早的窗口不越过它，否则基线会混进已被清理的数据。 */
  readonly retentionSince: number;
  readonly groupBy?: TelemetryAttributeKey;
};

/** 跑完四条规则并返回命中。存储不可用时由调用方短路，这里假设 `store` 可用。 */
export function collectAnomalies(
  store: SqliteTelemetryStore,
  query: AnomalyWindowQuery
): readonly TelemetryAnomaly[] {
  const { until, retentionSince, groupBy } = query;
  const windowMs = TELEMETRY_WINDOW_MS[query.window];
  const currentSince = Math.max(until - windowMs, retentionSince);
  const previousSince = Math.max(until - windowMs * 2, retentionSince);
  const earlierSince = Math.max(until - windowMs * 3, retentionSince);
  const group = groupBy === undefined ? {} : { groupBy };

  const currentStats = store.rangeStats({
    since: currentSince,
    until,
    withDurations: true,
    withErrorCodes: true,
    ...group
  });
  const previousStats = store.rangeStats({ since: previousSince, until: currentSince, withDurations: true, ...group });
  const earlierStats = store.rangeStats({ since: earlierSince, until: previousSince, ...group });

  const currentByKey = new Map<string, NameWindowStats>(currentStats.map((stats) => [statsKey(stats), stats]));
  const previousByKey = new Map<string, NameWindowStats>(previousStats.map((stats) => [statsKey(stats), stats]));
  const earlierByKey = new Map<string, number>(earlierStats.map((stats) => [statsKey(stats), stats.count]));

  // `new-error-code` 需要跨保留期的"从未出现"判断：这一步必须查库，所以在这里算好集合，
  // 再把它作为纯函数规则的输入（规则本身不碰存储，便于单测）。
  const previouslySeenErrorCodes = new Set<string>();
  for (const stats of currentStats) {
    for (const code of stats.errorCodes ?? []) {
      if (previouslySeenErrorCodes.has(code.code)) continue;
      if (store.hasErrorCodeBefore(code.code, { since: retentionSince, before: currentSince })) {
        previouslySeenErrorCodes.add(code.code);
      }
    }
  }

  // 并集里要包含基线窗口的键：`event-silence` 描述的正是"当前窗口没有、之前有"。
  const keys = [...new Set([...currentByKey.keys(), ...previousByKey.keys()])].sort();
  return evaluateTelemetryAnomalies({
    window: query.window,
    names: keys.map((key) => {
      // 一个键可能只在一侧出现；两侧都没有的键进不了并集，所以这里一定取得到样本。
      const sample = currentByKey.get(key) ?? previousByKey.get(key);
      return {
        name: (sample?.name ?? "") as TelemetryEventName,
        ...(sample?.attributeValue === undefined ? {} : { attributeValue: sample.attributeValue }),
        current: currentByKey.get(key) ?? EMPTY_WINDOW_STATS,
        previous: previousByKey.get(key) ?? EMPTY_WINDOW_STATS,
        earlier: earlierByKey.get(key) ?? 0
      };
    }),
    previouslySeenErrorCodes
  });
}

/**
 * 异常规则的分组键：`attributeValue` 存在时是「名字 + 取值」，否则就是名字。
 *
 * 用 `\u0000` 而不是 `:` 分隔：事件名里本就有 `.`，分组值可能含冒号（错误码风格），
 * 只有 NUL 在两者里都不会出现，拼接才无歧义。
 */
function statsKey(stats: { readonly name: string; readonly attributeValue?: string }): string {
  return stats.attributeValue === undefined ? stats.name : `${stats.name}\u0000${stats.attributeValue}`;
}
