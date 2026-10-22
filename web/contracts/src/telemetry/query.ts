/**
 * 本机遥测的查询契约（change: 2026-10-20-add-local-client-telemetry，design D5/D6）。
 *
 * 三条口径：
 * - **窗口有界**：只接受 `1h` / `6h` / `24h` / `7d` 四档，分桶只接受 `1m` / `5m` / `1h`。
 *   任意起止时间会让聚合的基线对比失去意义，也让"这一页和上一页统计口径不同"成为常态。
 * - **分页与服务端同取向**：最新在前、opaque 游标、默认 50 条、单页最多 200 条。
 * - **异常只描述、不处置**：规则输出的是"规则 + 窗口 + 观测值与基线值 + 样本数"，
 *   不含建议动作，也不触发任何副作用。
 */
import {
  isTelemetryEventName,
  isTelemetryResult,
  type TelemetryEvent,
  type TelemetryEventName,
  type TelemetryResult
} from "./event.js";

export const TELEMETRY_WINDOWS = ["1h", "6h", "24h", "7d"] as const;
export type TelemetryWindow = (typeof TELEMETRY_WINDOWS)[number];

export const TELEMETRY_BUCKETS = ["1m", "5m", "1h"] as const;
export type TelemetryBucket = (typeof TELEMETRY_BUCKETS)[number];

export const TELEMETRY_WINDOW_MS: Readonly<Record<TelemetryWindow, number>> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000
};

export const TELEMETRY_BUCKET_MS: Readonly<Record<TelemetryBucket, number>> = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000
};

/** 分页缺省与上限（与 `ListEventsRequest` 一致）。 */
export const TELEMETRY_PAGE_SIZE_DEFAULT = 50;
export const TELEMETRY_PAGE_SIZE_MAX = 200;

/** 游标是不透明串；上限只是防滥用。 */
export const TELEMETRY_CURSOR_MAX_LENGTH = 64;

export function isTelemetryWindow(value: unknown): value is TelemetryWindow {
  return typeof value === "string" && (TELEMETRY_WINDOWS as readonly string[]).includes(value);
}

export function isTelemetryBucket(value: unknown): value is TelemetryBucket {
  return typeof value === "string" && (TELEMETRY_BUCKETS as readonly string[]).includes(value);
}

/** 每个窗口的缺省分桶：窗口越长桶越大，避免把 7 天切成 10080 个点。 */
export function defaultTelemetryBucket(window: TelemetryWindow): TelemetryBucket {
  switch (window) {
    case "1h":
      return "1m";
    case "6h":
      return "5m";
    case "24h":
    case "7d":
      return "1h";
  }
}

/** 事件列表的筛选条件。 */
export type TelemetryEventFilter = {
  /** 时间窗口；缺省 `24h`。 */
  readonly window?: TelemetryWindow;
  /** 事件名；缺省不限。 */
  readonly names?: readonly TelemetryEventName[];
  /** 结果；缺省不限。 */
  readonly results?: readonly TelemetryResult[];
  /** 稳定错误码精确匹配；缺省不限。 */
  readonly errorCode?: string;
  /** 上一页最后一条的 id（不透明）。 */
  readonly cursor?: string;
  /** 单页条数；缺省 50、上限 200。 */
  readonly limit?: number;
};

/** 一条已落库的事件：事件本身 + 宿主决定的身份与时间。 */
export type TelemetryEventRecord = TelemetryEvent & {
  readonly id: number;
  /** 宿主接收时间；排序、窗口与保留都认它。 */
  readonly receivedAt: number;
};

export type TelemetryEventPage = {
  readonly events: readonly TelemetryEventRecord[];
  readonly nextCursor?: string;
};

/** 聚合表的一行：一个事件名在窗口内的表现。 */
export type TelemetrySummaryRow = {
  readonly name: TelemetryEventName;
  readonly count: number;
  readonly results: Readonly<Record<TelemetryResult, number>>;
  /** 以下分位数只统计带 `durationMs` 的事件；没有样本时为 `undefined`。 */
  readonly durationP50?: number;
  readonly durationP95?: number;
  readonly durationMax?: number;
  readonly durationSamples: number;
  readonly topErrorCodes: readonly { readonly code: string; readonly count: number }[];
};

/** 时间序列的一个点，供页面画趋势。 */
export type TelemetrySeriesPoint = {
  /** 桶起点（epoch ms）。 */
  readonly at: number;
  readonly name: TelemetryEventName;
  readonly count: number;
  /** `failure` + `rejected` + `cancelled` 的数量。 */
  readonly failures: number;
};

export type TelemetrySummary = {
  readonly window: TelemetryWindow;
  readonly bucket: TelemetryBucket;
  readonly since: number;
  readonly until: number;
  readonly total: number;
  readonly rows: readonly TelemetrySummaryRow[];
  readonly series: readonly TelemetrySeriesPoint[];
};

export const TELEMETRY_ANOMALY_RULE_IDS = [
  "failure-rate-spike",
  "new-error-code",
  "latency-regression",
  "event-silence"
] as const;

export type TelemetryAnomalyRuleId = (typeof TELEMETRY_ANOMALY_RULE_IDS)[number];
export type TelemetryAnomalySeverity = "info" | "warn" | "error";

/**
 * 一条异常命中。
 *
 * `observed` / `baseline` 是同一度量在两个窗口上的值（比率或耗时），`samples` 是观测窗口的
 * 样本数——没有样本数的"100% 失败"是解读陷阱，必须一起呈现。
 */
export type TelemetryAnomaly = {
  readonly ruleId: TelemetryAnomalyRuleId;
  readonly severity: TelemetryAnomalySeverity;
  readonly name: TelemetryEventName;
  readonly window: TelemetryWindow;
  readonly observed: number;
  readonly baseline: number;
  readonly samples: number;
  readonly evidence: Readonly<Record<string, string | number>>;
};

export type TelemetryStoreState = "ok" | "unavailable";

/** 单个导出出口的运行时状态。 */
export type TelemetryExportStatus = {
  readonly exportId: string;
  readonly label?: string;
  readonly available: boolean;
  /** 最近一次失败的稳定错误码。 */
  readonly lastError?: string;
  /** 这个出口丢弃的事件数。 */
  readonly dropped: number;
};

/** 复盘页与 `status` 路由共用的一份状态快照。 */
export type TelemetryStatus = {
  /** `telemetry.local.enabled` 的当前值。 */
  readonly enabled: boolean;
  /** `telemetry.export.enabled` 的当前值。 */
  readonly exportEnabled: boolean;
  readonly store: TelemetryStoreState;
  /**
   * 本地库文件位置（总是给出）。
   *
   * 不可用时它就是"该去处理哪个文件"的答案；可用时它是核对占用的依据（页面显示 `bytes`）。
   * 读面在启用访问控制时受 `telemetry.inspect` 保护，因此这里不是公开信息。
   */
  readonly storePath?: string;
  /** 排队待写的事件数。 */
  readonly queued: number;
  readonly droppedInvalid: number;
  readonly droppedOverflow: number;
  readonly writeErrors: number;
  /** 已落库事件数（过期行不计）。 */
  readonly eventCount: number;
  /** 数据库文件字节数。 */
  readonly bytes: number;
  readonly exports: readonly TelemetryExportStatus[];
};

export type TelemetryFilterParseErrorCode =
  | "invalid-window"
  | "invalid-name"
  | "invalid-result"
  | "invalid-error-code"
  | "invalid-cursor"
  | "invalid-limit";

export type TelemetryFilterParse =
  | { readonly ok: true; readonly filter: TelemetryEventFilter }
  | { readonly ok: false; readonly code: TelemetryFilterParseErrorCode; readonly message: string };

/**
 * 解析查询参数。非法值一律返回稳定错误码，而不是静默夹到合法值——静默纠正会让"我明明筛了"
 * 与"界面显示的结果"对不上。
 */
export function parseTelemetryEventFilter(input: Record<string, unknown>): TelemetryFilterParse {
  const filter: {
    -readonly [K in keyof TelemetryEventFilter]: TelemetryEventFilter[K];
  } = {};

  if (input.window !== undefined && input.window !== "") {
    if (!isTelemetryWindow(input.window)) {
      return { ok: false, code: "invalid-window", message: "未知的时间窗口" };
    }
    filter.window = input.window;
  }

  const names = parseEnumList(input.name ?? input.names, isTelemetryEventName);
  if (names === "invalid") return { ok: false, code: "invalid-name", message: "未知的事件名" };
  if (names.length > 0) filter.names = names;

  const results = parseEnumList(input.result ?? input.results, isTelemetryResult);
  if (results === "invalid") return { ok: false, code: "invalid-result", message: "未知的结果" };
  if (results.length > 0) filter.results = results;

  if (input.errorCode !== undefined && input.errorCode !== "") {
    if (typeof input.errorCode !== "string" || !/^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(input.errorCode)) {
      return { ok: false, code: "invalid-error-code", message: "错误码非法" };
    }
    filter.errorCode = input.errorCode;
  }

  if (input.cursor !== undefined && input.cursor !== "") {
    if (typeof input.cursor !== "string" || input.cursor.length > TELEMETRY_CURSOR_MAX_LENGTH) {
      return { ok: false, code: "invalid-cursor", message: "游标非法" };
    }
    filter.cursor = input.cursor;
  }

  if (input.limit !== undefined && input.limit !== "") {
    // 不用 `parseInt`：它会把 "1.5" 静默截成 1，而"我传了 1.5 却按 1 处理"正是这里要拒绝的
    // 静默纠正。`Number` 保留小数，交给下面的整数判定拒绝。
    const limit = typeof input.limit === "number" ? input.limit : Number(String(input.limit));
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0 || limit > TELEMETRY_PAGE_SIZE_MAX) {
      return { ok: false, code: "invalid-limit", message: `limit 必须在 1..${TELEMETRY_PAGE_SIZE_MAX}` };
    }
    filter.limit = limit;
  }

  return { ok: true, filter };
}

function parseEnumList<T extends string>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T
): T[] | "invalid" {
  if (value === undefined || value === "") return [];
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out: T[] = [];
  for (const entry of raw) {
    const candidate = typeof entry === "string" ? entry.trim() : entry;
    if (candidate === "") continue;
    if (!guard(candidate)) return "invalid";
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}
