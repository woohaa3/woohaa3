/**
 * 原生录制的 HTTP 路由
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 7.1）。
 *
 * ```
 * POST /api/canvases/:canvasId/recording            提交（幂等 requestId）
 * GET  /api/canvases/:canvasId/recording            当前跟踪的任务（重连查询）
 * GET  /api/canvases/:canvasId/recording/:jobId     单个任务状态
 * POST /api/canvases/:canvasId/recording/:jobId/cancel
 * ```
 *
 * 与既有 film-set 路由同一授权口径：写操作要 write，查询要 read。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CanvasLogger, CanvasRequestHandlerOptions } from "./types.js";
import { readJsonBody, sendError, sendJson } from "./http-codec.js";
import { decodeRecordingSubmitRequest } from "./recording-port.js";

/** 录制请求体上限：只有稳定身份与少量元数据，远小于命令批次。 */
const MAX_RECORDING_BODY_BYTES = 64 * 1024;

export async function handleRecordingSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  options: CanvasRequestHandlerOptions,
  log?: CanvasLogger
): Promise<boolean> {
  const recording = options.recording;
  const write = (event: string, status: number) => log?.({ event, status });
  if (!recording) {
    sendError(res, 503, "recording-unavailable", "当前构建未启用原生录制能力");
    return true;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req, MAX_RECORDING_BODY_BYTES);
  } catch {
    sendError(res, 400, "malformed-request", "录制请求体非法");
    return true;
  }
  const request = decodeRecordingSubmitRequest(body);
  if (!request) {
    sendError(res, 400, "malformed-request", "录制请求需要 requestId / purpose / nodeId / clipId");
    return true;
  }
  try {
    const result = await recording.submit({ canvasId, body: request });
    if (!result.ok) {
      // 能力不足与输入非法分开：前者可重试（等执行器），后者要用户改输入。
      const retryable = /unavailable|not-ready|busy|executor/.test(result.code);
      sendJson(res, retryable ? 503 : 409, { ok: false, code: result.code, message: result.message });
      return true;
    }
    sendJson(res, 202, { ok: true, jobId: result.jobId, state: result.state, duplicate: result.duplicate });
    return true;
  } catch (error) {
    write("recording-submit-failed", 500);
    void error;
    sendError(res, 500, "recording-submit-failed", "录制任务提交失败");
    return true;
  }
}

export async function handleRecordingStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  jobId: string,
  options: CanvasRequestHandlerOptions,
  log?: CanvasLogger
): Promise<boolean> {
  const recording = options.recording;
  const write = (event: string, status: number) => log?.({ event, status });
  if (!recording) {
    sendError(res, 503, "recording-unavailable", "当前构建未启用原生录制能力");
    return true;
  }
  try {
    const result = await recording.status({ canvasId, jobId });
    if (!result.ok) {
      sendJson(res, result.code === "recording-unknown-job" ? 404 : 409, {
        ok: false,
        code: result.code,
        message: result.message
      });
      return true;
    }
    sendJson(res, 200, { ok: true, status: result.status });
    return true;
  } catch (error) {
    write("recording-status-failed", 500);
    void error;
    sendError(res, 500, "recording-status-failed", "录制状态查询失败");
    return true;
  }
}

export async function handleRecordingList(
  _req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  options: CanvasRequestHandlerOptions,
  log?: CanvasLogger
): Promise<boolean> {
  const recording = options.recording;
  const write = (event: string, status: number) => log?.({ event, status });
  if (!recording) {
    sendError(res, 503, "recording-unavailable", "当前构建未启用原生录制能力");
    return true;
  }
  try {
    sendJson(res, 200, { ok: true, jobs: await recording.list({ canvasId }) });
    return true;
  } catch (error) {
    write("recording-list-failed", 500);
    void error;
    sendError(res, 500, "recording-list-failed", "录制任务列表查询失败");
    return true;
  }
}

export async function handleRecordingCancel(
  _req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  jobId: string,
  options: CanvasRequestHandlerOptions,
  log?: CanvasLogger
): Promise<boolean> {
  const recording = options.recording;
  const write = (event: string, status: number) => log?.({ event, status });
  if (!recording) {
    sendError(res, 503, "recording-unavailable", "当前构建未启用原生录制能力");
    return true;
  }
  try {
    const result = await recording.cancel({ canvasId, jobId });
    if (!result.ok) {
      // `too-late` 是明确的业务结论，不是错误码层面的失败。
      const status = result.code === "recording-unknown-job" ? 404 : result.code === "recording-too-late" ? 409 : 409;
      sendJson(res, status, { ok: false, code: result.code, message: result.message });
      return true;
    }
    sendJson(res, 200, { ok: true, cancelled: true });
    return true;
  } catch (error) {
    write("recording-cancel-failed", 500);
    void error;
    sendError(res, 500, "recording-cancel-failed", "录制取消失败");
    return true;
  }
}
