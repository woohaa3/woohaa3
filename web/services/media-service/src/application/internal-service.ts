/**
 * Media 内部能力应用服务（change: 2026-10-06-unify-backend-runtime-with-cordis，任务 2.1）。
 *
 * 把 verify / sign / import / import-bytes 的**领域逻辑**从 HTTP handler 中抽出，供两种调用方复用：
 * - HTTP 内部协议 handler（保留兼容面）；
 * - 统一后端进程内的 `BackendMediaPort`（无网络、无服务令牌）。
 *
 * 本模块不接触请求/响应对象，只处理稳定 DTO；副作用与校验语义与原 handler 完全一致。
 */
import type { MediaLocator, MediaMetadata, MediaStorage, MediaStorageScope } from "@woohaa3/contracts";
import {
  defaultMaxOutputBytesFor,
  extensionForMediaType,
  isAllowedMediaType,
  isMediaObjectNotFoundError,
  isStorageExposeUnavailableError,
  mediaKindForType
} from "@woohaa3/contracts";
import {
  computeGeneratedStorageKey,
  computeSha256Hex,
  normalizeMediaType,
  DEFAULT_MAX_UPLOAD_BYTES
} from "../application/ingest.js";
import { guardedDownload, GuardedDownloadError } from "../security/guarded-fetch.js";
import { canvasScopeOf } from "./media-scope.js";

/** 生成结果转存允许的媒体类型（图片 + 视频 + 音频）。 */
export const GENERATED_IMPORT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4"
] as const;

export const DEFAULT_SIGN_TTL_SECONDS = 900;
export const DEFAULT_IMPORT_TIMEOUT_MS = 30_000;

export class MediaApplicationError extends Error {
  readonly code:
    | "unauthorized"
    | "malformed-request"
    | "unsupported"
    | "limit-exceeded"
    | "media-not-found"
    | "storage-failed"
    | "unavailable";
  constructor(code: MediaApplicationError["code"], message: string) {
    super(message);
    this.name = "MediaApplicationError";
    this.code = code;
  }
}

export type MediaApplicationServiceOptions = {
  storage: MediaStorage;
  maxImportBytes?: number;
  importTimeoutMs?: number;
  signTtlSeconds?: number;
  fetchImpl?: typeof globalThis.fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  now?: () => Date;
  /**
   * 转存失败诊断出口。
   *
   * 进程内 port 直接调本服务，不经 `api/internal-handler.ts`（那条路径自己会 log），所以
   * 没有这个出口时线上只剩一句「受控下载失败」，分不清是超时、403 还是响应类型被拒。
   */
  logger?: (event: { event: string; status: number; code?: string }) => void;
};

export type MediaApplicationService = {
  verify(
    storageKey: string,
    expected?: Partial<Omit<MediaMetadata, "storageKey">>,
    scope?: MediaStorageScope
  ): Promise<{ exists: boolean; matches: boolean; metadata?: MediaMetadata }>;
  sign(storageKey: string, expiresSeconds?: number, scope?: MediaStorageScope): Promise<string>;
  importFromUrl(input: { url: string; contentType?: string; maxBytes?: number; canvasId?: string }): Promise<MediaMetadata>;
  importBytes(input: { bytesBase64: string; contentType: string; maxBytes?: number; canvasId?: string }): Promise<MediaMetadata>;
  /** 按 locator 导入：字节可能在任何后端，存储层取数，媒体层只做校验与登记。 */
  importFromLocator(input: {
    locator: MediaLocator;
    canvasId?: string;
    contentType?: string;
    maxBytes?: number;
    expected?: { contentType?: string; size?: number; checksum?: string };
  }): Promise<MediaMetadata>;
};

export function createMediaApplicationService(
  options: MediaApplicationServiceOptions
): MediaApplicationService {
  const now = options.now ?? (() => new Date());
  const maxImport = options.maxImportBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  /** 画布作用域：缺省无作用域；显式给了非法形状则拒绝（不能静默落到主存储）。 */
  const scopeOf = (canvasId: string | undefined): MediaStorageScope | undefined => {
    if (canvasId === undefined) return undefined;
    const scope = canvasScopeOf(canvasId);
    if (!scope) throw new MediaApplicationError("malformed-request", "canvasId 必须是合法的画布 id");
    return scope;
  };

  /** 进程内契约传的是已成形的作用域：再校验一次 id 形状，避免非法前缀进入存储键空间。 */
  const checkedScope = (scope: MediaStorageScope | undefined): MediaStorageScope | undefined =>
    scope === undefined ? undefined : scopeOf(scope.canvasId);

  const statMetadata = async (storageKey: string, scope?: MediaStorageScope): Promise<MediaMetadata | null> => {
    try {
      if (typeof options.storage.stat === "function") {
        const stat = await options.storage.stat(storageKey, scope);
        return {
          storageKey,
          contentType: stat.contentType ?? "application/octet-stream",
          size: stat.size,
          checksum: checksumFromKey(storageKey)
        };
      }
      const object = await options.storage.get(storageKey, scope);
      return {
        storageKey,
        contentType: object.contentType ?? "application/octet-stream",
        size: object.bytes.byteLength,
        checksum: checksumFromKey(storageKey)
      };
    } catch (error) {
      if (isMediaObjectNotFoundError(error)) return null;
      throw error;
    }
  };

  const persistBytes = async (input: {
    bytes: Uint8Array;
    contentType: string;
    maxBytes?: number;
    scope?: MediaStorageScope;
  }): Promise<MediaMetadata> => {
    if (input.bytes.byteLength === 0) throw new MediaApplicationError("malformed-request", "导入内容为空");
    const requestedMax = Math.min(input.maxBytes ?? maxImport, maxImport);
    if (input.bytes.byteLength > requestedMax) throw new MediaApplicationError("limit-exceeded", "导入内容超过上限");
    const contentType = normalizeMediaType(input.contentType);
    if (!isAllowedMediaType(contentType, [...GENERATED_IMPORT_MEDIA_TYPES])) {
      throw new MediaApplicationError("unsupported", "只接受受控的图片、视频或音频输出");
    }
    const kindLimit = defaultMaxOutputBytesFor(contentType);
    if (input.bytes.byteLength > Math.min(requestedMax, kindLimit)) {
      throw new MediaApplicationError("limit-exceeded", "导入内容超过该媒体类型上限");
    }
    const checksum = await computeSha256Hex(input.bytes);
    const storageKey = computeGeneratedStorageKey(checksum, extensionForMediaType(contentType));
    try {
      const exists = await options.storage.exists(storageKey, input.scope);
      if (!exists) await options.storage.put(storageKey, input.bytes, contentType, input.scope);
    } catch {
      throw new MediaApplicationError("storage-failed", "写入媒体存储失败");
    }
    return {
      storageKey,
      contentType,
      size: input.bytes.byteLength,
      checksum,
      mediaKind: mediaKindForType(contentType)
    };
  };

  return {
    async verify(storageKey, expected, scope) {
      const metadata = await statMetadata(storageKey, checkedScope(scope));
      if (!metadata) return { exists: false, matches: false };
      const mismatch = expected ? compareMetadata(metadata, expected) : null;
      return { exists: true, matches: mismatch === null, metadata };
    },

    async sign(storageKey, expiresSeconds, scope) {
      const checked = checkedScope(scope);
      if (typeof options.storage.getHttpsUrl !== "function") {
        throw new MediaApplicationError("unavailable", "当前存储没有对外地址能力：请配置支持签名的存储后端（storage.expose）");
      }
      const ttl = expiresSeconds ?? options.signTtlSeconds ?? DEFAULT_SIGN_TTL_SECONDS;
      try {
        const url = await options.storage.getHttpsUrl(storageKey, { expiresSeconds: ttl }, checked);
        if (!/^https:\/\//i.test(url)) throw new MediaApplicationError("storage-failed", "签名 URL 必须是 HTTPS");
        void now();
        return url;
      } catch (error) {
        if (error instanceof MediaApplicationError) throw error;
        // 「没有可用的对外存储后端」是配置问题，如实报 503 并带上可操作的原因。
        if (isStorageExposeUnavailableError(error)) {
          throw new MediaApplicationError("unavailable", error instanceof Error ? error.message : "没有可用的对外存储后端");
        }
        if (isMediaObjectNotFoundError(error)) throw new MediaApplicationError("media-not-found", "媒体对象不存在");
        throw new MediaApplicationError("storage-failed", "无法生成签名 URL");
      }
    },

    async importFromUrl(input) {
      const scope = scopeOf(input.canvasId);
      const requestedMax = Math.min(input.maxBytes ?? maxImport, maxImport);
      let downloaded;
      try {
        downloaded = await guardedDownload({
          url: input.url,
          maxBytes: requestedMax,
          timeoutMs: options.importTimeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS,
          allowedMediaTypes: [...GENERATED_IMPORT_MEDIA_TYPES],
          fetchImpl: options.fetchImpl,
          resolveHost: options.resolveHost
        });
      } catch (error) {
        const code = error instanceof GuardedDownloadError ? error.code : "http-error";
        // 守卫失败码只进日志（不含 URL / 凭据）：对外文案保持笼统，诊断靠这一行。
        options.logger?.({
          event: "media-import",
          status: code === "blocked-host" || code === "unsupported-protocol" ? 400 : code === "too-large" ? 413 : 502,
          code
        });
        if (code === "blocked-host" || code === "unsupported-protocol") {
          throw new MediaApplicationError("unsupported", "受控下载失败");
        }
        if (code === "too-large") throw new MediaApplicationError("limit-exceeded", "受控下载失败");
        throw new MediaApplicationError("storage-failed", "受控下载失败");
      }
      return persistBytes({
        bytes: downloaded.bytes,
        contentType: downloaded.contentType || input.contentType || "",
        maxBytes: requestedMax,
        scope
      });
    },

    async importBytes(input) {
      const scope = scopeOf(input.canvasId);
      let bytes: Uint8Array;
      try {
        bytes = Buffer.from(input.bytesBase64, "base64");
      } catch {
        throw new MediaApplicationError("malformed-request", "bytesBase64 不是合法 base64");
      }
      return persistBytes({ bytes, contentType: input.contentType, maxBytes: input.maxBytes, scope });
    },

    async importFromLocator(input) {
      if (typeof options.storage.readLocator !== "function") {
        throw new MediaApplicationError("unavailable", "当前存储不支持按 locator 读取");
      }
      const scope = scopeOf(input.canvasId);
      let object;
      try {
        object = await options.storage.readLocator(input.locator);
      } catch (error) {
        if (isMediaObjectNotFoundError(error)) {
          throw new MediaApplicationError("media-not-found", "locator 指向的对象不存在或不可读");
        }
        throw new MediaApplicationError("storage-failed", "按 locator 读取字节失败");
      }
      const contentType = input.contentType ?? object.contentType;
      if (contentType === undefined || contentType === "") {
        throw new MediaApplicationError("unsupported", "无法从 locator 判断媒体类型");
      }
      const metadata = await persistBytes({ bytes: object.bytes, contentType, maxBytes: input.maxBytes, scope });
      if (input.expected !== undefined && compareMetadata(metadata, input.expected) !== null) {
        throw new MediaApplicationError("storage-failed", "locator 对象的元数据与期望不一致");
      }
      return metadata;
    }
  };
}

function compareMetadata(
  actual: MediaMetadata,
  expected: Partial<Omit<MediaMetadata, "storageKey">>
): string | null {
  if (expected.size !== undefined && expected.size !== actual.size) return "size";
  if (expected.contentType !== undefined && expected.contentType !== actual.contentType) return "contentType";
  if (expected.checksum !== undefined && expected.checksum !== actual.checksum) return "checksum";
  return null;
}

function checksumFromKey(storageKey: string): string {
  return storageKey.replace(/^sha256-/, "").replace(/^generation-outputs\//, "").replace(/\.[a-z0-9]+$/, "");
}
