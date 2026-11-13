/**
 * fal.ai Provider 的共享身份与模型名单解析。
 *
 * 模型不写死：配置里填写 endpoint id（`owner/alias[/子路径]`，例如 `fal-ai/flux/schnell`），
 * 发现时再按 id 读取该 endpoint 的队列 OpenAPI 定义。
 * 本文件不含执行实现、网络或秘密。
 */
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";

export const FAL_PLUGIN_ID = "fal-provider";

export const FAL_PROVIDER_ID = "fal";

/** 队列 API。同步入口是 `https://fal.run`，这里只用带重试语义的队列。 */
export const DEFAULT_FAL_BASE_URL = "https://queue.fal.run";

/** 每个 endpoint 的输入/输出定义。公开可读，不需要 Key。 */
export const FAL_SCHEMA_ENDPOINT = "https://fal.ai/api/openapi/queue/openapi.json";

/** 一次发现的上限，避免一次配置把整个平台目录拉下来。 */
export const MAX_FAL_MODELS = 32;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

export const FAL_PLUGIN_METADATA: ApplicationExtensionMetadata = {
  extensionId: FAL_PLUGIN_ID,
  name: "fal.ai Provider",
  description: "fal.ai。填写 API Key，以及要使用的模型（endpoint id，例如 fal-ai/flux/schnell）。按队列接口执行图片、视频、音频与文本生成。",
  version: "1.0.1",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "fal-provider-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [],
  defaultEnabled: true
};

/** 去掉末尾斜杠。endpoint id 自己带在路径上，基址保持到队列根。 */
export function falOrigin(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** 单个 endpoint 的 OpenAPI 地址。 */
export function falSchemaUrl(endpointId: string, schemaEndpoint = FAL_SCHEMA_ENDPOINT): string {
  return `${schemaEndpoint}?endpoint_id=${encodeURIComponent(endpointId)}`;
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
    return { ok: false, message: `模型标识必须是 endpoint id（owner/别名）：${invalid.slice(0, 3).join("、")}` };
  }
  if (ids.length > MAX_FAL_MODELS) {
    return { ok: false, message: `一次最多接入 ${MAX_FAL_MODELS} 个模型` };
  }
  return { ok: true, ids };
}
