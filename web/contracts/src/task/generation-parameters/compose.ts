/**
 * 卡片 → 目录模型的合成。
 *
 * 顺序不能反：
 * 1. **基线**：家族声明了这个键就用家族的属性（家族知道厂商细节：档位、步长、枚举）；
 * 2. **剪枝**：只保留卡片 `keeps` 声明的键，被删的进 `dropped`；
 * 3. **追加**：`adds` 补上类型预设里没有的遗留键。
 *
 * 家族已声明的键**不套 `narrow` 的值域**：那会形成第二份事实。只有 `hiddenWhen`（交互联动）
 * 从卡片来——同一个模型在不同链路下的联动可能不同。
 */
import {
  referenceInputCapabilityFromDescription,
  type CanvasTaskCatalogModel
} from "../dto.js";
import { imageFamilyParameters, imageParameterFamily } from "../image-parameters.js";
import { videoFamilyParameters, videoFamilyFor } from "../video-parameters.js";
import type { GenerationModelLimits } from "../model-capabilities.js";
import type { PresetCard } from "./card.js";
import { CONTROL_BY_KEY } from "./controls.js";
import { MODEL_TYPE_PRESETS, type PresetModelType } from "./types.js";

export type ComposedPresetCard = {
  /** 合成后的目录模型，可直接交给 `projectParameterFields`。 */
  model: CanvasTaskCatalogModel;
  /** 类型预设里有、这张卡片剪掉的键。 */
  dropped: readonly string[];
  /** 卡片声明的约束（未与部署级取 min）。 */
  limits: GenerationModelLimits | undefined;
};

function mergeOptions(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined
): Record<string, unknown> {
  return { ...(base ?? {}), ...(override ?? {}) };
}

/**
 * 家族 schema。图像与视频共用同一套接缝（`imageFamilyParameters` / `videoFamilyParameters`），
 * 因此「新增一个厂商家族」只改家族表，卡片不需要跟着改。
 *
 * 音频没有版本化的值域（音色 / 格式 / 语速由模型目录与卡片本身给出），所以返回 null：
 * 卡片直接按类型预设 + `narrow` 合成，不经过家族表。
 */
function familySchema(
  modelType: PresetModelType,
  providerModelId: string
): { properties: Record<string, unknown>; defaults: Record<string, unknown> } | null {
  if (modelType === "image") {
    if (imageParameterFamily(providerModelId) === "generic") return null;
    const family = imageFamilyParameters(providerModelId);
    return family === null
      ? null
      : { properties: { ...family.properties }, defaults: { ...family.defaults } };
  }
  if (modelType === "audio") return null;
  if (videoFamilyFor(providerModelId) === undefined) return null;
  const family = videoFamilyParameters(providerModelId);
  return family === null
    ? null
    : { properties: { ...family.properties }, defaults: { ...family.defaults } };
}

/** 把一张卡片合成目录模型。 */
export function composePresetCard(card: PresetCard): ComposedPresetCard {
  const preset = MODEL_TYPE_PRESETS[card.modelType];
  const family = familySchema(card.modelType, card.providerModelId);

  const kept = new Set(card.keeps);
  const properties: Record<string, unknown> = {};
  const defaults: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const key of preset.keys) {
    if (!kept.has(key)) {
      dropped.push(key);
      continue;
    }
    const fromFamily = family?.properties[key] as Record<string, unknown> | undefined;
    if (fromFamily !== undefined) {
      const hiddenWhen = card.narrow?.[key]?.hiddenWhen;
      properties[key] =
        hiddenWhen === undefined ? { ...fromFamily } : { ...fromFamily, "x-hidden-when": hiddenWhen };
      const familyDefault = family?.defaults[key];
      const propertyDefault = fromFamily.default;
      if (familyDefault !== undefined) defaults[key] = familyDefault;
      else if (propertyDefault !== undefined) defaults[key] = propertyDefault;
      continue;
    }
    const control = CONTROL_BY_KEY.get(key);
    if (control === undefined) continue;
    const property = control.build(mergeOptions(preset.options[key], card.narrow?.[key]));
    properties[key] = property;
    if (property.default !== undefined) defaults[key] = property.default;
  }

  for (const key of card.adds ?? []) {
    const control = CONTROL_BY_KEY.get(key);
    if (control === undefined) continue;
    const property = control.build({});
    properties[key] = property;
    if (property.default !== undefined) defaults[key] = property.default;
  }

  // 参考素材的 `maxItems` 由约束驱动：同一张卡片声明了 `limits.references.image.max` 时，
  // 这里必须与它一致，否则「面板说最多 3 张」和「绑定说最多 16 张」会变成两份真相。
  for (const [key, kind] of [
    ["referencesImage", "image"],
    ["referencesVideo", "video"],
    ["referencesAudio", "audio"]
  ] as const) {
    const limit = card.limits?.references?.[kind];
    const property = properties[key] as Record<string, unknown> | undefined;
    if (limit === undefined || property === undefined) continue;
    property.maxItems = limit.max;
  }

  const inputSchema: Record<string, unknown> = { type: "object", properties };
  if (preset.required.every((key) => kept.has(key))) {
    inputSchema.required = [...preset.required];
  }

  const model: CanvasTaskCatalogModel = {
    modelKey: card.providerId + ":" + card.id,
    providerId: card.providerId,
    providerModelId: card.providerModelId,
    modelType: card.modelType,
    title: card.title,
    interaction: { id: "generic-model", version: 1 },
    inputSchema,
    defaultInput: defaults,
    bindings: referenceInputCapabilityFromDescription({ inputSchema, defaultInput: defaults }).bindings,
    ...(card.referencePolicy ? { referencePolicy: card.referencePolicy } : {}),
    taskTimeoutMs: 8 * 60_000,
    ...(card.limits !== undefined ? { capabilityFacts: { limits: card.limits } } : {})
  };

  return { model, dropped, limits: card.limits };
}
