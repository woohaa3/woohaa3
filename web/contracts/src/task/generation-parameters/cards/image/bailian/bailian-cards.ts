/**
 * 百炼卡片 → 模型语义的投影。
 *
 * **卡片是唯一事实来源**：比例、档位、官方像素表、带参考图时的档位上限、负向提示词与智能
 * 改写全都写在同一目录的卡片里。本模块只做两件事：
 *
 * 1. 按模型 id 找卡片：**只做精确 `providerModelId` 匹配**。百炼的 id 由我们自己登记（不像
 *    网关那样带日期后缀或别名），所以不给前缀 / 家族兜底——猜错版本会发出上游不认的 `size`；
 * 2. 把卡片投影成 Provider 与家族共用的 `BailianSizePreset`（`id` 与参考图上限取自卡片本身，
 *    不再另存一份数字）。
 *
 * 所以「新增一个百炼模型」= 加一张卡片，不需要往任何表里补一行数据。
 */
import type { PresetCard } from "../../../card.js";
import type { BailianSizePreset } from "./bailian-spec.js";
import { bailianQwenImage20 } from "./qwen-image-2.0.js";
import { bailianQwenImage20Pro } from "./qwen-image-2.0-pro.js";
import { bailianQwenImage21Pro } from "./qwen-image-2.1-pro.js";
import { bailianQwenImage21Turbo } from "./qwen-image-2.1-turbo.js";
import { bailianQwenImage30Pro } from "./qwen-image-3.0-pro.js";
import { bailianWan27 } from "./wan2.7-image.js";
import { bailianWan27Pro } from "./wan2.7-image-pro.js";
import { bailianZImageTurbo } from "./z-image-turbo.js";

/** 卡片声明的百炼模型语义 → Provider 共用形状。 */
export function bailianSpecOfCard(card: PresetCard): BailianSizePreset | undefined {
  const data = card.bailian;
  if (data === undefined) return undefined;
  return {
    ...data,
    id: card.id,
    // 参考图上限只存一份：卡片的 `limits`。
    maxReferenceImages: card.limits?.references?.image?.max ?? 0
  };
}

/** 声明了百炼模型语义的卡片（顺序即设置页与面板里的顺序：旗舰在前）。 */
export const BAILIAN_CARDS: readonly PresetCard[] = [
  bailianWan27Pro,
  bailianWan27,
  bailianQwenImage30Pro,
  bailianQwenImage21Pro,
  bailianQwenImage21Turbo,
  bailianQwenImage20Pro,
  bailianQwenImage20,
  bailianZImageTurbo
];

const BAILIAN_SPECS: readonly { card: PresetCard; spec: BailianSizePreset }[] = BAILIAN_CARDS.flatMap(
  (card) => {
    const spec = bailianSpecOfCard(card);
    return spec === undefined ? [] : [{ card, spec }];
  }
);

/** 所有已登记的百炼模型（卡片投影）。 */
export const BAILIAN_SIZE_PRESETS: readonly BailianSizePreset[] = BAILIAN_SPECS.map(
  (entry) => entry.spec
);

/**
 * 按模型 id 精确匹配百炼模型；未命中返回 undefined。
 *
 * 不做前缀兜底：`qwen-image-*` 这类前缀横跨三代、参数能力不同（2.0 有负向提示词，2.1 / 3.0
 * 没有），按前缀挑一张就会给出另一个版本的值域。
 */
export function bailianSizePresetFor(modelId: string): BailianSizePreset | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === "") return undefined;
  return BAILIAN_SPECS.find(
    (entry) => entry.card.providerModelId.trim().toLowerCase() === normalized
  )?.spec;
}
