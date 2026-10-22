/** 有界、内容寻址的扩展资源端口；HTTP 与进程内宿主共享同一存储策略。 */
import {
  ALLOWED_MEDIA_TYPES, computeStorageKey, inferMediaKindFromType, isValidStorageKey,
  normalizeMediaType, type ApplicationExtensionMediaResourcesFacade, type MediaStorage,
  type MediaStorageScope
} from "@woohaa3/contracts";
import { computeSha256Hex } from "./ingest.js";
import { decodeCanvasScope } from "./media-scope.js";

const MAX_BYTES = 16 * 1024 * 1024;
const TYPES = new Set([...ALLOWED_MEDIA_TYPES, "application/zip", "text/html", "text/css",
  "application/javascript", "text/javascript", "model/gltf-binary", "model/gltf+json",
  "application/octet-stream", "image/svg+xml", "font/woff", "font/woff2", "font/ttf", "font/otf"]);

export class ExtensionResourceError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

/**
 * 把可选的 canvasId 解成存储作用域。
 *
 * 不变量：**声明了画布就必须带作用域落到该画布的后端**，远端画布的字节只在托管存储里
 * （`<canvasId>/media/<key>`）；非法 id 直接拒绝，绝不静默退化成「无作用域」。
 * 省略 canvasId 表示与画布无关（扩展素材、独立页），行为与历史一致。
 */
function scopeOf(canvasId: string | undefined): MediaStorageScope | undefined {
  const decoded = decodeCanvasScope(canvasId);
  if (!decoded.ok) throw new ExtensionResourceError("malformed-request", 400, decoded.message);
  return decoded.scope;
}

export function createExtensionMediaResources(storage: MediaStorage): ApplicationExtensionMediaResourcesFacade {
  return {
    async read(storageKey, canvasId) {
      if (!isValidStorageKey(storageKey)) throw new ExtensionResourceError("malformed-request", 400, "稳定资源键非法");
      const object = await storage.get(storageKey, scopeOf(canvasId));
      if (object.bytes.byteLength > MAX_BYTES) throw new ExtensionResourceError("limit-exceeded", 413, "资源超过读取上限");
      return { bytes: object.bytes, contentType: object.contentType ?? "application/octet-stream" };
    },
    async write(input) {
      const contentType = normalizeMediaType(input.contentType);
      if (!TYPES.has(contentType)) throw new ExtensionResourceError("malformed-request", 400, "媒体类型非法");
      if (!input.bytes.byteLength || input.bytes.byteLength > MAX_BYTES) throw new ExtensionResourceError("limit-exceeded", 413, "资源字节超限");
      const scope = scopeOf(input.canvasId);
      const checksum = await computeSha256Hex(input.bytes);
      const storageKey = computeStorageKey(checksum);
      if (await storage.exists(storageKey, scope)) {
        const existing = await storage.get(storageKey, scope);
        if (existing.contentType !== contentType) throw new ExtensionResourceError("content-type-conflict", 409, "同一稳定资源不可更改类型");
      } else await storage.put(storageKey, input.bytes, contentType, scope);
      return { storageKey, checksum, contentType, size: input.bytes.byteLength, mediaKind: inferMediaKindFromType(contentType) ?? "other" };
    }
  };
}
