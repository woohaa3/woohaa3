/**
 * 本机遥测事件契约（change: 2026-10-20-add-local-client-telemetry，design D3）。
 *
 * 三条口径：
 * - **白名单**：`name` / `result` / `origin` / `surface` 与属性键都取自固定常量；未知值丢弃，
 *   不接受现拼键名，也不接受任意属性。
 * - **有界**：每个字段都有长度/数量/取值上限，`TELEMETRY_LIMITS` 是唯一来源。
 * - **无用户内容**：prompt、标题、文件名、画布名、URL、媒体地址一律不进入事件；这里不做
 *   "先收进来再过滤"，而是结构上就没有能装这些内容的字段。
 *
 * 与 `woohaa.telemetry.v1alpha1` 的关系：`name`/`result`/`origin`/`surface` 与 proto 的
 * `Action`/`Result`/`Client`/`Surface` 一一对应（`task.terminal` 除外，它没有对应枚举）；
 * `durationMs`/`errorCode`/`attributes` 是本地独有，导出时丢弃。本地是事实的形状，proto 是
 * 它的一个有损投影。
 */

/** 事件名白名单。新增一个名字等于新增一类可复盘事实，必须同时补异常规则与文档。 */
export const TELEMETRY_EVENT_NAMES = [
  "canvas.open",
  "canvas.save",
  "canvas.edit",
  "sync.connect",
  "sync.reconcile",
  "local.validation",
  "task.terminal"
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

export const TELEMETRY_RESULTS = ["success", "failure", "cancelled", "rejected"] as const;
export type TelemetryResult = (typeof TELEMETRY_RESULTS)[number];

/** 事件产生的位置。与 proto 的 `Client` 对应。 */
export const TELEMETRY_ORIGINS = ["browser", "desktop", "local-host"] as const;
export type TelemetryOrigin = (typeof TELEMETRY_ORIGINS)[number];

/** 事件发生的界面面。与 proto 的 `Surface` 对应；`task` 无对应值。 */
export const TELEMETRY_SURFACES = ["canvas", "editor", "sync", "local-validation", "task"] as const;
export type TelemetrySurface = (typeof TELEMETRY_SURFACES)[number];

/**
 * 允许出现的属性键。
 *
 * 这些键名固定成常量而不是由调用点现拼：键名决定复盘页与聚合的展示口径，改名等于改口径，
 * 必须显式改这里（同 `base/diagnostics.ts` 的 `ATTRIBUTE_KEYS` 取向）。
 */
export const TELEMETRY_ATTRIBUTE_KEYS = [
  "canvas",
  "node",
  "provider",
  "model",
  "phase",
  "status",
  "code",
  "source",
  "version"
] as const;

export type TelemetryAttributeKey = (typeof TELEMETRY_ATTRIBUTE_KEYS)[number];

/** 唯一的上限来源；实现与测试都读这里，不各自写数字。 */
export const TELEMETRY_LIMITS = {
  /** 单条事件最多属性对。 */
  maxAttributes: 8,
  /** 属性值单行最大字符数（按码点截断，中文不会被切坏）。 */
  maxAttributeValueLength: 128,
  /** 属性序列化后最大字节数；超预算按排序确定性丢弃。 */
  maxAttributesBytes: 1024,
  /** 错误码最大长度（与 `[a-z0-9][a-z0-9_.:-]{0,63}` 一致）。 */
  maxErrorCodeLength: 64,
  /** `trace_id` 固定 32 位小写十六进制。 */
  traceIdLength: 32,
  /** 前端版本最大长度（与 proto 的 `frontend_version` 一致）。 */
  maxFrontendVersionLength: 64,
  /** 耗时上限：一天。超过视为坏数据而不是"很慢"。 */
  maxDurationMs: 86_400_000,
  /** 客户端时钟超前于宿主时钟的可接受窗口；超过即视为不可信时间。 */
  maxClockSkewMs: 5 * 60 * 1000,
  /** 单批最多事件数（与 proto 的 `ReportEvents` 一致）。 */
  maxBatchEvents: 100,
  /** 单请求体上限。仓库无统一 helper，按 `task-inspection-api.ts` 的 64 KiB。 */
  maxRequestBytes: 64 * 1024
} as const;

/** 一条本机遥测事实。 */
export type TelemetryEvent = {
  readonly name: TelemetryEventName;
  readonly result: TelemetryResult;
  readonly origin: TelemetryOrigin;
  readonly surface?: TelemetrySurface;
  /** 操作耗时；缺失表示该事件不度量耗时。 */
  readonly durationMs?: number;
  /** 稳定错误码（不是错误消息）。 */
  readonly errorCode?: string;
  /** 关联标识；32 位小写十六进制。 */
  readonly traceId?: string;
  /** 上报端构建版本；服务端只做形状校验，因此这里同样只留形状。 */
  readonly frontendVersion?: string;
  /** 上报端时钟（epoch ms）；`0` 表示不可信/未知。窗口与保留永远不认它。 */
  readonly occurredAt: number;
  /** 有界键值细节；键来自 `TELEMETRY_ATTRIBUTE_KEYS`。 */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
};

/**
 * 调用点用来发事件的输入形状。
 *
 * 与 `TelemetryEvent` 只差 `occurredAt` 可缺省（缺省取宿主当前时间）。字段仍可能非法——
 * 归一在 `normalizeTelemetryEvent` 里统一做，调用点不需要自己校验。
 */
export type TelemetryEventInput = Omit<TelemetryEvent, "occurredAt"> & { readonly occurredAt?: number };

const EVENT_NAME_SET: ReadonlySet<string> = new Set(TELEMETRY_EVENT_NAMES);
const RESULT_SET: ReadonlySet<string> = new Set(TELEMETRY_RESULTS);
const ORIGIN_SET: ReadonlySet<string> = new Set(TELEMETRY_ORIGINS);
const SURFACE_SET: ReadonlySet<string> = new Set(TELEMETRY_SURFACES);
const ATTRIBUTE_KEY_SET: ReadonlySet<string> = new Set(TELEMETRY_ATTRIBUTE_KEYS);

const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const FRONTEND_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export function isTelemetryEventName(value: unknown): value is TelemetryEventName {
  return typeof value === "string" && EVENT_NAME_SET.has(value);
}

export function isTelemetryResult(value: unknown): value is TelemetryResult {
  return typeof value === "string" && RESULT_SET.has(value);
}

export function isTelemetryOrigin(value: unknown): value is TelemetryOrigin {
  return typeof value === "string" && ORIGIN_SET.has(value);
}

export function isTelemetrySurface(value: unknown): value is TelemetrySurface {
  return typeof value === "string" && SURFACE_SET.has(value);
}

export function isTelemetryAttributeKey(value: unknown): value is TelemetryAttributeKey {
  return typeof value === "string" && ATTRIBUTE_KEY_SET.has(value);
}

/** 按码点截断，避免把代理对或中文切坏。 */
export function truncateByCodePoints(value: string, max: number): string {
  if (value.length <= max) return value;
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

/** 把控制字符与换行折叠成单个空格，并去掉首尾空白。 */
export function foldSingleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 归一一条事件。返回 `null` 表示这条事件必须整条丢弃（未知 `name`/`result`/`origin`）。
 *
 * 其余字段的非法值一律**丢该字段而不丢整条**：一次上报是一批，为一个可疑字段丢掉同批其它
 * 合法事实不值得。
 */
export function normalizeTelemetryEvent(input: unknown, options: { now?: number } = {}): TelemetryEvent | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const { name, result, origin } = raw;
  if (!isTelemetryEventName(name) || !isTelemetryResult(result) || !isTelemetryOrigin(origin)) return null;

  const now = options.now ?? Date.now();
  const event: {
    -readonly [K in keyof TelemetryEvent]: TelemetryEvent[K];
  } = {
    name,
    result,
    origin,
    occurredAt: normalizeOccurredAt(raw.occurredAt, now)
  };

  if (isTelemetrySurface(raw.surface)) event.surface = raw.surface;

  const durationMs = normalizeDuration(raw.durationMs);
  if (durationMs !== undefined) event.durationMs = durationMs;

  const errorCode = normalizeErrorCode(raw.errorCode);
  if (errorCode !== undefined) event.errorCode = errorCode;

  const traceId = normalizeTraceId(raw.traceId);
  if (traceId !== undefined) event.traceId = traceId;

  const frontendVersion = normalizeFrontendVersion(raw.frontendVersion);
  if (frontendVersion !== undefined) event.frontendVersion = frontendVersion;

  const attributes = normalizeAttributes(raw.attributes);
  if (attributes !== undefined) event.attributes = attributes;

  // 全零 trace_id 单独判掉：形状合法但没有关联意义。
  if (event.traceId !== undefined && /^0{32}$/.test(event.traceId)) delete event.traceId;

  return event;
}

function normalizeOccurredAt(value: unknown, now: number): number {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  // 超前超过可接受偏差 → 不可信，存 0。早于保留期的判定在存储侧做（它才知道保留配置）。
  if (ms - now > TELEMETRY_LIMITS.maxClockSkewMs) return 0;
  return Math.floor(ms);
}

function normalizeDuration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > TELEMETRY_LIMITS.maxDurationMs) return undefined;
  return Math.round(value);
}

function normalizeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || !ERROR_CODE_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

function normalizeTraceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!TRACE_ID_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

function normalizeFrontendVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || !FRONTEND_VERSION_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * 归一属性：未在白名单里的键逐对丢弃，值折叠单行并按码点截断，超过条数或字节预算时按
 * **排序后的确定性顺序**丢弃尾部。返回 `undefined` 表示一个都没留下。
 */
function normalizeAttributes(
  value: unknown
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries: Array<[string, string | number | boolean]> = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isTelemetryAttributeKey(key)) continue;
    const normalized = normalizeAttributeValue(raw);
    if (normalized === undefined) continue;
    entries.push([key, normalized]);
  }
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const kept: Array<[string, string | number | boolean]> = [];
  for (const entry of entries) {
    if (kept.length >= TELEMETRY_LIMITS.maxAttributes) break;
    const candidate = [...kept, entry];
    if (utf8ByteLength(JSON.stringify(Object.fromEntries(candidate))) > TELEMETRY_LIMITS.maxAttributesBytes) {
      break;
    }
    kept.push(entry);
  }
  if (kept.length === 0) return undefined;
  return Object.fromEntries(kept);
}

/**
 * UTF-8 字节数。`contracts` 同时被浏览器与宿主使用，因此不能用 Node 的 `Buffer`。
 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function normalizeAttributeValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const folded = foldSingleLine(value);
  if (folded === "") return undefined;
  return truncateByCodePoints(folded, TELEMETRY_LIMITS.maxAttributeValueLength);
}
