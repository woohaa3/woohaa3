/**
 * 受控媒体对象的 HTTP 接口（change: split-web-runtime-services，任务 3.1；源自
 * `apps/site/server/handler.ts`）。
 *
 * 路由（默认前缀 `/api/media`，同源路径保持不变，由 ingress/dev proxy 路由到本服务）：
 * - `POST  /api/media`         上传
 * - `GET   /api/media/<key>`   读取（支持 `Range`）
 * - `HEAD  /api/media/<key>`   元数据
 * - `GET   /api/media/<key>?variant=thumbnail&edge=256[&format=webp][&kind=poster]`
 *   受控预览派生物（change: 2026-10-23-scale-canvas-media-residency，design D4 / 任务 4.1）：
 *   命中缓存仍需按当前作用域验证原资产授权；未命中时有界排队生成，本次以 `202 pending`
 *   结束，调用方保持占位/上次合法图并重试。派生物不是 canonical 资产，不产生 asset/job。
 *
 * 安全性：key 必须是内容寻址键；错误响应只给稳定 `code`，不回显 COS 原始错误。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ALLOWED_MEDIA_TYPES,
  isDerivableSourceKey,
  isValidStorageKey,
  thumbnailDerivativeQuery,
  type MediaDerivativeIdentity
} from "@woohaa3/contracts";
import { isMediaObjectNotFoundError, type MediaStorage, type MediaStorageScope } from "@woohaa3/contracts";
import { canvasScopeOf } from "../application/media-scope.js";
import { DEFAULT_MAX_UPLOAD_BYTES,
  MediaIngestError,
  ingestMediaObject,
  mediaErrorStatus,
  mediaObjectUrl } from "../application/ingest.js";
import {
  MediaDerivativeError,
  type MediaDerivativeReadFacade
} from "../application/media-derivatives.js";
import type { MediaFormatRegistry } from "@woohaa3/contracts";

export const DEFAULT_MEDIA_BASE_PATH = "/api/media";

/**
 * 工程对象专用入口（change: 2026-10-16-integrate-photocraft-image-editing，任务 2.3）。
 *
 * 与普通上传分开：只有这条路径设置 `projectIngest`，因此普通 `POST /api/media` 改 MIME
 * 也拿不到核验。工程 MIME 在普通入口被直接拒绝（`project-requires-verification`）。
 */
export const DEFAULT_MEDIA_PROJECT_BASE_PATH = "/api/media-projects";

export type MediaRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type MediaRequestHandlerOptions = {
  storage: MediaStorage;
  basePath?: string;
  /** 工程对象专用入口前缀（缺省 `/api/media-projects`）。 */
  projectBasePath?: string;
  maxBytes?: number;
  allowedTypes?: readonly string[];
  /** 只用于传递安全字段；不要传 header 或凭据。 */
  logger?: (event: { event: string; status: number; code?: string }) => void;
  /** Registered extension-owned formats, shared with the service instance. */
  formats?: MediaFormatRegistry;
  /**
   * 预览派生物读取面（change: 2026-10-23-scale-canvas-media-residency，任务 4.1）。
   *
   * 缺省表示本部署不启用派生：带 `variant` 的读取以 `derivative-unsupported` 拒绝，调用方
   * 回退到原图路径。派生物字节仍只经注入的 `storage` 读写。
   */
  derivatives?: MediaDerivativeReadFacade;
};

export function createMediaRequestHandler(options: MediaRequestHandlerOptions): MediaRequestHandler {
  const basePath = (options.basePath ?? DEFAULT_MEDIA_BASE_PATH).replace(/\/$/, "");
  const projectBasePath = (options.projectBasePath ?? DEFAULT_MEDIA_PROJECT_BASE_PATH).replace(/\/$/, "");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const log = options.logger ?? (() => undefined);

  return async (req, res) => {
    let pathname: string;
    let key: string;
    let projectUpload = false;
    let scope: MediaStorageScope | undefined;
    let variant: MediaDerivativeIdentity | undefined;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      pathname = url.pathname;
      // 非法/空 canvas 视为无作用域：public 路由保持旧行为（主存储），不因坏参数拒绝读取。
      scope = canvasScopeOf(url.searchParams.get("canvas"));
      if (pathname === projectBasePath) {
        projectUpload = true;
        key = "";
      } else if (pathname === basePath || pathname.startsWith(`${basePath}/`)) {
        key = pathname === basePath ? "" : decodeURIComponent(pathname.slice(basePath.length + 1));
      } else {
        return false;
      }
      // 只有显式声明 `variant` 才走派生物；参数非法时在访问存储之前稳定拒绝。
      const variantKind = url.searchParams.get("variant");
      if (variantKind !== null && key !== "") {
        const decoded = thumbnailDerivativeQuery({
          sourceKey: key,
          edge: url.searchParams.get("edge"),
          format: url.searchParams.get("format") ?? undefined,
          kind: variantKind
        });
        if (!decoded || !isDerivableSourceKey(key)) {
          sendJson(res, 400, { error: "invalid-derivative" });
          return true;
        }
        variant = decoded;
      }
    } catch {
      sendJson(res, 400, { error: "invalid-request" });
      return true;
    }

    if (req.method === "POST" && (pathname === basePath || projectUpload)) {
      await handleUpload(req, res, options.storage, maxBytes, options.allowedTypes, basePath, log, projectUpload, scope, options.formats);
      return true;
    }
    if ((req.method === "GET" || req.method === "HEAD") && key !== "" && variant) {
      await handleDerivativeRead(req, res, options.derivatives, variant, scope, log);
      return true;
    }
    if ((req.method === "GET" || req.method === "HEAD") && key !== "") {
      await handleRead(req, res, options.storage, key, log, scope);
      return true;
    }
    if (key !== "") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    sendJson(res, 404, { error: "not-found" });
    return true;
  };
}

type Logger = MediaRequestHandlerOptions["logger"];

async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  storage: MediaStorage,
  maxBytes: number,
  allowedTypes: readonly string[] | undefined,
  basePath: string,
  log: Logger,
  projectIngest = false,
  scope?: MediaStorageScope,
  formats?: MediaFormatRegistry
): Promise<void> {
  try {
    const declared = Number(req.headers["content-length"] ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new MediaIngestError("payload-too-large", `上传内容超过上限：${declared} > ${maxBytes}`);
    }

    const bytes = await readBody(req, maxBytes);
    const result = await ingestMediaObject({
      storage,
      bytes,
      contentType: String(req.headers["content-type"] ?? ""),
      basePath,
      maxBytes,
      allowedTypes,
      projectIngest,
      scope,
      ...(formats ? { formats } : {})
    });

    log?.({ event: "media-upload", status: 201 });
    sendJson(res, 201, {
      storageKey: result.storageKey,
      checksum: result.checksum,
      contentType: result.contentType,
      size: result.size,
      url: result.url,
      deduplicated: result.deduplicated
    });
  } catch (error) {
    respondError(res, error, "media-upload", log);
  }
}

async function handleDerivativeRead(
  req: IncomingMessage,
  res: ServerResponse,
  derivatives: MediaDerivativeReadFacade | undefined,
  identity: MediaDerivativeIdentity,
  scope: MediaStorageScope | undefined,
  log: Logger
): Promise<void> {
  // HEAD 只用于探测；必须与 GET 一样经过授权和预算，不能成为绕过读取权限的旁路。
  if (!derivatives) {
    res.setHeader("Cache-Control", "no-store");
    sendJson(res, 415, { error: "derivative-unsupported" });
    log?.({ event: "media-derivative", status: 415, code: "unsupported" });
    return;
  }
  try {
    const result = await derivatives.read({ identity, scope });
    if (result.status === "pending") {
      // 已排队/正在生成：显式 202，调用方保持占位或上次合法图并稍后重试。
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", "1");
      sendJson(res, 202, { error: "derivative-pending" });
      log?.({ event: "media-derivative", status: 202, code: "pending" });
      return;
    }
    res.statusCode = 200;
    applyObjectHeaders(res, mediaDerivativeCacheKeyOf(identity), result.contentType, result.bytes.byteLength);
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(Buffer.from(result.bytes));
    }
    log?.({ event: "media-derivative", status: 200 });
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    if (error instanceof MediaDerivativeError) {
      sendJson(res, error.status, { error: error.code });
      log?.({ event: "media-derivative", status: error.status, code: error.code });
      return;
    }
    sendJson(res, 500, { error: "derivative-failed" });
    log?.({ event: "media-derivative", status: 500, code: "failed" });
  }
}

function mediaDerivativeCacheKeyOf(identity: MediaDerivativeIdentity): string {
  return `${identity.sourceKey}-${identity.kind}-${identity.edge}.${identity.format}`;
}

async function handleRead(
  req: IncomingMessage,
  res: ServerResponse,
  storage: MediaStorage,
  key: string,
  log: Logger,
  scope?: MediaStorageScope
): Promise<void> {
  try {
    assertValidStorageKey(key);

    if (req.method === "HEAD") {
      const stat = await readStat(storage, key, scope);
      res.statusCode = 200;
      applyObjectHeaders(res, key, stat.contentType, stat.size);
      res.end();
      log?.({ event: "media-head", status: 200 });
      return;
    }

    // Range 必须下推至存储；不能先下载完整视频再切片。流式返回也让 bytes=0-
    // 的请求能在首帧就绪后取消余下下载，并通过背压限制内存占用。
    if (storage.openRead && storage.stat) {
      const stat = await storage.stat(key, scope);
      const range = parseRange(req.headers.range, stat.size);
      if (range === "unsatisfiable") {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${stat.size}`);
        res.end();
        log?.({ event: "media-get", status: 416 });
        return;
      }
      if (res.destroyed) return;
      const stream = await storage.openRead(key, range ?? undefined, scope);
      const cancel = () => stream.cancel();
      res.once("close", cancel);
      try {
        if (res.destroyed) return;
        res.statusCode = range ? 206 : 200;
        applyObjectHeaders(res, key, stat.contentType, range ? range.end - range.start + 1 : stat.size);
        if (range) res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
        await pipeline(Readable.from(stream.bytes), res);
        log?.({ event: "media-get", status: res.statusCode });
      } finally {
        res.off("close", cancel);
        cancel();
      }
      return;
    }

    const object = await storage.get(key, scope);
    const total = object.bytes.byteLength;
    const range = parseRange(req.headers.range, total);

    if (range === "unsatisfiable") {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${total}`);
      res.end();
      log?.({ event: "media-get", status: 416 });
      return;
    }

    if (range) {
      const slice = object.bytes.subarray(range.start, range.end + 1);
      res.statusCode = 206;
      applyObjectHeaders(res, key, object.contentType, slice.byteLength);
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${total}`);
      res.end(Buffer.from(slice));
      log?.({ event: "media-get", status: 206 });
      return;
    }

    res.statusCode = 200;
    applyObjectHeaders(res, key, object.contentType, total);
    res.end(Buffer.from(object.bytes));
    log?.({ event: "media-get", status: 200 });
  } catch (error) {
    if (res.headersSent || res.destroyed) res.destroy();
    else respondError(res, error, "media-get", log);
  }
}

async function readStat(storage: MediaStorage, key: string, scope?: MediaStorageScope) {
  if (typeof storage.stat === "function") return storage.stat(key, scope);
  const object = await storage.get(key, scope);
  return { size: object.bytes.byteLength, contentType: object.contentType };
}

function applyObjectHeaders(
  res: ServerResponse,
  key: string,
  contentType: string | undefined,
  length: number
): void {
  res.setHeader("Content-Type", contentType ?? "application/octet-stream");
  if (["text/html","text/css","application/javascript","text/javascript"].includes(contentType ?? "")) res.setHeader("Content-Disposition", "attachment");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Length", String(length));
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("ETag", `"${key}"`);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
}

/** 只支持单段 range；不支持多段是有意为之。 */
function parseRange(
  header: string | undefined,
  total: number
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "unsatisfiable";
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return "unsatisfiable";

  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    const start = Math.max(0, total - suffix);
    return total === 0 ? "unsatisfiable" : { start, end: total - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === "" ? total - 1 : Math.min(Number(rawEnd), total - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return "unsatisfiable";
  }
  return { start, end };
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        reject(new MediaIngestError("payload-too-large", `上传内容超过上限：${total} > ${maxBytes}`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

function assertValidStorageKey(key: string): void {
  if (!isValidStorageKey(key)) {
    throw new MediaIngestError("invalid-storage-key", `非法的媒体对象键：${key}`);
  }
}

function respondError(res: ServerResponse, error: unknown, event: string, log: Logger): void {
  if (error instanceof MediaIngestError) {
    const status = mediaErrorStatus(error.code);
    log?.({ event, status, code: error.code });
    sendJson(res, status, { error: error.code, message: error.message });
    return;
  }
  if (isMediaObjectNotFoundError(error)) {
    log?.({ event, status: 404, code: "media-object-not-found" });
    sendJson(res, 404, { error: "media-object-not-found" });
    return;
  }
  log?.({ event, status: 500, code: "media-storage-failure" });
  sendJson(res, 500, { error: "media-storage-failure" });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

/** 同源媒体地址（与 ingest 返回的 `url` 一致）。 */
export function mediaUrlFor(storageKey: string, basePath = DEFAULT_MEDIA_BASE_PATH): string {
  return mediaObjectUrl(storageKey, basePath);
}

export { ALLOWED_MEDIA_TYPES, DEFAULT_MAX_UPLOAD_BYTES };
