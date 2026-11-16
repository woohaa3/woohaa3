/**
 * RunningHub Provider 后端插件入口
 * （change: 2026-10-06-add-runninghub-api-models-and-provider-credentials +
 *  2026-11-07-add-runninghub-llm-and-provider-temporary-hosting）。
 *
 * 通过 `ctx.generation` 注册 RunningHub provider：
 * - 媒体：入库的 API 逻辑模型（`data/models.json`），按输入路由到具体 `api/<endpoint>`；
 * - 文字：官方 OpenAI 兼容目录（`/v1/models`）与独立端点 `llm.runninghub.{ai|cn}/v1`，身份 `llm/<id>`；
 * - 临时图床：新版二进制上传接口返回的 `download_url`，由 `ctx.exposer` 作为提供商候选。
 *
 * 国内站与国际站的账号、Key 和目录互相独立；插件按当前 Key 的账户鉴权结果识别区域并持久化，
 * 媒体、文字、上传、余额和刷新都从该区域派生地址（change: 2026-11-17-add-runninghub-region-detection）。
 *
 * 同一份 API Key 是唯一凭据权威；图片/视频、文字与临时上传分别记录可用证据，
 * 文字权限拒绝不会停用仍可用的媒体能力。
 */
import {
  credentialEpoch,
  defineConfigSchema,
  type GenerationProvider,
  type ExtensionPlugin
} from "@woohaa3/contracts";
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
  runningHubRegistry,
  setRunningHubModels,
  setRunningHubRegion
} from "./shared.js";
import { translateRunningHubParameters } from "./model-cards.js";
import { discoverRunningHubModels, runningHubModelDefinitionsForRegion } from "./discovery.js";
import {
  discoverRunningHubLanguageModels,
  ensureRunningHubLanguageRegion,
  runningHubLanguageCapabilities,
  runningHubLanguageCatalogRevision,
  runningHubLanguageDefinitions,
  RUNNINGHUB_LANGUAGE_MODEL_PREFIX,
  setRunningHubLanguageModels
} from "./llm-catalog.js";
import { createRunningHubTemporaryExposer } from "./temporary-hosting.js";
import { registerRunningHubRefreshRoute, type ModelRefreshResult } from "./refresh-route.js";
import { fetchRunningHubBalance } from "./backend/balance.js";
import { registerRunningHubBalanceRoute } from "./backend/balance-route.js";
import {
  DEFAULT_RUNNINGHUB_REGION,
  detectRunningHubRegion,
  isRunningHubRegion,
  runningHubApiBaseURL,
  runningHubCatalogURL,
  runningHubKeyPageURL,
  runningHubLLMBaseURL,
  runningHubLLMCatalogURL,
  runningHubRegionLabel,
  runningHubUploadURL,
  type RunningHubRegion
} from "./region.js";
import { createRunningHubRegionStore, type RunningHubRegionStore } from "./backend/region-store.js";
import type { RunningHubEndpointAvailability } from "./model-availability.js";

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
  /** 当前站点区域；缺省国际站。 */
  region?: RunningHubRegion;
  /** 区域可用性覆盖（测试）；缺省使用入库映射。 */
  availability?: RunningHubEndpointAvailability;
  /** 受控媒体 API 地址（测试可覆盖；默认写死常量）。 */
  apiBaseURL?: string;
  /** 受控文字 API 地址（测试可覆盖；默认写死常量）。 */
  languageBaseURL?: string;
  fetchImpl?: typeof globalThis.fetch;
  jobRepository?: unknown;
};

export type RunningHubPluginDependencies = Pick<RunningHubRegistrationInput, "apiBaseURL" | "languageBaseURL" | "fetchImpl" | "jobRepository"> & {
  /** 受控覆盖（测试或部署排障）：跳过探测直接使用该区域。 */
  region?: RunningHubRegion;
  /** 区域探测的单站超时；缺省 5 秒。 */
  regionProbeTimeoutMs?: number;
  /** 测试可注入持久化实现；缺省使用 `ctx.services.documents` 或进程内缓存。 */
  regionStore?: RunningHubRegionStore;
  /** 测试可注入区域可用性；缺省使用入库映射。 */
  availability?: RunningHubEndpointAvailability;
  /** 受控上传地址覆盖（测试）；缺省按区域派生。 */
  uploadUrl?: string;
  /** 受控标准模型目录页覆盖（测试）；缺省按区域派生。 */
  catalogUrl?: string;
  /** 受控文字目录覆盖（测试）；缺省按区域派生。 */
  languageCatalogUrl?: string;
};

export function createRunningHubRegistration(input: RunningHubRegistrationInput): GenerationProvider {
  const apiKey = (input.apiKey ?? "").trim();
  const region = input.region ?? DEFAULT_RUNNINGHUB_REGION;
  const available = apiKey !== "";
  const providerOptions = {
    apiBaseURL: input.apiBaseURL ?? DEFAULT_RUNNINGHUB_API_BASE,
    languageBaseURL: input.languageBaseURL ?? DEFAULT_LLM_BASE_URL,
    ...(input.jobRepository ? { jobRepository: input.jobRepository as never } : {}),
    ...(input.fetchImpl ? { fetch: input.fetchImpl } : {})
  };
  const provider = available ? createRunninghubProvider({ apiKey, ...providerOptions } as never) : undefined;
  const models = [...runningHubModelDefinitionsForRegion(region, input.availability), ...runningHubLanguageDefinitions()];
  return {
    extensionId: RUNNINGHUB_PLUGIN_ID,
    providerId: RUNNINGHUB_PROVIDER_ID,
    available,
    provider,
    catalogRevision: runningHubLanguageCatalogRevision(),
    // 换 key 必须让 Task registry 重建实例：否则它按模型签名命中旧缓存，继续用持旧 key 的
    // provider 提交任务（2026-11-16 现场：同 key 重启前全失败、重启后全成功）。
    credentialEpoch: credentialEpoch(apiKey),
    models,
    serviceConnectionFactory: {
      protocols: ["chat-completions"],
      assistantProtocol: "chat-completions",
      endpoints: { "chat-completions": input.languageBaseURL ?? DEFAULT_LLM_BASE_URL },
      // 目录身份是 `llm/<原始 id>`，上游只认去掉前缀的原始 id：助手通道会把模型名原样发出。
      upstreamModelId: (modelId) => modelId.startsWith(RUNNINGHUB_LANGUAGE_MODEL_PREFIX) ? modelId.slice(RUNNINGHUB_LANGUAGE_MODEL_PREFIX.length) : modelId,
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
    website: runningHubKeyPageURL(DEFAULT_RUNNINGHUB_REGION),
    modelTypes: ["language", "image", "video"],
    inject: ["log", "generation", "gateway", "access", "storage", "exposer"],
    modelRefresh: {
      path: RUNNINGHUB_REFRESH_PATH,
      hint: "媒体模型来自 RunningHub 官方公开的端点 registry，并按当前站点隐藏上游 1001 的端点；文字模型来自当前站点区域的官方 OpenAI 兼容目录 /v1/models。刷新会更新两份独立目录，失败时保留上一次成功快照。文字模型与模型 API 需要 Enterprise-Shared Key。"
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
    async testConnection(config) {
      const apiKey = (config.apiKey ?? "").trim();
      if (!apiKey) return { ok: false, message: "请先填写 RunningHub API Key" };

      let region: RunningHubRegion;
      if (deps.region && isRunningHubRegion(deps.region)) {
        region = deps.region;
      } else {
        const detection = await detectRunningHubRegion({
          apiKey,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.regionProbeTimeoutMs === undefined ? {} : { timeoutMs: deps.regionProbeTimeoutMs })
        });
        if (!detection.ok) return { ok: false, message: detection.message };
        if (detection.accountState === "rejected") {
          return {
            ok: false,
            message: `RunningHub API Key 在${runningHubRegionLabel(detection.region)}存在，但当前 Key 类型无法读取账户`
          };
        }
        region = detection.region;
      }

      const result = await fetchRunningHubBalance({
        apiKey,
        apiBaseURL: deps.apiBaseURL ?? runningHubApiBaseURL(region),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        timeoutMs: 10_000
      });
      if (!result.ok) return { ok: false, message: result.message };
      return { ok: true, message: `RunningHub API Key 测试通过（${runningHubRegionLabel(region)}）` };
    },
    async apply(ctx, config) {
      const log = ctx.log.scope(RUNNINGHUB_PLUGIN_ID);
      const apiKey = (config.apiKey ?? "").trim();
      const regionStore = deps.regionStore ?? createRunningHubRegionStore({ documents: ctx.services?.documents });
      const resolveRegion = async (): Promise<RunningHubRegion> => {
        if (deps.region && isRunningHubRegion(deps.region)) return deps.region;
        if (apiKey === "") return DEFAULT_RUNNINGHUB_REGION;

        const cached = await regionStore.load(apiKey);
        if (cached) return cached;

        const detection = await detectRunningHubRegion({
          apiKey,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.regionProbeTimeoutMs === undefined ? {} : { timeoutMs: deps.regionProbeTimeoutMs })
        });
        if (detection.ok) {
          // 区域已唯一确定（即使账户接口拒绝了 Key 类型）就写缓存；能力失败由各能力自己报告。
          const saved = await regionStore.save(apiKey, detection.region);
          if (!saved) log({ event: "runninghub-region-persist-failed", region: detection.region });
          return detection.region;
        }
        log({
          event: "runninghub-region-detect-failed",
          reason: detection.reason,
          probes: detection.probes.map(({ region: probeRegion, outcome, status, code }) => ({
            region: probeRegion,
            outcome,
            ...(status === undefined ? {} : { status }),
            ...(code === undefined ? {} : { code })
          }))
        });
        return DEFAULT_RUNNINGHUB_REGION;
      };
      const region = await resolveRegion();
      // 换 Key 导致区域变化时，上一站过滤过的运行期清单与文字 fixture 必须一起失效。
      setRunningHubRegion(region);
      ensureRunningHubLanguageRegion(region);

      const apiBaseURL = deps.apiBaseURL ?? runningHubApiBaseURL(region);
      const languageBaseURL = deps.languageBaseURL ?? runningHubLLMBaseURL(region);
      const catalogUrl = deps.catalogUrl ?? runningHubCatalogURL(region);
      const languageCatalogUrl = deps.languageCatalogUrl ?? runningHubLLMCatalogURL(region);
      const uploadUrl = deps.uploadUrl ?? runningHubUploadURL(region);

      const registration = createRunningHubRegistration({
        ...(apiKey ? { apiKey } : {}),
        region,
        ...(deps.availability ? { availability: deps.availability } : {}),
        apiBaseURL,
        languageBaseURL,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.jobRepository ? { jobRepository: deps.jobRepository } : {})
      });
      const refresh = async (): Promise<ModelRefreshResult> => {
        const before = new Set(
          [...runningHubModelDefinitionsForRegion(region, deps.availability), ...runningHubLanguageDefinitions()]
            .map((model) => model.providerModelId)
        );
        const mediaResult = await discoverRunningHubModels({
          base: runningHubRegistry().models,
          region,
          ...(deps.availability ? { availability: deps.availability } : {}),
          catalogUrl,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
        });
        const languageResult = await discoverRunningHubLanguageModels({
          url: languageCatalogUrl,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
        });
        const parts: string[] = [];

        if (mediaResult.ok) {
          setRunningHubModels(mediaResult.models, { liveOnly: mediaResult.liveOnly });
          const partsMedia = [`上游 ${mediaResult.discovered} 个媒体逻辑模型`];
          if (mediaResult.removed.length > 0) partsMedia.push(`移除 ${mediaResult.removed.length} 个已下架的`);
          if (mediaResult.liveOnly.length > 0) partsMedia.push(`保留 ${mediaResult.liveOnly.length} 个站点仍在售的`);
          if (mediaResult.regionHidden.length > 0) partsMedia.push(`${runningHubRegionLabel(region)}不可用 ${mediaResult.regionHidden.length} 个已隐藏`);
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

        const all = [...runningHubModelDefinitionsForRegion(region, deps.availability), ...runningHubLanguageDefinitions()];
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
            apiBaseURL,
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
          })
      });
      // 临时图床：同一份 Key，独立于媒体/文字调用证据；未配置时不进入候选。
      ctx.effect(() => ctx.exposer.register(createRunningHubTemporaryExposer({
        storage: ctx.storage,
        getApiKey: () => (config.apiKey ?? "").trim() || undefined,
        getCredentialEpoch: () => credentialEpoch(config.apiKey),
        uploadUrl,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
      })));
      log({
        event: "runninghub-plugin-activated",
        region,
        available: registration.available,
        modelCount: registration.models.length
      });
    }
  };
}
