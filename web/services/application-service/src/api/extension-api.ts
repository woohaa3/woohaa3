/**
 * 站点插件公开状态 / 管理员管理 API 与插件 handler 分派公共入口
 * （change: 2026-10-05-extract-application-plugin-host，任务 3.2/3.3 / design D6/D7；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R15 —— 拆分为
 *  类型、认证、HTTP helper、管理员/公有/handler/内部路由子模块，本文件保留顶层路由 dispatch）。
 *
 * ```
 * GET  /api/extensions                                  公开状态 snapshot（不含秘密）
 * GET  /api/extensions/changes?after=<revision>         有界增量（cursor 过旧时 resyncRequired）
 * PUT  /api/extensions/:extensionId/config                 管理员配置写入（expectedRevision）
 * ANY  /api/extensions/:extensionId/handlers/*              受控插件 handler 分派（owner-scoped）
 * POST /internal/v1/extensions/:extensionId/work            内部工作 admission（服务令牌）
 * POST /internal/v1/extensions/:extensionId/work/:id/resume 内部恢复（服务令牌）
 * ```
 */
import {
  DEFAULT_APPLICATION_EXTENSION_BASE_PATH,
  DEFAULT_PLUGIN_HANDLER_LIMITS,
  PLUGIN_INTERNAL_BASE_PATH,
  type ApplicationExtensionApiHandler,
  type ApplicationExtensionApiDependencies,
  type ApplicationExtensionHandlerLimits
} from "./extension-api/types.js";
import { safeUrl, sendError, sendJson } from "./extension-api/http-helpers.js";
import { handleChanges, handleConfigWrite, withExtensionRelease } from "./extension-api/admin-routes.js";
import { handleExtensionHandler } from "./extension-api/handler-routes.js";
import { handlePublicHttp, matchPublicRoute } from "./extension-api/public-http.js";
import { handleInternal } from "./extension-api/internal-routes.js";

export {
  DEFAULT_APPLICATION_EXTENSION_BASE_PATH,
  PLUGIN_INTERNAL_BASE_PATH,
  DEFAULT_PLUGIN_HANDLER_LIMITS
} from "./extension-api/types.js";
export type {
  ApplicationExtensionApiDependencies,
  ApplicationExtensionApiHandler,
  ApplicationExtensionHandlerLimits
} from "./extension-api/types.js";

export function createApplicationExtensionApiHandler(deps: ApplicationExtensionApiDependencies): ApplicationExtensionApiHandler {
  const log = deps.logger ?? (() => undefined);
  const basePath = (deps.basePath ?? DEFAULT_APPLICATION_EXTENSION_BASE_PATH).replace(/\/$/, "");
  const alternateBasePaths = (deps.alternateBasePaths ?? []).map((path) => path.replace(/\/$/, ""));
  const internalBase = (deps.internalBasePath ?? PLUGIN_INTERNAL_BASE_PATH).replace(/\/$/, "");
  const limits: ApplicationExtensionHandlerLimits = { ...DEFAULT_PLUGIN_HANDLER_LIMITS, ...(deps.handlerLimits ?? {}) };

  return async (req, res) => {
    const url = safeUrl(req.url);
    if (!url) {
      sendError(res, 400, "malformed-request", "请求 URL 非法");
      return true;
    }
    const pathname = url.pathname;

    if (pathname.startsWith(internalBase)) {
      return handleInternal(req, res, deps, pathname.slice(internalBase.length), log);
    }

    // 可信清单声明的固定公开映射（如 `/api/chatgpt/*`）：分派到同一插件 registration。
    const publicMatch = matchPublicRoute(deps.publicRoutes ?? [], pathname);
    if (publicMatch) {
      return handlePublicHttp(req, res, deps, publicMatch, log);
    }

    const canonical = pathname === basePath || pathname.startsWith(`${basePath}/`);
    const aliasBase = canonical ? null : alternateBasePaths.find((path) => pathname === path || pathname.startsWith(`${path}/`));
    if (!canonical && !aliasBase) return false;
    const suffix = pathname.slice((aliasBase ?? basePath).length).replace(/^\/+/, "");
    // 别名基路径只分派受控 handler，不暴露管理快照/配置写入（避免第二套管理面）。
    if (!canonical) {
      const aliasHandlerMatch = /^([^/]+)\/handlers\/(.+)$/.exec(suffix);
      if (aliasHandlerMatch) {
        return handleExtensionHandler(req, res, deps, limits, decodeURIComponent(aliasHandlerMatch[1]!), decodeURIComponent(aliasHandlerMatch[2]!), log);
      }
      sendError(res, 404, "extension-not-found", "未知的插件路由");
      return true;
    }
    if (req.method === "GET" && suffix === "") {
      sendJson(res, 200, withExtensionRelease(deps, deps.controlPlane.snapshot()));
      return true;
    }
    if (req.method === "GET" && suffix === "changes") {
      return handleChanges(req, res, deps, log);
    }
    const configMatch = /^([^/]+)\/config$/.exec(suffix);
    if (configMatch && req.method === "PUT") {
      return handleConfigWrite(req, res, deps, decodeURIComponent(configMatch[1]!), log);
    }
    const handlerMatch = /^([^/]+)\/handlers\/(.+)$/.exec(suffix);
    if (handlerMatch) {
      return handleExtensionHandler(req, res, deps, limits, decodeURIComponent(handlerMatch[1]!), decodeURIComponent(handlerMatch[2]!), log);
    }
    if (req.method !== "GET") {
      sendError(res, 405, "unsupported", "不支持的管理路由");
      return true;
    }
    sendError(res, 404, "extension-not-found", "未知的插件路由");
    return true;
  };
}

export type { ApplicationExtensionStatus } from "@woohaa3/contracts";
