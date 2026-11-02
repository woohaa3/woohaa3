/**
 * 画布存储 HTTP API（任务 4.2–4.8 / design D9、D14；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R23 —— 抽出类型、
 *  HTTP codec、lifecycle 与 run/film-set 路由，本文件保留顶层路由 dispatch）。
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
import { checkServiceToken, decodeSegment, isLoopbackRequest, respondError, sendError, sendJson } from "./canvas-api/http-codec.js";
import { handleCreate, handleDelete, handleGet, handleHealth, handleImageList, handleList, loadCanvasListPage } from "./canvas-api/lifecycle-routes.js";
import { handleArchiveExport, handleArchiveImport } from "./canvas-api/archive-routes.js";
import { handleCancel, handleFilmSetConversionCancel, handleFilmSetConversionModels, handleFilmSetConversionRetry, handleFilmSetConversionStatus, handleFilmSetConversionSubmit, handleFilmSetImport, handleRun } from "./canvas-api/run-routes.js";
import {
  handleRecordingCancel,
  handleRecordingList,
  handleRecordingStatus,
  handleRecordingSubmit
} from "./canvas-api/recording-routes.js";

export {
  DEFAULT_CANVAS_API_BASE_PATH,
  DEFAULT_CANVAS_HEALTH_BASE_PATH,
  DEFAULT_CANVAS_MAX_BODY_BYTES
} from "./canvas-api/types.js";
export type {
  CanvasRequestHandler,
  CanvasRequestHandlerOptions,
  CanvasFilmSetImportPort,
  CanvasFilmSetConversionPort,
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

      /*
       * 归档导入：`POST /api/canvases/archive`。
       *
       * 必须排在单段分支之前 —— 否则 `archive` 会被当成一个 canvasId 去查。
       * 归档包是二进制体，不能走 `readJsonBody`，所以这条路由自己读 body。
       */
      if (segments.length === 1 && segments[0] === "archive" && req.method === "POST") {
        return await handleArchiveImport(req, res, options, log);
      }
      /*
       * 跨画布图片列表：`GET /api/canvases/images?offset=&limit=`。
       *
       * **排在单段分支之前**：否则 `images` 会被当成一个 canvasId 去查，返回 404。
       * 只读、不依赖 room；权限沿用画布列表的口径（目录里能看到什么就能列出什么）。
       */
      if (segments.length === 1 && segments[0] === "images" && req.method === "GET") {
        return await handleImageList(req, res, options, log);
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

      // 归档导出：`GET /api/canvases/:canvasId/archive`（只读，权限与 GET 画布一致）。
      if (segments.length === 2 && segments[1] === "archive" && req.method === "GET") {
        const decision = await authorizeImported(segments[0], "read");
        if (decision === "deny") return denyImported("read");
        return await handleArchiveExport(req, res, segments[0], options, log);
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
      // 原生录制 submit/cancel/status（change: 2026-10-17-add-native-offscreen-film-set-recording）。
      if (segments.length === 2 && segments[1] === "recording" && req.method === "POST") {
        const decision = await authorizeImported(segments[0], "write");
        if (decision === "deny") return denyImported("write");
        return await handleRecordingSubmit(req, res, segments[0], options, log);
      }
      if (segments.length === 2 && segments[1] === "recording" && req.method === "GET") {
        const decision = await authorizeImported(segments[0], "read");
        if (decision === "deny") return denyImported("read");
        return await handleRecordingList(req, res, segments[0], options, log);
      }
      if (segments.length === 3 && segments[1] === "recording" && req.method === "GET") {
        const decision = await authorizeImported(segments[0], "read");
        if (decision === "deny") return denyImported("read");
        return await handleRecordingStatus(req, res, segments[0], segments[2]!, options, log);
      }
      if (segments.length === 4 && segments[1] === "recording" && segments[3] === "cancel" && req.method === "POST") {
        const decision = await authorizeImported(segments[0], "write");
        if (decision === "deny") return denyImported("write");
        return await handleRecordingCancel(req, res, segments[0], segments[2]!, options, log);
      }
      if (segments.length === 3 && segments[1] === "film-set" && segments[2] === "import" && req.method === "POST") {
        const decision = await authorizeImported(segments[0], "write");
        if (decision === "deny") return denyImported("write");
        return await handleFilmSetImport(req, res, segments[0], options, log);
      }
      // 单节点快捷「转为片场」（change: 2026-10-13-add-node-to-film-set-shortcut）。
      if (segments.length === 3 && segments[1] === "film-set" && segments[2] === "conversion-models" && req.method === "GET") {
        const decision = await authorizeImported(segments[0], "read");
        if (decision === "deny") return denyImported("read");
        return await handleFilmSetConversionModels(req, res, segments[0], options, log);
      }
      if (segments.length === 3 && segments[1] === "film-set" && segments[2] === "conversion" && req.method === "POST") {
        const decision = await authorizeImported(segments[0], "write");
        if (decision === "deny") return denyImported("write");
        return await handleFilmSetConversionSubmit(req, res, segments[0], options, log);
      }
      if (segments.length === 4 && segments[1] === "film-set" && segments[2] === "conversion" && req.method === "GET") {
        const decision = await authorizeImported(segments[0], "read");
        if (decision === "deny") return denyImported("read");
        return await handleFilmSetConversionStatus(req, res, segments[0], segments[3], options, log);
      }
      if (
        segments.length === 5
        && segments[1] === "film-set"
        && segments[2] === "conversion"
        && segments[4] === "cancel"
        && req.method === "POST"
      ) {
        const decision = await authorizeImported(segments[0], "write");
        if (decision === "deny") return denyImported("write");
        return await handleFilmSetConversionCancel(req, res, segments[0], segments[3], options, log);
      }
      if (
        segments.length === 5
        && segments[1] === "film-set"
        && segments[2] === "conversion"
        && segments[4] === "retry"
        && req.method === "POST"
      ) {
        const decision = await authorizeImported(segments[0], "write");
        if (decision === "deny") return denyImported("write");
        return await handleFilmSetConversionRetry(req, res, segments[0], segments[3], options, log);
      }

      sendError(res, 404, "CANVAS_NOT_FOUND", "未知的画布路由");
      return true;
    } catch (error) {
      respondError(res, error, log);
      return true;
    }
  };
}
