/**
 * 百炼（Model Studio / DashScope）Provider 后端插件入口。
 *
 * 声明 `providers.bailian` 配置段，向 `ctx.generation` 注册生图模型。
 *
 * 地址有两种写法，**优先业务空间专属域名**：填了业务空间 ID 就拼
 * `https://{WorkspaceId}.{region}.maas.aliyuncs.com`（官方建议迁移，推理性能与稳定性更好），
 * 没填才退回 `baseUrl`（老公开域名，文档仍标注可用）。
 *
 * 模型清单来自契约层的卡片目录（`@woohaa3/contracts` 的 `cards/image/alibaba/`），`src/catalog.ts`
 * 只把卡片读成本地形状。**卡片仍手写**：`GET /api/v1/models?capabilities=IG` 只给出 id、名称、
 * 模态这类身份事实，给不出档位、官方像素表、参考图上限、有没有负向提示词——那些才决定参数面板
 * 长什么样。所以发现只用于对账（卡片登记的模型上游还在不在、有没有卡片没覆盖的新模型），
 * 注册表以卡片为准，执行路径不会凭空多出一个没有参数事实的模型。
 */
import {
  defineConfigSchema,
  type GenerationModelDescription,
  type GenerationModelDefinition,
  type GenerationProvider,
  type ExtensionPlugin
} from "@woohaa3/contracts";
import { createGuardedFetch, createProviderLifecycleFetch, registerModelRefreshRoute } from "@woohaa3/provider-sdk";
import { BAILIAN_IMAGE_MODELS } from "./catalog.js";
import { discoverBailianModels } from "./discovery.js";
import { createBailianProvider, describeModel } from "./provider.js";
import { describeBailianModel } from "./schema.js";
import {
  BAILIAN_PLUGIN_ID,
  BAILIAN_PROVIDER_ID,
  BAILIAN_REGIONS,
  DEFAULT_BAILIAN_BASE_URL,
  DEFAULT_BAILIAN_REGION,
  bailianOrigin,
  bailianWorkspaceOrigin
} from "./shared.js";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** 设置页「可用模型」的刷新入口。 */
const REFRESH_PATH = "/api/providers/bailian/refresh";

export const BAILIAN_CONFIG = defineConfigSchema({
  apiKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "DASHSCOPE_API_KEY",
    label: "API Key",
    description: "百炼 / DashScope API Key，请求头使用 Bearer。北京与新加坡的 Key 不互通"
  },
  workspaceId: {
    kind: "string",
    default: "",
    reload: "hot",
    label: "业务空间 ID",
    description: "业务空间详情里的 ID。填写后按官方建议改走 https://{业务空间ID}.{地域}.maas.aliyuncs.com；留空用下面的 API 地址"
  },
  region: {
    kind: "string",
    default: DEFAULT_BAILIAN_REGION,
    reload: "hot",
    label: "地域",
    description: `业务空间域名所属地域：${BAILIAN_REGIONS.join(" / ")}`
  },
  baseUrl: {
    kind: "url",
    protocols: ["https:", "http:"],
    default: DEFAULT_BAILIAN_BASE_URL,
    reload: "hot",
    legacyEnv: "DASHSCOPE_BASE_URL",
    label: "API 地址",
    description: "未填业务空间 ID 时使用：北京 https://dashscope.aliyuncs.com，新加坡 https://dashscope-intl.aliyuncs.com"
  }
});

export type BailianRegistrationInput = {
  apiKey?: string;
  /** 业务空间 ID；填写后优先于 `baseUrl`。 */
  workspaceId?: string;
  /** 业务空间域名地域；缺省华北 2。 */
  region?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof globalThis.fetch;
};

export type BailianPluginDependencies = Pick<BailianRegistrationInput, "timeoutMs" | "maxBytes" | "fetchImpl">;

/**
 * 实际出网地址：业务空间 ID 能拼出合法域名就用它，否则退回 `baseUrl`。
 *
 * 不做「两个都试」：翻倍的重试会把一次配置错误变成两次超时，报错还更难读。
 */
export function bailianResolvedOrigin(input: Pick<BailianRegistrationInput, "workspaceId" | "region" | "baseUrl">): string {
  const workspace = bailianWorkspaceOrigin(input.workspaceId, input.region);
  if (workspace !== undefined) return workspace;
  return bailianOrigin(input.baseUrl?.trim() || DEFAULT_BAILIAN_BASE_URL);
}

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
  const baseUrl = bailianResolvedOrigin(input);
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
    website: "https://bailian.console.aliyun.com",
    modelTypes: ["image"],
    modelRefresh: {
      path: REFRESH_PATH,
      hint: "模型清单仍以扩展内的卡片为准（参数档位、像素表、参考图上限只有卡片有）。这里拉一次百炼的生图模型列表做对账：卡片里登记的模型上游是否还在，以及有没有新模型没被覆盖。"
    },
    inject: ["log", "generation", "gateway", "access"],
    Config: BAILIAN_CONFIG,
    health: (config) => {
      const apiKey = (config.apiKey ?? "").trim();
      const workspaceId = (config.workspaceId ?? "").trim();
      // 地址永远有值（`baseUrl` 有默认值），所以只有两种退化：缺 Key，或业务空间 ID 写了但
      // 拼不出域名——后者会静默退回老域名，用户以为已经走了新域名，必须报出来。
      const diagnostics = [];
      if (apiKey === "") {
        diagnostics.push({ code: "provider-credentials-missing", message: "未配置 API Key，百炼模型当前不可执行" });
      }
      if (workspaceId !== "" && bailianWorkspaceOrigin(workspaceId, config.region) === undefined) {
        diagnostics.push({
          code: "provider-workspace-id-invalid",
          message: `业务空间 ID「${workspaceId}」拼不出专属域名（只接受字母、数字与 -），当前用的是 API 地址`
        });
      }
      return diagnostics.length > 0 ? { state: "degraded" as const, diagnostics } : undefined;
    },
    async testConnection(config) {
      const apiKey = (config.apiKey ?? "").trim();
      if (!apiKey) return { ok: false, message: "请先填写百炼 API Key" };
      const workspaceId = (config.workspaceId ?? "").trim();
      const region = (config.region ?? "").trim() || DEFAULT_BAILIAN_REGION;
      if (workspaceId !== "" && bailianWorkspaceOrigin(workspaceId, region) === undefined) {
        return { ok: false, message: `业务空间 ID「${workspaceId}」拼不出专属域名（只接受字母、数字与 -）` };
      }
      const origin = bailianResolvedOrigin({ workspaceId, region, baseUrl: config.baseUrl });
      const result = await discoverBailianModels({
        baseUrl: origin,
        apiKey,
        known: BAILIAN_IMAGE_MODELS.map((model) => model.id),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        timeoutMs: 10_000
      });
      if (!result.ok) return { ok: false, message: result.message };
      return { ok: true, message: `测试通过，上游返回 ${result.models.length} 个生图模型` };
    },
    async apply(ctx, config) {
      const apiKey = config.apiKey?.trim() ?? "";
      const workspaceId = config.workspaceId?.trim() ?? "";
      const region = config.region?.trim() || DEFAULT_BAILIAN_REGION;
      const baseUrl = config.baseUrl;
      const origin = bailianResolvedOrigin({ workspaceId, region, baseUrl });
      const log = ctx.log.scope(BAILIAN_PLUGIN_ID);
      const registration = createBailianRegistration({
        ...deps,
        // 停用或改配置后，残留的调用不再发出带旧 Key 的请求。
        fetchImpl: createProviderLifecycleFetch(ctx, deps.fetchImpl),
        ...(apiKey ? { apiKey } : {}),
        workspaceId,
        region,
        baseUrl
      });

      const refresh = async (): Promise<{ ok: true; modelCount: number; message?: string } | { ok: false; message: string }> => {
        if (!registration.available) return { ok: false, message: "先配置 API Key 与地址" };
        const result = await discoverBailianModels({
          baseUrl: origin,
          apiKey,
          known: BAILIAN_IMAGE_MODELS.map((model) => model.id),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
        });
        if (!result.ok) {
          log({ event: "bailian-model-discovery-failed", message: result.message });
          return result;
        }

        // 对账完整（翻到了 total）才敢按发现结果降级：只翻到页数上限时的 `missing` 只是
        // 「这一轮没看到」，据此把模型判死会在上游正常时让用户白白看到一堆不可用模型。
        const unavailable = result.complete ? new Set(result.missing.map((id) => id.toLowerCase())) : new Set<string>();
        for (const model of registration.models) {
          const off = unavailable.has(model.providerModelId.toLowerCase());
          // 保留原始对象形状；这里只翻 `executable`，schema 与默认值仍来自卡片。
          model.executable = !off;
        }

        const parts = [`上游返回 ${result.models.length} 个生图模型`];
        if (unavailable.size > 0) parts.push(`上游未返回、已标记不可执行：${result.missing.join("、")}`);
        if (result.uncovered.length > 0) parts.push(`上游有但卡片未覆盖：${result.uncovered.join("、")}`);
        if (!result.complete) parts.push("模型列表未翻完，本次不做可用性判定");
        const message = parts.join("；");
        log({
          event: "bailian-models-discovered",
          modelCount: result.models.length,
          missing: result.missing,
          uncovered: result.uncovered,
          complete: result.complete
        });
        // 注册表本身不扩容：发现出来的新模型没有参数事实，注册进去只会得到一个不能用的面板。
        return { ok: true, modelCount: registration.models.length, message };
      };

      // 配好凭据就顺手对一次账：设置页的模型数量与「上游还在不在」不该等用户点刷新才出现。
      if (registration.available) await refresh();
      ctx.effect(() => ctx.generation.register(registration));
      registerModelRefreshRoute(ctx, { path: REFRESH_PATH, refresh });
      log({
        event: "bailian-plugin-activated",
        available: registration.available,
        modelCount: registration.models.length,
        origin,
        workspace: workspaceId !== ""
      });
    }
  };
}
