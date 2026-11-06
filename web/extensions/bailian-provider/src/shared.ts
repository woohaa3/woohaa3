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
 * 老公开域名（北京）。文档仍标注「现有域名可正常使用」，所以保留为缺省兜底。
 *
 * 新加坡站是 `https://dashscope-intl.aliyuncs.com`，两套 Key 不互通。
 */
export const DEFAULT_BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com";

/**
 * 业务空间专属域名的缺省地域（华北 2）。
 *
 * 百炼为北京 / 新加坡推出了 `https://{WorkspaceId}.{region}.maas.aliyuncs.com`，官方建议迁移：
 * 推理性能与稳定性更好。域名里带业务空间 ID，没法当常量写死，只能由配置拼出来。
 */
export const DEFAULT_BAILIAN_REGION = "cn-beijing";

/**
 * 有业务空间专属域名的地域（模型列表页逐个给出的 maas 主机）。
 *
 * 美国（弗吉尼亚）不在其中：那一站仍然是 `https://dashscope-us.aliyuncs.com`，没有
 * `{WorkspaceId}.us-east-1.maas.aliyuncs.com` 这种主机。所以美国用户不填业务空间 ID，
 * 直接填 API 地址。
 */
export const BAILIAN_REGIONS = [
  "cn-beijing",
  "ap-southeast-1",
  "cn-hongkong",
  "ap-northeast-1",
  "eu-central-1"
] as const;

export type BailianRegion = (typeof BAILIAN_REGIONS)[number];

/** 同步生图接口：文生图与图片编辑共用。 */
export const BAILIAN_IMAGE_PATH = "/api/v1/services/aigc/multimodal-generation/generation";

/** 模型列表（`GET`，`capabilities=IG` 只取生图）。 */
export const BAILIAN_MODELS_PATH = "/api/v1/models";

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

/**
 * 业务空间 ID → 专属域名。
 *
 * 只接受「像业务空间 ID」的值（字母数字与 `-`），避免把整条 URL 或空串拼进主机名后发出一个
 * 必然失败的请求；不合法时返回 undefined，调用方回退到 `baseUrl`。
 */
export function bailianWorkspaceOrigin(
  workspaceId: string | undefined,
  region: string = DEFAULT_BAILIAN_REGION
): string | undefined {
  const id = (workspaceId ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(id)) return undefined;
  const zone = (BAILIAN_REGIONS as readonly string[]).includes(region) ? region : DEFAULT_BAILIAN_REGION;
  return `https://${id}.${zone}.maas.aliyuncs.com`;
}
