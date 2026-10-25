/**
 * 本机遥测 HTTP 面（change: 2026-10-20-add-local-client-telemetry，design D7）。
 *
 * 只做三件事：认路径、解析输入、把 service 的结果写成 JSON。**鉴权不在这里**：本函数签名只拿
 * 得到 `HostTelemetryService`，拿不到 access runtime；三项式鉴权（`authenticator` + 本地单实例
 * 跳过 + 检视类 action）由宿主装配层在调用本函数之前完成，避免这里发明第二份鉴权判定。
 *
 * 错误响应只回稳定短文案（`{"error":"..."}`），不回显输入、不回显 SQL 或路径：复盘页与客户端
 * 只需要按类别处理，把原始输入带回去只会让日志与界面出现不该出现的正文。
 *
 * 路由（未命中的路径返回 `false`，让宿主继续走它自己的链）：
 * - `POST   /api/telemetry/events`    批量上报，≤100 条且 body ≤64 KiB → `202 {accepted, dropped}`
 * - `GET    /api/telemetry/events`    事件列表（窗口/名字/结果/错误码/属性/游标分页）
 * - `DELETE /api/telemetry/events`    清空 → `{removed}`
 * - `GET    /api/telemetry/summary`   窗口聚合（`bucket` 分桶、`groupBy` 单键分组）
 * - `GET    /api/telemetry/anomalies` 异常命中（`groupBy` 与聚合同口径）
 * - `GET    /api/telemetry/status`    只读状态快照
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  TELEMETRY_LIMITS,
  defaultTelemetryBucket,
  isTelemetryBucket,
  isTelemetryWindow,
  normalizeTelemetryEvent,
  parseTelemetryEventFilter,
  parseTelemetryGroupBy,
  type HostTelemetryService,
  type TelemetryEventInput,
  type TelemetryFilterParse,
  type TelemetryWindow
} from "@woohaa3/contracts";

const EVENTS_PATH = "/api/telemetry/events";
const SUMMARY_PATH = "/api/telemetry/summary";
const ANOMALIES_PATH = "/api/telemetry/anomalies";
const STATUS_PATH = "/api/telemetry/status";
const ROUTE_PATHS: ReadonlySet<string> = new Set([EVENTS_PATH, SUMMARY_PATH, ANOMALIES_PATH, STATUS_PATH]);
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
/** 汇总与异常路由的缺省窗口；与 `TelemetryEventFilter` 的缺省一致。 */
const DEFAULT_WINDOW: TelemetryWindow = "24h";

/** 稳定的内部错误码：存储异常、未预期异常都归到这里，不带内部细节。 */
const ERROR_UNAVAILABLE = "unavailable";

export async function handleTelemetryRequest(
  service: HostTelemetryService,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!ROUTE_PATHS.has(url.pathname)) return false;
  const method = (req.method ?? "GET").toUpperCase();
  try {
    if (url.pathname === EVENTS_PATH) {
      if (method === "POST") {
        await ingest(service, req, res);
        return true;
      }
      if (method === "GET") {
        await list(service, url, res);
        return true;
      }
      if (method === "DELETE") {
        sendJson(res, 200, { removed: await service.clear() });
        return true;
      }
      sendError(res, 405, "method-not-allowed");
      return true;
    }

    if (method !== "GET") {
      sendError(res, 405, "method-not-allowed");
      return true;
    }
    if (url.pathname === SUMMARY_PATH) {
      await summary(service, url, res);
      return true;
    }
    if (url.pathname === ANOMALIES_PATH) {
      const parsed = parseWindow(url);
      if (!parsed.ok) {
        sendError(res, 400, "invalid-window");
        return true;
      }
      const groupBy = parseTelemetryGroupBy(url.searchParams.get("groupBy"));
      if (groupBy === "invalid") {
        sendError(res, 400, "invalid-attribute");
        return true;
      }
      const parsedFilter = parseAttributeOnly(url);
      if (!parsedFilter.ok) {
        sendError(res, 400, parsedFilter.code);
        return true;
      }
      const { attributeKey, attributeValue } = parsedFilter.filter;
      sendJson(res, 200, {
        anomalies: await service.anomalies(parsed.window, {
          ...(groupBy === undefined ? {} : { groupBy }),
          ...(attributeKey === undefined || attributeValue === undefined ? {} : { attributeKey, attributeValue })
        })
      });
      return true;
    }
    sendJson(res, 200, await service.status());
    return true;
  } catch {
    // 存储异常不该把内部细节（SQL、文件路径）写进响应：只回稳定短文案。
    if (!res.headersSent) sendError(res, 500, ERROR_UNAVAILABLE);
    return true;
  }
}

async function ingest(service: HostTelemetryService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, body.status, body.error);
    return;
  }
  if (!isRecord(body.value)) {
    sendError(res, 400, "invalid-body");
    return;
  }
  const events = body.value.events;
  if (!Array.isArray(events)) {
    sendError(res, 400, "invalid-body");
    return;
  }
  // 条数上限与 proto 的 `ReportEvents` 一致，直接读契约里的常量，不在路由里写数字。
  if (events.length > TELEMETRY_LIMITS.maxBatchEvents) {
    sendError(res, 413, "payload-too-large");
    return;
  }

  const nowMs = Date.now();
  let accepted = 0;
  let dropped = 0;
  for (const raw of events) {
    // 归一在这里先做一次，是为了能如实回报 `dropped`（`service.emit` 只返回 void）；
    // 对已归一的事件再归一一次是幂等的，不会改变形状。
    const event = normalizeTelemetryEvent(raw, { now: nowMs });
    if (event === null) {
      dropped += 1;
      continue;
    }
    service.emit(event as TelemetryEventInput);
    accepted += 1;
  }
  sendJson(res, 202, { accepted, dropped });
}

async function list(service: HostTelemetryService, url: URL, res: ServerResponse): Promise<void> {
  const parsed = parseTelemetryEventFilter(toQueryRecord(url));
  if (!parsed.ok) {
    sendError(res, 400, parsed.code);
    return;
  }
  sendJson(res, 200, await service.query(parsed.filter));
}

async function summary(service: HostTelemetryService, url: URL, res: ServerResponse): Promise<void> {
  const parsedWindow = parseWindow(url);
  if (!parsedWindow.ok) {
    sendError(res, 400, "invalid-window");
    return;
  }
  const rawBucket = url.searchParams.get("bucket");
  const bucket = rawBucket === null || rawBucket === "" ? defaultTelemetryBucket(parsedWindow.window) : rawBucket;
  if (!isTelemetryBucket(bucket)) {
    sendError(res, 400, "invalid-bucket");
    return;
  }
  // 未知 `groupBy` 与未知属性键同待遇：`invalid-attribute`，不静默降级成"不分组"——
  // 否则界面会显示一份看起来分组了、实际是全量聚合的表（spec「未知属性键」）。
  const groupBy = parseTelemetryGroupBy(url.searchParams.get("groupBy"));
  if (groupBy === "invalid") {
    sendError(res, 400, "invalid-attribute");
    return;
  }
  // 属性筛选复用事件列表的解析器：两条读面若各写一份，"只给键"的判定迟早分叉。
  const parsedFilter = parseAttributeOnly(url);
  if (!parsedFilter.ok) {
    sendError(res, 400, parsedFilter.code);
    return;
  }
  const { attributeKey, attributeValue } = parsedFilter.filter;
  const options = {
    ...(groupBy === undefined ? {} : { groupBy }),
    ...(attributeKey === undefined || attributeValue === undefined ? {} : { attributeKey, attributeValue })
  };
  sendJson(res, 200, await service.summary(parsedWindow.window, bucket, options));
}

/**
 * 只解析属性筛选这一对参数。
 *
 * 不复用整份 `toQueryRecord`：`summary` 与 `anomalies` 不认 `cursor`/`limit`/`result`，
 * 让无关参数（例如从列表链接带过来的 `cursor`）把聚合请求打成 400 是纯粹的噪声。
 */
function parseAttributeOnly(url: URL): TelemetryFilterParse {
  return parseTelemetryEventFilter({
    attributeKey: url.searchParams.get("attributeKey") ?? undefined,
    attributeValue: url.searchParams.get("attributeValue") ?? undefined
  });
}

type WindowParse = { readonly ok: true; readonly window: TelemetryWindow } | { readonly ok: false };

function parseWindow(url: URL): WindowParse {
  const raw = url.searchParams.get("window");
  if (raw === null || raw === "") return { ok: true, window: DEFAULT_WINDOW };
  return isTelemetryWindow(raw) ? { ok: true, window: raw } : { ok: false };
}

type BodyRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly error: string };

/**
 * 读请求体并解析成 JSON，上限自写（仓库无统一 helper，照 `task-inspection-api.ts` 的 64 KiB）。
 *
 * 先按字节累计判断上限再解析：超限的 body 不该被完整读进内存后才拒绝。
 */
async function readJsonBody(req: IncomingMessage): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.byteLength;
    if (size > TELEMETRY_LIMITS.maxRequestBytes) {
      return { ok: false, status: 413, error: "payload-too-large" };
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return { ok: false, status: 400, error: "invalid-body" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "invalid-body" };
  }
}

/** 查询串转记录：同名参数出现多次时保留数组，`parseTelemetryEventFilter` 支持 `readonly string[]`。 */
function toQueryRecord(url: URL): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    record[key] = values.length === 1 ? values[0] : values;
  }
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": JSON_CONTENT_TYPE });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error });
}
