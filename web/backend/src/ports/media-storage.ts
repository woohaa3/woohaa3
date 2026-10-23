/**
 * 存储扩展点 → Media 存储端口适配器。
 *
 * media-service 只认中立的 `MediaStorage`：字节读写与「取外部地址」，不知道字节存在哪里。
 * 本机宿主在这里把 `ctx.storage` 的 `media` namespace 视图接上去，所以：
 * - media 不再读任何存储凭据（COS 等后端都在扩展层）；
 * - `getHttpsUrl` 走 `bucket.expose`，对外地址的解析顺序（当前后端 presign → expose 后端复制后签名）
 *   只有 core storage 一处实现；
 * - 每次调用现查 `bucket`（主存储热切换对 media 无感）；
 * - 调用方声明的画布作用域按**调用**透传：同一进程里不同画布的媒体读写各自路由，适配器自己
 *   不缓存、不理解路由（local / cos 忽略它，server 用画布拼键并判权）。
 */
import {
  MediaObjectNotFoundError,
  isStorageObjectNotFoundError,
  type HostStorageService,
  type MediaStorage,
  type MediaStorageScope
} from "@woohaa3/contracts";

/** media 的 namespace。COS 后端最终键仍是 `${prefix}/media/${key}`，已存对象不失联。 */
export const MEDIA_STORAGE_NAMESPACE = "media";

export function createMediaStorageFromStorage(
  storage: HostStorageService,
  namespace: string = MEDIA_STORAGE_NAMESPACE
): MediaStorage {
  const bucket = (scope?: MediaStorageScope) =>
    storage.bucket(namespace, scope ? { canvasId: scope.canvasId } : undefined);
  return {
    put: (key, bytes, contentType, scope) => bucket(scope).put(key, bytes, contentType),
    async putStream(key, bytes, contentType, options, scope) {
      const current = bucket(scope);
      if (!current.putStream) throw new Error("当前存储后端不支持流式写入");
      await current.putStream(key, bytes, contentType, options);
    },
    async get(key, scope) {
      try {
        return await bucket(scope).get(key);
      } catch (error) {
        // media 下游按 `MEDIA_OBJECT_NOT_FOUND` 字符串判定 not-found；在边界上完成翻译。
        if (isStorageObjectNotFoundError(error)) throw new MediaObjectNotFoundError(key);
        throw error;
      }
    },
    async openRead(key, range, scope) {
      try {
        const current = bucket(scope);
        if (current.openRead) return await current.openRead(key, range);
        const object = await current.get(key);
        const bytes = range ? object.bytes.subarray(range.start, range.end + 1) : object.bytes;
        return { bytes: (async function* () { yield bytes; })(), cancel() {} };
      } catch (error) {
        if (isStorageObjectNotFoundError(error)) throw new MediaObjectNotFoundError(key);
        throw error;
      }
    },
    async exists(key, scope) {
      return (await bucket(scope).head(key)) !== null;
    },
    async stat(key, scope) {
      const stat = await bucket(scope).head(key);
      if (!stat) throw new MediaObjectNotFoundError(key);
      return stat;
    },
    getHttpsUrl: (key, options, scope) => bucket(scope).expose(key, options),
    // 按 locator 读字节：解析归 ctx.storage（它知道有哪些后端），本适配器只做翻译。
    async readLocator(locator) {
      try {
        return await storage.readLocator(locator);
      } catch (error) {
        if (isStorageObjectNotFoundError(error)) throw new MediaObjectNotFoundError(locator);
        throw error;
      }
    }
  };
}
