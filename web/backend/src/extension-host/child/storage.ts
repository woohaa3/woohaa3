/**
 * 子进程侧的 `ctx.storage`（D4）：只在声明了 `permissions.storageNamespaces` 时注入。
 *
 * `bucket(ns)` 只接受声明过的命名空间；字节走大载荷 / 流帧（`rpc.large`）。`register` 一律拒绝：
 * 受管扩展不能注册存储后端（预检已拒绝 kind=storage，这里是纵深防御）。
 */
import { EXTENSION_HOST_METHODS } from "@woohaa3/contracts";
import { RpcError, decodeLarge, encodeLarge, type RpcEndpoint } from "../rpc/index.js";

type BucketCall = { namespace: string; scope?: unknown; key?: string; options?: unknown; body?: unknown };

export function createChildStorage(endpoint: RpcEndpoint, namespaces: readonly string[]) {
  const allowed = new Set(namespaces);
  const call = async (method: string, input: BucketCall) =>
    decodeLarge(endpoint, await endpoint.request(method, encodeLarge(endpoint, input)));
  const bucket = (namespace: string, scope?: unknown) => {
    if (!allowed.has(namespace)) {
      throw new RpcError("permission-denied", `存储命名空间未在 permissions.storageNamespaces 中声明：${namespace}`);
    }
    const base = { namespace, ...(scope !== undefined ? { scope } : {}) };
    return {
      head: (key: string) => call(EXTENSION_HOST_METHODS.storageHead, { ...base, key }),
      get: (key: string, options?: unknown) => call(EXTENSION_HOST_METHODS.storageGet, { ...base, key, ...(options !== undefined ? { options } : {}) }),
      put: (key: string, body: unknown, options?: unknown) =>
        call(EXTENSION_HOST_METHODS.storagePut, { ...base, key, body, ...(options !== undefined ? { options } : {}) }),
      delete: (key: string) => call(EXTENSION_HOST_METHODS.storageDelete, { ...base, key }),
      presign: (key: string, options?: unknown) =>
        call(EXTENSION_HOST_METHODS.storagePresign, { ...base, key, ...(options !== undefined ? { options } : {}) }),
      expose: (key: string, options?: unknown) =>
        call(EXTENSION_HOST_METHODS.storageExpose, { ...base, key, ...(options !== undefined ? { options } : {}) })
    };
  };
  return {
    bucket,
    register() {
      throw new RpcError("permission-denied", "受管扩展不能注册存储后端");
    },
    unregister() {
      throw new RpcError("permission-denied", "受管扩展不能注销存储后端");
    },
    list: () => []
  };
}
