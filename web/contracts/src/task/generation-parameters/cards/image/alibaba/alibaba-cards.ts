/**
 * 阿里卡片 → 模型语义的投影。
 *
 * **卡片是唯一事实来源**：比例、档位、官方像素表、带参考图时的档位上限、负向提示词与智能
 * 改写全都写在同一目录的卡片里。本模块只做两件事：
 *
 * 1. 按模型 id 找卡片：**只做精确 `providerModelId` 匹配**。阿里的 id 由我们自己登记（不像
 *    网关那样带日期后缀或别名），所以不给前缀 / 家族兜底——猜错版本会发出上游不认的 `size`；
 * 2. 把卡片投影成 Provider 与家族共用的 `AlibabaSizePreset`（`id` 与参考图上限取自卡片本身，
 *    不再另存一份数字）。
 *
 * 所以「新增一个阿里模型」= 加一张卡片，不需要往任何表里补一行数据。
 */
import type { PresetCard } from "../../../card.js";
import type { AlibabaSizePreset } from "./alibaba-spec.js";
import { alibabaQwenImage20 } from "./qwen-image-2.0.js";
import { alibabaQwenImage20Pro } from "./qwen-image-2.0-pro.js";
import { alibabaQwenImage21Pro } from "./qwen-image-2.1-pro.js";
import { alibabaQwenImage21Turbo } from "./qwen-image-2.1-turbo.js";
import { alibabaQwenImage30Pro } from "./qwen-image-3.0-pro.js";
import { alibabaWan27 } from "./wan2.7-image.js";
import { alibabaWan27Pro } from "./wan2.7-image-pro.js";
import { alibabaZImageTurbo } from "./z-image-turbo.js";

/** 卡片声明的阿里模型语义 → Provider 共用形状。 */
export function alibabaSpecOfCard(card: PresetCard): AlibabaSizePreset | undefined {
  const data = card.alibaba;
  if (data === undefined) return undefined;
  return {
    ...data,
    id: card.id,
    // 参考图上限只存一份：卡片的 `limits`。
    maxReferenceImages: card.limits?.references?.image?.max ?? 0
  };
}

/** 声明了阿里模型语义的卡片（顺序即设置页与面板里的顺序：旗舰在前）。 */
export const ALIBABA_CARDS: readonly PresetCard[] = [
  alibabaWan27Pro,
  alibabaWan27,
  alibabaQwenImage30Pro,
  alibabaQwenImage21Pro,
  alibabaQwenImage21Turbo,
  alibabaQwenImage20Pro,
  alibabaQwenImage20,
  alibabaZImageTurbo
];

const ALIBABA_SPECS: readonly { card: PresetCard; spec: AlibabaSizePreset }[] = ALIBABA_CARDS.flatMap(
  (card) => {
    const spec = alibabaSpecOfCard(card);
    return spec === undefined ? [] : [{ card, spec }];
  }
);

/** 所有已登记的阿里模型（卡片投影）。 */
export const ALIBABA_SIZE_PRESETS: readonly AlibabaSizePreset[] = ALIBABA_SPECS.map(
  (entry) => entry.spec
);

/**
 * 按模型 id 精确匹配阿里模型；未命中返回 undefined。
 *
 * 不做前缀兜底：`qwen-image-*` 这类前缀横跨三代、参数能力不同（3.0 才接受 `negative_prompt`，
 * 2.1 只给 `prompt_extend`，2.0 又是另一套像素表），按前缀挑一张就会给出另一个版本的值域。
 */
export function alibabaSizePresetFor(modelId: string): AlibabaSizePreset | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === "") return undefined;
  return ALIBABA_SPECS.find(
    (entry) => entry.card.providerModelId.trim().toLowerCase() === normalized
  )?.spec;
}
