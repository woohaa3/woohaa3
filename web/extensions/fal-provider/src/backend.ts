/**
 * fal.ai Provider 后端插件入口。
 *
 * 声明 `providers.fal` 配置段，向 `ctx.generation` 注册。模型来自配置里的 endpoint id 名单：
 * 凭据加载后逐个读取队列 OpenAPI 定义，设置页可再刷新。
 */
import {
  defineConfigSchema,
  type GenerationModelDescription,
  type GenerationProvider,
  type ExtensionPlugin,
} from "@woohaa3/contracts";
import { discoverFalModels } from "./discovery.js";
import { createProviderLifecycleFetch, createGuardedFetch, registerModelRefreshRoute } from "@woohaa3/provider-sdk";
import { createFalProvider, type FalCatalog } from "./provider.js";
import { falModelDefinitions, type FalModel } from "./schema.js";
import { DEFAULT_FAL_BASE_URL, FAL_PLUGIN_ID, FAL_PROVIDER_ID, falOrigin, parseModelIds } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const REFRESH_PATH = "/api/providers/fal/refresh";

export const FAL_CONFIG = defineConfigSchema({
  apiKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "FAL_KEY",
    label: "API Key",
    description: "fal API Key，请求头使用 `Authorization: Key <key>`"
  },
  baseUrl: {
    kind: "url",
    protocols: ["https:", "http:"],
    default: DEFAULT_FAL_BASE_URL,
    reload: "hot",
    legacyEnv: "FAL_BASE_URL",
    label: "API 地址",
    description: "默认 https://queue.fal.run（队列接口）"
  },
  models: {
    kind: "string",
    reload: "hot",
    label: "模型",
    description: "要接入的 endpoint id，逗号或换行分隔。例如 fal-ai/flux/schnell、fal-ai/kling-video/v3/pro/text-to-video"
  }
});

export type FalRegistrationInput = {
  apiKey?: string;
  baseUrl?: string;
  models?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof globalThis.fetch;
  jobRepository?: unknown;
  discovered?: readonly FalModel[];
};

export type FalPluginDependencies = Pick<FalRegistrationInput, "timeoutMs" | "maxBytes" | "fetchImpl" | "jobRepository">;

/**
 * `available` 需要 API Key、地址，以及至少一条合法的 endpoint id。
 * 未配齐时仍注册，设置页能看到插件并预填。
 */
export function createFalRegistration(input: FalRegistrationInput): { registration: GenerationProvider; catalog: FalCatalog } {
  const apiKey = (input.apiKey ?? "").trim();
  const baseUrl = (input.baseUrl ?? DEFAULT_FAL_BASE_URL).trim();
  const parsed = parseModelIds(input.models);
  const available = apiKey !== "" && baseUrl !== "" && parsed.ok && parsed.ids.length > 0;
  const catalog: FalCatalog = { models: [...(input.discovered ?? [])] };
  const provider = available
    ? createFalProvider({
        apiKey,
        baseURL: baseUrl,
        catalog,
        ...(input.jobRepository ? { jobRepository: input.jobRepository } : {}),
        fetch: createGuardedFetch({
          baseUrl,
          maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          // 语音模型会下载音频，按需放行 audio/*（缺省只允许图片）。
    allowedContentTypes: ["image/", "audio/"],
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
        })
      })
    : undefined;
  return {
    catalog,
    registration: {
      extensionId: FAL_PLUGIN_ID,
      providerId: FAL_PROVIDER_ID,
      available,
      provider,
      models: falModelDefinitions(catalog.models),
      describeModel: (model) => {
        const found = catalog.models.find((item) => item.id === model.providerModelId);
        if (!found) return undefined;
        return {
          title: found.title,
          inputSchema: found.inputSchema,
          defaultInput: found.defaultInput,
          promptRequirement: found.promptRequirement,
          cancel: "remote"
        } satisfies GenerationModelDescription;
      }
    }
  };
}

export function createFalProviderPlugin(deps: FalPluginDependencies = {}): ExtensionPlugin<typeof FAL_CONFIG.fields> {
  return {
    name: FAL_PLUGIN_ID,
    label: "fal.ai",
    configPrefix: "providers.fal",
    website: "https://fal.ai",
    modelTypes: ["language", "image", "video", "audio"],
    // 设置页「可用模型」一节由插件声明驱动：宿主不硬编码 Provider 的刷新入口。
    modelRefresh: { path: REFRESH_PATH, hint: "填写 API Key，以及要使用的模型（逗号或换行分隔，endpoint id，例如 fal-ai/flux/schnell 或 fal-ai/kling-video/v3/pro/text-to-video）。保存后会读取这些模型的队列定义，也可以再刷新。" },
    inject: ["log", "generation", "gateway", "access"],
    Config: FAL_CONFIG,
    health: (config) => {
      const apiKey = (config.apiKey ?? "").trim();
      const baseUrl = (config.baseUrl ?? DEFAULT_FAL_BASE_URL).trim();
      const parsed = parseModelIds(config.models);
      if (apiKey !== "" && baseUrl !== "" && parsed.ok && parsed.ids.length > 0) return undefined;
      const message = apiKey === ""
        ? "未配置 API Key，fal 模型当前不可执行"
        : baseUrl === ""
          ? "API 地址为空，fal 模型当前不可执行"
          : !parsed.ok
            ? parsed.message
            : "未填写模型。填 endpoint id，例如 fal-ai/flux/schnell";
      return { state: "degraded" as const, diagnostics: [{ code: "provider-credentials-missing", message }] };
    },
    async testConnection(config) {
      const apiKey = (config.apiKey ?? "").trim();
      const baseUrl = (config.baseUrl ?? DEFAULT_FAL_BASE_URL).trim();
      if (!apiKey || !baseUrl) return { ok: false, message: "请先填写 fal.ai API Key 和地址" };
      const parsed = parseModelIds(config.models);
      if (!parsed.ok) return { ok: false, message: parsed.message };
      const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
      if (parsed.ids.length > 0) {
        const result = await discoverFalModels({
          modelIds: parsed.ids,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          timeoutMs: 10_000
        });
        if (!result.ok) return { ok: false, message: result.message };
      }
      const probeEndpoint = parsed.ids[0] ?? "fal-ai/flux/schnell";
      try {
        const response = await fetchImpl(`${falOrigin(baseUrl)}/${probeEndpoint}/requests/00000000-0000-0000-0000-000000000000/status`, {
          method: "GET",
          headers: { authorization: `Key ${apiKey}`, accept: "application/json" },
          signal: AbortSignal.timeout(10_000)
        });
        if (response.status === 401 || response.status === 403) {
          return { ok: false, message: `fal.ai API Key 验证失败（HTTP ${response.status}）` };
        }
        return { ok: true, message: "fal.ai 连接测试通过" };
      } catch (error) {
        return { ok: false, message: `fal.ai 连接失败：${error instanceof Error ? error.message : String(error)}` };
      }
    },
    async apply(ctx, config) {
      const apiKey = config.apiKey?.trim() ?? "";
      const baseUrl = config.baseUrl;
      const log = ctx.log.scope(FAL_PLUGIN_ID);
      const { registration, catalog } = createFalRegistration({
        ...deps,
        fetchImpl: createProviderLifecycleFetch(ctx, deps.fetchImpl),
        ...(apiKey ? { apiKey } : {}),
        baseUrl,
        ...(config.models ? { models: config.models } : {})
      });
      const refresh = async (): Promise<{ ok: true; modelCount: number; message?: string } | { ok: false; message: string }> => {
        const parsed = parseModelIds(config.models);
        if (!registration.available || !apiKey || !parsed.ok) {
          return { ok: false, message: !parsed.ok ? parsed.message : "先配置 API Key 和模型名单" };
        }
        const result = await discoverFalModels({
          modelIds: parsed.ids,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
        });
        if (!result.ok) {
          log({ event: "fal-model-discovery-failed", message: result.message });
          return result;
        }
        catalog.models.splice(0, catalog.models.length, ...result.models);
        registration.models.splice(0, registration.models.length, ...falModelDefinitions(result.models));
        log({ event: "fal-models-discovered", modelCount: result.models.length });
        return { ok: true, modelCount: result.models.length, ...(result.message ? { message: result.message } : {}) };
      };
      if (registration.available) await refresh();
      ctx.effect(() => ctx.generation.register(registration));
      registerModelRefreshRoute(ctx, { path: REFRESH_PATH, refresh });
      log({ event: "fal-plugin-activated", available: registration.available, modelCount: registration.models.length });
    }
  };
}

