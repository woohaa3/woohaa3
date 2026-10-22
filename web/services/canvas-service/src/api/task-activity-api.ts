/**
 * Canvas 任务活动 HTTP API
 * （change: 2026-09-29-add-canvas-task-activity-feed，任务 1.4 / design D3；
 *   change: unify-canvas-session-websocket，任务 3.4 / D5：移除 `/events` NDJSON 长连接，
 *   新增有限 JSON `/changes` 补偿面）。
 *
 * 画布授权的安全活动面：
 * ```
 * GET /api/canvas-task-activity/:canvasId                    活动快照（active + recent）
 * GET /api/canvas-task-activity/:canvasId/changes?after=&limit=  有限增量（断线补偿）
 * ```
 *
 * 授权：所有路由在读取任何任务记录**之前**校验调用方对目标画布的访问资格（服务令牌或
 * 本机）+ 画布 ACL 钩子；未授权/跨画布/无权限返回稳定 not-found，绝不泄露任务数量、
 * taskKey、节点、模型或结果 metadata。投影只经 Task Service 的 canvas-scoped read model，
 * **不**复用全局 operator/admin history 接口。
 *
 * 实时主链路已迁到 Canvas Session 的 `task-activity` 通道；这里只提供**有限**的
 * snapshot/增量读取作为冷启动、重连补偿与诊断边界，**不再**持有任何 HTTP 长连接。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CanvasTaskActivitySnapshot } from "@woohaa3/contracts";
import type { CanvasTaskClient } from "../clients/task-client.js";

export const DEFAULT_TASK_ACTIVITY_API_BASE_PATH = "/api/canvas-task-activity";

/** 增量读取的单页上限（与 Task 侧夹紧一致）。 */
const CHANGES_MAX_LIMIT = 200;
const CHANGES_DEFAULT_LIMIT = 200;

export type TaskActivityRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type TaskActivityRequestHandlerOptions = {
  /** Task client 或懒解析（composition 中 taskClient 可能未配置）。 */
  taskClient: CanvasTaskClient | (() => CanvasTaskClient | undefined | null);
  /** 受信任代理服务令牌；未配置时只允许本机访问。 */
  serviceToken?: string;
  basePath?: string;
  /** 目标画布是否可读（存在性 + ACL 钩子）。缺省认为存在。 */
  canvasExists?: (canvasId: string, req?: IncomingMessage) => Promise<boolean>;
  logger?: (event: { event: string; status: number; code?: string }) => void;
};

export function createTaskActivityRequestHandler(options: TaskActivityRequestHandlerOptions): TaskActivityRequestHandler {
  const basePath = (options.basePath ?? DEFAULT_TASK_ACTIVITY_API_BASE_PATH).replace(/\/$/, "");
  const log = options.logger ?? (() => undefined);

  return async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendError(res, 400, "TASK_ACTIVITY_INVALID", "请求 URL 非法");
      return true;
    }
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return false;

    if (!authorize(req, options.serviceToken)) {
      log({ event: "task-activity-unauthorized", status: 401 });
      sendError(res, 401, "TASK_ACTIVITY_NOT_FOUND", "需要受信任身份或本机访问");
      return true;
    }

    const suffix = pathname === basePath ? "" : pathname.slice(basePath.length + 1);
    const segments = suffix === "" ? [] : suffix.split("/").map(decodeSegment);
    const canvasId = segments[0];
    const changes = segments[1] === "changes";

    if (!canvasId || segments.length > 2) {
      sendError(res, 404, "TASK_ACTIVITY_NOT_FOUND", "未知的任务活动路由");
      return true;
    }
    // 旧的 NDJSON 事件流已移除（BREAKING）；显式给出稳定 not-found 而不是静默 404。
    if (segments[1] === "events") {
      sendError(res, 404, "TASK_ACTIVITY_NOT_FOUND", "事件流已由 Canvas Session 取代");
      return true;
    }
    if (req.method !== "GET") {
      sendError(res, 405, "TASK_ACTIVITY_INVALID", "方法不允许");
      return true;
    }

    // 归属校验前置：画布不存在或无权读取时立即返回稳定 not-found，不读取任务记录。
    if (options.canvasExists && !(await options.canvasExists(canvasId, req))) {
      sendError(res, 404, "TASK_ACTIVITY_NOT_FOUND", "画布活动不存在");
      return true;
    }

    const client = typeof options.taskClient === "function" ? options.taskClient() : options.taskClient;
    if (!client) {
      sendError(res, 503, "TASK_ACTIVITY_UNAVAILABLE", "任务活动面未启用");
      return true;
    }

    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (changes) {
        const after = readAfter(url.searchParams.get("after"));
        const limit = readLimit(url.searchParams.get("limit"));
        const batch = await client.canvasActivityChanges(canvasId, after, limit);
        log({ event: "task-activity-changes", status: 200 });
        sendJson(res, 200, batch);
        return true;
      }

      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limit = readInt(url.searchParams.get("limit"));
      const snapshot = await client.canvasActivity(canvasId, {
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {})
      });
      log({ event: "task-activity-snapshot", status: 200 });
      sendJson(res, 200, snapshot);
      return true;
    } catch (error) {
      log({ event: "task-activity-error", status: 502 });
      // 响应头已发出（例如 sendJson 中途失败）时不能再写错误体，只能结束连接。
      if (!res.headersSent) {
        sendError(res, 502, "TASK_ACTIVITY_UNAVAILABLE", safeMessage(error));
      } else if (!res.writableEnded) {
        res.end();
      }
      return true;
    }
  };
}

function authorize(req: IncomingMessage, serviceToken: string | undefined): boolean {
  if (serviceToken) {
    const header = req.headers["x-woohaa3-service-token"];
    const value = Array.isArray(header) ? header[0] : header;
    return value === serviceToken;
  }
  return isLoopbackRequest(req);
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress ?? "";
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("::ffff:127.")) return true;
  return false;
}

function readInt(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** `after` 必须是非负整数，否则按 0 处理（稳定、不泄露）。 */
function readAfter(raw: string | null): number {
  if (raw === null || raw === "") return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function readLimit(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return CHANGES_DEFAULT_LIMIT;
  return Math.min(value, CHANGES_MAX_LIMIT);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function safeMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message.slice(0, 200);
  return "任务活动暂时不可用";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { code, message });
}

export type { CanvasTaskActivitySnapshot };
