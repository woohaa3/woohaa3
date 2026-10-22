/**
 * 提示词片段目录 HTTP API
 * （change: add-prompt-snippet-library，任务 1.4 / design D1）。
 *
 * 认证后的版本化目录面：
 * ```
 * GET    /api/prompt-snippets                列表（搜索/筛选/游标分页）
 * POST   /api/prompt-snippets                创建（operationId 幂等）
 * GET    /api/prompt-snippets/:id            读取
 * PATCH  /api/prompt-snippets/:id            更新（revision 乐观并发）
 * DELETE /api/prompt-snippets/:id            删除
 * GET    /api/prompt-snippets/tags           标签列表（含关联数）
 * POST   /api/prompt-snippets/tags           创建标签（operationId 幂等）
 * PATCH  /api/prompt-snippets/tags/:id       重命名标签（revision）
 * DELETE /api/prompt-snippets/tags/:id       删除标签（单事务解绑）
 * GET    /api/prompt-snippets/material       目录素材 resolver（存储 metadata）
 * ```
 *
 * 目录数据与画布 Y.Doc/聚合分表；错误映射为稳定 `{ code, message }`，绝不回显路径/凭据。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decodeCreatePromptSnippet,
  decodeCreatePromptSnippetTag,
  decodeRenamePromptSnippetTag,
  decodeUpdatePromptSnippet
} from "@woohaa3/contracts";
import type { PromptSnippetApplicationService } from "../storage/core/snippet-service.js";
import { CanvasStorageError, canvasStorageErrorCode, isCanvasStorageError } from "../storage/core/errors.js";

export const DEFAULT_SNIPPET_API_BASE_PATH = "/api/prompt-snippets";

export type SnippetRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type SnippetRequestHandlerOptions = {
  service: PromptSnippetApplicationService;
  /** 受信任代理服务令牌；未配置时只允许本机访问。 */
  serviceToken?: string;
  basePath?: string;
  maxBodyBytes?: number;
  logger?: (event: { event: string; status: number; code?: string }) => void;
};

export function createSnippetRequestHandler(options: SnippetRequestHandlerOptions): SnippetRequestHandler {
  const basePath = (options.basePath ?? DEFAULT_SNIPPET_API_BASE_PATH).replace(/\/$/, "");
  const maxBodyBytes = options.maxBodyBytes ?? 512 * 1024;
  const log: NonNullable<SnippetRequestHandlerOptions["logger"]> = options.logger ?? (() => undefined);

  return async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendError(res, 400, "SNIPPET_INVALID", "请求 URL 非法");
      return true;
    }
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return false;

    if (!authorize(req, options.serviceToken)) {
      log({ event: "snippet-unauthorized", status: 401 });
      sendError(res, 401, "REPOSITORY_FAILURE", "需要受信任身份或本机访问");
      return true;
    }

    const suffix = pathname === basePath ? "" : pathname.slice(basePath.length + 1);
    const segments = suffix === "" ? [] : suffix.split("/").map(decodeSegment);

    try {
      // 标签子路由。
      if (segments[0] === "tags") {
        if (segments.length === 1) {
          if (req.method === "GET") {
            sendJson(res, 200, { items: await options.service.listTags() });
            return true;
          }
          if (req.method === "POST") return await handleCreateTag(req, res, options, maxBodyBytes);
          sendError(res, 405, "SNIPPET_INVALID", "方法不允许");
          return true;
        }
        if (segments.length === 2) {
          const tagId = segments[1]!;
          if (req.method === "PATCH") return await handleRenameTag(req, res, tagId, options, maxBodyBytes);
          if (req.method === "DELETE") {
            await options.service.deleteTag(tagId);
            res.statusCode = 204;
            res.end();
            return true;
          }
          sendError(res, 405, "SNIPPET_INVALID", "方法不允许");
          return true;
        }
        sendError(res, 404, "TAG_NOT_FOUND", "未知的标签路由");
        return true;
      }

      // 素材 resolver：只返回稳定 storage metadata（design D4）。
      if (segments.length === 1 && segments[0] === "material" && req.method === "GET") {
        return handleMaterialResolver(req, res, options, log);
      }

      if (segments.length === 0) {
        if (req.method === "GET") {
          const url = new URL(req.url ?? "/", "http://localhost");
          const result = await options.service.listSnippets(Object.fromEntries(url.searchParams.entries()));
          sendJson(res, 200, result);
          return true;
        }
        if (req.method === "POST") return await handleCreateSnippet(req, res, options, maxBodyBytes);
        sendError(res, 405, "SNIPPET_INVALID", "方法不允许");
        return true;
      }

      if (segments.length === 1) {
        const snippetId = segments[0]!;
        if (req.method === "GET") {
          sendJson(res, 200, { snippet: await options.service.getSnippet(snippetId) });
          return true;
        }
        if (req.method === "PATCH") return await handleUpdateSnippet(req, res, snippetId, options, maxBodyBytes);
        if (req.method === "DELETE") {
          await options.service.deleteSnippet(snippetId);
          res.statusCode = 204;
          res.end();
          return true;
        }
        sendError(res, 405, "SNIPPET_INVALID", "方法不允许");
        return true;
      }

      sendError(res, 404, "SNIPPET_NOT_FOUND", "未知的片段路由");
      return true;
    } catch (error) {
      respondError(res, error, log);
      return true;
    }
  };
}

async function handleCreateSnippet(
  req: IncomingMessage,
  res: ServerResponse,
  options: SnippetRequestHandlerOptions,
  maxBodyBytes: number
): Promise<boolean> {
  const body = await readJsonBody(req, maxBodyBytes);
  const decoded = decodeCreatePromptSnippet(body);
  if (!decoded.ok) {
    sendError(res, 400, decoded.code, decoded.message);
    return true;
  }
  const snippet = await options.service.createSnippet(decoded.value);
  sendJson(res, 201, { snippet });
  return true;
}

async function handleUpdateSnippet(
  req: IncomingMessage,
  res: ServerResponse,
  snippetId: string,
  options: SnippetRequestHandlerOptions,
  maxBodyBytes: number
): Promise<boolean> {
  const body = await readJsonBody(req, maxBodyBytes);
  const decoded = decodeUpdatePromptSnippet({ ...body, snippetId });
  if (!decoded.ok) {
    sendError(res, 400, decoded.code, decoded.message);
    return true;
  }
  const snippet = await options.service.updateSnippet(decoded.value);
  sendJson(res, 200, { snippet });
  return true;
}

async function handleCreateTag(
  req: IncomingMessage,
  res: ServerResponse,
  options: SnippetRequestHandlerOptions,
  maxBodyBytes: number
): Promise<boolean> {
  const body = await readJsonBody(req, maxBodyBytes);
  const decoded = decodeCreatePromptSnippetTag(body);
  if (!decoded.ok) {
    sendError(res, 400, decoded.code, decoded.message);
    return true;
  }
  const tag = await options.service.createTag(decoded.value);
  sendJson(res, 201, { tag });
  return true;
}

async function handleRenameTag(
  req: IncomingMessage,
  res: ServerResponse,
  tagId: string,
  options: SnippetRequestHandlerOptions,
  maxBodyBytes: number
): Promise<boolean> {
  const body = await readJsonBody(req, maxBodyBytes);
  const decoded = decodeRenamePromptSnippetTag({ ...body, tagId });
  if (!decoded.ok) {
    sendError(res, 400, decoded.code, decoded.message);
    return true;
  }
  const tag = await options.service.renameTag(decoded.value);
  sendJson(res, 200, { tag });
  return true;
}

/**
 * 素材 resolver：当前画布找不到快照素材时，返回**稳定 storage metadata**（不含任何 URL）。
 * Frontend 再经 `mediaRemote` 解析同源预览 URL。
 */
function handleMaterialResolver(
  req: IncomingMessage,
  res: ServerResponse,
  options: SnippetRequestHandlerOptions,
  log: NonNullable<SnippetRequestHandlerOptions["logger"]>
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const storageKey = url.searchParams.get("storageKey");
  // 只回显稳定键形态，不解析为任何 URL。
  if (!storageKey || !/^(sha256-[0-9a-f]{64}|generation-outputs\/[0-9a-f]{64}\.[a-z0-9]+)$/.test(storageKey)) {
    sendError(res, 400, "SNIPPET_INVALID", "storageKey 非法");
    return true;
  }
  // metadata 由调用方（Frontend）已持有的片段快照提供；resolver 仅确认受控键形态。
  log({ event: "snippet-material-resolve", status: 200 });
  sendJson(res, 200, { storageKey, resolvable: true });
  void options;
  return true;
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

function respondError(res: ServerResponse, error: unknown, log: NonNullable<SnippetRequestHandlerOptions["logger"]>): void {
  const code = canvasStorageErrorCode(error);
  if (code) {
    const status = statusForCode(code);
    const message = isCanvasStorageError(error) ? error.message : "请求失败";
    log({ event: "snippet-error", status, code });
    sendError(res, status, code, message);
    return;
  }
  log({ event: "snippet-error", status: 500, code: "REPOSITORY_FAILURE" });
  sendError(res, 500, "REPOSITORY_FAILURE", "服务内部错误");
}

function statusForCode(code: string): number {
  switch (code) {
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
    case "LIMIT_EXCEEDED":
      return 400;
    case "NOT_READY":
    case "SCHEMA_VERSION_UNSUPPORTED":
      return 503;
    default:
      return 500;
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, maxBytes);
  if (bytes.byteLength === 0) return {};
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CanvasStorageError("SNIPPET_INVALID", "请求体必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CanvasStorageError) throw error;
    throw new CanvasStorageError("SNIPPET_INVALID", "请求体不是合法 JSON");
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
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
    req.on("error", () => reject(new CanvasStorageError("SNIPPET_INVALID", "读取请求体失败")));
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
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
  sendJson(res, status, { code, message });
}
