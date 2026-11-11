/**
 * DeepSeek 官方 Provider 后端插件入口。
 *
 * 声明 `providers.deepseek` 配置段（只有 `apiKey`，官方地址固定在 `shared.ts`），
 * 凭据就绪后请求 `GET /models` 并注册 provider 与目录。目录完全由发现结果派生：
 * 代码里没有内置模型 id，官方下架或改名后下一次成功发现即生效。
 *
 * 发现失败保留上一次成功发现的结果（进程内存，不落盘），诊断只记稳定事件名与脱敏原因。
 */
import {
  defineConfigSchema,
  type GenerationModelDescription,
  type GenerationProvider,
  type ExtensionPlugin
} from "@woohaa3/contracts";
import { createProviderLifecycleFetch, createGuardedFetch, registerModelRefreshRoute } from "@woohaa3/provider-sdk";
import {
  deepSeekLanguageCapabilities,
  deepSeekModelDefinitions,
  discoverDeepSeekModels,
  type DeepSeekModel
} from "./discovery.js";
import { createDeepSeekProvider, describeDeepSeekModel } from "./provider.js";
import { DEEPSEEK_CHAT_ENDPOINT, DEEPSEEK_ORIGIN, DEEPSEEK_PLUGIN_ID, DEEPSEEK_PROVIDER_ID } from "./shared.js";

/** 文本可能长时间生成，只防永久挂起；任务级上界由运行时按模型类型判定。 */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const REFRESH_PATH = "/api/providers/deepseek/refresh";

export const DEEPSEEK_CONFIG = defineConfigSchema({
  apiKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "DEEPSEEK_API_KEY",
    label: "API Key",
    description: "DeepSeek 官方 API Key，请求头使用 Bearer。平台地址固定为 https://api.deepseek.com"
  }
});

export type DeepSeekRegistrationInput = {
  apiKey?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof globalThis.fetch;
  jobRepository?: unknown;
  models?: readonly DeepSeekModel[];
};

export type DeepSeekPluginDependencies = Pick<
  DeepSeekRegistrationInput,
  "timeoutMs" | "maxBytes" | "fetchImpl" | "jobRepository"
>;

/**
 * 构造注册项。`available` 只看凭据：发现失败是上游瞬时问题，不该把已配置的 Provider
 * 标成不可用，上一次成功的目录继续可用。
 *
 * 返回的可变 `models` 数组是**目录事实的同一份引用**：provider 与刷新都读写它，
 * 刷新后已构造的 provider 立刻看到新的视觉/输出上限/档位事实，不会停在启动时的快照。
 */
export function createDeepSeekRegistration(
  input: DeepSeekRegistrationInput
): { registration: GenerationProvider; models: DeepSeekModel[] } {
  const apiKey = (input.apiKey ?? "").trim();
  const available = apiKey !== "";
  const models: DeepSeekModel[] = [...(input.models ?? [])];
  const guarded = createGuardedFetch({
    baseUrl: DEEPSEEK_ORIGIN,
    maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // 文本 Provider 不下载媒体：只放行图片，避免任何响应被当成素材落盘。
    allowedContentTypes: ["image/"],
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  const provider = available
    ? createDeepSeekProvider({
        apiKey,
        models,
        ...(input.jobRepository ? { jobRepository: input.jobRepository as never } : {}),
        fetch: guarded
      })
    : undefined;
  return {
    registration: {
      extensionId: DEEPSEEK_PLUGIN_ID,
      providerId: DEEPSEEK_PROVIDER_ID,
      available,
      provider,
      // 个人 API Key 来源：同一协议下按来源自己的凭据与地址执行，站点目录不被改写。
      serviceConnectionFactory: {
        protocols: ["chat-completions"],
        assistantProtocol: "chat-completions",
        // 地址固定：来源不提供 baseUrl 配置项，按协议声明官方入口（Agent 侧据此拼
        // `<baseUrl>/chat/completions`），不把凭据发往任意主机。
        endpoints: { "chat-completions": DEEPSEEK_CHAT_ENDPOINT },
        create: ({ secret, validate, fetch: sourceFetch }) => createDeepSeekProvider({
          apiKey: secret,
          models,
          ...(input.jobRepository ? { jobRepository: input.jobRepository as never } : {}),
          fetch: createGuardedFetch({
            baseUrl: DEEPSEEK_ORIGIN,
            maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
            timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            allowedContentTypes: ["image/"],
            validate,
            ...(sourceFetch ? { apiFetchImpl: sourceFetch } : {}),
            ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
          })
        } as never)
      },
      models: deepSeekModelDefinitions(models),
      languageCapabilities: (providerModelId) => deepSeekLanguageCapabilities(models, providerModelId),
      describeModel: (model) =>
        describeDeepSeekModel(
          model.providerModelId,
          model.modelType,
          models.find((item) => item.id === model.providerModelId)
        ) as GenerationModelDescription | undefined
    },
    models
  };
}

export function createDeepSeekProviderPlugin(
  deps: DeepSeekPluginDependencies = {}
): ExtensionPlugin<typeof DEEPSEEK_CONFIG.fields> {
  // 上一次成功发现的结果：发现失败时回退到它，而不是清空目录或内置兜底清单。
  let lastDiscovered: DeepSeekModel[] = [];
  return {
    name: DEEPSEEK_PLUGIN_ID,
    label: "DeepSeek",
    configPrefix: "providers.deepseek",
    setupOrder: 25,
    website: "https://platform.deepseek.com",
    modelTypes: ["language"],
    // 设置页「可用模型」一节由插件声明驱动：宿主不硬编码 Provider 的刷新入口。
    modelRefresh: {
      path: REFRESH_PATH,
      hint: "模型从 DeepSeek 官方模型列表发现（含上下文长度、输出上限与思考档位），官方下架或改名的模型不会注册。填入 API Key 后会发现一次，也可以再刷新。"
    },
    inject: ["log", "generation", "gateway", "access"],
    Config: DEEPSEEK_CONFIG,
    health: (config) => {
      if ((config.apiKey ?? "").trim() !== "") return undefined;
      return {
        state: "degraded" as const,
        diagnostics: [
          {
            code: "provider-credentials-missing",
            message: "未配置 API Key，DeepSeek 模型当前不可执行"
          }
        ]
      };
    },
    async testConnection(config) {
      const apiKey = (config.apiKey ?? "").trim();
      if (!apiKey) return { ok: false, message: "请先填写 DeepSeek API Key" };
      const result = await discoverDeepSeekModels({
        apiKey,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        timeoutMs: 10_000
      });
      if (!result.ok) return { ok: false, message: result.message };
      return { ok: true, message: `测试通过，已发现 ${result.models.length} 个模型` };
    },
    async apply(ctx, config) {
      const apiKey = config.apiKey?.trim() ?? "";
      const log = ctx.log.scope(DEEPSEEK_PLUGIN_ID);
      const { registration, models } = createDeepSeekRegistration({
        ...deps,
        // 停用或换 Key 后，残留的在途请求不再带旧凭据继续发出。
        fetchImpl: createProviderLifecycleFetch(ctx, deps.fetchImpl),
        ...(apiKey ? { apiKey } : {}),
        models: apiKey ? lastDiscovered : []
      });
      if (!apiKey) lastDiscovered = [];

      const refresh = async (): Promise<{ ok: true; modelCount: number } | { ok: false; message: string }> => {
        if (!registration.available) return { ok: false, message: "先配置 API Key" };
        const result = await discoverDeepSeekModels({
          apiKey,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
        });
        if (!result.ok) {
          log({ event: "deepseek-model-discovery-failed", message: result.message });
          return result;
        }
        lastDiscovered = result.models;
        // 目录事实与 provider 共用这一个数组：原地替换，provider 的视觉/档位判定立刻生效。
        models.splice(0, models.length, ...result.models);
        registration.models.splice(0, registration.models.length, ...deepSeekModelDefinitions(result.models));
        registration.catalogRevision = (registration.catalogRevision ?? 0) + 1;
        log({ event: "deepseek-models-discovered", modelCount: registration.models.length });
        return { ok: true, modelCount: registration.models.length };
      };

      if (registration.available) await refresh();
      ctx.effect(() => ctx.generation.register(registration));
      registerModelRefreshRoute(ctx, { path: REFRESH_PATH, refresh });
      log({ event: "deepseek-plugin-activated", available: registration.available, modelCount: registration.models.length });
    }
  };
}
