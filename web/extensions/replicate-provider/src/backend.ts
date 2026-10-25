/**
 * Replicate Provider 后端插件入口。
 *
 * 声明 `providers.replicate` 配置段，向 `ctx.generation` 注册。模型来自配置里的
 * `owner/name` 名单：凭据加载后逐个读取输入定义，设置页可再刷新。
 */
import {
  defineConfigSchema,
  type GenerationModelDescription,
  type GenerationProvider,
  type HostExtensionPlugin,
} from "@woohaa3/contracts";
import { discoverReplicateModels } from "./discovery.js";
import { createProviderLifecycleFetch, createGuardedFetch, registerModelRefreshRoute } from "@woohaa3/provider-sdk";
import { createReplicateProvider, type ReplicateCatalog } from "./provider.js";
import { replicateModelDefinitions, type ReplicateModel } from "./schema.js";
import { DEFAULT_REPLICATE_BASE_URL, parseModelIds, REPLICATE_PLUGIN_ID, REPLICATE_PROVIDER_ID } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const REFRESH_PATH = "/api/providers/replicate/refresh";

export const REPLICATE_CONFIG = defineConfigSchema({
  apiKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "REPLICATE_API_TOKEN",
    label: "API Token",
    description: "Replicate API Token，请求头使用 Bearer"
  },
  baseUrl: {
    kind: "url",
    protocols: ["https:", "http:"],
    default: DEFAULT_REPLICATE_BASE_URL,
    reload: "hot",
    legacyEnv: "REPLICATE_BASE_URL",
    label: "API 地址",
    description: "默认 https://api.replicate.com/v1"
  },
  models: {
    kind: "string",
    reload: "hot",
    label: "模型",
    description: "要接入的模型，逗号或换行分隔，格式 owner/name。例如 black-forest-labs/flux-schnell"
  }
});

export type ReplicateRegistrationInput = {
  apiKey?: string;
  baseUrl?: string;
  models?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof globalThis.fetch;
  jobRepository?: unknown;
  discovered?: readonly ReplicateModel[];
};

export type ReplicatePluginDependencies = Pick<ReplicateRegistrationInput, "timeoutMs" | "maxBytes" | "fetchImpl" | "jobRepository">;

/**
 * `available` 需要 API Token、地址，以及至少一条合法的 owner/name。
 * 未配齐时仍注册，设置页能看到插件并预填。
 */
export function createReplicateRegistration(input: ReplicateRegistrationInput): { registration: GenerationProvider; catalog: ReplicateCatalog } {
  const apiKey = (input.apiKey ?? "").trim();
  const baseUrl = (input.baseUrl ?? DEFAULT_REPLICATE_BASE_URL).trim();
  const parsed = parseModelIds(input.models);
  const available = apiKey !== "" && baseUrl !== "" && parsed.ok && parsed.ids.length > 0;
  const catalog: ReplicateCatalog = { models: [...(input.discovered ?? [])] };
  const provider = available
    ? createReplicateProvider({
        apiKey,
        baseURL: baseUrl,
        catalog,
        ...(input.jobRepository ? { jobRepository: input.jobRepository } : {}),
        fetch: createGuardedFetch({
          baseUrl,
          maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
          // replicate 的交付 CDN 需要带自己的 token 才能下载：只对它自己的主机附加。
          prepareDownloadHeaders: (url, headers) => {
            if (isReplicateHost(url) && !headers.has("authorization")) {
              headers.set("authorization", `Bearer ${apiKey}`);
            }
          }
        })
      })
    : undefined;
  return {
    catalog,
    registration: {
      extensionId: REPLICATE_PLUGIN_ID,
      providerId: REPLICATE_PROVIDER_ID,
      available,
      provider,
      models: replicateModelDefinitions(catalog.models),
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

export function createReplicateProviderPlugin(deps: ReplicatePluginDependencies = {}): HostExtensionPlugin<typeof REPLICATE_CONFIG.fields> {
  return {
    name: REPLICATE_PLUGIN_ID,
    label: "Replicate",
    configPrefix: "providers.replicate",
    modelTypes: ["language", "image", "video", "audio"],
    // 设置页「可用模型」一节由插件声明驱动：宿主不硬编码 Provider 的刷新入口。
    modelRefresh: { path: REFRESH_PATH, hint: "填写 API Token，以及要使用的模型（逗号或换行分隔，格式 owner/name，例如 black-forest-labs/flux-schnell）。保存后会读取这些模型的输入定义，也可以再刷新。" },
    inject: ["log", "generation", "gateway", "access"],
    Config: REPLICATE_CONFIG,
    health: (config) => {
      const apiKey = (config.apiKey ?? "").trim();
      const baseUrl = (config.baseUrl ?? DEFAULT_REPLICATE_BASE_URL).trim();
      const parsed = parseModelIds(config.models);
      if (apiKey !== "" && baseUrl !== "" && parsed.ok && parsed.ids.length > 0) return undefined;
      const message = apiKey === ""
        ? "未配置 API Token，Replicate 模型当前不可执行"
        : baseUrl === ""
          ? "API 地址为空，Replicate 模型当前不可执行"
          : !parsed.ok
            ? parsed.message
            : "未填写模型。格式为 owner/name，例如 black-forest-labs/flux-schnell";
      return { state: "degraded" as const, diagnostics: [{ code: "provider-credentials-missing", message }] };
    },
    async apply(ctx, config) {
      const apiKey = config.apiKey?.trim() ?? "";
      const baseUrl = config.baseUrl;
      const log = ctx.log.scope(REPLICATE_PLUGIN_ID);
      const { registration, catalog } = createReplicateRegistration({
        ...deps,
        fetchImpl: createProviderLifecycleFetch(ctx, deps.fetchImpl),
        ...(apiKey ? { apiKey } : {}),
        baseUrl,
        ...(config.models ? { models: config.models } : {})
      });
      const refresh = async (): Promise<{ ok: true; modelCount: number; message?: string } | { ok: false; message: string }> => {
        const parsed = parseModelIds(config.models);
        if (!registration.available || !apiKey || !parsed.ok) {
          return { ok: false, message: !parsed.ok ? parsed.message : "先配置 API Token 和模型名单" };
        }
        const result = await discoverReplicateModels({
          baseUrl,
          apiKey,
          modelIds: parsed.ids,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
        });
        if (!result.ok) {
          log({ event: "replicate-model-discovery-failed", message: result.message });
          return result;
        }
        catalog.models.splice(0, catalog.models.length, ...result.models);
        registration.models.splice(0, registration.models.length, ...replicateModelDefinitions(result.models));
        log({ event: "replicate-models-discovered", modelCount: result.models.length });
        return { ok: true, modelCount: result.models.length, ...(result.message ? { message: result.message } : {}) };
      };
      if (registration.available) await refresh();
      ctx.effect(() => ctx.generation.register(registration));
      registerModelRefreshRoute(ctx, { path: REFRESH_PATH, refresh });
      log({ event: "replicate-plugin-activated", available: registration.available, modelCount: registration.models.length });
    }
  };
}

/** replicate 自己的 API 与交付 CDN 主机。 */
function isReplicateHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "replicate.com" || host.endsWith(".replicate.com") || host === "replicate.delivery" || host.endsWith(".replicate.delivery");
}
