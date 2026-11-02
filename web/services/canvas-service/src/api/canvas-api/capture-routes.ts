/**
 * T10 world-capture routes.
 *
 * These are the same-origin adaptation used by the existing generation entry:
 * `freeze` waits for the exact capture key at click time and returns a stable binding
 * that `/runs` must echo. `refresh` is the explicit authoring-driven refresh hook for
 * renderer integration; `ready` is the late resource notification seam for T09.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decodeWorldCaptureResourceReadyNotice,
  type WorldCaptureFreezeOutcome,
  type WorldCaptureGenerationBinding
} from "@woohaa3/contracts";
import { readJsonBody, sendError, sendJson } from "./http-codec.js";
import type { CanvasLogger, CanvasRequestHandlerOptions } from "./types.js";
import { DEFAULT_CANVAS_MAX_BODY_BYTES } from "./types.js";

function readCameraId(body: Record<string, unknown>): string | null {
  return typeof body.cameraId === "string" && body.cameraId.trim() !== "" ? body.cameraId : null;
}

export async function handleCaptureRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  if (!options.worldCapture) {
    sendError(res, 503, "NOT_READY", "取景服务未装配");
    return true;
  }
  const body = await readJsonBody(req, options.maxBodyBytes ?? DEFAULT_CANVAS_MAX_BODY_BYTES);
  if ("canvasId" in body) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", "请求包含非法字段");
    return true;
  }
  const cameraId = readCameraId(body);
  if (!cameraId) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", "cameraId 必须是非空字符串");
    return true;
  }
  const outcome = await options.worldCapture.refresh({ canvasId, cameraId });
  if (!outcome.ok) {
    const status = outcome.code === "camera-not-found" ? 404
      : outcome.code === "capture-unavailable" || outcome.code === "producer-missing" ? 503
        : 400;
    log?.({ event: "canvas-capture-refresh", status, code: outcome.code });
    sendJson(res, status, outcome);
    return true;
  }
  log?.({ event: "canvas-capture-refresh", status: 200 });
  sendJson(res, 200, outcome);
  return true;
}

export async function handleCaptureFreeze(
  req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  if (!options.worldCapture) {
    sendError(res, 503, "NOT_READY", "取景服务未装配");
    return true;
  }
  const body = await readJsonBody(req, options.maxBodyBytes ?? DEFAULT_CANVAS_MAX_BODY_BYTES);
  if ("canvasId" in body) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", "请求包含非法字段");
    return true;
  }
  const cameraId = readCameraId(body);
  const requestId = typeof body.requestId === "string" && body.requestId.trim() !== ""
    ? body.requestId
    : undefined;
  if (!cameraId) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", "cameraId 必须是非空字符串");
    return true;
  }

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.once("close", onClose);
  if (res.destroyed) controller.abort();
  let outcome: WorldCaptureFreezeOutcome;
  try {
    outcome = await options.worldCapture.freezeForGeneration({
      canvasId,
      cameraId,
      ...(requestId ? { requestId } : {}),
      signal: controller.signal
    });
  } finally {
    res.removeListener("close", onClose);
  }
  if (controller.signal.aborted) return true;
  const status = outcome.ok ? 200
    : outcome.code === "camera-not-found" || outcome.code === "canvas-not-found" ? 404
      : outcome.code === "capture-unavailable" ? 503
        : outcome.code === "timeout" ? 504
          : outcome.code === "invalid-data" ? 400
            : 409;
  log?.({ event: "canvas-capture-freeze", status, code: outcome.ok ? "ready" : outcome.code });
  sendJson(res, status, outcome);
  return true;
}

export async function handleCaptureReady(
  req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  if (!options.worldCapture) {
    sendError(res, 503, "NOT_READY", "取景服务未装配");
    return true;
  }
  const body = await readJsonBody(req, options.maxBodyBytes ?? DEFAULT_CANVAS_MAX_BODY_BYTES);
  if ("canvasId" in body && body.canvasId !== canvasId) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", "canvasId 不一致");
    return true;
  }
  const decoded = decodeWorldCaptureResourceReadyNotice({ ...body, canvasId });
  if (!decoded.ok) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", "资源就绪通知不合法");
    return true;
  }
  options.worldCapture.notifyResourcesReady(decoded.value);
  log?.({ event: "canvas-capture-ready", status: 202 });
  sendJson(res, 202, { ok: true, state: "accepted" });
  return true;
}

/** Public freeze reply shape (used by tests and the browser adapter). */
export type WorldCaptureFreezeReply = {
  ok: true;
  binding: WorldCaptureGenerationBinding;
} | {
  ok: false;
  code: string;
  message: string;
};
