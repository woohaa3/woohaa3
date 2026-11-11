/**
 * Cephalon Provider 后端插件入口。
 *
 * 声明 `providers.cephalon` 配置段（只有 `apiKey`，平台地址固定在 shared.ts），
 * 凭据就绪后请求平台模型列表并注册 provider 与目录。目录完全由发现结果派生：
 * 代码中没有内置模型 id，平台下架后下一次成功发现即从目录消失。
 *
 * 发现失败时保留上一次成功发现的模型集合（内存态，不落盘），诊断只记稳定 code。
 */
import {
  defineConfigSchema,
  type GenerationModelDescription,
  type GenerationProvider,
  type ExtensionPlugin
} from "@woohaa3/contracts";
import { createProviderLifecycleFetch, createGuardedFetch, registerModelRefreshRoute } from "@woohaa3/provider-sdk";
import { cephalonModelDefinitions, discoverCephalonModels, type DiscoveredModel } from "./discovery.js";
import { createCephalonProvider, describeCephalonModel } from "./provider.js";
import { CEPHALON_CHAT_BASE, CEPHALON_ORIGIN, CEPHALON_PLUGIN_ID, CEPHALON_PROVIDER_ID } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const REFRESH_PATH = "/api/providers/cephalon/refresh";

export const CEPHALON_CONFIG = defineConfigSchema({
  apiKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "CEPHALON_API_KEY",
    label: "API Key",
    description: "端脑云 API Key，请求头使用 Bearer。平台地址固定为 https://cephalon.cloud"
  }
});

export type CephalonRegistrationInput = {
  apiKey?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof globalThis.fetch;
  jobRepository?: unknown;
  models?: readonly DiscoveredModel[];
};

export type CephalonPluginDependencies = Pick<
  CephalonRegistrationInput,
  "timeoutMs" | "maxBytes" | "fetchImpl" | "jobRepository"
>;

/**
 * 构造注册项。`available` 只看凭据：发现失败是上游瞬时问题，不该把已配置的
 * Provider 标成不可用，旧目录继续可用。
 */
export function createCephalonRegistration(input: CephalonRegistrationInput): { registration: GenerationProvider } {
  const apiKey = (input.apiKey ?? "").trim();
  const available = apiKey !== "";
  const models: DiscoveredModel[] = [...(input.models ?? [])];
  const guardedFetch = (options: { validate?: () => Promise<void>; apiFetchImpl?: typeof globalThis.fetch } = {}) =>
    createGuardedFetch({
      baseUrl: CEPHALON_ORIGIN,
      maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // 图片结果由 Provider 自己下载成字节；视频只回地址，交给宿主入库流程。
      allowedContentTypes: ["image/", "video/"],
      ...options,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
    });
  const provider = available
    ? createCephalonProvider({
        apiKey,
        models,
        ...(input.jobRepository ? { jobRepository: input.jobRepository as never } : {}),
        fetch: guardedFetch()
      })
    : undefined;
  return {
    registration: {
      extensionId: CEPHALON_PLUGIN_ID,
      providerId: CEPHALON_PROVIDER_ID,
      available,
      provider,
      models: cephalonModelDefinitions(models),
      // 文本模型按 OpenAI 兼容对话协议接入助手：平台地址固定，来源只能换 Key，不能改写主机。
      serviceConnectionFactory: {
        protocols: ["chat-completions"],
        assistantProtocol: "chat-completions",
        endpoints: { "chat-completions": CEPHALON_CHAT_BASE },
        create: ({ secret, validate, fetch: sourceFetch }) =>
          createCephalonProvider({
            apiKey: secret,
            models,
            ...(input.jobRepository ? { jobRepository: input.jobRepository as never } : {}),
            fetch: guardedFetch({ validate, ...(sourceFetch ? { apiFetchImpl: sourceFetch } : {}) })
          })
      },
      languageCapabilities: (providerModelId) => {
        const model = models.find((item) => item.id === providerModelId && item.modelType === "language");
        return model ? { imageInput: model.supportsVision === true } : undefined;
      },
      describeModel: (model) =>
        describeCephalonModel(
          model.providerModelId,
          model.modelType,
          models.find((item) => item.id === model.providerModelId)
        ) as GenerationModelDescription | undefined
    }
  };
}

export function createCephalonProviderPlugin(
  deps: CephalonPluginDependencies = {}
): ExtensionPlugin<typeof CEPHALON_CONFIG.fields> {
  // 上一次成功发现的结果：发现失败时回退到它，而不是清空目录或内置兜底清单。
  let lastDiscovered: DiscoveredModel[] = [];
  return {
    name: CEPHALON_PLUGIN_ID,
    label: "端脑云",
    configPrefix: "providers.cephalon",
    setupOrder: 30,
    website: "https://cephalon.cloud/share/register-landing?invite_id=m95SDj",
    modelTypes: ["language", "image", "video"],
    // 设置页「可用模型」一节由插件声明驱动：宿主不硬编码 Provider 的刷新入口。
    modelRefresh: {
      path: REFRESH_PATH,
      hint: "模型从端脑云的模型列表接口发现，平台下架的模型不会注册。填入 API Key 后会发现一次，也可以再刷新。文本走 OpenAI 兼容对话接口，图片走图片生成接口，视频走异步任务接口。"
    },
    inject: ["log", "generation", "gateway", "access"],
    Config: CEPHALON_CONFIG,
    health: (config) => {
      if ((config.apiKey ?? "").trim() !== "") return undefined;
      return {
        state: "degraded" as const,
        diagnostics: [
          {
            code: "provider-credentials-missing",
            message: "未配置 API Key，端脑云模型当前不可执行"
          }
        ]
      };
    },
    async testConnection(config) {
      const apiKey = (config.apiKey ?? "").trim();
      if (!apiKey) return { ok: false, message: "请先填写端脑云 API Key" };
      const result = await discoverCephalonModels({
        apiKey,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        timeoutMs: 10_000
      });
      if (!result.ok) return { ok: false, message: result.message };
      return { ok: true, message: `测试通过，已发现 ${result.models.length} 个模型` };
    },
    async apply(ctx, config) {
      const apiKey = config.apiKey?.trim() ?? "";
      const log = ctx.log.scope(CEPHALON_PLUGIN_ID);
      const { registration } = createCephalonRegistration({
        ...deps,
        fetchImpl: createProviderLifecycleFetch(ctx, deps.fetchImpl),
        ...(apiKey ? { apiKey } : {}),
        // 有 Key 时先带上一次成功目录，发现成功后再整体替换。
        models: apiKey ? lastDiscovered : []
      });
      if (!apiKey) lastDiscovered = [];

      const refresh = async (): Promise<{ ok: true; modelCount: number } | { ok: false; message: string }> => {
        if (!registration.available) return { ok: false, message: "先配置 API Key" };
        const result = await discoverCephalonModels({
          apiKey,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
        });
        if (!result.ok) {
          // 只记稳定事件名与脱敏原因（discovery 已去掉 Key 与响应正文）。
          log({ event: "cephalon-model-discovery-failed", message: result.message });
          return result;
        }
        lastDiscovered = result.models;
        registration.models.splice(0, registration.models.length, ...cephalonModelDefinitions(result.models));
        log({ event: "cephalon-models-discovered", modelCount: registration.models.length });
        return { ok: true, modelCount: registration.models.length };
      };

      if (registration.available) await refresh();
      ctx.effect(() => ctx.generation.register(registration));
      registerModelRefreshRoute(ctx, { path: REFRESH_PATH, refresh });
      log({ event: "cephalon-plugin-activated", available: registration.available, modelCount: registration.models.length });
    }
  };
}
