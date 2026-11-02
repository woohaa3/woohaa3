/**
 * Cephalon Cloud（端脑云）Provider 的共享身份。
 *
 * 平台地址固定在这里，不做成配置项：凭据只能发往声明的主机。
 * 模型名单来自 `GET /user-center/v1/models`，代码里**没有**内置模型 id 清单。
 * 前后端均可导入，不含执行实现、网络或秘密。
 */
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";

export const CEPHALON_PLUGIN_ID = "cephalon-provider";

export const CEPHALON_PROVIDER_ID = "cephalon";

/** 平台固定 origin。设计第 4 条：不接受用户填写网关地址，避免凭据被改写到任意主机。 */
export const CEPHALON_ORIGIN = "https://cephalon.cloud";

/** OpenAI 兼容模型接口前缀（chat / images / video）。 */
export const CEPHALON_MODEL_PREFIX = "/user-center/v1/model";

/**
 * 平台模型列表。匿名请求当下也能返回模型，但那是公开子集、且随平台上下架变化
 * （2026-11-02 实测：同一时刻匿名 34 条、带 Key 37 条；隔日两侧同为 35 条）。
 * 账号可用的集合以带凭据的响应为准，所以发现一律带 Bearer，不依赖匿名结果。
 */
export const CEPHALON_MODELS_PATH = "/user-center/v1/models";

export const CEPHALON_PLUGIN_METADATA: ApplicationExtensionMetadata = {
  extensionId: CEPHALON_PLUGIN_ID,
  name: "Cephalon Provider",
  description: "端脑云（Cephalon Cloud）。填写 API Key 后，从平台模型列表发现可用的文本、图片与视频模型。",
  version: "1.0.0",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "cephalon-provider-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [],
  defaultEnabled: true
};
