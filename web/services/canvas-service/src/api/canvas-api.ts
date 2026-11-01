/**
 * 画布存储 HTTP API（任务 4.2–4.8 / design D9、D14；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R23 —— 抽出类型、
 *  HTTP codec、lifecycle 与 run 路由，本文件保留顶层路由 dispatch）。
 *
 * 与框架解耦（只依赖 Node 的 `IncomingMessage` / `ServerResponse`）。
 *
 * 路由：
 * ```
 * GET    /api/canvases
 * POST   /api/canvases
 * GET    /api/canvases/:canvasId
 * DELETE /api/canvases/:canvasId
 * POST   /api/canvases/:canvasId/runs
 * POST   /api/canvases/:canvasId/runs/cancel
 * GET    /api/canvas-storage/health/live
 * GET    /api/canvas-storage/health/ready
 * ```
 *
 * 安全：所有错误映射为 `{ code, message, details? }`，绝不回显数据库 URI、绝对路径、
 * 堆栈、COS 凭据或签名 URL；`actorId` 由服务端上下文产生，不信任客户端自报。
 */
import {
  DEFAULT_CANVAS_API_BASE_PATH,
  DEFAULT_CANVAS_HEALTH_BASE_PATH,
  type CanvasRequestHandler,
  type CanvasRequestHandlerOptions
} from "./canvas-api/types.js";
import { checkServiceToken, decodeSegment, isLoopbackRequest, readJsonBody, respondError, sendError, sendJson } from "./canvas-api/http-codec.js";
import { handleCreate, handleDelete, handleGet, handleHealth, handleList, loadCanvasListPage, requireCanvasAccess } from "./canvas-api/lifecycle-routes.js";
import { DEFAULT_CANVAS_MAX_BODY_BYTES } from "./canvas-api/types.js";
import { handleCancel, handleRun } from "./canvas-api/run-routes.js";

export {
  DEFAULT_CANVAS_API_BASE_PATH,
  DEFAULT_CANVAS_HEALTH_BASE_PATH,
  DEFAULT_CANVAS_MAX_BODY_BYTES
} from "./canvas-api/types.js";
export type {
  CanvasRequestHandler,
  CanvasRequestHandlerOptions,
  CanvasRunPort,
  CanvasReadiness
} from "./canvas-api/types.js";

export function createCanvasRequestHandler(options: CanvasRequestHandlerOptions): CanvasRequestHandler {
  const basePath = (options.basePath ?? DEFAULT_CANVAS_API_BASE_PATH).replace(/\/$/, "");
  const healthBasePath = (options.healthBasePath ?? DEFAULT_CANVAS_HEALTH_BASE_PATH).replace(/\/$/, "");
  const log = options.logger ?? (() => undefined);

  return async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendError(res, 400, "INVALID_COMMAND_BATCH", "请求 URL 非法");
      return true;
    }

    if (pathname === `${healthBasePath}/live` || pathname === `${healthBasePath}/ready`) {
      return handleHealth(req, res, options, log);
    }

    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return false;

    const tokenError = checkServiceToken(req, options.serviceToken);
    if (tokenError) {
      log({ event: "canvas-token-rejected", status: 401 });
      sendError(res, 401, "REPOSITORY_FAILURE", tokenError);
      return true;
    }

    // 访问边界（spec「默认访问边界」）：未配置服务令牌时，画布写接口只允许本机访问。
    // 注入资源/身份运行时（`accessRuntime`）后由各路由的可信 principal 判定接管（企业/网关部署）。
    if (options.accessRuntime === undefined && !options.serviceToken && !isLoopbackRequest(req)) {
      log({ event: "canvas-non-loopback-rejected", status: 403 });
      sendError(res, 403, "REPOSITORY_FAILURE", "画布接口默认只允许本机访问；公网部署请配置服务令牌");
      return true;
    }

    const suffix = pathname === basePath ? "" : pathname.slice(basePath.length + 1);
    const segments = suffix === "" ? [] : suffix.split("/").map(decodeSegment);

    /**
     * 导入画布 ACL 优先判定（任务 4.8）：非导入画布返回 `"native"`（沿用既有路径）；
     * 导入画布无主体即 fail-closed。native 且未配置 subject 时返回 `"skip"`。
     */
    const authorizeImported = async (canvasId: string, permission: "read" | "write"): Promise<"allow" | "deny" | "skip"> => {
      const guard = options.importGuard;
      if (!guard) return "skip";
      const subject = await guard.subject(req);
      if (!subject) {
        // 无主体：仅当目标确为导入画布时 fail-closed；native 画布沿用既有服务身份路径。
        const inspected = guard.authorize({ canvasId, subject: "", permission });
        return inspected === null ? "skip" : "deny";
      }
      const decision = guard.authorize({ canvasId, subject, permission });
      if (decision === null) return "skip";
      return decision ? "allow" : "deny";
    };
    const denyImported = (permission: "read" | "write"): true => {
      log({ event: "canvas-import-forbidden", status: 403, code: "FORBIDDEN" });
      sendError(res, 403, permission === "read" ? "CANVAS_NOT_FOUND" : "COMMAND_REJECTED", "无权访问该作品");
      return true;
    };

    try {
      if (segments.length === 0) {
        if (req.method === "GET") {
          // 列表按导入 ACL 过滤：仅返回主体可读的导入画布。
          const guard = options.importGuard;
          // 注入统一认证/资源授权时，列表授权与可发现集合过滤由 handleList 负责
          // （导入目标 ACL 已并入同一 access 端口）；否则沿用服务身份 + 导入 ACL 过滤。
          if (!guard || options.authenticate) return await handleList(req, res, options, log);
          const subject = await guard.subject(req);
          const page = await loadCanvasListPage(req, options);
          const entries = subject
            ? page.items.filter((entry) => {
                const decision = guard.authorize({ canvasId: entry.id, subject, permission: "read" });
                return decision !== false;
              })
            : page.items;
          sendJson(res, 200, { ...page, items: entries });
          return true;
        }
        if (req.method === "POST") return await handleCreate(req, res, options, log);
        sendError(res, 405, "INVALID_COMMAND_BATCH", "方法不允许");
        return true;
      }

      if (segments.length === 1) {
        const canvasId = segments[0];
        if (req.method === "GET") {
          const gate = options.importGuard?.state(canvasId);
          if (gate?.kind === "deleted") {
            log({ event: "canvas-get-deleted", status: 410, code: "DELETED" });
            sendError(res, 410, "DELETED", "已删除的作品不会自动重建");
            return true;
          }
          if (gate?.kind === "preparing") {
            log({ event: "canvas-get-preparation-required", status: 409, code: "PREPARATION_REQUIRED" });
            sendError(res, 409, "PREPARATION_REQUIRED", "作品正在准备中，请稍后重试");
            return true;
          }
          const decision = await authorizeImported(canvasId, "read");
          if (decision === "deny") return denyImported("read");
          return await handleGet(req, res, canvasId, options, log);
        }
        if (req.method === "DELETE") {
          const gate = options.importGuard?.state(canvasId);
          if (gate?.kind === "deleted") {
            sendError(res, 410, "DELETED", "已删除的作品不会自动重建");
            return true;
          }
          if (gate?.kind === "ready") {
            const decision = await authorizeImported(canvasId, "write");
            if (decision === "deny") return denyImported("write");
            await options.importGuard!.deleteImported(canvasId);
            res.statusCode = 204;
            res.end();
            log({ event: "canvas-delete-imported", status: 204 });
            return true;
          }
          const decision = await authorizeImported(canvasId, "write");
          if (decision === "deny") return denyImported("write");
          return await handleDelete(req, res, canvasId, options, log);
        }
        sendError(res, 405, "INVALID_COMMAND_BATCH", "方法不允许");
        return true;
      }

      if (segments.length === 2 && segments[1] === "world-conversion-commit") {
        if (req.method !== "POST") { sendError(res, 405, "INVALID_COMMAND_BATCH", "方法不允许"); return true; }
        const canvasId = segments[0];
        const gate = options.importGuard?.state(canvasId);
        if (gate?.kind === "deleted" || gate?.kind === "preparing") { sendError(res, gate.kind === "deleted" ? 410 : 409, gate.kind === "deleted" ? "DELETED" : "PREPARATION_REQUIRED", "画布不可用"); return true; }
        if (await authorizeImported(canvasId, "write") === "deny") return denyImported("write");
        const access = await requireCanvasAccess({ req, res, canvasId, permission: "write", options, log });
        if (!access.ok) return true;
        if (!options.worldConversion) { sendError(res, 503, "NOT_READY", "转换服务不可用"); return true; }
        const body = await readJsonBody(req, options.maxBodyBytes ?? DEFAULT_CANVAS_MAX_BODY_BYTES);
        if ("canvasId" in body) { sendError(res, 400, "INVALID_COMMAND_BATCH", "请求包含非法字段"); return true; }
        const authorize = async () => (await authorizeImported(canvasId, "write")) !== "deny" && (!options.authenticate || !!access.principal && !!options.access && (await options.access.authorize({ principal: access.principal, canvasId, permission: "write" })).allowed);
        const controller = new AbortController();
        const onClose = () => { if (!res.writableFinished) controller.abort(); };
        res.once("close", onClose);
        if (res.destroyed) controller.abort();
        try {
          const result = await options.worldConversion.commit({ ...body, canvasId } as import("@woohaa3/contracts").WorldConversionCommitInput, { authorize, signal: controller.signal });
          if (!controller.signal.aborted) sendJson(res, result.ok ? 200 : result.code === "malformed-request" ? 400 : result.code === "canvas-not-found" ? 404 : 409, result);
        } finally { res.removeListener("close", onClose); }
        return true;
      }
      if (segments.length === 2 && segments[1] === "world-conversion-prepare") {
        if (req.method !== "POST") { sendError(res, 405, "INVALID_COMMAND_BATCH", "方法不允许"); return true; }
        const canvasId = segments[0];
        const gate = options.importGuard?.state(canvasId);
        if (gate?.kind === "deleted" || gate?.kind === "preparing") {
          sendError(res, gate.kind === "deleted" ? 410 : 409, gate.kind === "deleted" ? "DELETED" : "PREPARATION_REQUIRED", "画布不可用"); return true;
        }
        if (await authorizeImported(canvasId, "read") === "deny") return denyImported("read");
        if (!(await requireCanvasAccess({ req, res, canvasId, permission: "read", options, log })).ok) return true;
        if (!options.worldConversion) { sendError(res, 503, "NOT_READY", "准备服务不可用"); return true; }
        const body = await readJsonBody(req, options.maxBodyBytes ?? DEFAULT_CANVAS_MAX_BODY_BYTES);
        if (Object.keys(body).length !== 1 || !Array.isArray(body.nodeIds)) {
          sendError(res, 400, "INVALID_COMMAND_BATCH", "请求必须只包含 nodeIds"); return true;
        }
        const controller = new AbortController();
        const onClose = () => { if (!res.writableFinished) controller.abort(); };
        res.once("close", onClose);
        if (res.destroyed) controller.abort();
        try {
          const result = await options.worldConversion.prepare({ canvasId, nodeIds: body.nodeIds as string[] }, { signal: controller.signal });
          if (!controller.signal.aborted) sendJson(res, result.ok ? 200 : result.code === "malformed-request" ? 400 : result.code === "canvas-not-found" ? 404 : 409, result);
        } finally {
          res.removeListener("close", onClose);
        }
        return true;
      }
      if (segments.length === 2 && segments[1] === "runs" && req.method === "POST") {
        const decision = await authorizeImported(segments[0], "write");
        if (decision === "deny") return denyImported("write");
        return await handleRun(req, res, segments[0], options, log);
      }
      if (segments.length === 3 && segments[1] === "runs" && segments[2] === "cancel" && req.method === "POST") {
        const decision = await authorizeImported(segments[0], "write");
        if (decision === "deny") return denyImported("write");
        return await handleCancel(req, res, segments[0], options, log);
      }
      sendError(res, 404, "CANVAS_NOT_FOUND", "未知的画布路由");
      return true;
    } catch (error) {
      console.error("DEBUG_RUN_THROW", error);
      respondError(res, error, log);
      return true;
    }
  };
}
