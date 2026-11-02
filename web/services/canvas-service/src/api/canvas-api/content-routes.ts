/**
 * `/api/canvases/:canvasId/content/:extensionId/...`
 *
 * 宿主只做授权和请求体上限。路径、状态和超时由已注册的内容路由决定。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchContentRoute } from "@woohaa3/contracts";
import { DEFAULT_CANVAS_MAX_BODY_BYTES, type CanvasLogger, type CanvasRequestHandlerOptions } from "./types.js";
import { readJsonBody, sendJson } from "./http-codec.js";

export async function handleContentRoute(
  req: IncomingMessage,
  res: ServerResponse,
  extensionId: string,
  path: readonly string[],
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  const content = options.content;
  if (!content) {
    sendJson(res, 404, { code: "content-route-not-found" });
    return true;
  }
  const body = req.method === "GET" || req.method === "HEAD"
    ? {}
    : await readJsonBody(req, options.maxBodyBytes ?? DEFAULT_CANVAS_MAX_BODY_BYTES);
  const result = await dispatchContentRoute(content, {
    method: req.method ?? "GET",
    extensionId,
    path,
    body,
    authorized: true
  });
  log?.({ event: "content-route", status: result.status });
  sendJson(res, result.status, result.body ?? { ok: result.status < 400 });
  return true;
}
