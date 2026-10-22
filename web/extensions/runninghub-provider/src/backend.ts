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
import { defineConfigSchema, type GenerationProvider, type HostExtensionPlugin } from "@woohaa3/contracts";
import { createRunninghubProvider } from "./provider/index.js";
import {
  DEFAULT_RUNNINGHUB_API_BASE,
  RUNNINGHUB_PLUGIN_ID,
  RUNNINGHUB_PROVIDER_ID,
  findRunningHubModel,
  pickRunningHubRoute,
  prepareRunningHubInput,
  runningHubEndpointModelId,
  runningHubModelDefinitions
} from "./shared.js";

export { DEFAULT_RUNNINGHUB_API_BASE };

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
    // 参数 schema 的权威是入库清单（合并逻辑模型的并集）；动态 describe 只补 title/cancel。
    describeModel: ({ providerModelId }) => {
      const model = findRunningHubModel(providerModelId);
      if (!model) return undefined;
      return {
        title: model.label,
        inputSchema: model.inputSchema,
        defaultInput: model.defaultInput,
        promptRequirement: model.promptRequirement,
        cancel: model.cancel
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
      const route = pickRunningHubRoute(model, {
        prompt: input.prompt,
        parameters: input.parameters,
        references: input.references
      });
      const fields = prepareRunningHubInput(model, route, {
        prompt: input.prompt,
        parameters: input.parameters,
        references: input.references
      });
      return { ...fields, providerOptions: { runninghub: { input: fields } } };
    }
  };
}

export function createRunningHubProviderPlugin(deps: RunningHubPluginDependencies = {}): HostExtensionPlugin<typeof RUNNINGHUB_CONFIG.fields> {
  return {
    name: RUNNINGHUB_PLUGIN_ID,
    label: "RunningHub",
    // 品牌图形由扩展包 assets/ 同步发布，路径由宿主按 extension.json 的 icon.asset 注入。
    configPrefix: "providers.runninghub",
    inject: ["log", "generation"],
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
      const registration = createRunningHubRegistration({ ...deps, ...(config.apiKey ? { apiKey: config.apiKey } : {}) });
      ctx.effect(() => ctx.generation.register(registration));
      ctx.log.scope(RUNNINGHUB_PLUGIN_ID)({ event: "runninghub-plugin-activated", available: registration.available, modelCount: registration.models.length });
    }
  };
}
