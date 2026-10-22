/**
 * 确定性异常规则（change: 2026-10-20-add-local-client-telemetry，design D6）。
 *
 * 四条规则都是**纯函数**：输入是"当前窗口 + 两个历史窗口"的聚合结果，输出命中或空，不查库、
 * 不读时钟、不产生副作用。这样规则才能被单测覆盖到每一条阈值边界——而这些边界正是复盘时
 * 用户会质疑的地方（"为什么你说这算异常"）。
 *
 * 为什么不用统计模型：本机没有足够历史基线，且复盘时人需要的是"哪条规则被什么证据触发"，
 * 不是分数。样本门槛与阈值刻意写死为导出常量：v1 先让规则稳定可复现，参数化等出现真实误报再加。
 *
 * `W` = 观察窗口，`B` = 紧邻其前的等长窗口，`B2` = 再往前一个等长窗口。
 */
import type { TelemetryAnomaly, TelemetryAnomalyRuleId, TelemetryEventName, TelemetryWindow } from "@woohaa3/contracts";

/** 规则参数（design D6 表）。导出是为了让测试与文档引用同一份数字，而不是各自抄一遍。 */
export const TELEMETRY_ANOMALY_THRESHOLDS = {
  /** `failure-rate-spike`：W 的样本门槛。 */
  failureRateSamples: 20,
  /** `failure-rate-spike`：W 的失败率下限。 */
  failureRateObserved: 0.2,
  /** `failure-rate-spike`：B 的失败率上限（基线本身已经很高就不算"突然变差"）。 */
  failureRateBaseline: 0.1,
  /** `failure-rate-spike`：W 失败率达到这个比例时升级为 `error`（只影响排序与配色）。 */
  failureRateError: 0.5,
  /** `latency-regression`：p95(W) / p95(B) 的下限。 */
  latencyRatio: 1.5,
  /** `latency-regression`：W 与 B 各自的样本门槛（design D6 的 count 口径）。 */
  latencySamples: 20,
  /** `event-silence`：前两个窗口各自的计数门槛。 */
  silenceSamples: 5
} as const;

/** 当前窗口里出现的一个错误码（`new-error-code` 的输入之一）。 */
export type AnomalyErrorCode = {
  readonly code: string;
  readonly count: number;
  /** 该码在最外层保留期内、当前窗口之前的首次出现时间（没有则不出现该码，由调用方过滤）。 */
  readonly firstSeenAt: number;
};

/** 一个事件名在一个窗口内的聚合（只保留规则用得到的度量）。 */
export type AnomalyWindowStats = {
  readonly count: number;
  /** `failure` + `rejected`；`cancelled` 不算失败。 */
  readonly failures: number;
  /** 带耗时的样本数；分位数只在样本内取位。 */
  readonly durationSamples: number;
  readonly durationP95?: number;
  /** 只在当前窗口需要：`new-error-code` 要按名字列出当前出现过的错误码。 */
  readonly errorCodes?: readonly AnomalyErrorCode[];
};

export type AnomalyNameInput = {
  readonly name: TelemetryEventName;
  readonly current: AnomalyWindowStats;
  readonly previous: AnomalyWindowStats;
  /** `B2` 的计数，只供 `event-silence` 判断"之前确实在发生"。 */
  readonly earlier: number;
};

export type TelemetryAnomalyInput = {
  readonly window: TelemetryWindow;
  /**
   * 需要评估的事件名：当前窗口与基线窗口里出现过的名字并集。
   *
   * `event-silence` 必须能看见"当前窗口完全没有"的名字，所以并集里要包含基线窗口的名字。
   */
  readonly names: readonly AnomalyNameInput[];
  /**
   * 当前窗口的错误码里，哪些在**当前窗口之前**（基线窗口或保留期内更早数据）已经出现过。
   *
   * 不在这里直接查库：`new-error-code` 的"从未出现"要跨整个保留期判断，属于存储查询，
   * 由调用方先算好这个集合再喂给纯函数。
   */
  readonly previouslySeenErrorCodes: ReadonlySet<string>;
};

/** 跑完四条规则并按"严重度 → 规则 → 事件名"稳定排序。 */
export function evaluateTelemetryAnomalies(input: TelemetryAnomalyInput): readonly TelemetryAnomaly[] {
  const found: TelemetryAnomaly[] = [];
  for (const entry of input.names) {
    const spike = detectFailureRateSpike(entry, input.window);
    if (spike) found.push(spike);
    found.push(...detectNewErrorCodes(entry, input.window, input.previouslySeenErrorCodes));
    const latency = detectLatencyRegression(entry, input.window);
    if (latency) found.push(latency);
    const silence = detectEventSilence(entry, input.window);
    if (silence) found.push(silence);
  }
  return found.sort(
    (left, right) =>
      severityRank(left.severity) - severityRank(right.severity) ||
      compareText(left.ruleId, right.ruleId) ||
      compareText(left.name, right.name)
  );
}

/**
 * 失败率突增：W 样本足够、失败率过了下限，而 B 的失败率还在低水平。
 *
 * 同时要求"W 失败率高"与"B 失败率低"，是因为只有一侧的绝对阈值无法区分"本来就这样"和
 * "刚刚变差"——复盘要看的是变化。
 */
export function detectFailureRateSpike(entry: AnomalyNameInput, window: TelemetryWindow): TelemetryAnomaly | undefined {
  const { current, previous } = entry;
  if (current.count < TELEMETRY_ANOMALY_THRESHOLDS.failureRateSamples) return undefined;
  const observed = failureRate(current);
  const baseline = failureRate(previous);
  if (observed < TELEMETRY_ANOMALY_THRESHOLDS.failureRateObserved) return undefined;
  if (baseline >= TELEMETRY_ANOMALY_THRESHOLDS.failureRateBaseline) return undefined;
  return {
    ruleId: "failure-rate-spike",
    severity: observed >= TELEMETRY_ANOMALY_THRESHOLDS.failureRateError ? "error" : "warn",
    name: entry.name,
    window,
    observed: round4(observed),
    baseline: round4(baseline),
    samples: current.count,
    evidence: {
      currentCount: current.count,
      currentFailures: current.failures,
      currentRate: round4(observed),
      baselineCount: previous.count,
      baselineFailures: previous.failures,
      baselineRate: round4(baseline)
    }
  };
}

/**
 * 新错误码：W 里出现、而 B 与保留期内更早数据里从未出现过的错误码。
 *
 * 每个（事件名, 错误码）一条：同名不同码的对策不同，合并成一条会丢证据。
 */
export function detectNewErrorCodes(
  entry: AnomalyNameInput,
  window: TelemetryWindow,
  previouslySeen: ReadonlySet<string>
): readonly TelemetryAnomaly[] {
  const codes = entry.current.errorCodes ?? [];
  return codes
    .filter((code) => !previouslySeen.has(code.code))
    .map((code) => ({
      ruleId: "new-error-code",
      severity: "warn",
      name: entry.name,
      window,
      observed: code.count,
      baseline: 0,
      samples: code.count,
      evidence: { code: code.code, firstSeenAt: code.firstSeenAt }
    }));
}

/**
 * 延迟退化：p95(W) 达到 p95(B) 的 1.5 倍以上，且两边样本都够。
 *
 * `p95(B) > 0` 是必要的守卫：全零耗时的基线会让"0 >= 1.5 × 0"成立，从而把"一直是 0ms"误报成
 * 退化。两边样本门槛用 count（design D6 表），分位数本身只在有耗时样本时才有值，所以还要
 * 求两侧都能算出 p95。
 */
export function detectLatencyRegression(entry: AnomalyNameInput, window: TelemetryWindow): TelemetryAnomaly | undefined {
  const { current, previous } = entry;
  if (current.count < TELEMETRY_ANOMALY_THRESHOLDS.latencySamples) return undefined;
  if (previous.count < TELEMETRY_ANOMALY_THRESHOLDS.latencySamples) return undefined;
  const observed = current.durationP95;
  const baseline = previous.durationP95;
  if (observed === undefined || baseline === undefined || baseline <= 0) return undefined;
  if (observed < baseline * TELEMETRY_ANOMALY_THRESHOLDS.latencyRatio) return undefined;
  return {
    ruleId: "latency-regression",
    severity: "warn",
    name: entry.name,
    window,
    observed,
    baseline,
    samples: current.durationSamples,
    evidence: {
      currentP95: observed,
      baselineP95: baseline,
      ratio: round4(observed / baseline),
      currentSamples: current.durationSamples,
      baselineSamples: previous.durationSamples
    }
  };
}

/**
 * 事件静默：某个事件名在 B2 与 B 各有足够计数，但 W 内一条都没有。
 *
 * 这是阈值规则最容易漏掉的一类："该发生却没发生"（典型：`sync.connect` 忽然完全消失）。
 * 观测窗口样本数只能是 0，前两窗的计数放进 `evidence`，否则界面上的"0 样本"会被误读成没数据。
 */
export function detectEventSilence(entry: AnomalyNameInput, window: TelemetryWindow): TelemetryAnomaly | undefined {
  if (entry.current.count > 0) return undefined;
  if (entry.previous.count < TELEMETRY_ANOMALY_THRESHOLDS.silenceSamples) return undefined;
  if (entry.earlier < TELEMETRY_ANOMALY_THRESHOLDS.silenceSamples) return undefined;
  return {
    ruleId: "event-silence",
    severity: "warn",
    name: entry.name,
    window,
    observed: 0,
    baseline: entry.previous.count,
    samples: 0,
    evidence: { current: 0, previous: entry.previous.count, earlier: entry.earlier }
  };
}

function failureRate(stats: AnomalyWindowStats): number {
  return stats.count === 0 ? 0 : stats.failures / stats.count;
}

/** 比率保留 4 位：证据展示与 JSON 输出都不该出现浮点长尾。 */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function severityRank(severity: TelemetryAnomaly["severity"]): number {
  switch (severity) {
    case "error":
      return 0;
    case "warn":
      return 1;
    case "info":
      return 2;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 规则 id 的稳定顺序（导出给文档与测试引用，避免两处各写一份字面量数组）。 */
export const TELEMETRY_ANOMALY_RULE_ORDER: readonly TelemetryAnomalyRuleId[] = [
  "failure-rate-spike",
  "new-error-code",
  "latency-regression",
  "event-silence"
];
