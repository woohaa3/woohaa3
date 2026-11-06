/**
 * 万相 2.7（阿里）。
 *
 * 与 Pro 的差别只有档位：普通版没有 4K 表（官方只给 2.7 Pro 开放 4K），其余能力相同
 * （无负向提示词、无智能改写、参考图 9 张）。
 */
import { MB, imageCard } from "../../../card.js";
import {
  ALIBABA_WAN_ASPECT_RATIOS,
  ALIBABA_WAN_SIZES
} from "./alibaba-spec.js";

export const alibabaWan27 = imageCard({
  id: "wan2.7-image",
  title: "万相 2.7",
  providerId: "bailian",
  vendor: "alibaba",
  providerModelId: "wan2.7-image",
  docs: "https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference",
  note: "万相：1K / 2K 两档，没有 4K",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution"],
  alibaba: {
    aspectRatios: ALIBABA_WAN_ASPECT_RATIOS,
    resolutions: ["1K", "2K"],
    defaultAspectRatio: "1:1",
    defaultResolution: "2K",
    sizes: ALIBABA_WAN_SIZES,
    fallbackSize: "2048*2048",
    supportsNegativePrompt: false,
    negativePromptLimit: 0,
    supportsPromptExtend: false,
    promptExtendDefault: false
  },
  limits: {
    references: { image: { min: 0, max: 9, maxBytesPerItem: 10 * MB } }
  }
});
