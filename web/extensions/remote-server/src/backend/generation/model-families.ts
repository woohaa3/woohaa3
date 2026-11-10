/**
 * 远端模型 catalog 的**参数家族适配**（Provider 侧的职责）。
 *
 * 为什么这一层在扩展而不是 server：server 只是把 LiteLLM 网关的 `/v1/models` 目录原样
 * 转述——它不该知道「seedream 只认 size、Gemini 认 aspect_ratio」「Veo 只有 4/6/8 秒」这类
 * 厂商细节。模型家族判定与参数面板是 **Provider 适配器**的职责，与本地插件
 * （`extensions/litellm-provider`、`ark-provider`）同源，所以两边共用
 * `@woohaa3/contracts` 里的家族实现。
 *
 * 三个接缝：
 * 1. **目录**：`withModelFamily` 用家族 schema 覆盖服务端下发的那份通用形状；
 * 2. **约束**：`withPresetLimits` 按卡片给出 `capabilityFacts.limits`（`inputSchema`
 *    表达不了的「至少几张」「合计多少」）；
 * 3. **提交**：`translateParameters` 把面板语义（resolution / aspectRatio / durationSeconds）
 *    翻译成上游认识的字段。服务端把 `parameters` 原样转发给 LiteLLM，所以必须在这里翻译。
 *
 * 未识别家族或卡片时**保持服务端下发的自描述**：那是服务端最了解的东西，比按名字猜一个
 * 更安全。
 */
import {
  audioRequestFields,
  BUILTIN_PRESET_CARDS,
  composePresetCard,
  imageFamilyParameters,
  imageParameterFamily,
  imageRequestFields,
  musicRequestFields,
  videoFamilyFor,
  videoFamilyParameters,
  videoRequestFields,
  type GenerationModelDefinition
} from "@woohaa3/contracts";

/**
 * 按 `providerModelId` 找内置卡片。
 *
 * 两级匹配，顺序不能反：
 * 1. **精确 id**：卡片就是按这个上游 id 写的；
 * 2. **同家族**：网关的 id 带日期后缀与别名（`seedance-2-0-fast-260128`），精确匹配不到时
 *    退到家族——同一个家族的时长档位与参考上限一样，用哪张卡片的约束都不会错。
 *
 * 图像只做精确匹配：同一家族的不同版本（Seedream Pro / Flash / 4.5）档位确实不同，
 * 按家族挑一张会给出另一个版本的值域。
 */
function cardFor(providerModelId: string, modelType: string) {
  const normalized = providerModelId.trim().toLowerCase();
  if (normalized === "") return undefined;
  const exact = BUILTIN_PRESET_CARDS.find(
    (card) =>
      card.modelType === modelType && card.providerModelId.trim().toLowerCase() === normalized
  );
  if (exact !== undefined) return exact;
  if (modelType !== "video") return undefined;
  const family = videoFamilyFor(normalized);
  if (family === undefined) return undefined;
  return BUILTIN_PRESET_CARDS.find(
    (card) =>
      card.modelType === "video" && videoFamilyFor(card.providerModelId)?.id === family.id
  );
}

/**
 * 用 Provider 侧的家族 schema 覆盖目录里的通用 schema，并按卡片补上约束。
 *
 * 处理 image / video / audio：language 的参数仍以服务端为准。
 * 家族未命中时保持服务端 schema 不动——音频没有家族表，只有卡片能识别时才覆盖。
 */
export function withModelFamily(model: GenerationModelDefinition): GenerationModelDefinition {
  if (model.modelType !== "image" && model.modelType !== "video" && model.modelType !== "audio") {
    return model;
  }

  const card = cardFor(model.providerModelId, model.modelType);
  // 卡片只有约束、没有家族时（例如远端通用卡片），仍然要把约束带上。
  if (card !== undefined) {
    // 卡片自身的 schema 可能比家族更窄（keeps 剪枝 + narrow），直接用它合成。
    const composed = composePresetCard(card);
    return {
      ...model,
      title: model.title ?? composed.model.title,
      inputSchema: composed.model.inputSchema,
      defaultInput: composed.model.defaultInput,
      capabilities: mergeReferenceBindings(model.capabilities, composed.model.bindings),
      ...(composed.model.capabilityFacts !== undefined
        ? { capabilityFacts: composed.model.capabilityFacts }
        : {})
    };
  }

  // 音频没有家族表：卡片没命中就保持服务端下发的语音形状。
  if (model.modelType === "audio") return model;

  const family =
    model.modelType === "image"
      ? imageParameterFamily(model.providerModelId) === "generic"
        ? null
        : imageFamilyParameters(model.providerModelId)
      : videoFamilyFor(model.providerModelId) === undefined
        ? null
        : videoFamilyParameters(model.providerModelId);
  if (family === null) return model;
  const required =
    "required" in family && Array.isArray(family.required)
      ? family.required.filter((key): key is string => typeof key === "string")
      : [];

  return {
    ...model,
    inputSchema: {
      type: "object",
      properties: family.properties,
      ...(required.length > 0 ? { required } : {}),
      ...(family.schemaVersion !== undefined ? { "x-pptask-schema-version": family.schemaVersion } : {})
    },
    defaultInput: { ...family.defaults }
  };
}

/**
 * 把卡片声明的参考绑定并入 `capabilities.referenceInput.bindings`。
 *
 * 服务端下发的是**按模型类型**的一份通用绑定（视频三类都开、`max_items` 都是部署上限）。
 * 卡片知道得更细：某个模型只收参考图、上限 3 张。合并时以卡片的绑定为准，服务端那份只
 * 在卡片没声明时兜底。
 */
function mergeReferenceBindings(
  capabilities: Record<string, unknown> | undefined,
  bindings: readonly { field: string; semantic: string; roles: string[]; mediaKinds: string[]; mediaTypes: string[]; maxItems: number; valueFormat: string }[]
): Record<string, unknown> | undefined {
  if (bindings.length === 0) return capabilities;
  const referenceInput =
    capabilities !== null && typeof capabilities === "object" && !Array.isArray(capabilities)
      ? ((capabilities.referenceInput as Record<string, unknown> | undefined) ?? {})
      : {};
  return {
    ...(capabilities ?? {}),
    referenceInput: { ...referenceInput, bindings: bindings.map((binding) => ({ ...binding })) }
  };
}

/**
 * 把面板语义参数翻译成上游请求字段。
 *
 * 传入的是**已收敛**的参数（默认值已合并、脏值已清洗）：这里只做字段映射，不做校验。
 * 未识别家族时原样返回——服务端转发的就是上游原本想要的字段。
 */
export function translateParameters(
  providerModelId: string,
  modelType: string,
  parameters: Record<string, unknown>
): Record<string, unknown> {
  if (modelType === "image") {
    if (imageParameterFamily(providerModelId) === "generic") return parameters;
    return { ...imageRequestFields(providerModelId, parameters) };
  }
  if (modelType === "video") {
    if (videoFamilyFor(providerModelId) === undefined) return parameters;
    return { ...videoRequestFields(providerModelId, parameters) };
  }
  if (modelType === "audio") {
    // 只有卡片识别出的音频模型才翻译：未识别的模型保持服务端下发的字段名，
    // 由服务端与 LiteLLM 按它们自己的约定处理。
    const card = cardFor(providerModelId, "audio");
    if (card === undefined) return parameters;
    // 语音与音乐是两条上游路由，参数集合不同：音乐只认 lyrics，绝不发 voice / speed /
    // response_format（上游会忽略它们或报参数错误，而真正的问题是它们不属于这条路由）。
    if (isMusicCard(card)) return { ...musicRequestFields(parameters) };
    return { ...audioRequestFields(parameters) };
  }
  return parameters;
}

/**
 * 判定一张音频卡片是不是音乐生成。
 *
 * 依据卡片保留的语义键，而不是 id 关键字：卡片是「这个模型能用哪些参数」的唯一来源，
 * 音乐卡片恰好剪掉了 voice。这样新增一个音乐模型只要写对卡片，不必再维护一份 id 名单。
 */
function isMusicCard(card: { modelType: string; keeps: readonly string[] }): boolean {
  if (card.modelType !== "audio") return false;
  return !card.keeps.includes("voice");
}
