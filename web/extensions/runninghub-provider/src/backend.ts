/**
 * RunningHub Provider 后端插件入口
 * （change: 2026-10-06-add-runninghub-api-models-and-provider-credentials，任务 1.4/2.3/2.4 / design D1/D1b/D2/D3）。
 *
 * 通过 `ctx.generation` 注册 RunningHub provider（协议实现在本扩展 `src/provider/`，
 * 复用 `@sdppp/pptask` 的 core 类型与 shared toolkit），并：
 * - 只注册**入库的 API 逻辑模型**（`data/models.json`；不含 App/webappId）；
 * - 合并模型按输入路由到具体 `api/<endpoint>`（`resolveProviderModel`），并把引用写入
 *   对应媒体字段（`prepareInput`）；
 * - apiKey 是配置段里的 `secret` 字段（写进本地密钥文件）；baseURL 写死常量。
 */
import { defineConfigSchema, type GenerationProvider, type ExtensionPlugin } from "@woohaa3/contracts";
import { createRunninghubProvider } from "./provider/index.js";
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
import { registerRunningHubRefreshRoute, type ModelRefreshResult } from "./refresh-route.js";

export { DEFAULT_RUNNINGHUB_API_BASE };

/** 设置页「刷新可用模型」的路径（`ExtensionPlugin.modelRefresh.path`）。 */
export const RUNNINGHUB_REFRESH_PATH = "/api/providers/runninghub/refresh";

export const RUNNINGHUB_CONFIG = defineConfigSchema({
  apiKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "RUNNINGHUB_API_KEY",
    label: "API Key",
    description: "RunningHub API Key"
  }
});

export type RunningHubRegistrationInput = {
  apiKey?: string;
  /** 受控 API 地址（测试可覆盖；默认写死常量）。 */
  apiBaseURL?: string;
  fetchImpl?: typeof globalThis.fetch;
  jobRepository?: unknown;
};

export type RunningHubPluginDependencies = Pick<RunningHubRegistrationInput, "apiBaseURL" | "fetchImpl" | "jobRepository">;

export function createRunningHubRegistration(input: RunningHubRegistrationInput): GenerationProvider {
  const apiKey = (input.apiKey ?? "").trim();
  const available = apiKey !== "";
  const provider = available
    ? createRunninghubProvider({
        apiKey,
        apiBaseURL: input.apiBaseURL ?? DEFAULT_RUNNINGHUB_API_BASE,
        ...(input.jobRepository ? { jobRepository: input.jobRepository as never } : {}),
        ...(input.fetchImpl ? { fetch: input.fetchImpl } : {})
      } as never)
    : undefined;
  return {
    extensionId: RUNNINGHUB_PLUGIN_ID,
    providerId: RUNNINGHUB_PROVIDER_ID,
    available,
    provider,
    models: runningHubModelDefinitions(),
    // 参数 schema 的权威是入库清单（合并逻辑模型的并集），再经卡片投影成面板语义
    // （见 `model-cards`：上游是落点，卡片是展示真相）；动态 describe 只补 title/cancel。
    describeModel: ({ providerModelId }) => {
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
    // 合并逻辑模型 → 具体 endpoint（design D1b）：执行身份按输入选择。
    resolveProviderModel: ({ providerModelId, prompt, parameters, references }) => {
      const model = findRunningHubModel(providerModelId);
      if (!model) return providerModelId;
      return runningHubEndpointModelId(pickRunningHubRoute(model, { prompt, parameters, references }));
    },
    // RunningHub 从 `providerOptions.runninghub.input` 读取字段；按同一 route 写入媒体字段。
    // 同时把字段平铺到顶层：vendored provider 的 imageInput/videoInput 会用它自己的
    // 顶层 `prompt`/`resolution`/`duration` 覆盖自定义字段，平铺保证两者一致。
    prepareInput: (input) => {
      const model = findRunningHubModel(input.providerModelId);
      if (!model) return {};
      // 路由看面板原始参数（`x-pptask-routing` 的键在翻译前还在）；字段用翻译后的。
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
    // 品牌图形由扩展包 assets/ 同步发布，路径由宿主按 extension.json 的 icon.asset 注入。
    configPrefix: "providers.runninghub",
    modelTypes: ["image", "video"],
    inject: ["log", "generation", "gateway", "access"],
    // 设置页「可用模型」一节由插件声明驱动；刷新只做增量（见 `discovery.ts`）。
    modelRefresh: {
      path: RUNNINGHUB_REFRESH_PATH,
      hint: "模型清单来自 RunningHub 官方公开的端点 registry：刷新会补上新模型，并清理公开清单与站点目录都不再提供的模型。站点仍在售、只是清单没收录的会保留，并在列表里标「站点在售」。RunningHub 没有按 API Key 查询标准模型的接口，API Key 只决定这些模型能不能被调用。"
    },
    Config: RUNNINGHUB_CONFIG,
    // 没配 API Key 时插件照样装载（模型要留在管理面预填配置），只是它们进不了 catalog。
    // 站点状态据此报 degraded，而不是笼统的「运行中」。
    health: (config) =>
      (config.apiKey ?? "").trim() === ""
        ? {
            state: "degraded" as const,
            diagnostics: [
              { code: "provider-credentials-missing", message: "未配置 API Key，RunningHub 模型当前不可执行" }
            ]
          }
        : undefined,
    apply(ctx, config) {
      const log = ctx.log.scope(RUNNINGHUB_PLUGIN_ID);
      const registration = createRunningHubRegistration({ ...deps, ...(config.apiKey ? { apiKey: config.apiKey } : {}) });
      const refresh = async (): Promise<ModelRefreshResult> => {
        const before = new Set(registration.models.map((model) => model.providerModelId));
        const result = await discoverRunningHubModels({
          base: runningHubRegistry().models,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
        });
        if (!result.ok) {
          log({ event: "runninghub-model-discovery-failed", message: result.message });
          return result;
        }
        // 保留的模型带「站点在售」标签：列表上要能看出它不在公开 registry 里。
        setRunningHubModels(result.models, { liveOnly: result.liveOnly });
        registration.models.splice(0, registration.models.length, ...runningHubModelDefinitions());
        const added = registration.models.filter((model) => !before.has(model.providerModelId)).length;
        log({
          event: "runninghub-models-discovered",
          modelCount: registration.models.length,
          added,
          removed: result.removed,
          liveOnly: result.liveOnly,
          catalogChecked: result.catalogChecked
        });
        // 文案只说有信息量的事：新增 / 移除 / 仅站点可见。没变化就不报流水账。
        const parts = [`上游 ${result.discovered} 个逻辑模型`, `新增 ${added} 个`];
        if (result.removed.length > 0) {
          parts.push(`移除 ${result.removed.length} 个已下架的（${result.removed.join("、")}）`);
        }
        if (result.liveOnly.length > 0) {
          parts.push(
            `保留 ${result.liveOnly.length} 个公开清单没收录、但站点仍在售的（${result.liveOnly.join("、")}）`
          );
        }
        if (!result.catalogChecked) parts.push("站点目录未取到，本次未做下架清理");
        return { ok: true, modelCount: registration.models.length, message: parts.join("，") };
      };
      ctx.effect(() => ctx.generation.register(registration));
      registerRunningHubRefreshRoute(ctx, { path: RUNNINGHUB_REFRESH_PATH, refresh });
      log({ event: "runninghub-plugin-activated", available: registration.available, modelCount: registration.models.length });
    }
  };
}
