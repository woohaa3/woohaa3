/**
 * Task history 浏览器只读 API（change: split-web-runtime-services，任务 4.7 / 4.8 / 4.9；
 *   change: 2026-10-06-improve-task-history-experience，任务 1.1、2.1–2.3、6.4）。
 *
 * 同源（经 ingress 路由到 Task Service），受保护只读：
 * ```
 * GET /api/pptask/history?cursor=&limit=&states=&providerId=&modelType=&modelKey=
 *                          &canvasId=&nodeId=&taskKey=&from=&to=
 * GET /api/pptask/history/candidates?providerId=&modelType=&limit=
 * GET /api/pptask/history/:taskKey
 * GET /api/pptask/history/events?after=<cursor>&limit=<batch>
 * ```
 *
 * 授权：要求 operator/admin 身份。身份系统完成前，接口**只允许 loopback 或受信任代理
 * 令牌**（`WOOHAA3_TASK_SERVICE_TOKEN` 或显式 operator 令牌）。未授权请求在查询
 * repository **之前**拒绝（spec「未授权请求不会查询 repository」）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseTaskHistoryQuery,
  type TaskExecutionDetail,
  type TaskHistoryCandidateQuery } from "@woohaa3/contracts";
import type { SqliteTaskHistoryRepository } from "../repository/history-repository.js";

export const DEFAULT_HISTORY_BASE_PATH = "/api/pptask/history";

export type TaskHistoryHandlerOptions = {
  history: SqliteTaskHistoryRepository;
  /** 受信任代理服务令牌（loopback 之外的唯一放行方式）。 */
  serviceToken?: string;
  /** operator/admin 令牌（存在时优先于服务令牌）。 */
  operatorToken?: string;
  /** 允许无令牌的 loopback 访问（默认 true，用于本地开发/无身份系统部署）。 */
  allowLoopback?: boolean;
  logger?: (event: Record<string, unknown>) => void;
  retentionDays?: number;
  maxRecords?: number;
  now?: () => Date;
  /** 事件流推送间隔（毫秒）。 */
  eventFlushMs?: number;
  /** 事件流单次推送记录上限（速率限制）。 */
  eventBatchLimit?: number;
};

export type TaskHistoryHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createTaskHistoryHandler(options: TaskHistoryHandlerOptions): TaskHistoryHandler {
  const basePath = DEFAULT_HISTORY_BASE_PATH.replace(/\/$/, "");

  return async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendError(res, 400, "malformed-request", "请求 URL 非法");
      return true;
    }
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return false;
    if (req.method !== "GET") {
      sendError(res, 405, "unsupported", "只读接口");
      return true;
    }

    // 授权在**查询 repository 之前**完成。
    if (!isAuthorized(req, options)) {
      options.logger?.({ event: "task-history-unauthorized", status: 401 });
      sendError(res, 401, "unauthorized", "需要 operator/admin 身份");
      return true;
    }

    const suffix = pathname === basePath ? "" : pathname.slice(basePath.length + 1);

    if (suffix === "events") {
      return handleEvents(req, res, options);
    }
    if (suffix === "changes") {
      return handleChanges(req, res, options);
    }
    if (suffix === "candidates") {
      return handleCandidates(req, res, options);
    }
    if (suffix === "") {
      return handleList(req, res, options);
    }
    return handleDetail(res, decodeURIComponent(suffix), options);
  };
}

function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  options: TaskHistoryHandlerOptions
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parsed = parseTaskHistoryQuery(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.ok) {
    sendError(res, 400, parsed.code, parsed.message);
    return true;
  }
  const result = options.history.list(parsed.query);
  if (!result.ok) {
    sendError(res, 400, result.code, result.message);
    return true;
  }
  options.logger?.({ event: "task-history-list", status: 200 });
  sendJson(res, 200, result.page);
  return true;
}

/** 有界 JSON 增量（轮询/补偿；流式不可用时实际交付变更，而不是只做心跳）。 */
function handleChanges(
  req: IncomingMessage,
  res: ServerResponse,
  options: TaskHistoryHandlerOptions
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const rawAfter = url.searchParams.get("after") ?? "0";
  const after = Number(rawAfter);
  if (!Number.isFinite(after) || after < 0 || !Number.isInteger(after)) {
    sendError(res, 400, "invalid-cursor", "after 非法");
    return true;
  }
  const rawLimit = Number(url.searchParams.get("limit") ?? "0");
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  const batch = options.history.listSince(after, limit);
  options.logger?.({ event: "task-history-changes", status: 200, resync: batch.resync === true });
  sendJson(res, 200, batch);
  return true;
}

function handleCandidates(
  req: IncomingMessage,
  res: ServerResponse,
  options: TaskHistoryHandlerOptions
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query: TaskHistoryCandidateQuery = {};
  const providerId = url.searchParams.get("providerId");
  if (providerId) query.providerId = providerId.slice(0, 200);
  const modelType = url.searchParams.get("modelType");
  if (modelType === "language" || modelType === "image" || modelType === "video" || modelType === "audio" || modelType === "motion") {
    query.modelType = modelType;
  }
  const limit = Number(url.searchParams.get("limit") ?? "0");
  if (Number.isInteger(limit) && limit > 0) query.limit = limit;
  options.logger?.({ event: "task-history-candidates", status: 200 });
  sendJson(res, 200, options.history.candidates(query));
  return true;
}
function handleDetail(
  res: ServerResponse,
  taskKey: string,
  options: TaskHistoryHandlerOptions
): boolean {
  // 浏览器详情是 operator/admin 视图：显式带上请求摘要（prompt/parameters）。
  const detail: TaskExecutionDetail | undefined = options.history.get(taskKey, { includeRequest: true });
  if (!detail) {
    sendError(res, 404, "task-not-found", "执行记录不存在或已超过保留期");
    return true;
  }
  options.logger?.({ event: "task-history-detail", status: 200, taskKey });
  sendJson(res, 200, detail);
  return true;
}

/** 事件流：NDJSON，只发送已持久化记录与逐条可确认 cursor；水位失效发显式 resync。 */
function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  options: TaskHistoryHandlerOptions
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const rawAfter = url.searchParams.get("after") ?? "0";
  const after = Number(rawAfter);
  if (!Number.isFinite(after) || after < 0 || !Number.isInteger(after)) {
    sendError(res, 400, "invalid-cursor", "after 非法");
    return true;
  }
  const batchLimit = Math.min(Math.max(options.eventBatchLimit ?? 100, 1), 200);
  const requestedBatch = Number(url.searchParams.get("limit") ?? "0");
  const readLimit = Number.isInteger(requestedBatch) && requestedBatch > 0 ? Math.min(requestedBatch, 200) : 200;

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");

  // 1) 从请求水位补齐全部有界批次（不越过未交付记录确认水位）。
  const queue: string[] = [];
  let cursor = after;
  let iterations = 0;
  let resync = false;
  while (true) {
    const batch = options.history.listSince(cursor, readLimit);
    if (batch.resync) {
      resync = true;
      cursor = batch.cursor;
      break;
    }
    for (const message of batch.messages) queue.push(JSON.stringify(message));
    cursor = batch.cursor;
    if (!batch.hasMore) break;
    iterations += 1;
    // 防御性上限：极端情况下也不会无限循环。
    if (iterations > 1000) break;
  }

  if (resync) {
    // cursor 失效：显式要求客户端重读快照后再订阅，不尝试跳过缺口。
    writeLine(res, JSON.stringify({ type: "resync", cursor }));
    res.end();
    options.logger?.({ event: "task-history-events", status: 200, resync: true });
    return true;
  }

  // 2) 订阅后续 durable 变化；每个通知携带自身可恢复 cursor。
  const unsubscribe = options.history.subscribe((record, nextCursor) => {
    cursor = nextCursor;
    queue.push(JSON.stringify({ record, cursor: nextCursor }));
  });

  const flushIntervalMs = options.eventFlushMs ?? 100;
  const flush = () => {
    if (queue.length === 0) return;
    const chunk = queue.splice(0, batchLimit).join("\n");
    writeLine(res, chunk);
  };
  const timer = setInterval(flush, flushIntervalMs);
  // 首帧立刻推送已补齐的 snapshot，避免客户端等到第一个 tick。
  flush();

  const cleanup = () => {
    clearInterval(timer);
    unsubscribe();
  };
  req.on("close", cleanup);

  options.logger?.({ event: "task-history-events", status: 200 });
  return true;
}

function writeLine(res: ServerResponse, payload: string): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`${payload}\n`);
}

/** loopback 或携带受信任令牌。 */
function isAuthorized(req: IncomingMessage, options: TaskHistoryHandlerOptions): boolean {
  const token = headerValue(req.headers["x-woohaa3-service-token"]);
  if (options.operatorToken && token === options.operatorToken) return true;
  if (options.serviceToken && token === options.serviceToken) return true;
  if ((options.allowLoopback ?? true) && isLoopback(req)) return true;
  return false;
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress ?? "";
  return (
    address === "::1" ||
    address === "127.0.0.1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

function headerValue(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value !== "" ? value : undefined;
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { code, message });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}
