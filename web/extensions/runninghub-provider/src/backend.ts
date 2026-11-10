/**
 * RunningHub Provider 后端插件入口
 * （change: 2026-10-06-add-runninghub-api-models-and-provider-credentials +
 *  2026-11-07-add-runninghub-llm-and-provider-temporary-hosting）。
 *
 * 通过 `ctx.generation` 注册 RunningHub provider：
 * - 媒体：入库的 API 逻辑模型（`data/models.json`），按输入路由到具体 `api/<endpoint>`；
 * - 文字：官方 OpenAI 兼容目录（`/v1/models`）与独立端点 `llm.runninghub.ai/v1`，身份 `llm/<id>`；
 * - 临时图床：新版二进制上传接口返回的 `download_url`，由 `ctx.exposer` 作为提供商候选。
 *
 * 同一份 API Key 是唯一凭据权威；图片/视频、文字与临时上传分别记录可用证据，
 * 文字权限拒绝不会停用仍可用的媒体能力。
 */
import { defineConfigSchema, type GenerationProvider, type ExtensionPlugin } from "@woohaa3/contracts";
import { createRunninghubProvider } from "./provider/index.js";
import { DEFAULT_LLM_BASE_URL } from "./provider/provider.js";
import {
  DEFAULT_RUNNINGHUB_API_BASE,
  RUNNINGHUB_PLUGIN_ID,
  RUNNINGHUB_PROVIDER_ID,
  findRunningHubModel,
  pickRunningHubRoute,
  prepareRunningHubInput,
  runningHubEndpointModelId,
  runningHubModelDefinition,
  runningHubModelDefinitions,
  runningHubRegistry,
  setRunningHubModels
} from "./shared.js";
import { translateRunningHubParameters } from "./model-cards.js";
import { discoverRunningHubModels } from "./discovery.js";
import {
  discoverRunningHubLanguageModels,
  runningHubLanguageCapabilities,
  runningHubLanguageCatalogRevision,
  runningHubLanguageDefinitions,
  setRunningHubLanguageModels
} from "./llm-catalog.js";
import { createRunningHubTemporaryExposer } from "./temporary-hosting.js";
import { registerRunningHubRefreshRoute, type ModelRefreshResult } from "./refresh-route.js";
import { fetchRunningHubBalance } from "./backend/balance.js";
import { registerRunningHubBalanceRoute } from "./backend/balance-route.js";

export { DEFAULT_RUNNINGHUB_API_BASE, DEFAULT_LLM_BASE_URL };

/** 设置页「刷新可用模型」的路径（`ExtensionPlugin.modelRefresh.path`）。 */
export const RUNNINGHUB_REFRESH_PATH = "/api/providers/runninghub/refresh";

export const RUNNINGHUB_CONFIG = defineConfigSchema({
  apiKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "RUNNINGHUB_API_KEY",
    label: "API Key",
    description: "RunningHub API Key；文字模型与模型 API 需要 Enterprise-Shared Key"
  }
});

export type RunningHubRegistrationInput = {
  apiKey?: string;
  /** 受控媒体 API 地址（测试可覆盖；默认写死常量）。 */
  apiBaseURL?: string;
  /** 受控文字 API 地址（测试可覆盖；默认写死常量）。 */
  languageBaseURL?: string;
  fetchImpl?: typeof globalThis.fetch;
  jobRepository?: unknown;
};

export type RunningHubPluginDependencies = Pick<RunningHubRegistrationInput, "apiBaseURL" | "languageBaseURL" | "fetchImpl" | "jobRepository">;

export function createRunningHubRegistration(input: RunningHubRegistrationInput): GenerationProvider {
  const apiKey = (input.apiKey ?? "").trim();
  const available = apiKey !== "";
  const providerOptions = {
    apiBaseURL: input.apiBaseURL ?? DEFAULT_RUNNINGHUB_API_BASE,
    languageBaseURL: input.languageBaseURL ?? DEFAULT_LLM_BASE_URL,
    ...(input.jobRepository ? { jobRepository: input.jobRepository as never } : {}),
    ...(input.fetchImpl ? { fetch: input.fetchImpl } : {})
  };
  const provider = available ? createRunninghubProvider({ apiKey, ...providerOptions } as never) : undefined;
  const models = [...runningHubModelDefinitions(), ...runningHubLanguageDefinitions()];
  return {
    extensionId: RUNNINGHUB_PLUGIN_ID,
    providerId: RUNNINGHUB_PROVIDER_ID,
    available,
    provider,
    catalogRevision: runningHubLanguageCatalogRevision(),
    models,
    serviceConnectionFactory: {
      protocols: ["chat-completions"],
      assistantProtocol: "chat-completions",
      endpoints: { "chat-completions": input.languageBaseURL ?? DEFAULT_LLM_BASE_URL },
      create: ({ secret, endpoint, fetch: sourceFetch }) => createRunninghubProvider({
        apiKey: secret,
        ...providerOptions,
        languageBaseURL: endpoint || providerOptions.languageBaseURL,
        ...(sourceFetch ? { fetch: sourceFetch } : {})
      } as never)
    },
    languageCapabilities: (providerModelId) => runningHubLanguageCapabilities(providerModelId),
    // 参数 schema 的权威是入库清单（合并逻辑模型的并集），再经卡片投影成面板语义；
    // 文字模型的描述直接来自官方目录的逐模型证据。
    describeModel: ({ providerModelId }) => {
      if (providerModelId.startsWith("llm/")) {
        const definition = runningHubLanguageDefinitions().find(model => model.providerModelId === providerModelId);
        if (!definition) return undefined;
        return {
          title: definition.title,
          inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
          promptRequirement: definition.promptRequirement,
          cancel: definition.cancel
        };
      }
      const model = findRunningHubModel(providerModelId);
      if (!model) return undefined;
      const definition = runningHubModelDefinition(model);
      return {
        title: definition.title,
        inputSchema: definition.inputSchema,
        defaultInput: definition.defaultInput,
        promptRequirement: definition.promptRequirement,
        cancel: definition.cancel
      };
    },
    // 合并逻辑模型 → 具体 endpoint（design D1b）：执行身份按输入选择；文字模型身份原样保留。
    resolveProviderModel: ({ providerModelId, prompt, parameters, references }) => {
      if (providerModelId.startsWith("llm/")) return providerModelId;
      const model = findRunningHubModel(providerModelId);
      if (!model) return providerModelId;
      return runningHubEndpointModelId(pickRunningHubRoute(model, { prompt, parameters, references }));
    },
    // RunningHub 从 `providerOptions.runninghub.input` 读取字段；文字模型不经媒体输入组装。
    prepareInput: (input) => {
      if (input.providerModelId.startsWith("llm/")) return {};
      const model = findRunningHubModel(input.providerModelId);
      if (!model) return {};
      const route = pickRunningHubRoute(model, {
        prompt: input.prompt,
        parameters: input.parameters,
        references: input.references
      });
      const fields = prepareRunningHubInput(model, route, {
        prompt: input.prompt,
        parameters: translateRunningHubParameters(model, input.parameters),
        references: input.references
      });
      return { ...fields, providerOptions: { runninghub: { input: fields } } };
    }
  };
}

export function createRunningHubProviderPlugin(deps: RunningHubPluginDependencies = {}): ExtensionPlugin<typeof RUNNINGHUB_CONFIG.fields> {
  return {
    name: RUNNINGHUB_PLUGIN_ID,
    label: "RunningHub",
    configPrefix: "providers.runninghub",
    setupOrder: 20,
    website: "https://www.runninghub.ai?inviteCode=rh-v1272",
    modelTypes: ["language", "image", "video"],
    inject: ["log", "generation", "gateway", "access", "storage", "exposer"],
    modelRefresh: {
      path: RUNNINGHUB_REFRESH_PATH,
      hint: "媒体模型来自 RunningHub 官方公开的端点 registry；文字模型来自官方 OpenAI 兼容目录 /v1/models。刷新会更新两份独立目录，失败时保留上一次成功快照。文字模型与模型 API 需要 Enterprise-Shared Key。"
    },
    Config: RUNNINGHUB_CONFIG,
    health: (config) =>
      (config.apiKey ?? "").trim() === ""
        ? {
            state: "degraded" as const,
            diagnostics: [
              { code: "provider-credentials-missing", message: "未配置 API Key，RunningHub 模型与临时图床当前不可执行" }
            ]
          }
        : undefined,
    apply(ctx, config) {
      const log = ctx.log.scope(RUNNINGHUB_PLUGIN_ID);
      const apiKey = (config.apiKey ?? "").trim();
      const registration = createRunningHubRegistration({ ...deps, ...(apiKey ? { apiKey } : {}) });
      const refresh = async (): Promise<ModelRefreshResult> => {
        const before = new Set(registration.models.map((model) => model.providerModelId));
        const mediaResult = await discoverRunningHubModels({
          base: runningHubRegistry().models,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
        });
        const languageResult = await discoverRunningHubLanguageModels(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
        const parts: string[] = [];

        if (mediaResult.ok) {
          setRunningHubModels(mediaResult.models, { liveOnly: mediaResult.liveOnly });
          const partsMedia = [`上游 ${mediaResult.discovered} 个媒体逻辑模型`];
          if (mediaResult.removed.length > 0) partsMedia.push(`移除 ${mediaResult.removed.length} 个已下架的`);
          if (mediaResult.liveOnly.length > 0) partsMedia.push(`保留 ${mediaResult.liveOnly.length} 个站点仍在售的`);
          if (!mediaResult.catalogChecked) partsMedia.push("站点目录未取到，本次未做下架清理");
          parts.push(partsMedia.join("，"));
        } else {
          log({ event: "runninghub-model-discovery-failed", scope: "media", message: mediaResult.message });
          parts.push(`媒体目录刷新失败，保留上次成功目录：${mediaResult.message}`);
        }

        if (languageResult.ok) {
          setRunningHubLanguageModels(languageResult.models);
          const tools = languageResult.models.filter(model => model.capabilities.tools).length;
          parts.push(`文字目录 ${languageResult.models.length} 个模型（${tools} 个声明工具调用）`);
        } else {
          // 失败保留最近成功快照；没有旧目录时仍保留入库 fixture，展示未获取状态由设置面承担。
          log({ event: "runninghub-llm-discovery-failed", message: languageResult.message });
          parts.push(`文字目录刷新失败，保留上次成功目录：${languageResult.message}`);
        }

        const all = [...runningHubModelDefinitions(), ...runningHubLanguageDefinitions()];
        registration.models.splice(0, registration.models.length, ...all);
        // 目录修订参与服务来源 revision：能力变化即使模型 ID 集合不变也要让旧投影失效。
        registration.catalogRevision = runningHubLanguageCatalogRevision();
        const added = all.filter((model) => !before.has(model.providerModelId)).length;
        log({ event: "runninghub-models-discovered", modelCount: all.length, added, mediaOk: mediaResult.ok, languageOk: languageResult.ok });
        const summary = `新增 ${added} 个`;
        if (!mediaResult.ok && !languageResult.ok) return { ok: false, message: `${summary}；${parts.join("；")}` };
        return { ok: true, modelCount: all.length, message: `${summary}；${parts.join("；")}` };
      };
      ctx.effect(() => ctx.generation.register(registration));
      registerRunningHubRefreshRoute(ctx, { path: RUNNINGHUB_REFRESH_PATH, refresh });
      registerRunningHubBalanceRoute(ctx, {
        read: () =>
          fetchRunningHubBalance({
            apiKey: (config.apiKey ?? "").trim(),
            ...(deps.apiBaseURL ? { apiBaseURL: deps.apiBaseURL } : {}),
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
          })
      });
      // 临时图床：同一份 Key，独立于媒体/文字调用证据；未配置时不进入候选。
      ctx.effect(() => ctx.exposer.register(createRunningHubTemporaryExposer({
        storage: ctx.storage,
        getApiKey: () => (config.apiKey ?? "").trim() || undefined,
        getCredentialEpoch: () => credentialEpoch(config.apiKey),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
      })));
      log({ event: "runninghub-plugin-activated", available: registration.available, modelCount: registration.models.length });
    }
  };
}

/** 凭据修订：只用于缓存隔离与请求冻结，不进入日志或公开视图。 */
function credentialEpoch(secret: string | undefined): number {
  const value = (secret ?? "").trim();
  if (value === "") return 0;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
