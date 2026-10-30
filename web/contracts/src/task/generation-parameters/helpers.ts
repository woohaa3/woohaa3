/**
 * 卡片表的读取入口。
 *
 * 放在 `compose.ts` 旁边而不是塞进 `cards/`：它读的是**合成后的目录模型**，
 * 与具体有哪些卡片无关。
 */
import { catalogModelBindings, type CanvasTaskCatalogModel, type CanvasTaskInputBinding } from "../dto.js";
import type { GenerationModelLimits } from "../model-capabilities.js";
import type { PresetCard } from "./card.js";
import type { PresetModelType } from "./types.js";

/** 按模型类型筛卡片。 */
export function presetCardsOf(
  cards: readonly PresetCard[],
  modelType: PresetModelType
): readonly PresetCard[] {
  return cards.filter((card) => card.modelType === modelType);
}

/** 从目录模型取回卡片声明的约束（供只拿到模型、没有卡片对象的一方使用）。 */
export function presetLimitsOf(
  model: Pick<CanvasTaskCatalogModel, "capabilityFacts">
): GenerationModelLimits | undefined {
  const facts = model.capabilityFacts as { limits?: GenerationModelLimits } | undefined;
  return facts?.limits;
}

/**
 * 卡片用 `narrow` 收窄的枚举值（例如 `outputFormat`）；没声明时返回 undefined。
 *
 * Provider 做请求字段校验时需要「这个模型能发哪些值」——那是卡片的事实，不能自己再存一份。
 */
export function cardEnumValues(card: PresetCard, key: string): readonly string[] | undefined {
  const values = card.narrow?.[key]?.values;
  if (!Array.isArray(values)) return undefined;
  const strings = values.filter((value): value is string => typeof value === "string");
  return strings.length > 0 ? strings : undefined;
}

/** 卡片声明的参考图上限（`limits.references.image.max`），没声明时返回 undefined。 */
export function cardImageReferenceLimit(card: PresetCard): number | undefined {
  return card.limits?.references?.image?.max;
}

/** 参考素材绑定的便捷读取（与 `catalogModelBindings` 同源，避免调用方各写一份）。 */
export function referenceBindingsOf(model: CanvasTaskCatalogModel): readonly CanvasTaskInputBinding[] {
  return catalogModelBindings(model);
}
