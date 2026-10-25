/**
 * 媒体写入策略与内容寻址 ingest（change: split-web-runtime-services，任务 3.1）。
 *
 * 从 `apps/site/server/media.ts` 迁入 Media Service。键形态与允许类型来自 `contracts`
 * （跨边界事实），这里只保留**媒体写入策略**：
 * - 对象键只由内容决定（SHA-256），相同 bytes 天然幂等；
 * - 先校验、再上传，COS put 成功后才返回 metadata；
 * - 失败时不产生可提交的 asset。
 */
import { ALLOWED_MEDIA_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
  computeGeneratedStorageKey,
  computeStorageKey,
  isAllowedMediaType,
  normalizeMediaType } from "@woohaa3/contracts";
import type { MediaStorage, MediaStorageScope } from "@woohaa3/contracts";
import type { MediaFormatRegistry } from "@woohaa3/contracts";

export { ALLOWED_MEDIA_TYPES, DEFAULT_MAX_UPLOAD_BYTES };

/** 稳定拒绝原因（跨进程按字符串判定，测试与 UI 共用）。 */
export type MediaIngestErrorCode =
  | "empty-payload"
  | "payload-too-large"
  | "unsupported-media-type"
  | "invalid-storage-key"
  /** 工程 MIME 只允许走专用 ingest；普通上传不得绕过核验。 */
  | "project-requires-verification"
  | "project-verification-failed";

export class MediaIngestError extends Error {
  readonly code: MediaIngestErrorCode;

  constructor(code: MediaIngestErrorCode, message: string) {
    super(message);
    this.name = "MediaIngestError";
    this.code = code;
  }
}

/** HTTP 状态码映射；集中在这里，避免每个路由各写一遍。 */
export function mediaErrorStatus(code: MediaIngestErrorCode): number {
  switch (code) {
    case "payload-too-large":
      return 413;
    case "unsupported-media-type":
      return 415;
    case "project-requires-verification":
    case "project-verification-failed":
      return 422;
    case "empty-payload":
    case "invalid-storage-key":
      return 400;
  }
}

export { computeStorageKey, computeGeneratedStorageKey, normalizeMediaType };

/** Web Crypto 在 Node 20+ 与浏览器都可用。 */
export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes).buffer;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 同源读取地址；Canvas asset 的 `url` 只保存它，不保存临时签名 URL。 */
export function mediaObjectUrl(storageKey: string, basePath = "/api/media"): string {
  return `${basePath.replace(/\/$/, "")}/${storageKey}`;
}

export type MediaIngestResult = {
  storageKey: string;
  checksum: string;
  contentType: string;
  size: number;
  url: string;
  deduplicated: boolean;
};

export type IngestMediaOptions = {
  storage: MediaStorage;
  bytes: Uint8Array;
  contentType: string;
  basePath?: string;
  maxBytes?: number;
  allowedTypes?: readonly string[];
  computeChecksum?: (bytes: Uint8Array) => Promise<string>;
  /**
   * 受控工程 ingest 开关（change: 2026-10-16-integrate-photocraft-image-editing）。
   *
   * 只有专用工程入口可置 true；普通媒体上传即使改 MIME 也拿不到核验，必须被拒绝。
   */
  projectIngest?: boolean;
  /**
   * 这次写入属于哪张画布（可选）。媒体服务只透传、不解释路由；缺省与旧版一致，
   * 写入当前主存储。
   */
  scope?: MediaStorageScope;
  /** Extension-owned format providers; no provider means project ingest is unavailable. */
  formats?: MediaFormatRegistry;
};

/**
 * 校验 + 内容寻址 + 写入。只有 `put` 成功返回后才返回 metadata。
 */
export async function ingestMediaObject(options: IngestMediaOptions): Promise<MediaIngestResult> {
  const contentType = normalizeMediaType(options.contentType);
  const allowed = options.allowedTypes ?? ALLOWED_MEDIA_TYPES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  if (options.bytes.byteLength === 0) {
    throw new MediaIngestError("empty-payload", "上传内容为空");
  }
  // 工程 MIME 不能被普通上传使用：必须先经过有界内容核验（spec canvas-media-storage）。
  if (options.formats?.get(contentType) && !options.projectIngest) {
    throw new MediaIngestError("project-requires-verification", "工程对象必须经专用核验入口上传");
  }
  if (options.bytes.byteLength > maxBytes) {
    throw new MediaIngestError(
      "payload-too-large",
      `上传内容超过上限：${options.bytes.byteLength} > ${maxBytes}`
    );
  }
  if (options.projectIngest) {
    const format = options.formats?.get(contentType);
    if (!format) throw new MediaIngestError("unsupported-media-type", "没有安装支持此工程格式的扩展");
    if (options.bytes.byteLength > format.maxBytes) throw new MediaIngestError("payload-too-large", "工程超过格式上限");
    try {
      await format.validate(options.bytes, { maxBytes: Math.min(maxBytes, format.maxBytes) });
    } catch (error) {
      throw new MediaIngestError("project-verification-failed", error instanceof Error ? error.message : "工程核验失败");
    }
  } else if (!isAllowedMediaType(contentType, allowed)) {
    throw new MediaIngestError("unsupported-media-type", `不支持的媒体类型：${contentType || "(空)"}`);
  }

  const checksum = await (options.computeChecksum ?? computeSha256Hex)(options.bytes);
  const storageKey = computeStorageKey(checksum);

  const exists = await options.storage.exists(storageKey, options.scope);
  if (!exists) {
    await options.storage.put(storageKey, options.bytes, contentType, options.scope);
  }

  return {
    storageKey,
    checksum,
    contentType,
    size: options.bytes.byteLength,
    url: mediaObjectUrl(storageKey, options.basePath),
    deduplicated: exists
  };
}
