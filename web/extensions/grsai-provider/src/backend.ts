/**
 * grsai Provider 后端插件入口。
 *
 * 声明 `providers.grsai` 配置段，向 `ctx.generation` 注册。模型来自公开模型列表
 * （`POST /client/serverGrsai/getModelListV2`，不需要 Key）：凭据加载后会发现一次，
 * 设置页可以再刷新。参考图由插件自己上传（`uploadReference`），不依赖宿主存储签名。
 */
import {
  defineConfigSchema,
  type GenerationProvider,
  type ExtensionPlugin,
} from "@woohaa3/contracts";
import { discoverGrsaiModels, grsaiModelDefinitions, type GrsaiModel } from "./discovery.js";
import { createProviderLifecycleFetch, createGuardedFetch, registerModelRefreshRoute } from "@woohaa3/provider-sdk";
import { createGrsaiProvider, type GrsaiCatalog } from "./provider.js";
import { describeGrsaiModel } from "./schema.js";
import { DEFAULT_GRSAI_BASE_URL, GRSAI_PLUGIN_ID, GRSAI_PROVIDER_ID, grsaiOrigin } from "./shared.js";
import { uploadGrsaiReference } from "./upload.js";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const REFRESH_PATH = "/api/providers/grsai/refresh";

export const GRSAI_CONFIG = defineConfigSchema({
  apiKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "GRSAI_API_KEY",
    label: "API Key",
    description: "grsai API Key，请求头使用 Bearer"
  },
  baseUrl: {
    kind: "url",
    protocols: ["https:", "http:"],
    default: DEFAULT_GRSAI_BASE_URL,
    reload: "hot",
    legacyEnv: "GRSAI_BASE_URL",
    label: "API 地址",
    description: "国内 https://grsai.dakka.com.cn，海外 https://grsaiapi.com（两套 Key 不互通）"
  }
});

export type GrsaiRegistrationInput = {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof globalThis.fetch;
  jobRepository?: unknown;
  discovered?: readonly GrsaiModel[];
};

export type GrsaiPluginDependencies = Pick<GrsaiRegistrationInput, "timeoutMs" | "maxBytes" | "fetchImpl" | "jobRepository">;

/**
 * `available` 需要 API Key 与地址。模型表为空（还没发现）时仍注册，设置页能看到插件并预填。
 */
export function createGrsaiRegistration(input: GrsaiRegistrationInput): { registration: GenerationProvider; catalog: GrsaiCatalog } {
  const apiKey = (input.apiKey ?? "").trim();
  const baseUrl = (input.baseUrl ?? DEFAULT_GRSAI_BASE_URL).trim();
  const available = apiKey !== "" && baseUrl !== "";
  const catalog: GrsaiCatalog = { models: [...(input.discovered ?? [])] };
  const guarded = createGuardedFetch({
    baseUrl,
    maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // 语音模型会下载音频，按需放行 audio/*（缺省只允许图片）。
    allowedContentTypes: ["image/", "audio/"],
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  const provider = available
    ? createGrsaiProvider({
        apiKey,
        baseURL: baseUrl,
        catalog,
        ...(input.jobRepository ? { jobRepository: input.jobRepository } : {}),
        fetch: guarded
      })
    : undefined;
  return {
    catalog,
    registration: {
      extensionId: GRSAI_PLUGIN_ID,
      providerId: GRSAI_PROVIDER_ID,
      available,
      provider,
      models: grsaiModelDefinitions(catalog.models),
      describeModel: (model) => {
        const found = catalog.models.find((item) => item.id === model.providerModelId);
        if (!found) return undefined;
        return describeGrsaiModel(found);
      },
      // 参考图直接传到 grsai 的素材服务（令牌 → 七牛上传），不依赖宿主存储的签名能力。
      uploadReference: async ({ bytes, contentType }) => {
        if (!available) return undefined;
        const url = await uploadGrsaiReference({
          origin: grsaiOrigin(baseUrl),
          apiKey,
          bytes,
          contentType,
          tokenFetch: guarded,
          uploadFetch: input.fetchImpl ?? globalThis.fetch
        });
        return url ? { url } : undefined;
      }
    }
  };
}

export function createGrsaiProviderPlugin(deps: GrsaiPluginDependencies = {}): ExtensionPlugin<typeof GRSAI_CONFIG.fields> {
  return {
    name: GRSAI_PLUGIN_ID,
    label: "grsai",
    configPrefix: "providers.grsai",
    website: "https://grsai.ai",
    modelTypes: ["language", "image", "video"],
    // 设置页「可用模型」一节由插件声明驱动：宿主不硬编码 Provider 的刷新入口。
    modelRefresh: { path: REFRESH_PATH, hint: "模型从 grsai 的公开模型表发现，下线或维护中的模型不会注册。保存 API Key 和 API 地址后会发现一次，也可以再刷新。图片和视频走统一生成接口，文本走 OpenAI 兼容对话接口。" },
    inject: ["log", "generation", "gateway", "access"],
    Config: GRSAI_CONFIG,
    health: (config) => {
      const apiKey = (config.apiKey ?? "").trim();
      const baseUrl = (config.baseUrl ?? DEFAULT_GRSAI_BASE_URL).trim();
      if (apiKey !== "" && baseUrl !== "") return undefined;
      return {
        state: "degraded" as const,
        diagnostics: [{
          code: "provider-credentials-missing",
          message: apiKey === "" ? "未配置 API Key，grsai 模型当前不可执行" : "API 地址为空，grsai 模型当前不可执行"
        }]
      };
    },
    async apply(ctx, config) {
      const apiKey = config.apiKey?.trim() ?? "";
      const baseUrl = config.baseUrl;
      const log = ctx.log.scope(GRSAI_PLUGIN_ID);
      const { registration, catalog } = createGrsaiRegistration({
        ...deps,
        fetchImpl: createProviderLifecycleFetch(ctx, deps.fetchImpl),
        ...(apiKey ? { apiKey } : {}),
        baseUrl
      });
      const refresh = async (): Promise<{ ok: true; modelCount: number; message?: string } | { ok: false; message: string }> => {
        if (!registration.available) return { ok: false, message: "先配置 API Key 和 API 地址" };
        const result = await discoverGrsaiModels({
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
        });
        if (!result.ok) {
          log({ event: "grsai-model-discovery-failed", message: result.message });
          return result;
        }
        catalog.models.splice(0, catalog.models.length, ...result.models);
        registration.models.splice(0, registration.models.length, ...grsaiModelDefinitions(result.models));
        log({ event: "grsai-models-discovered", modelCount: result.models.length });
        return { ok: true, modelCount: result.models.length, ...(result.message ? { message: result.message } : {}) };
      };
      if (registration.available) await refresh();
      ctx.effect(() => ctx.generation.register(registration));
      registerModelRefreshRoute(ctx, { path: REFRESH_PATH, refresh });
      log({ event: "grsai-plugin-activated", available: registration.available, modelCount: registration.models.length });
    }
  };
}
