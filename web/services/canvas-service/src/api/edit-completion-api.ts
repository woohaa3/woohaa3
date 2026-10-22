/**
 * 编辑完成 HTTP API
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 1.4/2.5 / design D6）。
 *
 * 画布授权的版本化编辑面：
 * ```
 * POST /api/canvas-node-history/:canvasId/:nodeId/edit-begin     捕获会话基线（不推进 revision）
 * POST /api/canvas-node-history/:canvasId/:nodeId/edit-complete  提交图片/模型最终编辑版本
 * GET  /api/canvas-node-history/:canvasId/:nodeId/edit-status    受保护回执查询（?requestId=）
 * POST /api/canvas-node-history/:canvasId/:nodeId/edit-abandon   放弃尚未提交内容的 prepared 草稿
 * ```
 *
 * 授权与归属校验在读取/写入之前完成；越权访问返回稳定 not-found，不泄露目标或快照。
 * actor 由已有认证确认，绝不来自请求字段。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decodeEditSessionBeginRequest,
  decodeImageProjectReferencesRequest,
  decodeEditSessionCompleteRequest,
  decodeEditSessionStatusRequest,
  isEditSessionErrorCode,
  type EditSessionErrorCode
} from "@woohaa3/contracts";
import type { EditCompletionService } from "../storage/core/edit-completion-service.js";
import type { ProjectReferencesFailure } from "../storage/core/edit-completion-service/references.js";

export type EditCompletionRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type EditCompletionRequestHandlerOptions = {
  service: EditCompletionService;
  serviceToken?: string;
  canvasExists?: (canvasId: string, req?: IncomingMessage) => Promise<boolean>;
  logger?: (event: { event: string; status: number; code?: string }) => void;
};

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * 引用核验失败 → 稳定错误码与可读原因。粘贴是用户直接操作，这些文案会原样显示在对话框里，
 * 所以必须指出是哪一步没通过（来源不可读 / 工程不一致 / 素材缺失 / 媒体对象缺失）。
 */
const PROJECT_REFERENCE_FAILURES: Readonly<Record<ProjectReferencesFailure, readonly [EditSessionErrorCode, string]>> = {
  "source-unavailable": ["EDIT_SESSION_NOT_FOUND", "来源画布不可读取，复制已取消"],
  "project-mismatch": ["EDIT_SESSION_INVALID", "工程记录与来源画布不一致，复制已取消"],
  "asset-missing": ["EDIT_SESSION_INVALID", "来源素材不在来源画布中，复制已取消"],
  "media-unavailable": ["EDIT_SESSION_MEDIA_UNRESOLVABLE", "工程或来源素材的媒体对象已不可用，复制已取消"]
};

export function createEditCompletionRequestHandler(options: EditCompletionRequestHandlerOptions): EditCompletionRequestHandler {
  const log = options.logger ?? (() => undefined);
  return async (req, res) => {
    const url = safeUrl(req.url);
    if (!url) return false;
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    // 期望前缀 api/canvas-node-history/<canvasId>/<nodeId>/<action>
    if (segments.length < 5 || segments[0] !== "api" || segments[1] !== "canvas-node-history") return false;
    const [, , canvasId, nodeId, action] = segments;
    if (!["edit-begin", "edit-complete", "edit-status", "edit-abandon", "image-project-references"].includes(action)) return false;
    if (!canvasId || !nodeId) return true;

    if (!authorize(req, options.serviceToken)) {
      log({ event: "edit-completion-unauthorized", status: 401 });
      sendError(res, 401, "EDIT_SESSION_UNAUTHORIZED", "需要受信任身份或本机访问");
      return true;
    }
    if (options.canvasExists && !(await options.canvasExists(canvasId, req))) {
      sendError(res, 404, "EDIT_SESSION_NOT_FOUND", "目标不存在");
      return true;
    }

    try {
      if (action === "image-project-references") {
        if (req.method !== "POST") return methodNotAllowed(res);
        const request = decodeImageProjectReferencesRequest(await readJson(req));
        if (!request || request.canvasId !== canvasId) return sendCode(res, "EDIT_SESSION_INVALID", "图片引用请求不合法");
        if (options.canvasExists && !await options.canvasExists(request.sourceCanvasId, req)) return sendCode(res, "EDIT_SESSION_NOT_FOUND", "来源画布不可读取");
        const result = await options.service.verifyProjectReferences(request);
        if (!result.ok) {
          const [code, message] = PROJECT_REFERENCE_FAILURES[result.reason];
          return sendCode(res, code, message);
        }
        sendJson(res, 200, { ok: true, assets: result.assets });
        return true;
      }
      if (action === "edit-begin") {
        if (req.method !== "POST") return methodNotAllowed(res);
        const body = await readJson(req);
        const decoded = decodeEditSessionBeginRequest(body);
        if (!decoded.ok) return sendCode(res, decoded.code, decoded.message);
        if (decoded.value.canvasId !== canvasId || decoded.value.nodeId !== nodeId) return sendCode(res, "EDIT_SESSION_INVALID", "请求与路由目标不一致");
        const result = await options.service.begin(decoded.value);
        if (!result.ok) return sendCode(res, result.code, result.message);
        sendJson(res, 200, { ok: true, sessionId: result.sessionId, baselineContentIdentity: result.baselineContentIdentity, revision: result.revision });
        return true;
      }
      if (action === "edit-complete") {
        if (req.method !== "POST") return methodNotAllowed(res);
        const body = await readJson(req);
        const decoded = decodeEditSessionCompleteRequest(body);
        if (!decoded.ok) return sendCode(res, decoded.code, decoded.message);
        if (decoded.value.canvasId !== canvasId || decoded.value.nodeId !== nodeId) return sendCode(res, "EDIT_SESSION_INVALID", "请求与路由目标不一致");
        const result = await options.service.complete(decoded.value);
        if (!result.ok) {
          sendJson(res, statusForCode(result.code), { ok: false, code: result.code, message: result.message, receipt: result.receipt });
          return true;
        }
        sendJson(res, 200, { ok: true, receipt: result.receipt });
        return true;
      }
      if (action === "edit-status") {
        if (req.method !== "GET") return methodNotAllowed(res);
        const requestId = url.searchParams.get("requestId") ?? "";
        const decoded = decodeEditSessionStatusRequest({ canvasId, nodeId, requestId });
        if (!decoded.ok) return sendCode(res, decoded.code, decoded.message);
        const result = await options.service.status(decoded.value);
        if (!result.ok) return sendCode(res, result.code, result.message);
        sendJson(res, 200, { ok: true, receipt: result.receipt });
        return true;
      }
      // edit-abandon
      if (req.method !== "POST") return methodNotAllowed(res);
      const body = await readJson(req);
      const requestId = typeof body === "object" && body !== null && typeof (body as { requestId?: unknown }).requestId === "string"
        ? (body as { requestId: string }).requestId
        : "";
      const decoded = decodeEditSessionStatusRequest({ canvasId, nodeId, requestId });
      if (!decoded.ok) return sendCode(res, decoded.code, decoded.message);
      const result = await options.service.abandon(decoded.value);
      if (!result.ok) return sendCode(res, result.code, result.message);
      sendJson(res, 200, { ok: true, status: result.status });
      return true;
    } catch (error) {
      log({ event: "edit-completion-error", status: 500 });
      sendError(res, 500, "EDIT_SESSION_INVALID", error instanceof Error ? error.message.slice(0, 200) : "服务内部错误");
      return true;
    }
  };
}

function methodNotAllowed(res: ServerResponse): true {
  sendError(res, 405, "EDIT_SESSION_INVALID", "方法不允许");
  return true;
}

function sendCode(res: ServerResponse, code: EditSessionErrorCode, message: string): true {
  sendError(res, statusForCode(code), code, message);
  return true;
}

function statusForCode(code: EditSessionErrorCode): number {
  switch (code) {
    case "EDIT_SESSION_NOT_FOUND":
    case "EDIT_SESSION_UNAUTHORIZED":
      return 404;
    case "EDIT_SESSION_CONFLICT":
    case "EDIT_SESSION_REQUEST_CONFLICT":
    case "EDIT_SESSION_BASELINE_STALE":
    case "EDIT_SESSION_GENERATION_ACTIVE":
    case "EDIT_SESSION_UNRECOVERABLE":
      return 409;
    case "EDIT_SESSION_CAPABILITY_UNAVAILABLE":
      return 503;
    default:
      return 400;
  }
}

function safeUrl(raw: string | undefined): URL | null {
  try {
    return new URL(raw ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

function authorize(req: IncomingMessage, serviceToken: string | undefined): boolean {
  if (serviceToken) {
    const header = req.headers["x-woohaa3-service-token"];
    const value = Array.isArray(header) ? header[0] : header;
    return value === serviceToken;
  }
  return isLoopbackRequest(req);
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress ?? "";
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("::ffff:127.")) return true;
  return false;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("请求体过大");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, code, message });
}

export { isEditSessionErrorCode };
