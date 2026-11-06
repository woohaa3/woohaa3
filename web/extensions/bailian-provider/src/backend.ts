/**
 * 百炼（Model Studio / DashScope）Provider 后端插件入口。
 *
 * 声明 `providers.bailian` 配置段，向 `ctx.generation` 注册生图模型。
 *
 * 模型清单来自契约层的卡片目录（`@woohaa3/contracts` 的 `cards/image/alibaba/`），
 * `src/catalog.ts` 只把卡片读成本地形状。卡片本身是**手写**的，不是发现来的：DashScope 没有
 * 免鉴权的模型列表接口，管理面接口返回全品类部署信息且需要按「生图」再筛一遍能力。所以设置页
 * 没有刷新按钮，换模型靠升级扩展。这一点在 README 里写明，避免看起来像漏了实现。
 */
import {
  defineConfigSchema,
  type GenerationModelDescription,
  type GenerationModelDefinition,
  type GenerationProvider,
  type ExtensionPlugin
} from "@woohaa3/contracts";
import { createGuardedFetch, createProviderLifecycleFetch } from "@woohaa3/provider-sdk";
import { BAILIAN_IMAGE_MODELS } from "./catalog.js";
import { createBailianProvider, describeModel } from "./provider.js";
import { describeBailianModel } from "./schema.js";
import { BAILIAN_PLUGIN_ID, BAILIAN_PROVIDER_ID, DEFAULT_BAILIAN_BASE_URL, bailianOrigin } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export const BAILIAN_CONFIG = defineConfigSchema({
  apiKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "DASHSCOPE_API_KEY",
    label: "API Key",
    description: "百炼 / DashScope API Key，请求头使用 Bearer。北京与新加坡的 Key 不互通"
  },
  baseUrl: {
    kind: "url",
    protocols: ["https:", "http:"],
    default: DEFAULT_BAILIAN_BASE_URL,
    reload: "hot",
    legacyEnv: "DASHSCOPE_BASE_URL",
    label: "API 地址",
    description: "北京 https://dashscope.aliyuncs.com，新加坡 https://dashscope-intl.aliyuncs.com；也可填工作空间域名 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com"
  }
});

export type BailianRegistrationInput = {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof globalThis.fetch;
};

export type BailianPluginDependencies = Pick<BailianRegistrationInput, "timeoutMs" | "maxBytes" | "fetchImpl">;

/** 目录 → 生成模块的模型定义。`executable` 跟随目录（当前全部可执行）。 */
export function bailianModelDefinitions(): GenerationModelDefinition[] {
  return BAILIAN_IMAGE_MODELS.map((model) => {
    const description = describeBailianModel(model);
    return {
      providerId: BAILIAN_PROVIDER_ID,
      providerModelId: model.id,
      modelType: "image" as const,
      ...(description.title ? { title: description.title } : {}),
      ...(description.inputSchema ? { inputSchema: description.inputSchema } : {}),
      ...(description.defaultInput ? { defaultInput: description.defaultInput } : {}),
      promptRequirement: "required" as const,
      // 同步接口：任务一旦发出就没有远端 id 可取消，只停本地。
      cancel: "local" as const
    };
  });
}

/**
 * `available` 需要 API Key 与地址。未配置时仍注册：设置页要能看到插件并给出缺凭据的诊断。
 */
export function createBailianRegistration(input: BailianRegistrationInput): GenerationProvider {
  const apiKey = (input.apiKey ?? "").trim();
  const baseUrl = (input.baseUrl ?? DEFAULT_BAILIAN_BASE_URL).trim();
  const available = apiKey !== "" && baseUrl !== "";
  const guarded = createGuardedFetch({
    baseUrl,
    maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // 只出图：下载也只放行图片。
    allowedContentTypes: ["image/"],
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  return {
    extensionId: BAILIAN_PLUGIN_ID,
    providerId: BAILIAN_PROVIDER_ID,
    available,
    provider: available
      ? createBailianProvider({ apiKey, baseURL: baseUrl, fetch: guarded })
      : undefined,
    models: bailianModelDefinitions(),
    describeModel: (model) =>
      describeModel(model.providerModelId, model.modelType) as GenerationModelDescription | undefined
  };
}

export function createBailianProviderPlugin(deps: BailianPluginDependencies = {}): ExtensionPlugin<typeof BAILIAN_CONFIG.fields> {
  return {
    name: BAILIAN_PLUGIN_ID,
    label: "百炼（阿里云）",
    configPrefix: "providers.bailian",
    // 只接生图。文本与视频不在本次范围内，所以这里不声明。
    modelTypes: ["image"],
    inject: ["log", "generation", "gateway", "access"],
    Config: BAILIAN_CONFIG,
    health: (config) => {
      const apiKey = (config.apiKey ?? "").trim();
      const baseUrl = (config.baseUrl ?? DEFAULT_BAILIAN_BASE_URL).trim();
      if (apiKey !== "" && baseUrl !== "") return undefined;
      return {
        state: "degraded" as const,
        diagnostics: [{
          code: "provider-credentials-missing",
          message: apiKey === "" ? "未配置 API Key，百炼模型当前不可执行" : "API 地址为空，百炼模型当前不可执行"
        }]
      };
    },
    async apply(ctx, config) {
      const apiKey = config.apiKey?.trim() ?? "";
      const baseUrl = config.baseUrl;
      const log = ctx.log.scope(BAILIAN_PLUGIN_ID);
      const registration = createBailianRegistration({
        ...deps,
        // 停用或改配置后，残留的调用不再发出带旧 Key 的请求。
        fetchImpl: createProviderLifecycleFetch(ctx, deps.fetchImpl),
        ...(apiKey ? { apiKey } : {}),
        baseUrl
      });
      ctx.effect(() => ctx.generation.register(registration));
      log({
        event: "bailian-plugin-activated",
        available: registration.available,
        modelCount: registration.models.length,
        origin: bailianOrigin(baseUrl)
      });
    }
  };
}
