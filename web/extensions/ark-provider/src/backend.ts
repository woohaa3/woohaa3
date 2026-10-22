/**
 * Ark（火山方舟）Provider 后端插件入口。
 *
 * 声明 `providers.ark` 配置段，向 `ctx.generation` 注册内置目录里的文本、图片和视频模型。
 * 执行协议由本扩展 `src/provider/` 拥有（复用 `@sdppp/pptask` 的 core 类型与 shared toolkit）；
 * 参考图素材库仍由本扩展在视频提交前替换。
 */
import {
  defineConfigSchema,
  type GenerationModelDescription,
  type GenerationProvider,
  type HostConfigValues,
  type HostExtensionPlugin
} from "@woohaa3/contracts";
import { arkApiRoot, createArkProvider, describeArkModel } from "./provider/index.js";
import { ARK_DEFAULT_BASE_URL, ARK_PLUGIN_ID, ARK_PROVIDER_ID, arkEndpointFields, arkModelDefinitions, endpointsFromConfig, type ArkEndpointMap } from "./shared.js";
import { createArkImageMaterializer, resolveArkAssetConfig, type ArkAssetConfig } from "./assets.js";

export { ARK_DEFAULT_BASE_URL, ARK_PROVIDER_ID };

export const ARK_CONFIG = defineConfigSchema({
  apiKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "ARK_VIDEO_API_KEY",
    label: "API Key",
    description: "火山方舟 API Key"
  },
  baseUrl: {
    kind: "url",
    protocols: ["https:", "http:"],
    default: ARK_DEFAULT_BASE_URL,
    reload: "hot",
    legacyEnv: "ARK_VIDEO_GENERATION_URL",
    label: "API 地址",
    description: "方舟 API 根路径。若填的是旧的视频任务地址，会自动去掉 /contents/generations/tasks"
  },
  ...arkEndpointFields(),
  assetAccessKeyId: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "ARK_ASSET_ACCESS_KEY_ID",
    label: "素材库 AccessKeyId",
    description: "火山引擎 OpenAPI 的 AccessKeyId；与 SecretAccessKey、分组一起配置才启用素材库"
  },
  assetSecretAccessKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "ARK_ASSET_SECRET_ACCESS_KEY",
    label: "素材库 SecretAccessKey",
    description: "火山引擎 OpenAPI 的 SecretAccessKey"
  },
  assetGroupId: {
    kind: "string",
    reload: "hot",
    legacyEnv: "ARK_ASSET_GROUP_ID",
    label: "素材库分组",
    description: "视频参考图先注册到这个素材分组；留空则不使用素材库"
  },
  assetProjectName: {
    kind: "string",
    default: "default",
    reload: "hot",
    legacyEnv: "ARK_ASSET_PROJECT_NAME",
    label: "素材库项目",
    description: "火山引擎项目名"
  },
  assetRegion: {
    kind: "string",
    default: "cn-beijing",
    reload: "hot",
    legacyEnv: "ARK_ASSET_REGION",
    label: "素材库区域",
    description: "火山引擎区域"
  },
  assetService: {
    kind: "string",
    default: "ark",
    reload: "hot",
    legacyEnv: "ARK_ASSET_SERVICE",
    label: "素材库服务名",
    description: "签名用的服务名"
  },
  assetEndpoint: {
    kind: "url",
    protocols: ["https:"],
    default: "https://ark.cn-beijing.volcengineapi.com",
    reload: "hot",
    legacyEnv: "ARK_ASSET_ENDPOINT",
    label: "素材库地址",
    description: "素材库 OpenAPI 地址"
  },
  assetPollTimeoutMs: {
    kind: "integer",
    min: 1,
    default: 120_000,
    reload: "hot",
    legacyEnv: "ARK_ASSET_POLL_TIMEOUT_MS",
    label: "素材注册超时（毫秒）",
    description: "等待素材变为可用的上限"
  },
  assetPollIntervalMs: {
    kind: "integer",
    min: 1,
    default: 1_000,
    reload: "hot",
    legacyEnv: "ARK_ASSET_POLL_INTERVAL_MS",
    label: "素材轮询间隔（毫秒）",
    description: "查询素材状态的间隔"
  }
});

export type ArkConfig = HostConfigValues<typeof ARK_CONFIG.fields>;

export type ArkRegistrationInput = {
  apiKey?: string;
  assets?: ArkAssetConfig;
  baseUrl?: string;
  /** 目录模型 ID → 推理接入点。只有这里有的模型会注册。 */
  endpoints?: ArkEndpointMap;
  fetchImpl?: typeof globalThis.fetch;
  jobRepository?: unknown;
};

export type ArkPluginDependencies = Pick<ArkRegistrationInput, "fetchImpl" | "jobRepository">;

export function createArkRegistration(input: ArkRegistrationInput): GenerationProvider {
  const apiKey = (input.apiKey ?? "").trim();
  const baseURL = arkApiRoot(input.baseUrl ?? ARK_DEFAULT_BASE_URL);
  const endpoints = input.endpoints ?? {};
  const models = arkModelDefinitions(endpoints);
  const available = apiKey !== "" && baseURL !== "";
  const provider = available
    ? createArkProvider({
        apiKey,
        baseURL,
        endpoints,
        ...(input.assets ? { materializeImage: createArkImageMaterializer(input.assets, input.fetchImpl) } : {}),
        ...(input.jobRepository ? { jobRepository: input.jobRepository as never } : {}),
        ...(input.fetchImpl ? { fetch: input.fetchImpl } : {})
      })
    : undefined;
  return {
    extensionId: ARK_PLUGIN_ID,
    providerId: ARK_PROVIDER_ID,
    available,
    provider,
    models,
    describeModel: ({ providerModelId }) => {
      if (!models.some((model) => model.providerModelId === providerModelId)) return undefined;
      return describeArkModel(providerModelId) as GenerationModelDescription;
    }
  };
}

export function createArkProviderPlugin(deps: ArkPluginDependencies = {}): HostExtensionPlugin<typeof ARK_CONFIG.fields> {
  return {
    name: ARK_PLUGIN_ID,
    label: "Ark（火山方舟）",
    configPrefix: "providers.ark",
    inject: ["log", "generation"],
    Config: ARK_CONFIG,
    health: (config) => {
      const hasKey = (config.apiKey ?? "").trim() !== "";
      const { endpoints, errors } = endpointsFromConfig(config);
      if (hasKey && errors.length === 0 && Object.keys(endpoints).length > 0) return undefined;
      const message = !hasKey
        ? "未配置 API Key，Ark 模型当前不可执行"
        : errors[0] ?? "还没有为模型填写推理接入点";
      return {
        state: "degraded" as const,
        diagnostics: [
          {
            code: hasKey ? "provider-models-unconfigured" : "provider-credentials-missing",
            message
          }
        ]
      };
    },
    apply(ctx, config) {
      const log = ctx.log.scope(ARK_PLUGIN_ID);
      const assets = resolveArkAssetConfig(
        {
          ...(config.assetGroupId ? { groupId: config.assetGroupId } : {}),
          projectName: config.assetProjectName,
          region: config.assetRegion,
          service: config.assetService,
          endpoint: config.assetEndpoint,
          pollTimeoutMs: config.assetPollTimeoutMs,
          pollIntervalMs: config.assetPollIntervalMs
        },
        {
          ...(config.assetAccessKeyId ? { accessKeyId: config.assetAccessKeyId } : {}),
          ...(config.assetSecretAccessKey ? { secretAccessKey: config.assetSecretAccessKey } : {})
        }
      );
      const { endpoints } = endpointsFromConfig(config);
      const registration = createArkRegistration({
        ...deps,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(assets ? { assets } : {}),
        baseUrl: config.baseUrl,
        endpoints
      });
      ctx.effect(() => ctx.generation.register(registration));
      log({
        event: "ark-plugin-activated",
        available: registration.available,
        modelCount: registration.models.length,
        imageAssetsEnabled: Boolean(assets)
      });
    }
  };
}
