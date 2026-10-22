import { setTimeout as delay } from "node:timers/promises";
import { createVolcengineAssetClient, type VolcengineAssetClientOptions } from "./asset-client.js";

export type ArkAssetConfig = Omit<VolcengineAssetClientOptions, "fetch" | "now"> & {
  pollTimeoutMs: number;
  pollIntervalMs: number;
};

/** 素材库的非敏感配置（来自插件 Config）；访问密钥由凭据解析。 */
export type ArkAssetSettings = {
  groupId?: string;
  projectName: string;
  region: string;
  service: string;
  endpoint: string;
  pollTimeoutMs: number;
  pollIntervalMs: number;
};

/** 三项都没配置时关闭素材库；只配了一部分时报错，不提及已配置的值。 */
export function resolveArkAssetConfig(
  settings: ArkAssetSettings,
  keys: { accessKeyId?: string; secretAccessKey?: string }
): ArkAssetConfig | undefined {
  const required = {
    accessKeyId: keys.accessKeyId?.trim() ?? "",
    secretAccessKey: keys.secretAccessKey?.trim() ?? "",
    groupId: settings.groupId?.trim() ?? ""
  };
  const missing = Object.entries(required).filter(([, value]) => value === "").map(([name]) => name);
  if (missing.length === 3) return undefined;
  if (missing.length > 0) throw new Error(`Ark 素材库配置不完整：缺少 ${missing.join("、")}`);
  return {
    ...required,
    projectName: settings.projectName,
    region: settings.region,
    service: settings.service,
    endpoint: settings.endpoint,
    pollTimeoutMs: settings.pollTimeoutMs,
    pollIntervalMs: settings.pollIntervalMs
  };
}

export function createArkImageMaterializer(config: ArkAssetConfig, fetchImpl?: typeof globalThis.fetch) {
  const client = createVolcengineAssetClient({ ...config, fetch: fetchImpl });
  return async (url: string, abortSignal?: AbortSignal): Promise<string> => {
    if (url.startsWith("asset://")) return url;
    if (!/^https:\/\//i.test(url)) throw new Error("Ark 素材库图片需要 HTTPS 地址");
    const timeout = AbortSignal.timeout(config.pollTimeoutMs);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
    try {
      signal.throwIfAborted();
      const assetId = await client.createImageAsset({ url, name: "reference.png", signal });
      for (;;) {
        signal.throwIfAborted();
        const asset = await client.getAsset(assetId, signal);
        const status = asset.status?.toLowerCase();
        if (status === "active") return `asset://${assetId}`;
        if (status && ["failed", "error", "rejected", "deleted", "cancelled"].includes(status)) {
          throw new Error(`Ark 素材注册失败：${asset.status}`);
        }
        await delay(config.pollIntervalMs, undefined, { signal });
      }
    } catch (error) {
      if (timeout.aborted && !abortSignal?.aborted) {
        throw new Error(`Ark 素材注册超时（${config.pollTimeoutMs}ms）`);
      }
      throw error;
    }
  };
}
