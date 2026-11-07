import { handleExtensionResources, handleExtensionStream } from "./extension-resources.js";
/**
 * Media Service 内部 v1 协议 handler（change: split-web-runtime-services，任务 3.2 / 3.3）。
 *
 * ```
 * POST /internal/v1/media/verify   对象 stat/verify（Canvas 与 Task）
 * POST /internal/v1/media/sign     短期签名 URL（只允许 Task）
 * POST /internal/v1/media/import   受控下载 provider 输出并内容寻址写入（只允许 Task）
 * GET  /internal/v1/media/health   readiness
 * ```
 *
 * 所有操作：先做协议版本与服务身份/作用域校验，再做副作用；响应不含 bytes、签名 URL
 * （除 sign 本身）或 COS 配置。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { checkProtocolVersion,
  decodeMediaImportBytesRequest,
  decodeMediaImportRequest,
  decodeMediaSignRequest,
  decodeMediaVerifyRequest,
  isJsonObject,
  WOOHAA3_PROTOCOL_VERSION,
  type MediaImportResponse,
  type MediaMetadata,
  type MediaSignResponse,
  type MediaVerifyResponse,
  type ProtocolErrorCode } from "@woohaa3/contracts";
import type { MediaStorage, MediaStorageScope } from "@woohaa3/contracts";
import { decodeCanvasScope as decodeCanvasScopeValue } from "../application/media-scope.js";
import { MediaObjectNotFoundError, isMediaObjectNotFoundError, isStorageExposeUnavailableError } from "@woohaa3/contracts";
import { computeGeneratedStorageKey, computeSha256Hex, normalizeMediaType } from "../application/ingest.js";
import { extensionForMediaType, isAllowedMediaType, mediaKindForType, defaultMaxOutputBytesFor } from "@woohaa3/contracts";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../application/ingest.js";
import { classifyDownloadFailure, downloadProviderUrl } from "../application/url-import.js";
import { hasScope, resolveServiceIdentity, type ServiceIdentityConfig } from "../security/identity.js";

export { DEFAULT_MEDIA_INTERNAL_BASE_PATH } from "@woohaa3/contracts";
export const MEDIA_INTERNAL_BASE_PATH = "/internal/v1/media";

import {
  DEFAULT_SIGN_TTL_SECONDS,
  DEFAULT_IMPORT_TIMEOUT_MS,
  GENERATED_IMPORT_MEDIA_TYPES
} from "../application/internal-service.js";

export type MediaInternalOptions = {
  storage: MediaStorage;
  identities: ServiceIdentityConfig;
  basePath?: string;
  maxImportBytes?: number;
  importTimeoutMs?: number;
  /** provider URL 转存的重试退避（默认 300ms/900ms；测试可注入零等待）。 */
  importRetryDelaysMs?: readonly number[];
  importSleep?: (ms: number) => Promise<void>;
  signTtlSeconds?: number;
  fetchImpl?: typeof globalThis.fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  logger?: (event: { event: string; status: number; code?: string; upstreamStatus?: number }) => void;
  /** readiness 覆盖（测试注入 COS 故障）。 */
  readiness?: () => Promise<{ ready: boolean; reason?: string }>;
  now?: () => Date;
};

export type MediaInternalHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createMediaInternalHandler(options: MediaInternalOptions): MediaInternalHandler {
  const basePath = (options.basePath ?? MEDIA_INTERNAL_BASE_PATH).replace(/\/$/, "");
  const log = options.logger ?? (() => undefined);
  const now = options.now ?? (() => new Date());

  return async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendError(res, 400, "malformed-request", "请求 URL 非法");
      return true;
    }
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return false;

    // health 不需要服务身份（供编排探针使用），但也不泄漏配置细节。
    if (pathname === `${basePath}/health`) {
      if (req.method !== "GET") return methodNotAllowed(res);
      const readiness = options.readiness ? await options.readiness() : { ready: true };
      sendJson(res, readiness.ready ? 200 : 503, {
        status: readiness.ready ? "ok" : "not-ready",
        ...(readiness.reason ? { reason: readiness.reason } : {})
      });
      return true;
    }

    // 协议版本：在副作用之前校验。
    const declaredVersion = headerValue(req.headers["x-woohaa3-protocol-version"]);
    const version = declaredVersion === undefined ? undefined : Number(declaredVersion);
    const versionCheck = checkProtocolVersion(version);
    if (!versionCheck.ok) {
      sendError(res, 409, "protocol-incompatible", versionCheck.message);
      return true;
    }

    const token = headerValue(req.headers["x-woohaa3-service-token"]);
    const identity = resolveIdentity(token, options.identities);
    if (!identity) {
      log({ event: "media-internal-unauthorized", status: 401, code: "unauthorized" });
      sendError(res, 401, "unauthorized", "缺少或无效的服务身份");
      return true;
    }

    if (req.method !== "POST") return methodNotAllowed(res);

    const suffix = pathname.slice(basePath.length + 1);
    if (suffix === "extension-stream-read" || suffix === "extension-stream-write") {
      if (!hasScope(identity, suffix === "extension-stream-write" ? "write" : "read")) return forbidden(res, suffix);
      return handleExtensionStream(req, res, options.storage, suffix === "extension-stream-write");
    }
    if (suffix === "extension-read" || suffix === "extension-write") {
      if (!hasScope(identity, suffix === "extension-write" ? "write" : "read")) return forbidden(res, suffix);
      // 画布作用域由 handler 自己解析：它的 body 上限是 24 MiB（base64 图片），不能在这里预读；
      // 解码复用 `decodeCanvasScopeValue`，与 verify/sign/import 的 400 口径一致。
      return handleExtensionResources(req,res,options.storage,suffix === "extension-write");
    }
    if (suffix === "verify") {
      if (!hasScope(identity, "verify")) return forbidden(res, "verify");
      return handleVerify(req, res, options, log);
    }
    if (suffix === "sign") {
      if (!hasScope(identity, "sign")) return forbidden(res, "sign");
      return handleSign(req, res, options, log, now);
    }
    if (suffix === "import") {
      if (!hasScope(identity, "import")) return forbidden(res, "import");
      return handleImport(req, res, options, log);
    }
    if (suffix === "import-bytes") {
      if (!hasScope(identity, "import")) return forbidden(res, "import-bytes");
      return handleImportBytes(req, res, options, log);
    }
    sendError(res, 404, "unsupported", "未知的内部媒体路由");
    return true;
  };
}

async function handleVerify(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaInternalOptions,
  log: NonNullable<MediaInternalOptions["logger"]>
): Promise<boolean> {
  const body = await readJson(req);
  const decoded = decodeMediaVerifyRequest(body);
  if (!decoded.ok) {
    sendError(res, 400, "malformed-request", decoded.message);
    return true;
  }
  const scope = decodeCanvasScope(res, body);
  if (!scope.ok) return true;
  const { storageKey, expected } = decoded.value;
  const metadata = await statMetadata(options.storage, storageKey, scope.scope);
  if (!metadata) {
    sendJson(res, 200, { exists: false } satisfies MediaVerifyResponse);
    return true;
  }
  const mismatch = expected ? compareMetadata(metadata, expected) : null;
  if (mismatch) log({ event: "media-verify", status: 200, code: "media-mismatch" });
  else log({ event: "media-verify", status: 200 });
  // 存在但 metadata 不匹配时仍返回 exists:true + matches:false：调用方据此拒绝持久化，
  // 同时拿到实测 metadata 做诊断（不含 bytes / 签名 URL）。
  sendJson(res, 200, { exists: true, metadata, matches: mismatch === null } satisfies MediaVerifyResponse);
  return true;
}

async function handleSign(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaInternalOptions,
  log: NonNullable<MediaInternalOptions["logger"]>,
  now: () => Date
): Promise<boolean> {
  const body = await readJson(req);
  const decoded = decodeMediaSignRequest(body);
  if (!decoded.ok) {
    sendError(res, 400, "malformed-request", decoded.message);
    return true;
  }
  const scope = decodeCanvasScope(res, body);
  if (!scope.ok) return true;
  const { storageKey } = decoded.value;
  const ttl = decoded.value.expiresSeconds ?? options.signTtlSeconds ?? DEFAULT_SIGN_TTL_SECONDS;
  if (typeof options.storage.getHttpsUrl !== "function") {
    sendError(res, 503, "unavailable", "当前存储没有对外地址能力：请在 exposer.primary 选择地址提供者");
    return true;
  }
  try {
    const url = await options.storage.getHttpsUrl(storageKey, { expiresSeconds: ttl }, scope.scope);
    if (!/^https:\/\//i.test(url)) {
      sendError(res, 502, "storage-failed", "签名 URL 必须是 HTTPS");
      return true;
    }
    const expiresAt = new Date(now().getTime() + ttl * 1000).toISOString();
    log({ event: "media-sign", status: 200 });
    sendJson(res, 200, { url, expiresAt } satisfies MediaSignResponse);
  } catch (error) {
    // 「没有可用的对外存储后端」是配置问题：503 + 可操作的原因，而不是笼统的 502。
    if (isStorageExposeUnavailableError(error)) {
      sendError(res, 503, "unavailable", error instanceof Error ? error.message : "没有可用的对外存储后端");
      return true;
    }
    if (isMediaObjectNotFoundError(error)) {
      sendError(res, 404, "media-not-found", "媒体对象不存在");
      return true;
    }
    sendError(res, 502, "storage-failed", "无法生成签名 URL");
  }
  return true;
}

async function handleImport(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaInternalOptions,
  log: NonNullable<MediaInternalOptions["logger"]>
): Promise<boolean> {
  const body = await readJson(req);
  const decoded = decodeMediaImportRequest(body);
  if (!decoded.ok) {
    sendError(res, 400, "malformed-request", decoded.message);
    return true;
  }
  const maxBytes = Math.min(
    decoded.value.maxBytes ?? options.maxImportBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
    options.maxImportBytes ?? DEFAULT_MAX_UPLOAD_BYTES
  );
  const scope = decodeCanvasScope(res, body);
  if (!scope.ok) return true;

  let downloaded;
  try {
    downloaded = await downloadProviderUrl({
      url: decoded.value.url,
      maxBytes,
      timeoutMs: options.importTimeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS,
      // 生成结果转存允许图片、视频与音频（provider 输出 URL）。
      allowedMediaTypes: [...GENERATED_IMPORT_MEDIA_TYPES],
      fetchImpl: options.fetchImpl,
      resolveHost: options.resolveHost,
      ...(options.importRetryDelaysMs ? { retryDelaysMs: options.importRetryDelaysMs } : {}),
      ...(options.importSleep ? { sleep: options.importSleep } : {})
    });
  } catch (error) {
    const failure = classifyDownloadFailure(error);
    log({
      event: "media-import",
      status: failure.httpStatus,
      code: failure.code,
      ...(failure.upstreamStatus !== undefined ? { upstreamStatus: failure.upstreamStatus } : {})
    });
    sendError(
      res,
      failure.httpStatus,
      failure.code === "limit-exceeded"
        ? "limit-exceeded"
        : failure.code === "media-not-found"
          ? "media-not-found"
          : failure.code === "storage-failed"
            ? "storage-failed"
            : "unsupported",
      "受控下载失败"
    );
    return true;
  }

  return persistImportedBytes(res, options, log, {
    bytes: downloaded.bytes,
    contentType: downloaded.contentType || decoded.value.contentType || "",
    maxBytes,
    scope: scope.scope
  });
}

/**
 * 按字节转存（Task 已持有 provider 输出字节，例如 base64 图片）。
 *
 * 与 URL import 共用同一套「类型/体积校验 + 内容寻址 + 写入」尾部；区别只是字节来源。
 * Task 仍不接触 COS，也不把 bytes 落进自己的 store/history。
 */
async function handleImportBytes(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaInternalOptions,
  log: NonNullable<MediaInternalOptions["logger"]>
): Promise<boolean> {
  const body = await readJson(req, base64BodyLimit(options));
  const decoded = decodeMediaImportBytesRequest(body);
  if (!decoded.ok) {
    sendError(res, 400, "malformed-request", decoded.message);
    return true;
  }
  const maxBytes = Math.min(decoded.value.maxBytes ?? options.maxImportBytes ?? DEFAULT_MAX_UPLOAD_BYTES, options.maxImportBytes ?? DEFAULT_MAX_UPLOAD_BYTES);
  const scope = decodeCanvasScope(res, body);
  if (!scope.ok) return true;

  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(decoded.value.bytesBase64, "base64");
  } catch {
    sendError(res, 400, "malformed-request", "bytesBase64 不是合法 base64");
    return true;
  }

  return persistImportedBytes(res, options, log, {
    bytes,
    contentType: decoded.value.contentType,
    maxBytes,
    scope: scope.scope
  });
}

/** URL import 与 bytes import 共用的校验 + 内容寻址写入尾部。 */
async function persistImportedBytes(
  res: ServerResponse,
  options: MediaInternalOptions,
  log: NonNullable<MediaInternalOptions["logger"]>,
  input: { bytes: Uint8Array; contentType: string; maxBytes: number; scope?: MediaStorageScope }
): Promise<boolean> {
  if (input.bytes.byteLength === 0) {
    sendError(res, 400, "malformed-request", "导入内容为空");
    return true;
  }
  if (input.bytes.byteLength > input.maxBytes) {
    sendError(res, 413, "limit-exceeded", "导入内容超过上限");
    return true;
  }
  const contentType = normalizeMediaType(input.contentType);
  if (!isAllowedMediaType(contentType, GENERATED_IMPORT_MEDIA_TYPES)) {
    sendError(res, 415, "unsupported", "只接受受控的图片、视频或音频输出");
    return true;
  }
  // 按媒体类型分档硬上限；客户端声明的 maxBytes 只能收紧，不能放宽。
  const kindLimit = defaultMaxOutputBytesFor(contentType);
  const effectiveMax = Math.min(input.maxBytes, kindLimit);
  if (input.bytes.byteLength > effectiveMax) {
    sendError(res, 413, "limit-exceeded", "导入内容超过该媒体类型上限");
    return true;
  }

  const checksum = await computeSha256Hex(input.bytes);
  const storageKey = computeGeneratedStorageKey(checksum, extensionForMediaType(contentType));
  try {
    // 内容寻址：相同内容重复导入复用同一对象键，天然幂等。
    const exists = await options.storage.exists(storageKey, input.scope);
    if (!exists) await options.storage.put(storageKey, input.bytes, contentType, input.scope);
  } catch {
    sendError(res, 502, "storage-failed", "写入媒体存储失败");
    return true;
  }

  const mediaKind = mediaKindForType(contentType);
  const metadata: MediaMetadata = {
    storageKey,
    contentType,
    size: input.bytes.byteLength,
    checksum,
    mediaKind
  };
  log({ event: "media-import", status: 201 });
  sendJson(res, 201, metadata satisfies MediaImportResponse);
  return true;
}

async function statMetadata(storage: MediaStorage, storageKey: string, scope?: MediaStorageScope): Promise<MediaMetadata | null> {
  try {
    if (typeof storage.stat === "function") {
      const stat = await storage.stat(storageKey, scope);
      return {
        storageKey,
        contentType: stat.contentType ?? "application/octet-stream",
        size: stat.size,
        checksum: storageKey.replace(/^sha256-/, "").replace(/^generation-outputs\//, "").replace(/\.[a-z0-9]+$/, "")
      };
    }
    const object = await storage.get(storageKey, scope);
    return {
      storageKey,
      contentType: object.contentType ?? "application/octet-stream",
      size: object.bytes.byteLength,
      checksum: storageKey.replace(/^sha256-/, "").replace(/^generation-outputs\//, "").replace(/\.[a-z0-9]+$/, "")
    };
  } catch (error) {
    if (isMediaObjectNotFoundError(error)) return null;
    throw error;
  }
}

/** 逐项比较声明与实测 metadata；不一致时返回首个不一致字段名。 */
function compareMetadata(
  actual: MediaMetadata,
  expected: Partial<Omit<MediaMetadata, "storageKey">>
): string | null {
  if (expected.size !== undefined && expected.size !== actual.size) return "size";
  if (expected.contentType !== undefined && expected.contentType !== actual.contentType) return "contentType";
  if (expected.checksum !== undefined && expected.checksum !== actual.checksum) return "checksum";
  return null;
}

function resolveIdentity(token: string | undefined, config: ServiceIdentityConfig) {
  return resolveServiceIdentity(token, config);
}

function forbidden(res: ServerResponse, scope: string): boolean {
  sendError(res, 403, "unauthorized", `服务身份无权执行 ${scope}`);
  return true;
}

function methodNotAllowed(res: ServerResponse): boolean {
  sendError(res, 405, "unsupported", "方法不允许");
  return true;
}

function headerValue(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value !== "" ? value : undefined;
}

type DecodedCanvasScope = { ok: true; scope?: MediaStorageScope } | { ok: false };

/**
 * 内部协议的可选 canvasId：缺省表示与画布无关；出现但形状非法时拒绝（400），
 * 不能静默丢掉 —— 调用方否则会误以为字节写到了画布后端。
 */
function decodeCanvasScope(res: ServerResponse, body: unknown): DecodedCanvasScope {
  if (!isJsonObject(body)) return { ok: true };
  const decoded = decodeCanvasScopeValue(body.canvasId);
  if (!decoded.ok) {
    sendError(res, 400, "malformed-request", decoded.message);
    return { ok: false };
  }
  return decoded;
}

/**
 * `import-bytes` 的 JSON body 上限。
 *
 * 请求体是 base64（比原始字节大约 4/3），再留 JSON 字段开销。**必须**由配置的
 * `maxImportBytes` 推导，而不是用 `readJson` 的 1 MiB 默认值 —— 否则一张几十 KB 以上的
 * 图片就会被 body 读取阶段拒掉，且错误是笼统的 `payload-too-large`（真实缺陷，已修）。
 */
function base64BodyLimit(options: MediaInternalOptions): number {
  const maxImportBytes = options.maxImportBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  return Math.ceil(maxImportBytes / 3) * 4 + 64 * 1024;
}

async function readJson(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        reject(new Error("payload-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

function sendError(res: ServerResponse, status: number, code: ProtocolErrorCode, message: string): void {
  sendJson(res, status, { code, message, protocolVersion: WOOHAA3_PROTOCOL_VERSION });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

export { MediaObjectNotFoundError };
