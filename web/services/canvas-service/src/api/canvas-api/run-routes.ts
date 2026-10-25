/**
 * Canvas API：run/cancel 与片场导入路由
 * （自 `canvas-api.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R23）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  resolveRequestDataContext,
  decodeCanvasCancelRequest,
  decodeCanvasRunRequest,
  decodeFilmSetConversionRequest,
  decodeMcpImportFilmSetContentRequest
} from "@woohaa3/contracts";
import { DEFAULT_CANVAS_MAX_BODY_BYTES, type CanvasLogger, type CanvasRequestHandlerOptions } from "./types.js";
import { readJsonBody, sendError, sendJson } from "./http-codec.js";
import { authorizeCanvasRequest, httpStatusForCanvasAccess } from "../../access/resolve-access.js";

/**
 * run/cancel/film-set 前的 write 资源授权（仅注入 authenticate 时）。
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
  const owner = resolveRequestDataContext(options.accessRuntime ?? { enabled: true }, access.principal ?? null).dataScope.ownerId;
  const outcome = await options.runService.run(decoded.value, { owner });
  if (!outcome.ok) {
    // task-submit-failed 是上游（Task/Provider 物化）在调用前就失败：2xx 会骗调用方「已受理」。
    const status =
      outcome.code === "canvas-not-found"
        ? 404
        : outcome.code === "catalog-unavailable" || outcome.code === "task-submit-failed"
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

/**
 * POST /api/canvases/:canvasId/film-set/import
 * （change: 2026-10-08-make-film-set-model-only，任务 2.3）。
 */
export async function handleFilmSetImport(
  req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  if (!options.filmSetImport) {
    sendError(res, 503, "NOT_READY", "片场导入未启用");
    return true;
  }
  if (!(await requireWriteAccess({ req, res, canvasId, options, log })).ok) return true;
  const body = await readJsonBody(req, options.maxBodyBytes ?? DEFAULT_CANVAS_MAX_BODY_BYTES);
  const decoded = decodeMcpImportFilmSetContentRequest({ ...body, canvasId });
  if (!decoded.ok) {
    sendError(res, 400, decoded.code, decoded.message);
    return true;
  }
  const outcome = await options.filmSetImport.import({
    canvasId,
    nodeId: decoded.value.nodeId,
    requestId: decoded.value.requestId,
    items: decoded.value.items
  });
  if (!outcome.ok) {
    const status = outcome.code === "canvas-not-found" || outcome.code === "unknown-node" ? 404 : 409;
    log?.({ event: "film-set-import", status, code: outcome.code });
    sendError(res, status, "COMMAND_REJECTED", outcome.message);
    return true;
  }
  log?.({ event: "film-set-import", status: 200 });
  sendJson(res, 200, {
    ok: true,
    nodeId: outcome.nodeId,
    commandId: outcome.commandId,
    duplicate: outcome.duplicate,
    noop: outcome.noop,
    itemCount: outcome.itemCount
  });
  return true;
}

/** 转换错误码 → HTTP 状态：来源/画布缺失 404，输入冲突 409，其余 400/422。 */
function conversionErrorStatus(code: string): number {
  if (code === "canvas-not-found" || code === "source-not-found") return 404;
  if (code === "request-id-reused" || code === "stale-source") return 409;
  return 400;
}

/**
 * POST /api/canvases/:canvasId/film-set/conversion
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.1/1.2）。
 */
export async function handleFilmSetConversionSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  if (!options.filmSetConversion) {
    sendError(res, 503, "NOT_READY", "片场转换未启用");
    return true;
  }
  const body = await readJsonBody(req, options.maxBodyBytes ?? DEFAULT_CANVAS_MAX_BODY_BYTES);
  const decoded = decodeFilmSetConversionRequest({ ...body, canvasId });
  if (!decoded.ok) {
    sendError(res, 400, decoded.code, decoded.message);
    return true;
  }
  // 可信主体由宿主认证适配器解析（非请求体）；供生成 adapter 解析个人授权/owner。
  const subject = (await options.importGuard?.subject(req)) ?? undefined;
  // owner 由提供方在边界解析（生产 principal、本地开发受控会话）；把结果冻结进记录，
  // 使重试/恢复复用同一 owner。新建本地会话时下发 Set-Cookie（与 /api/chatgpt/* 同源）。
  // 仅 LLM 来源（图片/视频）需要个人授权 owner；3D 直接复制不解析、不下发 cookie。
  const needsOwner = decoded.value.sourceKind === "image" || decoded.value.sourceKind === "video";
  const owner = needsOwner
    ? options.filmSetConversionOwnerResolver?.({
        ...(subject ? { subject } : {}),
        ...(typeof req.headers.cookie === "string" ? { cookie: req.headers.cookie } : {})
      }) ?? null
    : null;
  if (owner?.setCookie) res.setHeader("Set-Cookie", owner.setCookie);
  const outcome = await options.filmSetConversion.submit({
    ...decoded.value,
    ...(subject ? { subject } : {}),
    ...(owner?.ownerId ? { ownerId: owner.ownerId } : {})
  });
  if (!outcome.ok) {
    const status = conversionErrorStatus(outcome.code);
    log?.({ event: "film-set-conversion-submit", status, code: outcome.code });
    sendError(res, status, outcome.code, outcome.message);
    return true;
  }
  log?.({ event: "film-set-conversion-submit", status: 202 });
  sendJson(res, 202, { ok: true, receipt: outcome.receipt, status: outcome.status });
  return true;
}

/**
 * GET /api/canvases/:canvasId/film-set/conversion/:requestId
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.2）。
 */
export async function handleFilmSetConversionStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  requestId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  if (!options.filmSetConversion) {
    sendError(res, 503, "NOT_READY", "片场转换未启用");
    return true;
  }
  const outcome = await options.filmSetConversion.status({ canvasId, requestId });
  if (!outcome.ok) {
    log?.({ event: "film-set-conversion-status", status: 400, code: outcome.code });
    sendError(res, 400, outcome.code, outcome.message);
    return true;
  }
  log?.({ event: "film-set-conversion-status", status: 200 });
  sendJson(res, 200, { ok: true, status: outcome.status });
  return true;
}

/**
 * GET /api/canvases/:canvasId/film-set/conversion-models
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.6/3.7）。
 *
 * 返回当前可用转换模型候选（提供方集合的只读投影）：前端据此展示真实模型名、可用性，
 * 并在无候选时显示「连接 ChatGPT / 配置语言模型」入口。只读画布授权；不写任何状态。
 */
export async function handleFilmSetConversionModels(
  _req: IncomingMessage,
  res: ServerResponse,
  _canvasId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  if (!options.filmSetConversion) {
    sendError(res, 503, "NOT_READY", "片场转换未启用");
    return true;
  }
  const models = options.filmSetConversion.models?.() ?? [];
  log?.({ event: "film-set-conversion-models", status: 200 });
  sendJson(res, 200, { ok: true, models });
  return true;
}

/**
 * POST /api/canvases/:canvasId/film-set/conversion/:requestId/retry
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 2.5 / design D5）。
 */
export async function handleFilmSetConversionRetry(
  _req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  requestId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  if (!options.filmSetConversion) {
    sendError(res, 503, "NOT_READY", "片场转换未启用");
    return true;
  }
  const retry = options.filmSetConversion.retry?.bind(options.filmSetConversion);
  if (!retry) {
    sendError(res, 503, "NOT_READY", "该部署不支持转换重试");
    return true;
  }
  const outcome = await retry({ canvasId, requestId });
  if (!outcome.ok) {
    const status = conversionErrorStatus(outcome.code);
    log?.({ event: "film-set-conversion-retry", status, code: outcome.code });
    sendError(res, status, outcome.code, outcome.message);
    return true;
  }
  log?.({ event: "film-set-conversion-retry", status: 202 });
  sendJson(res, 202, { ok: true, receipt: outcome.receipt, status: outcome.status });
  return true;
}

/**
 * POST /api/canvases/:canvasId/film-set/conversion/:requestId/cancel
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.2）。
 */
export async function handleFilmSetConversionCancel(
  _req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  requestId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  if (!options.filmSetConversion) {
    sendError(res, 503, "NOT_READY", "片场转换未启用");
    return true;
  }
  const outcome = await options.filmSetConversion.cancel({ canvasId, requestId });
  if (!outcome.ok) {
    const status = outcome.code === "unknown-result" ? 404 : 400;
    log?.({ event: "film-set-conversion-cancel", status, code: outcome.code });
    sendError(res, status, outcome.code, outcome.message);
    return true;
  }
  log?.({ event: "film-set-conversion-cancel", status: 200 });
  sendJson(res, 200, { ok: true, status: outcome.status });
  return true;
}
