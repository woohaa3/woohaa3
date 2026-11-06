/**
 * 百炼（Model Studio / DashScope）Provider 的共享身份与端点常量。
 *
 * 只有生图：模型走同步的多模态生成接口，文生图与参考图编辑是同一个端点，差别只在
 * `input.messages[0].content` 里有没有 `{ image }` 项。本文件不含执行实现、网络或秘密。
 */
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";

export const BAILIAN_PLUGIN_ID = "bailian-provider";

export const BAILIAN_PROVIDER_ID = "bailian";

/**
 * 北京地域的公开域名。新加坡站是 `https://dashscope-intl.aliyuncs.com`。
 *
 * 两套 Key 不互通；控制台现在推荐工作空间域名
 * `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`（新加坡 `ap-southeast-1`），
 * 所以地址必须可配。
 */
export const DEFAULT_BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com";

/** 同步生图接口：文生图与图片编辑共用。 */
export const BAILIAN_IMAGE_PATH = "/api/v1/services/aigc/multimodal-generation/generation";

export const BAILIAN_PLUGIN_METADATA: ApplicationExtensionMetadata = {
  extensionId: BAILIAN_PLUGIN_ID,
  name: "百炼 Provider",
  description: "阿里云百炼（Model Studio）生图 Provider。填写 DashScope API Key 后可用通义万相与 Qwen-Image 系列做文生图和多图参考编辑。",
  version: "1.0.0",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "bailian-provider-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [],
  defaultEnabled: true
};

/** 去掉末尾斜杠，后续路径自己带版本。 */
export function bailianOrigin(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}
