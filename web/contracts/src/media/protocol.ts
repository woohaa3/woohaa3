/**
 * Media Service 内部 v1 协议（change: split-web-runtime-services，任务 1.3 / design D5）。
 *
 * ```
 * POST /internal/v1/media/verify   对象 stat/verify（Canvas 与 Task）
 * POST /internal/v1/media/sign     短期签名 URL（只允许 Task）
 * POST /internal/v1/media/import   受控下载 provider 输出并内容寻址写入（只允许 Task）
 * GET  /internal/v1/media/health   liveness/readiness
 * ```
 *
 * 所有内部操作都要求服务身份、版本号与稳定错误码；verify 响应不含 bytes、签名 URL 或
 * COS 配置；sign 只返回给发起 provider 调用的 Task。
 */
import { isFiniteNumber, isJsonObject, isNonNegativeInteger, isValidStorageKey } from "../validation.js";

export const DEFAULT_MEDIA_INTERNAL_BASE_PATH = "/internal/v1/media";

/** 稳定媒体 metadata（跨服务传输的安全形态）。 */
export type MediaMetadata = {
  storageKey: string;
  contentType: string;
  size: number;
  checksum: string;
  /** 媒体类别（由 contentType 推导，供调用方免于重复解析）。 */
  mediaKind?: "image" | "video" | "audio" | "text" | "other";
};

export type MediaVerifyRequest = {
  storageKey: string;
  /** 调用方声明的 metadata；提供时服务端必须逐项匹配。 */
  expected?: Partial<Omit<MediaMetadata, "storageKey">>;
  /** 这次核验属于哪张画布（远端画布资产可能只在托管存储里）。 */
  canvasId?: string;
};

export type MediaVerifyResponse =
  | { exists: true; metadata: MediaMetadata; matches: boolean }
  | { exists: false };

export type MediaSignRequest = {
  storageKey: string;
  expiresSeconds?: number;
  /** 这次签名属于哪张画布（按画布路由到远端存储时使用）。 */
  canvasId?: string;
};

export type MediaSignResponse = {
  url: string;
  expiresAt: string;
};

export type MediaImportRequest = {
  /** 受控下载目标（provider 输出）。 */
  url: string;
  /** 期望的媒体类型（可省略，由内容嗅探）。 */
  contentType?: string;
  /** 单次导入字节上限。 */
  maxBytes?: number;
  /** 生成结果属于哪张画布（同步到远端的画布要写进托管存储）。 */
  canvasId?: string;
};

export type MediaImportResponse = MediaMetadata;

/**
 * 受控「按字节转存」请求（Task 已持有 provider 输出字节时使用）。
 *
 * 与 `import` 的区别：`import` 从外部 URL 受控下载；本接口接收调用方**已经持有**的
 * bytes（例如 provider 用 base64 返回的图片）。仍然只允许 Task 身份 + `import` 作用域，
 * 仍然做类型/体积校验与内容寻址写入 —— Task 依旧不接触 COS。
 */
export type MediaImportBytesRequest = {
  /**
   * base64 编码的字节。
   *
   * 只允许**图片与音频**（TTS 等小对象内联返回）；视频大对象必须走 URL/流式导入路径，
   * 因此协议层直接拒绝视频 content type，避免把 256 MiB 塞进 JSON body。
   */
  bytesBase64: string;
  /** 期望的媒体类型（必须由调用方声明，避免嗅探歧义）。 */
  contentType: string;
  /** 单次导入字节上限。 */
  maxBytes?: number;
  /** 生成结果属于哪张画布（同步到远端的画布要写进托管存储）。 */
  canvasId?: string;
};

export type MediaHealthResponse = {
  status: "ok" | "not-ready";
  reason?: string;
};

function isMediaMetadata(value: unknown): value is MediaMetadata {
  if (!isJsonObject(value)) return false;
  return (
    isValidStorageKey(value.storageKey) &&
    typeof value.contentType === "string" &&
    value.contentType !== "" &&
    isNonNegativeInteger(value.size) &&
    typeof value.checksum === "string" &&
    /^[0-9a-f]{64}$/.test(value.checksum)
  );
}

export function isMediaVerifyResponse(value: unknown): value is MediaVerifyResponse {
  if (!isJsonObject(value)) return false;
  if (value.exists === false) return true;
  return value.exists === true && typeof value.matches === "boolean" && isMediaMetadata(value.metadata);
}

export function isMediaSignResponse(value: unknown): value is MediaSignResponse {
  if (!isJsonObject(value)) return false;
  return typeof value.url === "string" && /^https:\/\//i.test(value.url) && typeof value.expiresAt === "string";
}

export function isMediaImportResponse(value: unknown): value is MediaImportResponse {
  return isMediaMetadata(value);
}

export function decodeMediaImportBytesRequest(
  value: unknown
): { ok: true; value: MediaImportBytesRequest } | { ok: false; code: string; message: string } {
  if (!isJsonObject(value)) return { ok: false, code: "malformed-request", message: "请求体必须是对象" };
  if (typeof value.bytesBase64 !== "string" || value.bytesBase64 === "") {
    return { ok: false, code: "malformed-request", message: "bytesBase64 必须是非空字符串" };
  }
  // 只允许图片与音频的按字节导入；视频必须走受控 URL/流式路径。
  if (typeof value.contentType !== "string" || !(value.contentType.startsWith("image/") || value.contentType.startsWith("audio/"))) {
    return { ok: false, code: "malformed-request", message: "contentType 必须是图片或音频类型" };
  }
  const request: MediaImportBytesRequest = { bytesBase64: value.bytesBase64, contentType: value.contentType };
  if (value.maxBytes !== undefined) {
    if (!isFiniteNumber(value.maxBytes) || value.maxBytes <= 0) {
      return { ok: false, code: "malformed-request", message: "maxBytes 必须是正数" };
    }
    request.maxBytes = Math.floor(value.maxBytes);
  }
  if (typeof value.canvasId === "string" && value.canvasId.trim() !== "") request.canvasId = value.canvasId.trim();
  return { ok: true, value: request };
}

export function decodeMediaVerifyRequest(value: unknown): { ok: true; value: MediaVerifyRequest } | { ok: false; code: string; message: string } {
  if (!isJsonObject(value)) return { ok: false, code: "malformed-request", message: "请求体必须是对象" };
  if (!isValidStorageKey(value.storageKey)) {
    return { ok: false, code: "malformed-request", message: "storageKey 不是受控对象键" };
  }
  if (value.expected !== undefined && !isJsonObject(value.expected)) {
    return { ok: false, code: "malformed-request", message: "expected 必须是对象" };
  }
  const request: MediaVerifyRequest = { storageKey: value.storageKey, expected: value.expected as MediaVerifyRequest["expected"] };
  if (typeof value.canvasId === "string" && value.canvasId.trim() !== "") request.canvasId = value.canvasId.trim();
  return { ok: true, value: request };
}

export function decodeMediaSignRequest(value: unknown): { ok: true; value: MediaSignRequest } | { ok: false; code: string; message: string } {
  if (!isJsonObject(value)) return { ok: false, code: "malformed-request", message: "请求体必须是对象" };
  if (!isValidStorageKey(value.storageKey)) {
    return { ok: false, code: "malformed-request", message: "storageKey 不是受控对象键" };
  }
  const request: MediaSignRequest = { storageKey: value.storageKey };
  if (value.expiresSeconds !== undefined) {
    if (!isFiniteNumber(value.expiresSeconds) || value.expiresSeconds <= 0 || value.expiresSeconds > 3600) {
      return { ok: false, code: "malformed-request", message: "expiresSeconds 必须在 (0, 3600]" };
    }
    request.expiresSeconds = Math.floor(value.expiresSeconds);
  }
  if (typeof value.canvasId === "string" && value.canvasId.trim() !== "") request.canvasId = value.canvasId.trim();
  return { ok: true, value: request };
}

export function decodeMediaImportRequest(value: unknown): { ok: true; value: MediaImportRequest } | { ok: false; code: string; message: string } {
  if (!isJsonObject(value)) return { ok: false, code: "malformed-request", message: "请求体必须是对象" };
  if (typeof value.url !== "string" || !/^https:\/\//i.test(value.url)) {
    return { ok: false, code: "malformed-request", message: "url 必须是 HTTPS 地址" };
  }
  const request: MediaImportRequest = { url: value.url };
  if (value.contentType !== undefined) {
    if (typeof value.contentType !== "string") return { ok: false, code: "malformed-request", message: "contentType 必须是字符串" };
    request.contentType = value.contentType;
  }
  if (value.maxBytes !== undefined) {
    if (!isFiniteNumber(value.maxBytes) || value.maxBytes <= 0) {
      return { ok: false, code: "malformed-request", message: "maxBytes 必须是正数" };
    }
    request.maxBytes = Math.floor(value.maxBytes);
  }
  if (typeof value.canvasId === "string" && value.canvasId.trim() !== "") request.canvasId = value.canvasId.trim();
  return { ok: true, value: request };
}

/** sign 默认有效期（秒）。 */
export const DEFAULT_MEDIA_SIGN_TTL_SECONDS = 900;

/**
 * 生成输出按媒体类别的默认字节上限（deploy 可下调，不可由客户端上调）。
 * 图片 32 MiB、音频 64 MiB、视频 256 MiB。
 */
export function defaultMaxOutputBytesFor(contentType: string): number {
  if (contentType.startsWith("video/")) return 256 * 1024 * 1024;
  if (contentType.startsWith("audio/")) return 64 * 1024 * 1024;
  return 32 * 1024 * 1024;
}
