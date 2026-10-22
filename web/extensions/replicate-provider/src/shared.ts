/**
 * Replicate Provider 的共享身份与模型名单解析。
 *
 * 模型不写死：配置里填写 `owner/name`，发现时再向 Replicate 读取输入定义。
 * 本文件不含执行实现、网络或秘密。
 */
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";

export const REPLICATE_PLUGIN_ID = "replicate-provider";

export const REPLICATE_PROVIDER_ID = "replicate";

export const DEFAULT_REPLICATE_BASE_URL = "https://api.replicate.com/v1";

/** 一次发现的上限，避免一次配置把公开模型目录整页拉下来。 */
export const MAX_REPLICATE_MODELS = 32;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const REPLICATE_PLUGIN_METADATA: ApplicationExtensionMetadata = {
  extensionId: REPLICATE_PLUGIN_ID,
  name: "Replicate Provider",
  description: "Replicate。填写 API Token，以及要使用的模型（owner/name）。图片、视频、音频与文本都通过预测接口运行。",
  version: "1.0.0",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "replicate-provider-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [],
  defaultEnabled: true
};

/** 去掉末尾斜杠。路径自己带 `/models` 与 `/predictions`，基址保持到 `/v1`。 */
export function replicateOrigin(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export type ParsedModelIds =
  | { ok: true; ids: string[] }
  | { ok: false; message: string };

/** 逗号、空格或换行分隔。重复的忽略；格式不对或超过上限则整份拒绝。 */
export function parseModelIds(value: string | undefined): ParsedModelIds {
  const ids: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const part of (value ?? "").split(/[\s,]+/)) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    if (!MODEL_ID.test(id) || id.includes("..")) invalid.push(id);
    else {
      seen.add(id);
      ids.push(id);
    }
  }
  if (invalid.length > 0) {
    return { ok: false, message: `模型标识必须是 owner/name：${invalid.slice(0, 3).join("、")}` };
  }
  if (ids.length > MAX_REPLICATE_MODELS) {
    return { ok: false, message: `一次最多接入 ${MAX_REPLICATE_MODELS} 个模型` };
  }
  return { ok: true, ids };
}
