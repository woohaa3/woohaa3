/**
 * 导入 API 路由（受认证 prepare / status / 来源目录）
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 5.1–5.3 / design D4、D5）。
 *
 * 路由（挂载在既有 Canvas 基路径下）：
 * ```
 * GET  /api/canvas-sources                    活动来源目录（受认证）
 * GET  /api/canvas-sources/:sourceId/canvases 可访问来源作品分页（受认证）
 * POST /api/canvases/:canvasId/prepare        幂等触发在线迁移（受认证）
 * GET  /api/canvases/:canvasId/preparation    无创建副作用状态（受认证）
 * ```
 *
 * 认证：principal.subject 只来自宿主注入的 `resolveSubject(req)`（扩展认证断言/本地会话），
 * **绝不**信任请求 body 的 staffId/ownerId。deep link 与 list 都在 CanvasRoom 之前。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeCanvasSourceListQuery } from "@woohaa3/contracts";
import type { CanvasImportService } from "../import/service.js";
import { sendError, sendJson, readJsonBody } from "./canvas-api/http-codec.js";

export const CANVAS_SOURCES_BASE_PATH = "/api/canvas-sources";

export type CanvasPreparationRoutesOptions = {
  importService: CanvasImportService;
  /** 可信主体解析（宿主认证）；返回 null 表示未认证。异步：统一认证器由 provider 解析。 */
  resolveSubject: (req: IncomingMessage) => Promise<string | null>;
  maxBodyBytes: number;
  log: (event: { event: string; status: number; code?: string; actorId?: string }) => void;
};

export type CanvasPreparationRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createCanvasPreparationRoutes(
  options: CanvasPreparationRoutesOptions
): CanvasPreparationRouteHandler {
  const service = options.importService;

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === CANVAS_SOURCES_BASE_PATH) {
      const subject = await options.resolveSubject(req);
      if (!subject) {
        sendUnauthorized(options, res);
        return true;
      }
      try {
        sendJson(res, 200, { sources: await service.listSources() });
      } catch {
        sendError(res, 503, "SOURCE_UNAVAILABLE", "来源目录不可用");
      }
      return true;
    }

    const listMatch = /^\/api\/canvas-sources\/([^/]+)\/canvases$/.exec(path);
    if (method === "GET" && listMatch) {
      const subject = await options.resolveSubject(req);
      if (!subject) {
        sendUnauthorized(options, res);
        return true;
      }
      const query = normalizeCanvasSourceListQuery({
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : null
      });
      try {
        const page = await service.listAccessible({ subject, sourceId: decodeURIComponent(listMatch[1]!), ...query });
        sendJson(res, 200, page);
      } catch {
        sendError(res, 503, "SOURCE_UNAVAILABLE", "来源目录不可用");
      }
      return true;
    }

    const statusMatch = /^\/api\/canvases\/([^/]+)\/preparation$/.exec(path);
    if (method === "GET" && statusMatch) {
      const subject = await options.resolveSubject(req);
      if (!subject) {
        sendUnauthorized(options, res);
        return true;
      }
      sendPreparation(res, service.status(decodeURIComponent(statusMatch[1]!)));
      return true;
    }

    const prepareMatch = /^\/api\/canvases\/([^/]+)\/prepare$/.exec(path);
    if (method === "POST" && prepareMatch) {
      const subject = await options.resolveSubject(req);
      if (!subject) {
        sendUnauthorized(options, res);
        return true;
      }
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req, options.maxBodyBytes);
      } catch {
        sendError(res, 400, "malformed-request", "请求体非法");
        return true;
      }
      const sourceId = typeof body.sourceId === "string" && body.sourceId ? body.sourceId : undefined;
      const result = await service.prepare({
        subject,
        sourceCanvasId: decodeURIComponent(prepareMatch[1]!),
        ...(sourceId ? { sourceId } : {})
      });
      if (result.ok) {
        sendJson(res, 200, result.state);
      } else {
        options.log({ event: "canvas-prepare-failed", status: result.status, code: result.code, actorId: subject });
        sendError(res, result.status, result.code, result.message);
      }
      return true;
    }

    return false;
  };
}

function sendUnauthorized(options: CanvasPreparationRoutesOptions, res: ServerResponse): void {
  options.log({ event: "canvas-preparation-rejected", status: 401, code: "UNAUTHENTICATED" });
  sendError(res, 401, "UNAUTHENTICATED", "需要已认证主体");
}

function sendPreparation(res: ServerResponse, status: ReturnType<CanvasImportService["status"]>): void {
  switch (status.kind) {
    case "ready":
      sendJson(res, 200, { state: "ready", canvasId: status.canvasId, revision: status.revision });
      return;
    case "preparing":
      sendJson(res, 202, {
        state: "preparing",
        jobId: status.jobId,
        phase: status.phase,
        completedMedia: status.completedMedia,
        totalMedia: status.totalMedia,
        pollAfterMs: 1_500
      });
      return;
    case "failed":
      sendJson(res, 200, { state: "failed", code: status.code, retryable: status.retryable, message: status.message });
      return;
    case "deleted":
      sendJson(res, 410, { state: "deleted", code: "DELETED" });
      return;
  }
}
