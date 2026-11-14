/**
 * grsai Provider 的共享身份与端点常量。
 *
 * 模型来自公开的模型列表接口（不需要 Key），执行走统一的 `/v1/api/generate` +
 * `/v1/api/result`。本文件不含执行实现、网络或秘密。
 */
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";

export const GRSAI_PLUGIN_ID = "grsai-provider";

export const GRSAI_PROVIDER_ID = "grsai";

/** 国内直连站。海外站是另一套 Key，部署时把地址改成 `https://grsaiapi.com`。 */
export const DEFAULT_GRSAI_BASE_URL = "https://grsai.dakka.com.cn";

/** 公开模型列表（无需鉴权）。`closeModel` / `maintenance` 的模型不注册。 */
export const GRSAI_MODEL_LIST_PATH = "/client/serverGrsai/getModelListV2";

/** 统一生成与查询接口。 */
export const GRSAI_GENERATE_PATH = "/v1/api/generate";

export const GRSAI_RESULT_PATH = "/v1/api/result";

/** OpenAI 兼容的对话接口（文本模型）。 */
export const GRSAI_CHAT_PATH = "/v1/chat/completions";

/** 参考素材上传的令牌接口（相对 base URL）。 */
export const GRSAI_UPLOAD_TOKEN_PATH = "/client/resource/newUploadTokenZH";

export const GRSAI_PLUGIN_METADATA: ApplicationExtensionMetadata = {
  extensionId: GRSAI_PLUGIN_ID,
  name: "grsai Provider",
  description: "grsai。填写 API Key 后从公开模型表发现可用的图片、视频与文本模型；图片和视频走统一生成接口，文本走 OpenAI 兼容对话接口。",
  version: "1.0.1",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "grsai-provider-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [],
  defaultEnabled: true
};

/** 去掉末尾斜杠和误粘的 `/v1`，后续路径自己带版本。 */
export function grsaiOrigin(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}
