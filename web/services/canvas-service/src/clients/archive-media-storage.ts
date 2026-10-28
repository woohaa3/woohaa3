/**
 * 归档包的媒体读写适配器（Canvas → Media Service 内部通道）。
 *
 * **为什么不用 `createMediaVerifierStorage`**：那个适配器的 `get` / `put` 直接抛错，
 * 注释写明「Canvas 不得读取媒体 bytes：媒体读取只属于 Media Service」。归档导出/导入
 * 确实需要字节，但那条约束仍然成立 —— 字节必须经 Media Service 的内部 HTTP 通道拿，
 * 而不是让 canvas 直接持有 COS/本地存储 adapter。
 *
 * 走的是扩展资源那对端点：
 * - 读：`POST /internal/v1/media/extension-read`
 * - 写：`POST /internal/v1/media/extension-write`
 *
 * 两者都带画布作用域（`canvasId`），由 Media Service 用它去做存储路由与判权。
 */
import {
  buildInternalHeaders,
  createCorrelationId,
  MediaObjectNotFoundError,
  withTimeout,
  type MediaObject,
  type MediaStorage,
  type MediaStorageScope
} from "@woohaa3/contracts";
import type { CanvasMediaClientOptions } from "./media-client.js";

/**
 * 单次读写上限。内部端点自身是 24 MiB（base64 后的 body），这里保持一致，
 * 免得发出去再被对面 413。
 */
const MAX_INLINE_BYTES = 24 * 1024 * 1024;

export type ArchiveMediaStorageOptions = Pick<CanvasMediaClientOptions, "baseUrl" | "serviceToken" | "timeoutMs" | "fetchImpl"> & {
  /**
   * 写进去时声明归属的扩展 id。端点要求一个合法扩展身份（`^[a-z][a-z0-9-]{0,127}$`）。
   * 归档不是某个具体扩展的行为，用一个稳定的内部身份表示。
   */
  extensionId?: string;
};

const DEFAULT_ARCHIVE_EXTENSION_ID = "canvas-archive";

/**
 * 为归档构造一个能读能写的 `MediaStorage`。
 *
 * `exists` / `stat` 仍走 verify（只读、便宜）；只有 `get` / `put` 走扩展资源端点。
 */
export function createArchiveMediaStorage(options: ArchiveMediaStorageOptions): MediaStorage {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const extensionId = options.extensionId ?? DEFAULT_ARCHIVE_EXTENSION_ID;

  const post = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    const response = await withTimeout(
      (signal) =>
        fetchImpl(`${baseUrl}${path}`, {
          method: "POST",
          headers: buildInternalHeaders({ serviceToken: options.serviceToken, correlationId: createCorrelationId() }),
          body: JSON.stringify(body),
          signal
        }),
      options.timeoutMs
    );
    if (!response.ok) {
      if (response.status === 404) {
        const key = typeof body.storageKey === "string" ? body.storageKey : "";
        throw new MediaObjectNotFoundError(key);
      }
      throw new Error(`媒体服务请求失败（${response.status}）`);
    }
    return response.json().catch(() => null);
  };

  const scopeId = (scope?: MediaStorageScope): Record<string, string> =>
    scope?.canvasId ? { canvasId: scope.canvasId } : {};

  return {
    async get(storageKey: string, scope?: MediaStorageScope): Promise<MediaObject> {
      const parsed = (await post("/internal/v1/media/extension-read", {
        extensionId,
        storageKey,
        ...scopeId(scope)
      })) as { bytesBase64?: unknown; contentType?: unknown } | null;
      if (typeof parsed?.bytesBase64 !== "string" || typeof parsed.contentType !== "string") {
        throw new Error("媒体服务响应非法");
      }
      const bytes = new Uint8Array(Buffer.from(parsed.bytesBase64, "base64"));
      if (bytes.byteLength > MAX_INLINE_BYTES) throw new Error("媒体对象超过归档读取上限");
      return { bytes, contentType: parsed.contentType };
    },

    async put(storageKey: string, bytes: Uint8Array, contentType: string, scope?: MediaStorageScope): Promise<void> {
      if (bytes.byteLength > MAX_INLINE_BYTES) throw new Error("媒体对象超过归档写入上限");
      await post("/internal/v1/media/extension-write", {
        extensionId,
        storageKey,
        contentType,
        bytesBase64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
        ...scopeId(scope)
      });
    },

    async exists(storageKey: string, scope?: MediaStorageScope): Promise<boolean> {
      const parsed = (await post("/internal/v1/media/verify", {
        storageKey,
        ...scopeId(scope)
      })) as { exists?: unknown } | null;
      return parsed?.exists === true;
    },

    async stat(storageKey: string, scope?: MediaStorageScope) {
      const parsed = (await post("/internal/v1/media/verify", {
        storageKey,
        ...scopeId(scope)
      })) as { exists?: unknown; metadata?: { size?: unknown; contentType?: unknown } } | null;
      if (parsed?.exists !== true || !parsed.metadata) throw new MediaObjectNotFoundError(storageKey);
      return {
        size: typeof parsed.metadata.size === "number" ? parsed.metadata.size : 0,
        ...(typeof parsed.metadata.contentType === "string" ? { contentType: parsed.metadata.contentType } : {})
      };
    }
  };
}
