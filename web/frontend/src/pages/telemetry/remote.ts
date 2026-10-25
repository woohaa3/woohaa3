/**
 * 本机遥测复盘页的同源 HTTP 客户端
 * （change: 2026-10-20-add-local-client-telemetry，任务 5.1/5.3 / design D9/D11）。
 *
 * 三条口径：
 * - **复用宿主传输**：请求走注入的同源 transport（携带同源会话、取消信号与稳定错误码映射），
 *   不在这里另建 fetch/WebSocket。传输的形状在本地声明为结构类型，页面层因此不 import Cordis；
 * - **契约即事实**：路由与查询参数严格按 `web/contracts/src/telemetry/query.ts` 与宿主路由约定拼，
 *   不在前端做第二名（例如不自己算窗口、不在本地截断分页）；
 * - **失败必须可读**：非 2xx、响应形状不认识、网络中断都映射成带稳定码的结果对象，由页面显示
 *   「遥测服务不可用」等文案，绝不让异常冒到渲染层。
 */
import {
  TELEMETRY_PAGE_SIZE_DEFAULT,
  TELEMETRY_PAGE_SIZE_MAX,
  defaultTelemetryBucket,
  type TelemetryAnomaly,
  type TelemetryAttributeKey,
  type TelemetryBucket,
  type TelemetryEventName,
  type TelemetryEventPage,
  type TelemetryEventRecord,
  type TelemetryPerfMode,
  type TelemetryResult,
  type TelemetryStatus,
  type TelemetrySummary,
  type TelemetryWindow
} from "@woohaa3/contracts";

/** 与宿主传输一致的结构类型（`ApplicationRemoteTransport["request"]` 可直接传入）。 */
export type TelemetryTransportRequest = {
  path: string;
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  signal?: AbortSignal;
};

export type TelemetryTransportResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; code: string; error: string; status?: number };

export type TelemetryTransport = {
  request: (input: TelemetryTransportRequest) => Promise<TelemetryTransportResult>;
};

export type TelemetryRemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; error: string; status?: number };

/** 事件列表请求：窗口 + 单值筛选 + 游标分页（页面一次只筛一个 name/result）。 */
export type TelemetryEventsRequest = {
  window: TelemetryWindow;
  name?: TelemetryEventName;
  result?: TelemetryResult;
  errorCode?: string;
  /** 构建模式筛选；与聚合用同一个键，保证"列表看到的样本"与"聚合算的样本"是一批。 */
  mode?: TelemetryPerfMode;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
};

export type TelemetrySummaryRequest = {
  window: TelemetryWindow;
  bucket?: TelemetryBucket;
  /** 单键分组；缺省按事件名聚合。 */
  groupBy?: TelemetryAttributeKey;
  /** 只看某个构建模式（spec：按 production 筛选的耗时分布不含 dev 样本）。 */
  mode?: TelemetryPerfMode;
  signal?: AbortSignal;
};

export type TelemetryRemote = {
  status(input?: { signal?: AbortSignal }): Promise<TelemetryRemoteResult<TelemetryStatus>>;
  summary(input: TelemetrySummaryRequest): Promise<TelemetryRemoteResult<TelemetrySummary>>;
  anomalies(input: {
    window: TelemetryWindow;
    groupBy?: TelemetryAttributeKey;
    signal?: AbortSignal;
  }): Promise<TelemetryRemoteResult<readonly TelemetryAnomaly[]>>;
  events(input: TelemetryEventsRequest): Promise<TelemetryRemoteResult<TelemetryEventPage>>;
};

const BASE = "/api/telemetry";

export function createTelemetryRemote(deps: { transport: TelemetryTransport }): TelemetryRemote {
  const call = async <T>(
    input: { path: string; signal?: AbortSignal },
    read: (data: unknown) => T | null
  ): Promise<TelemetryRemoteResult<T>> => {
    let result: TelemetryTransportResult;
    try {
      result = await deps.transport.request({
        path: input.path,
        method: "GET",
        ...(input.signal ? { signal: input.signal } : {})
      });
    } catch (error) {
      // transport 理论上不抛；真抛了也必须降级成可读失败，不许冒到渲染层。
      return { ok: false, code: "unavailable", error: error instanceof Error ? error.message : "无法连接遥测服务" };
    }
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        error: result.error,
        ...(result.status !== undefined ? { status: result.status } : {})
      };
    }
    const value = read(result.data);
    if (value === null) return { ok: false, code: "malformed", error: "遥测服务返回了无法识别的响应" };
    return { ok: true, value };
  };

  return {
    status: (input = {}) => call({ path: `${BASE}/status`, ...(input.signal ? { signal: input.signal } : {}) }, readStatus),

    summary: (input) => {
      const params = new URLSearchParams();
      params.set("window", input.window);
      params.set("bucket", input.bucket ?? defaultTelemetryBucket(input.window));
      if (input.groupBy) params.set("groupBy", input.groupBy);
      // 构建模式是属性维度上的**筛选**，不是分组：查询参数与列表一致用 `attributeKey/attributeValue`，
      // 这样宿主只需要一份属性筛选实现（design D5）。
      if (input.mode) {
        params.set("attributeKey", "mode");
        params.set("attributeValue", input.mode);
      }
      return call(
        { path: `${BASE}/summary?${params.toString()}`, ...(input.signal ? { signal: input.signal } : {}) },
        readSummary
      );
    },

    anomalies: (input) => {
      const params = new URLSearchParams();
      params.set("window", input.window);
      if (input.groupBy) params.set("groupBy", input.groupBy);
      return call(
        { path: `${BASE}/anomalies?${params.toString()}`, ...(input.signal ? { signal: input.signal } : {}) },
        readAnomalies
      );
    },

    events: (input) => {
      const params = new URLSearchParams();
      params.set("window", input.window);
      if (input.name) params.set("name", input.name);
      if (input.result) params.set("result", input.result);
      if (input.errorCode) params.set("errorCode", input.errorCode);
      if (input.mode) {
        params.set("attributeKey", "mode");
        params.set("attributeValue", input.mode);
      }
      if (input.cursor) params.set("cursor", input.cursor);
      params.set("limit", String(clampLimit(input.limit)));
      return call(
        { path: `${BASE}/events?${params.toString()}`, ...(input.signal ? { signal: input.signal } : {}) },
        readEventPage
      );
    }
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return TELEMETRY_PAGE_SIZE_DEFAULT;
  return Math.min(TELEMETRY_PAGE_SIZE_MAX, Math.max(1, Math.trunc(limit)));
}

function readStatus(data: unknown): TelemetryStatus | null {
  if (!isRecord(data)) return null;
  const store = data.store;
  if (!isBoolean(data.enabled) || !isBoolean(data.exportEnabled)) return null;
  if (store !== "ok" && store !== "unavailable") return null;
  const exports = Array.isArray(data.exports) ? data.exports.filter(isExportStatus) : [];
  return {
    enabled: data.enabled,
    exportEnabled: data.exportEnabled,
    store,
    ...(typeof data.storePath === "string" ? { storePath: data.storePath } : {}),
    queued: numberOr(data.queued, 0),
    droppedInvalid: numberOr(data.droppedInvalid, 0),
    droppedOverflow: numberOr(data.droppedOverflow, 0),
    writeErrors: numberOr(data.writeErrors, 0),
    eventCount: numberOr(data.eventCount, 0),
    bytes: numberOr(data.bytes, 0),
    exports
  };
}

function isExportStatus(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.exportId === "string" && isBoolean(value.available) && typeof value.dropped === "number";
}

function readSummary(data: unknown): TelemetrySummary | null {
  if (!isRecord(data)) return null;
  if (typeof data.window !== "string" || typeof data.bucket !== "string") return null;
  if (!Array.isArray(data.rows) || !Array.isArray(data.series)) return null;
  return {
    window: data.window as TelemetryWindow,
    bucket: data.bucket as TelemetryBucket,
    since: numberOr(data.since, 0),
    until: numberOr(data.until, 0),
    total: numberOr(data.total, 0),
    // 分组维度必须原样带出：界面靠它决定是否显示分组列与耗时榜，也靠它写"按X"的标题。
    ...(typeof data.groupBy === "string" ? { groupBy: data.groupBy as TelemetryAttributeKey } : {}),
    rows: data.rows.filter(isSummaryRow) as TelemetrySummary["rows"],
    series: data.series.filter(isSeriesPoint) as TelemetrySummary["series"]
  };
}

function isSummaryRow(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.name === "string" && typeof value.count === "number" && isRecord(value.results);
}

function isSeriesPoint(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.at === "number" &&
    typeof value.name === "string" &&
    typeof value.count === "number" &&
    typeof value.failures === "number"
  );
}

function readAnomalies(data: unknown): readonly TelemetryAnomaly[] | null {
  if (!isRecord(data) || !Array.isArray(data.anomalies)) return null;
  return data.anomalies.filter(isAnomaly) as readonly TelemetryAnomaly[];
}

function isAnomaly(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.ruleId === "string" &&
    typeof value.severity === "string" &&
    typeof value.name === "string" &&
    typeof value.observed === "number" &&
    typeof value.baseline === "number" &&
    typeof value.samples === "number"
  );
}

function readEventPage(data: unknown): TelemetryEventPage | null {
  if (!isRecord(data) || !Array.isArray(data.events)) return null;
  const events = data.events.filter(isEventRecord) as readonly TelemetryEventRecord[];
  return {
    events,
    ...(typeof data.nextCursor === "string" && data.nextCursor !== "" ? { nextCursor: data.nextCursor } : {})
  };
}

function isEventRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "number" &&
    typeof value.name === "string" &&
    typeof value.result === "string" &&
    typeof value.receivedAt === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 页面展示错误的统一文案（按稳定错误码；未知码回落到原始 error）。 */
export function telemetryErrorText(code: string, error: string, subject: "status" | "events"): string {
  if (code === "aborted") return "请求已取消";
  if (code === "unauthorized") return "需要登录后才能查看本机遥测";
  if (code === "not-found" || code === "malformed") {
    return subject === "status" ? "遥测服务不可用" : "读取事件列表失败";
  }
  if (code === "unavailable") return "遥测服务不可用";
  return error || (subject === "status" ? "遥测服务不可用" : "读取事件列表失败");
}
