/**
 * Canvas API：run/cancel 路由
 * （自 `canvas-api.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R23）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  resolveRequestDataContext,
  decodeCanvasCancelRequest,
  decodeCanvasRunRequest
} from "@woohaa3/contracts";
import { DEFAULT_CANVAS_MAX_BODY_BYTES, type CanvasLogger, type CanvasRequestHandlerOptions } from "./types.js";
import { readJsonBody, sendError, sendJson } from "./http-codec.js";
import { authorizeCanvasRequest, httpStatusForCanvasAccess } from "../../access/resolve-access.js";

/**
 * 本次运行的 owner（个人来源/凭据寻址用）。
 *
 * 只在身份运行时**启用**时才推导：`accessRuntime.enabled === false`（本机单实例）与
 * `undefined`（独立单元/本机部署，走「服务令牌 / loopback」历史边界）都没有可信 principal，
 * 此时 `runService` 按无 owner 处理。旧写法缺省成 `{ enabled: true }`，会和
 * `requireWriteAccess` 的默认放行打架 —— 授权通过、随后在这里抛 `unauthenticated`，
 * 表现成本机部署下所有 run 都回 500。
 */
function runOwner(
  options: CanvasRequestHandlerOptions,
  principal: import("@woohaa3/contracts").PrincipalContext | undefined
): string | undefined {
  if (options.accessRuntime?.enabled !== true) return undefined;
  return resolveRequestDataContext(options.accessRuntime, principal ?? null).dataScope.ownerId;
}

/**
 * run/cancel 前的 write 资源授权（仅注入 authenticate 时）。
 *
 * 返回可信 principal 供 actor 注入；未注入认证时返回 `{ ok: true }`（历史行为）。
 */
async function requireWriteAccess(input: {
  req: IncomingMessage;
  res: ServerResponse;
  canvasId: string;
  options: CanvasRequestHandlerOptions;
  log: CanvasLogger;
}): Promise<{ ok: true; principal?: import("@woohaa3/contracts").PrincipalContext } | { ok: false }> {
  if (!input.options.authenticate) return { ok: true };
  const decision = await authorizeCanvasRequest({
    req: input.req,
    canvasId: input.canvasId,
    permission: "write",
    authenticate: input.options.authenticate,
    access: input.options.access ?? { authorize: async () => ({ allowed: false, code: "provider-unavailable", message: "画布授权提供者不可用" }) }
  });
  if (decision.ok) return { ok: true, principal: decision.principal };
  const mapped = httpStatusForCanvasAccess(decision.decision);
  input.log?.({ event: "canvas-run-denied", status: mapped.status, code: mapped.code });
  sendError(input.res, mapped.status, mapped.code, decision.decision.message);
  return { ok: false };
}

export async function handleRun(
  req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  if (!options.runService) {
    sendError(res, 503, "NOT_READY", "任务运行未启用");
    return true;
  }
  const access = await requireWriteAccess({ req, res, canvasId, options, log });
  if (!access.ok) return true;
  const body = await readJsonBody(req, options.maxBodyBytes ?? DEFAULT_CANVAS_MAX_BODY_BYTES);
  const decoded = decodeCanvasRunRequest({ ...body, canvasId });
  if (!decoded.ok) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", decoded.message);
    return true;
  }
  const owner = runOwner(options, access.principal);
  const outcome = await options.runService.run(decoded.value, owner ? { owner } : undefined);
  if (!outcome.ok) {
    // task-submit-failed 是上游（Task/Provider 物化）在调用前就失败：2xx 会骗调用方「已受理」。
    const status =
      outcome.code === "canvas-not-found"
        ? 404
        : outcome.code === "catalog-unavailable" || outcome.code === "task-submit-failed" || outcome.code === "capture-unavailable"
          ? 502
          : 400;
    log?.({ event: "canvas-run", status, code: outcome.code });
    sendError(res, status, outcome.code === "canvas-not-found" ? "CANVAS_NOT_FOUND" : "COMMAND_REJECTED", outcome.message);
    return true;
  }
  log?.({ event: "canvas-run", status: 202 });
  sendJson(res, 202, { ok: true, runId: outcome.runId, jobId: outcome.jobId, state: "accepted" });
  return true;
}

export async function handleCancel(
  req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  if (!options.runService) {
    sendError(res, 503, "NOT_READY", "任务运行未启用");
    return true;
  }
  if (!(await requireWriteAccess({ req, res, canvasId, options, log })).ok) return true;
  const body = await readJsonBody(req, options.maxBodyBytes ?? DEFAULT_CANVAS_MAX_BODY_BYTES);
  const decoded = decodeCanvasCancelRequest({ ...body, canvasId });
  if (!decoded.ok) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", decoded.message);
    return true;
  }
  const outcome = await options.runService.cancel(decoded.value);
  if (!outcome.ok) {
    const status = outcome.code === "canvas-not-found" ? 404 : 409;
    log?.({ event: "canvas-cancel", status, code: outcome.code });
    sendError(res, status, outcome.code === "canvas-not-found" ? "CANVAS_NOT_FOUND" : "COMMAND_REJECTED", outcome.message);
    return true;
  }
  log?.({ event: "canvas-cancel", status: 200 });
  sendJson(res, 200, { ok: true, state: "cancel-requested" });
  return true;
}
