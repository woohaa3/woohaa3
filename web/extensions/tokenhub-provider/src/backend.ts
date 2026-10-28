/**
 * TokenHub Provider 后端插件入口。
 *
 * 声明 `providers.tokenhub` 配置段，向 `ctx.generation` 注册 provider 与发现到的模型。
 * apiKey 是 secret，不进入公开响应。模型不写死：凭据加载后请求 `GET /v1/models`，设置页可再刷新。
 */
import {
  defineConfigSchema,
  type GenerationModelDescription,
  type GenerationProvider,
  type ExtensionPlugin,
} from "@woohaa3/contracts";
import { discoverTokenHubModels, tokenHubModelDefinitions, type DiscoveredModel } from "./discovery.js";
import { createProviderLifecycleFetch, createGuardedFetch, registerModelRefreshRoute } from "@woohaa3/provider-sdk";
import { describeTokenHubModel, createTokenHubProvider } from "./provider.js";
import { DEFAULT_TOKENHUB_BASE_URL, TOKENHUB_PLUGIN_ID, TOKENHUB_PROVIDER_ID } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const REFRESH_PATH = "/api/providers/tokenhub/refresh";

export const TOKENHUB_CONFIG = defineConfigSchema({
  apiKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "TOKENHUB_API_KEY",
    label: "API Key",
    description: "TokenHub API Key。广州与新加坡的 Key 不互通"
  },
  baseUrl: {
    kind: "url",
    protocols: ["https:", "http:"],
    default: DEFAULT_TOKENHUB_BASE_URL,
    reload: "hot",
    legacyEnv: "TOKENHUB_BASE_URL",
    label: "网关地址",
    description: "广州 https://tokenhub.tencentmaas.com，新加坡 https://tokenhub-intl.tencentmaas.com"
  }
});

export type TokenHubRegistrationInput = {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof globalThis.fetch;
  jobRepository?: unknown;
  models?: readonly DiscoveredModel[];
};

export type TokenHubPluginDependencies = Pick<TokenHubRegistrationInput, "timeoutMs" | "maxBytes" | "fetchImpl" | "jobRepository">;

/**
 * `available` 只有 apiKey 与 baseUrl 都就绪时为真。未配置时仍注册，设置页显示「未配置」。
 */
export function createTokenHubRegistration(input: TokenHubRegistrationInput): { registration: GenerationProvider } {
  const apiKey = (input.apiKey ?? "").trim();
  const baseUrl = (input.baseUrl ?? DEFAULT_TOKENHUB_BASE_URL).trim();
  const available = apiKey !== "" && baseUrl !== "";
  const provider = available
    ? createTokenHubProvider({
        apiKey,
        baseURL: baseUrl,
        ...(input.jobRepository ? { jobRepository: input.jobRepository as never } : {}),
        fetch: createGuardedFetch({
          baseUrl,
          maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          // 语音模型会下载音频，按需放行 audio/*（缺省只允许图片）。
    allowedContentTypes: ["image/", "audio/"],
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
        })
      } as never)
    : undefined;
  const models = tokenHubModelDefinitions(input.models ?? []);
  return {
    registration: {
      extensionId: TOKENHUB_PLUGIN_ID,
      providerId: TOKENHUB_PROVIDER_ID,
      available,
      provider,
      serviceConnectionFactory: {
        protocols: [`provider:${TOKENHUB_PROVIDER_ID}`, "chat-completions"], assistantProtocol: "chat-completions",
        create: ({ secret, endpoint, validate, fetch: sourceFetch }) => createTokenHubProvider({
          apiKey: secret, baseURL: endpoint,
          ...(input.jobRepository ? { jobRepository: input.jobRepository as never } : {}),
          fetch: createGuardedFetch({ baseUrl: endpoint, maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
            timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, validate, allowedContentTypes: ["image/", "audio/"],
            ...(sourceFetch ? { apiFetchImpl: sourceFetch } : {}),
            ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) }),
        } as never),
      },
      models,
      describeModel: (model) => describeTokenHubModel(model.providerModelId, model.modelType) as GenerationModelDescription | undefined
    }
  };
}

export function createTokenHubProviderPlugin(deps: TokenHubPluginDependencies = {}): ExtensionPlugin<typeof TOKENHUB_CONFIG.fields> {
  return {
    name: TOKENHUB_PLUGIN_ID,
    label: "TokenHub",
    configPrefix: "providers.tokenhub",
    modelTypes: ["language", "image", "video"],
    // 设置页「可用模型」一节由插件声明驱动：宿主不硬编码 Provider 的刷新入口。
    modelRefresh: { path: REFRESH_PATH, hint: "模型从 TokenHub 的模型列表接口发现。保存 API Key 和网关地址后会发现一次，也可以再刷新。文本走对话接口；图片和视频按模型系列调用对应的生成接口。" },
    inject: ["log", "generation", "gateway", "access"],
    Config: TOKENHUB_CONFIG,
    health: (config) => {
      const apiKey = (config.apiKey ?? "").trim();
      const baseUrl = (config.baseUrl ?? DEFAULT_TOKENHUB_BASE_URL).trim();
      if (apiKey !== "" && baseUrl !== "") return undefined;
      return {
        state: "degraded" as const,
        diagnostics: [
          {
            code: "provider-credentials-missing",
            message: apiKey === "" ? "未配置 API Key，TokenHub 模型当前不可执行" : "网关地址为空，TokenHub 模型当前不可执行"
          }
        ]
      };
    },
    async apply(ctx, config) {
      const apiKey = config.apiKey?.trim() ?? "";
      const baseUrl = config.baseUrl;
      const log = ctx.log.scope(TOKENHUB_PLUGIN_ID);
      const { registration } = createTokenHubRegistration({
        ...deps,
        fetchImpl: createProviderLifecycleFetch(ctx, deps.fetchImpl),
        ...(apiKey ? { apiKey } : {}),
        baseUrl
      });
      const refresh = async (): Promise<{ ok: true; modelCount: number } | { ok: false; message: string }> => {
        if (!registration.available || !apiKey) return { ok: false, message: "先配置 API Key 和网关地址" };
        const result = await discoverTokenHubModels({
          baseUrl,
          apiKey,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
        });
        if (!result.ok) {
          log({ event: "tokenhub-model-discovery-failed", message: result.message });
          return result;
        }
        registration.models.splice(0, registration.models.length, ...tokenHubModelDefinitions(result.models));
        log({ event: "tokenhub-models-discovered", modelCount: registration.models.length });
        return { ok: true, modelCount: registration.models.length };
      };
      if (registration.available) await refresh();
      ctx.effect(() => ctx.generation.register(registration));
      registerModelRefreshRoute(ctx, { path: REFRESH_PATH, refresh });
      log({ event: "tokenhub-plugin-activated", available: registration.available, modelCount: registration.models.length });
    }
  };
}

