/**
 * 卡片表的读取入口。
 *
 * 放在 `compose.ts` 旁边而不是塞进 `cards/`：它读的是**合成后的目录模型**，
 * 与具体有哪些卡片无关。
 */
import { catalogModelBindings, type CanvasTaskCatalogModel, type CanvasTaskInputBinding } from "../dto.js";
import type { GenerationModelLimits } from "../model-capabilities.js";
import type { PresetCard } from "./card.js";

/** 按模型类型筛卡片。 */
export function presetCardsOf(cards: readonly PresetCard[], modelType: "image" | "video"): readonly PresetCard[] {
  return cards.filter((card) => card.modelType === modelType);
}

/** 从目录模型取回卡片声明的约束（供只拿到模型、没有卡片对象的一方使用）。 */
export function presetLimitsOf(
  model: Pick<CanvasTaskCatalogModel, "capabilityFacts">
): GenerationModelLimits | undefined {
  const facts = model.capabilityFacts as { limits?: GenerationModelLimits } | undefined;
  return facts?.limits;
}

/** 参考素材绑定的便捷读取（与 `catalogModelBindings` 同源，避免调用方各写一份）。 */
export function referenceBindingsOf(model: CanvasTaskCatalogModel): readonly CanvasTaskInputBinding[] {
  return catalogModelBindings(model);
}
