/**
 * Media verifier adapter（change: split-web-runtime-services，任务 3.5 / 5.5 / design D2）。
 *
 * Canvas 的 application/room 层需要校验稳定资产引用，但**不得**持有 COS adapter或凭据。
 * 这里把 Media Service client 适配成 canvas 代码期望的窄接口形态：只暴露 `exists` / `stat`，
 * 任何写入/读取 bytes 的调用都显式失败，从结构上阻止 Canvas 触碰媒体二进制。
 */
import { hashStorageKeyForLog, MediaObjectNotFoundError } from "@woohaa3/contracts";
import type { MediaObject, MediaStorage, MediaStorageScope } from "@woohaa3/contracts";
import type { CanvasMediaClient } from "./media-client.js";

export type MediaVerifierStorageOptions = {
  client: CanvasMediaClient;
  /** 探测用 storageKey（readiness）；缺省时 readiness 直接尝试一次空 verify。 */
  probeStorageKey?: string;
};

/**
 * 把 Media client 适配成 `MediaStorage` 的**只读校验子集**。
 *
 * `put` / `get` 明确抛错：Canvas 没有任何合法理由写或读取媒体 bytes。
 */
export function createMediaVerifierStorage(options: MediaVerifierStorageOptions): MediaStorage {
  return {
    async exists(storageKey: string, scope?: MediaStorageScope): Promise<boolean> {
      try {
        return (await options.client.verify(storageKey, undefined, scope)).exists;
      } catch (error) {
        // 媒体不可用时不要谎报存在；抛错让调用方按 unavailable 处理，但保留底层原因便于诊断。
        const canvasId = scope?.canvasId;
        throw new Error(
          `媒体校验不可用：${error instanceof Error ? error.message : String(error)}（storageKeyHash=${hashStorageKeyForLog(storageKey)}，canvas=${canvasId ?? "无"}）`
        );
      }
    },
    async stat(storageKey: string, scope?: MediaStorageScope): Promise<{ size: number; contentType?: string }> {
      const result = await options.client.verify(storageKey, undefined, scope);
      if (!result.exists || !result.metadata) throw new MediaObjectNotFoundError(storageKey);
      return { size: result.metadata.size, contentType: result.metadata.contentType };
    },
    async put(): Promise<void> {
      throw new Error("Canvas 不得写入媒体对象：媒体写入只属于 Media Service");
    },
    async get(): Promise<MediaObject> {
      throw new Error("Canvas 不得读取媒体 bytes：媒体读取只属于 Media Service");
    }
  };
}
