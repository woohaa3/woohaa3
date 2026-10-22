/**
 * Canvas API：HTTP helper 与错误映射
 * （自 `canvas-api.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R23）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { CanvasStorageError, canvasStorageErrorCode, isCanvasStorageError, type CanvasStorageErrorCode } from "../../storage/core/index.js";
import type { CanvasLogger } from "./types.js";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): void {
  sendJson(res, status, { code, message, ...(details ? { details } : {}) });
}

/** 统一错误映射：底层异常 → 安全状态码 + 稳定 code。 */
export function respondError(res: ServerResponse, error: unknown, log: CanvasLogger): void {
  const code = canvasStorageErrorCode(error);
  if (code) {
    const status = statusForCode(code);
    const message = isCanvasStorageError(error) ? error.message : "请求失败";
    const details = isCanvasStorageError(error) ? sanitizeDetails(error.details) : undefined;
    log?.({ event: "canvas-error", status, code });
    sendError(res, status, code, message, details);
    return;
  }
  log?.({ event: "canvas-error", status: 500, code: "REPOSITORY_FAILURE" });
  sendError(res, 500, "REPOSITORY_FAILURE", "服务内部错误");
}

export function statusForCode(code: CanvasStorageErrorCode): number {
  switch (code) {
    case "CANVAS_NOT_FOUND":
      return 404;
    case "CANVAS_ALREADY_EXISTS":
    case "REVISION_CONFLICT":
      return 409;
    case "COMMAND_REJECTED":
    case "INVALID_OPERATION_ID":
    case "INVALID_ACTOR_ID":
    case "INVALID_COMMAND_BATCH":
    case "ASSET_REFERENCE_INVALID":
      return 400;
    case "LIMIT_EXCEEDED":
      return 413;
    case "SCHEMA_VERSION_UNSUPPORTED":
    case "NOT_READY":
      return 503;
    case "REPOSITORY_FAILURE":
      return 500;
    case "SNIPPET_NOT_FOUND":
    case "TAG_NOT_FOUND":
      return 404;
    case "SNIPPET_NAME_CONFLICT":
    case "TAG_NAME_CONFLICT":
    case "SNIPPET_OPERATION_CONFLICT":
    case "SNIPPET_REVISION_CONFLICT":
      return 409;
    case "SNIPPET_READ_ONLY":
      return 403;
    case "SNIPPET_INVALID":
      return 400;
    case "NODE_HISTORY_NOT_FOUND":
      return 404;
    case "NODE_HISTORY_CONFLICT":
      return 409;
    case "NODE_HISTORY_UNRECOVERABLE":
      return 409;
    case "NODE_HISTORY_LIMIT_EXCEEDED":
      return 413;
    case "NODE_HISTORY_INVALID":
      return 400;
    case "SOURCE_CHANGED":
    case "TARGET_CONFLICT":
      return 409;
  }
}

/**
 * 只允许把**安全**字段放进详情：拒绝任何看起来像路径、URI 或签名 URL 的字符串。
 */
export function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === "currentCanvas" || key === "resultCanvas") continue;
    if (typeof value === "string") {
      if (/^(https?:|file:|\/|blob:|data:)/.test(value)) continue;
      safe[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export function etagFor(revision: number, updatedAt: string): string {
  return `"r${revision}-${hash(updatedAt)}"`;
}

function hash(value: string): string {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }
  return (result >>> 0).toString(16);
}

export function checkServiceToken(req: IncomingMessage, expected: string | undefined): string | null {
  if (!expected) return null;
  const header = req.headers["x-woohaa3-service-token"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== expected) return "缺少或无效的服务令牌";
  return null;
}

/** 请求是否来自本机。 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress ?? "";
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("::ffff:127.")) return true;
  return false;
}

export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function readInt(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, maxBytes);
  if (bytes.byteLength === 0) return {};
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CanvasStorageError("INVALID_COMMAND_BATCH", "请求体必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CanvasStorageError) throw error;
    throw new CanvasStorageError("INVALID_COMMAND_BATCH", "请求体不是合法 JSON");
  }
}

export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        reject(new CanvasStorageError("LIMIT_EXCEEDED", "请求体超过上限", { maxBodyBytes: maxBytes }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => reject(new CanvasStorageError("INVALID_COMMAND_BATCH", "读取请求体失败")));
  });
}
