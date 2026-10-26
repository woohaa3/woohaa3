/**
 * 扩展安装 API（change: 2026-10-21-add-extension-marketplace-point，D10 / tasks 7.1）。
 *
 * POST   /api/extensions/install              octet-stream：.wxt 原始字节（流式写盘，不缓冲进内存）
 *                                             application/json：{ sourceId, extensionId, range }
 *                                             → 202 { jobId, job }
 * GET    /api/extensions/install/:jobId       → ExtensionInstallJobView
 * DELETE /api/extensions/install/:jobId       → 取消（只在提交前有效）
 * POST   /api/extensions/:id/uninstall        { purgeData?: boolean } → 202 { jobId, job }
 * POST   /api/extensions/:id/rollback         { toVersion?: string } → 202 { jobId, job }
 *
 * 受控重启只有一个入口：P0 的 `POST /api/host/restart`（设置面「立即重启」直接调它），这里不再重复。
 * GET    /api/extensions/marketplace/search   ?q=&sourceId=&cursor=&limit= → { items, nextCursor?, unavailable }
 * GET    /api/extensions/:id/version-status    受管扩展当前版本在来源侧的状态（已撤回提示；失败为 unknown）
 * GET    /api/extensions/marketplace/extension ?sourceId=&extensionId= → MarketplaceExtensionDetailView（版本 + 本机是否信任 keyId）
 *
 * 鉴权沿用插件管理的具名 action（`extensions.configure`）。这些路径排在 application-service 的
 * `/api/extensions/*` 之前；未命中即交下游，不替整条前缀做鉴权。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { APPLICATION_EXTENSION_LOAD_ACTION, WOOHAA3_PROTOCOL_VERSION } from "@woohaa3/contracts";
import { authorizeAdmin, type AdminAuthDependencies } from "./admin-auth.js";
import { ExtensionManagerError } from "../host/core/extension-manager/errors.js";
import type { ExtensionManager } from "../host/core/extension-manager/manager.js";

export const EXTENSION_INSTALL_BASE_PATH = "/api/extensions";
const PACKAGE_CONTENT_TYPES = new Set(["application/octet-stream", "application/x-woohaa-extension", "application/gzip", "application/x-gzip"]);
const EXTENSION_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_JSON_BYTES = 16 * 1024;

export type ExtensionInstallApiDependencies = AdminAuthDependencies & {
  /** 按请求现取（Manager 在核心层装载；缺省时安装接口回 503）。 */
  manager: () => ExtensionManager | undefined;
  /** 受管扩展当前版本状态（已撤回提示）；缺省时该路由回 503。 */
  versionStatus?: () =>
    | ((input: { sourceId: string; extensionId: string; version: string }) => Promise<import("@woohaa3/contracts").ManagedVersionStatusView>)
    | undefined;
  /** 市场版本详情（7.4）；缺省时该路由回 503。 */
  marketplaceDetail?: () =>
    | ((input: { sourceId: string; extensionId: string }, signal: AbortSignal) => Promise<import("@woohaa3/contracts").MarketplaceExtensionDetailView>)
    | undefined;
  logger?: (event: Record<string, unknown>) => void;
};

type Route =
  | { kind: "install" }
  | { kind: "job"; jobId: string }
  | { kind: "uninstall"; extensionId: string }
  | { kind: "rollback"; extensionId: string }
  | { kind: "search" }
  | { kind: "extension" }
  | { kind: "versionStatus"; extensionId: string };

function match(pathname: string): Route | null {
  const base = EXTENSION_INSTALL_BASE_PATH;
  if (!pathname.startsWith(`${base}/`)) return null;
  const rest = pathname.slice(base.length + 1).split("/");
  if (rest.length === 1 && rest[0] === "install") return { kind: "install" };
  if (rest.length === 2 && rest[0] === "install" && rest[1]) return { kind: "job", jobId: decodeURIComponent(rest[1]) };
  if (rest.length === 2 && rest[0] === "marketplace" && rest[1] === "search") return { kind: "search" };
  if (rest.length === 2 && rest[0] === "marketplace" && rest[1] === "extension") return { kind: "extension" };
  if (rest.length === 2 && rest[0] && EXTENSION_ID.test(rest[0]) && rest[1] === "version-status") return { kind: "versionStatus", extensionId: rest[0] };
  if (rest.length === 2 && rest[0] && EXTENSION_ID.test(rest[0]) && rest[1] === "uninstall") return { kind: "uninstall", extensionId: rest[0] };
  if (rest.length === 2 && rest[0] && EXTENSION_ID.test(rest[0]) && rest[1] === "rollback") return { kind: "rollback", extensionId: rest[0] };
  return null;
}

const ALLOWED: Record<Route["kind"], readonly string[]> = {
  install: ["POST"],
  job: ["GET", "DELETE"],
  uninstall: ["POST"],
  rollback: ["POST"],
  search: ["GET"],
  extension: ["GET"],
  versionStatus: ["GET"]
};

export function createExtensionInstallApiHandler(deps: ExtensionInstallApiDependencies): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const log = deps.logger ?? (() => undefined);
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = match(url.pathname.replace(/\/+$/, ""));
    if (!route) return false;
    const method = req.method ?? "GET";
    if (!ALLOWED[route.kind].includes(method)) {
      sendJson(res, 405, { code: "malformed-request", message: `不支持 ${method}` });
      return true;
    }
    const auth = await authorizeAdmin(req, deps, APPLICATION_EXTENSION_LOAD_ACTION);
    if (!auth.ok) {
      sendJson(res, auth.status, { code: auth.code, message: "需要站点管理员授权" });
      return true;
    }
    const manager = deps.manager();
    if (!manager) {
      sendJson(res, 503, { code: "MARKETPLACE_UNAVAILABLE", message: "本机未启用扩展安装" });
      return true;
    }
    try {
      switch (route.kind) {
        case "install": {
          const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
          if (type === "application/json") {
            const body = await readJson(req);
            const sourceId = body?.sourceId;
            const extensionId = body?.extensionId;
            const range = body?.range ?? "*";
            if (typeof sourceId !== "string" || typeof extensionId !== "string" || !EXTENSION_ID.test(extensionId) || typeof range !== "string") {
              sendJson(res, 400, { code: "malformed-request", message: "请求体必须是 { sourceId, extensionId, range? }" });
              return true;
            }
            const job = manager.installFromSource({ sourceId, extensionId, range, actor: auth.actor });
            log({ event: "extension-install-requested", jobId: job.jobId, sourceId, extensionId, actor: auth.actor });
            sendJson(res, 202, { jobId: job.jobId, job });
            return true;
          }
          if (!PACKAGE_CONTENT_TYPES.has(type)) {
            sendJson(res, 415, { code: "malformed-request", message: "上传 .wxt 请使用 application/octet-stream；来源安装请使用 application/json" });
            return true;
          }
          const job = await manager.installFromFile({ body: req, actor: auth.actor });
          log({ event: "extension-install-requested", jobId: job.jobId, sourceId: job.sourceId, actor: auth.actor });
          sendJson(res, job.status === "failed" ? 422 : 202, { jobId: job.jobId, job });
          return true;
        }
        case "job": {
          if (method === "DELETE") {
            const view = manager.cancel(route.jobId);
            if (!view) sendJson(res, 404, { code: "not-found", message: "任务不存在" });
            else sendJson(res, 200, view);
            return true;
          }
          const view = manager.job(route.jobId);
          if (!view) sendJson(res, 404, { code: "not-found", message: "任务不存在" });
          else sendJson(res, 200, view);
          return true;
        }
        case "uninstall": {
          const body = await readJson(req, true);
          const purgeData = body?.purgeData === true;
          const job = manager.uninstall(route.extensionId, { purgeData, actor: auth.actor });
          sendJson(res, job.status === "failed" ? 409 : 202, { jobId: job.jobId, job });
          return true;
        }
        case "rollback": {
          const body = await readJson(req, true);
          const toVersion = typeof body?.toVersion === "string" ? body.toVersion : undefined;
          const job = manager.rollback(route.extensionId, { ...(toVersion ? { toVersion } : {}), actor: auth.actor });
          sendJson(res, job.status === "failed" ? 409 : 202, { jobId: job.jobId, job });
          return true;
        }
        case "search": {
          const limit = Number(url.searchParams.get("limit") ?? "");
          const page = await manager.search({
            ...(url.searchParams.get("q") ? { text: url.searchParams.get("q")! } : {}),
            ...(url.searchParams.get("sourceId") ? { sourceId: url.searchParams.get("sourceId")! } : {}),
            ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
            ...(Number.isInteger(limit) && limit > 0 ? { limit: Math.min(limit, 100) } : {})
          });
          sendJson(res, 200, page);
          return true;
        }
        case "extension": {
          // 市场版本详情（change: 2026-10-21-add-server-extension-marketplace，tasks 7.4）：只读。
          const sourceId = url.searchParams.get("sourceId") ?? "";
          const extensionId = url.searchParams.get("extensionId") ?? "";
          if (!sourceId || !EXTENSION_ID.test(extensionId)) {
            sendJson(res, 400, { code: "malformed-request", message: "需要 sourceId 与合法的 extensionId" });
            return true;
          }
          const detail = deps.marketplaceDetail?.();
          if (!detail) {
            sendJson(res, 503, { code: "MARKETPLACE_UNAVAILABLE", message: "本机未提供市场版本详情" });
            return true;
          }
          const view = await detail({ sourceId, extensionId }, AbortSignal.timeout(15_000));
          sendJson(res, 200, view);
          return true;
        }
        case "versionStatus": {
          // 受管扩展当前版本在来源侧的状态（已撤回提示）：只读、按需，失败也回 200 + unknown。
          const status = deps.versionStatus?.();
          if (!status) {
            sendJson(res, 503, { code: "MARKETPLACE_UNAVAILABLE", message: "本机未提供版本状态查询" });
            return true;
          }
          const record = manager.installed().find((entry) => entry.extensionId === route.extensionId);
          if (!record) {
            sendJson(res, 404, { code: "MARKETPLACE_NOT_INSTALLED", message: `扩展 ${route.extensionId} 不是受管扩展` });
            return true;
          }
          sendJson(res, 200, await status({ sourceId: record.sourceId, extensionId: record.extensionId, version: record.version }));
          return true;
        }
      }
    } catch (error) {
      if (error instanceof ExtensionManagerError) {
        const status = error.code === "MARKETPLACE_SOURCE_NOT_FOUND" ? 404 : error.code === "MARKETPLACE_SOURCE_UNAVAILABLE" ? 503 : 400;
        sendJson(res, status, { code: error.code, message: error.message });
        return true;
      }
      if ((error as { code?: string })?.code === "malformed-request") {
        sendJson(res, 400, { code: "malformed-request", message: (error as Error).message });
        return true;
      }
      log({ event: "extension-install-api-failed", message: error instanceof Error ? error.message : String(error) });
      sendJson(res, 500, { code: "internal", message: "扩展安装接口内部错误" });
      return true;
    }
    return false;
  };
}

async function readJson(req: IncomingMessage, optional = false): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BYTES) throw Object.assign(new Error("请求体过大"), { code: "malformed-request" });
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) {
    if (optional) return null;
    throw Object.assign(new Error("缺少请求体"), { code: "malformed-request" });
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON 对象"), { code: "malformed-request" });
  }
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify(status >= 400 ? { ...body, protocolVersion: WOOHAA3_PROTOCOL_VERSION } : body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}