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
  decodeWorldCaptureDynamicVersionKey,
  decodeWorldCaptureResourceReadyNotice,
  decodeWorldCaptureVersionKey,
  type WorldCaptureFreezeOutcome,
  type WorldCaptureGenerationBinding
} from "@woohaa3/contracts";
import { readJsonBody, sendError, sendJson } from "./http-codec.js";
import type { CanvasLogger, CanvasRequestHandlerOptions } from "./types.js";
import { DEFAULT_CANVAS_MAX_BODY_BYTES } from "./types.js";

/** 页面渲染取景的 PNG base64 上限（2048² 复杂画面约 8 MiB，base64 约 11 MiB）。 */
const PAGE_CAPTURE_MAX_BODY_BYTES = 32 * 1024 * 1024;
/** 页面录制的 MP4 base64 上限（60s / 4Mbps 约 30MB 原始，base64 约 40MB）。 */
const PAGE_VIDEO_MAX_BODY_BYTES = 96 * 1024 * 1024;

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

/**
 * 页面渲染路径的预备：返回当前 canonical 取景的输出尺寸与版本键，页面据此渲染。
 * 只读；不启动原生 producer。
 */
export async function handleCapturePagePrepare(
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
  const outcome = await options.worldCapture.preparePageCapture({ canvasId, cameraId });
  const status = outcome.ok ? 200
    : outcome.code === "camera-not-found" || outcome.code === "canvas-not-found" ? 404
      : outcome.code === "capture-unavailable" ? 503
        : 400;
  log?.({ event: "canvas-capture-page-prepare", status, code: outcome.ok ? "ready" : outcome.code });
  sendJson(res, status, outcome);
  return true;
}

/**
 * 页面渲染路径的提交：校验页面渲染版本仍是当前 canonical 取景，经可信 Media 端口保存后
 * 冻结并申领 binding。
 */
export async function handleCapturePageCommit(
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
  const body = await readJsonBody(req, PAGE_CAPTURE_MAX_BODY_BYTES);
  if ("canvasId" in body) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", "请求包含非法字段");
    return true;
  }
  const cameraId = readCameraId(body);
  const key = decodeWorldCaptureVersionKey(body.key);
  const pngBase64 = typeof body.pngBase64 === "string" ? body.pngBase64 : "";
  const width = typeof body.width === "number" && Number.isInteger(body.width) && body.width > 0 ? body.width : 0;
  const height = typeof body.height === "number" && Number.isInteger(body.height) && body.height > 0 ? body.height : 0;
  if (!cameraId || !key.ok || pngBase64 === "" || width === 0 || height === 0) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", "页面取景提交字段不合法");
    return true;
  }
  const png = Buffer.from(pngBase64, "base64");
  if (png.byteLength === 0) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", "页面取景图片为空");
    return true;
  }
  const outcome: WorldCaptureFreezeOutcome = await options.worldCapture.commitPageCapture({
    canvasId,
    cameraId,
    key: key.value,
    png,
    width,
    height
  });
  const code = outcome.ok ? "ready" : outcome.code;
  const status = outcome.ok ? 200
    : outcome.code === "camera-not-found" || outcome.code === "canvas-not-found" ? 404
      : outcome.code === "superseded" ? 409
        : outcome.code === "capture-unavailable" || outcome.code === "capture-not-ready" ? 503
          : 400;
  log?.({ event: "canvas-capture-page-commit", status, code });
  sendJson(res, status, outcome);
  return true;
}

/**
 * 页面驱动渲染的待取景清单：宿主观察到镜头/世界版本变化的项，供前端主动渲染并提交。
 */
export async function handleCapturePagePending(
  _req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  if (!options.worldCapture) {
    sendError(res, 503, "NOT_READY", "取景服务未装配");
    return true;
  }
  const pending = options.worldCapture.pendingPageCaptures(canvasId);
  log?.({ event: "canvas-capture-page-pending", status: 200 });
  sendJson(res, 200, { ok: true, captures: pending });
  return true;
}

/**
 * 动态镜头的页面视频提交：页面已逐帧渲染并由 WebCodecs 编码成 MP4；宿主重新核对
 * 当前动态键、经可信视频端口保存后冻结并申领 binding。
 */
export async function handleCapturePageCommitVideo(
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
  const body = await readJsonBody(req, PAGE_VIDEO_MAX_BODY_BYTES);
  if ("canvasId" in body) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", "请求包含非法字段");
    return true;
  }
  const cameraId = readCameraId(body);
  const key = decodeWorldCaptureDynamicVersionKey(body.key);
  const mp4Base64 = typeof body.mp4Base64 === "string" ? body.mp4Base64 : "";
  const width = typeof body.width === "number" && Number.isInteger(body.width) && body.width > 0 ? body.width : 0;
  const height = typeof body.height === "number" && Number.isInteger(body.height) && body.height > 0 ? body.height : 0;
  if (!cameraId || !key.ok || mp4Base64 === "" || width === 0 || height === 0) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", "页面视频取景提交字段不合法");
    return true;
  }
  const mp4 = Buffer.from(mp4Base64, "base64");
  if (mp4.byteLength === 0) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", "页面视频取景为空");
    return true;
  }
  const outcome = await options.worldCapture.commitPageVideoCapture({
    canvasId,
    cameraId,
    key: key.value,
    video: {
      bytes: new Uint8Array(mp4),
      contentType: "video/mp4",
      width,
      height,
      durationSeconds: key.value.timeRange.endSeconds - key.value.timeRange.startSeconds,
      fps: key.value.fps
    }
  });
  const status = outcome.ok ? 200
    : outcome.code === "camera-not-found" || outcome.code === "canvas-not-found" ? 404
      : outcome.code === "superseded" ? 409
        : outcome.code === "capture-unavailable" || outcome.code === "capture-not-ready" ? 503
          : 400;
  log?.({ event: "canvas-capture-page-commit-video", status, code: outcome.ok ? "ready" : outcome.code });
  sendJson(res, status, outcome);
  return true;
}

/**
 * 卡片状态：返回当前画布已观察镜头的取景状态（静态图片或动态视频）。
 * 只读；不触发取景。
 */
export async function handleCaptureStatuses(
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
  log?.({ event: "canvas-capture-statuses", status: 200 });
  sendJson(res, 200, { ok: true, statuses: options.worldCapture.statuses(canvasId) });
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
