/**
 * TokenHub Provider 的共享身份。
 *
 * 模型名单来自 `GET /v1/models`，不在这里写死。前后端均可导入，不含执行实现、网络或秘密。
 */
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";

export const TOKENHUB_PLUGIN_ID = "tokenhub-provider";

export const TOKENHUB_PROVIDER_ID = "tokenhub";

/** 广州站。新加坡站是另一套 Key，部署时把网关地址改成 `https://tokenhub-intl.tencentmaas.com`。 */
export const DEFAULT_TOKENHUB_BASE_URL = "https://tokenhub.tencentmaas.com";

export const TOKENHUB_PLUGIN_METADATA: ApplicationExtensionMetadata = {
  extensionId: TOKENHUB_PLUGIN_ID,
  name: "TokenHub Provider",
  description: "腾讯云 TokenHub。填写 API Key 后，从平台发现可用的文本、图片与视频模型。",
  version: "1.0.1",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "tokenhub-provider-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [],
  defaultEnabled: true
};

/** 去掉末尾斜杠和误粘的 `/v1`，后续路径自己带版本。 */
export function tokenHubOrigin(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}
