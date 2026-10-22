/**
 * 远端图像模型的参数家族适配（Provider 侧的职责）。
 *
 * 为什么这一层在扩展而不是 server：server 只是把 LiteLLM 网关的 /v1/models 目录原样转述
 * ——它不该知道「seedream 只认 size、Gemini 认 aspect_ratio」这类厂商细节。模型家族判定与
 * 参数面板、请求字段翻译都是 **Provider 适配器**的职责，与本地插件
 * (`extensions/litellm-provider`) 完全同源，所以两边共用 `@woohaa3/contracts` 里的
 * `imageParameterFamily` / `imageFamilyParameters` / `imageRequestFields`。
 *
 * 两个接缝：
 * 1. **目录**：`withImageParameterFamily` 用家族 schema 覆盖服务端下发的那份通用
 *    `{"size": "1024x1024"}`。服务端给的 schema 保留为回退（未知家族时不动它），
 *    这样新家族上线不需要先发服务端版本。
 * 2. **提交**：`translateImageParameters` 把面板语义（resolution / aspectRatio）翻译成
 *    上游认识的字段（像素 size / image_size / aspect_ratio）。服务端把 parameters 原样
 *    转发给 LiteLLM，所以必须在这里翻译——否则即梦会安静地忽略它们，出图尺寸回到默认。
 */
import {
  imageFamilyParameters,
  imageParameterFamily,
  imageRequestFields,
  type GenerationModelDefinition
} from "@woohaa3/contracts";

/**
 * 用 Provider 侧的家族 schema 覆盖目录里的通用 schema。
 *
 * 只处理 image：language/audio/video 的参数仍以服务端为准（本期未家族化）。
 * `imageFamilyParameters` 返回 null（未识别家族）时保持服务端 schema 不动——那是
 * 服务端最了解的自描述，比按名字猜一个更安全。
 */
export function withImageParameterFamily(model: GenerationModelDefinition): GenerationModelDefinition {
  if (model.modelType !== "image") return model;
  const family = imageFamilyParameters(model.providerModelId);
  if (family === null) return model;
  return {
    ...model,
    // 家族 schema 是权威：它来自与本地插件同一份契约，显式覆盖服务端的通用形状。
    inputSchema: {
      type: "object",
      properties: family.properties,
      ...(family.schemaVersion !== undefined ? { "x-pptask-schema-version": family.schemaVersion } : {})
    },
    defaultInput: { ...family.defaults }
  };
}

/**
 * 把面板语义参数翻译成上游请求字段。
 *
 * 传入的是**已收敛**的参数（默认值已合并、脏值已清洗）：这里只做字段映射，不做校验。
 * 未识别家族时原样返回——服务端转发的就是上游原本想要的字段。
 */
export function translateImageParameters(
  providerModelId: string,
  parameters: Record<string, unknown>
): Record<string, unknown> {
  if (imageParameterFamily(providerModelId) === "generic") return parameters;
  // imageRequestFields 的返回是「上游请求字段」，值只有 string/number：与协议里的
  // parameters Struct 同形，可以直接当提交体。
  return { ...imageRequestFields(providerModelId, parameters) };
}
