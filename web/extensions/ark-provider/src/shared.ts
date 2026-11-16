/**
 * Ark Provider 插件共享身份与模型目录。
 *
 * 只含身份、目录和静态描述；执行协议在本扩展 `src/provider/`（复用 pptask core/shared toolkit）。
 * 前后端均可导入。
 * 目录列出已知模型，全部按公开 Model ID 注册即可执行；推理接入点（`ep-`）是可选覆盖。
 */
import type { ApplicationExtensionMetadata, GenerationModelDefinition } from "@woohaa3/contracts";
import {
  ARK_CATALOG,
  ARK_DEFAULT_BASE_URL,
  ARK_PROVIDER_ID,
  describeArkModel,
  type ArkCatalogModel
} from "./provider/index.js";

export { ARK_DEFAULT_BASE_URL, ARK_PROVIDER_ID };

export const ARK_PLUGIN_ID = "ark-provider";

/** 目录模型 ID → 推理接入点 ID。 */
export type ArkEndpointMap = Record<string, string>;

const ENDPOINT_ID = /^ep-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/** 设置项字段名：`ep.<类型>.<模型ID>`，挂在 `providers.ark` 下。 */
export function arkEndpointField(kind: string, modelId: string): string {
  return `ep.${kind}.${modelId}`;
}

/** 从已解析的插件配置里收集填了接入点的模型。非法值记入 errors，不挡其它模型。 */
export function endpointsFromConfig(config: object): { endpoints: ArkEndpointMap; errors: string[] } {
  const record = config as Record<string, unknown>;
  const endpoints: ArkEndpointMap = {};
  const errors: string[] = [];
  for (const model of ARK_CATALOG) {
    const raw = record[arkEndpointField(model.kind, model.id)];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) continue;
    if (!ENDPOINT_ID.test(value)) {
      errors.push(`${model.title} 的接入点需要是 ep- 开头`);
      continue;
    }
    endpoints[model.id] = value;
  }
  return { endpoints, errors };
}

/**
 * 每个目录模型一个接入点字段。
 *
 * **全部留空也能用**：这时请求体直接发公开 Model ID。填了 `ep-` 就优先用接入点
 * （便于把调用绑到自己的限流/计费策略上）。
 */
export function arkEndpointFields(): Record<string, {
  kind: "string";
  reload: "hot";
  label: string;
  description: string;
  legacyEnv?: string;
}> {
  const legacy: Record<string, string> = {
    "doubao-seedance-2-0-260128": "ARK_VIDEO_SEEDANCE2_0_MODEL",
    "doubao-seedance-2-5-260628": "ARK_VIDEO_SEEDANCE2_5_MODEL"
  };
  return Object.fromEntries(ARK_CATALOG.map((model) => [arkEndpointField(model.kind, model.id), {
    kind: "string" as const,
    reload: "hot" as const,
    label: model.title,
    // 留空 = 直接用公开 Model ID 调用。
    description: `${model.id}（留空则直接用此 Model ID 调用；填 ep- 则改为走推理接入点）`,
    ...(legacy[model.id] ? { legacyEnv: legacy[model.id] } : {})
  }]));
}

/**
 * 目录里的每个模型都注册。
 *
 * `executable` 留给宿主按「Provider 是否可用」（API Key 就绪）与模型自身开关决定；
 * 这里**不因缺推理接入点而降级**：公开 Model ID 可以直接调用，接入点只是可选覆盖。
 *
 * 参数保留是为了让调用方能继续把已解析的接入点表传进来（将来若需要在模型行上
 * 暴露接入点归属，可以从这里取），当前不影响可执行性。
 */
export function arkModelDefinitions(_endpoints: ArkEndpointMap): GenerationModelDefinition[] {
  return ARK_CATALOG.map((model) => {
    const description = describeArkModel(model.id);
    return {
      providerId: ARK_PROVIDER_ID,
      providerModelId: model.id,
      modelType: model.kind,
      ...(description.title ? { title: description.title } : {}),
      ...(description.inputSchema ? { inputSchema: description.inputSchema } : {}),
      ...(description.defaultInput ? { defaultInput: description.defaultInput } : {}),
      promptRequirement: promptRequirement(model),
      cancel: "unsupported" as const,
      // 接入点只决定「请求体里的 model 用哪个 ID」，不是可执行的前提。
      executable: true
    };
  });
}

function promptRequirement(model: ArkCatalogModel): "required" | "optional" {
  if (model.kind === "image" && model.image?.layerDecomposition) return "optional";
  if (model.video?.family.startsWith("seedance-2")) return "optional";
  return "required";
}

export const ARK_PLUGIN_METADATA: ApplicationExtensionMetadata = {
  extensionId: ARK_PLUGIN_ID,
  name: "Ark Provider",
  description: "火山方舟文本、图片与视频生成 Provider。填 API Key 即可用公开 Model ID 调用；如需绑定自定义限流/计费，再为模型填推理接入点。",
  version: "1.1.1",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "ark-provider-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [],
  defaultEnabled: true
};
