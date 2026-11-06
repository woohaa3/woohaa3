/**
 * Qwen-Image 2.1 Turbo（阿里云百炼）。
 *
 * 与 2.1 Pro 的能力一致，只是更便宜更快；参数面板完全相同（2K 单档、参考图 10 张、无负向
 * 提示词、智能改写默认开）。
 */
import { MB, imageCard } from "../../../card.js";
import {
  BAILIAN_QWEN_SIZES,
  BAILIAN_WAN_ASPECT_RATIOS
} from "./bailian-spec.js";

export const bailianQwenImage21Turbo = imageCard({
  id: "qwen-image-2.1-turbo",
  title: "Qwen-Image 2.1 Turbo",
  providerId: "bailian",
  vendor: "bailian",
  providerModelId: "qwen-image-2.1-turbo",
  docs: "https://help.aliyun.com/zh/model-studio/qwen-image-api",
  note: "Qwen-Image 2.1：更快的同能力版本",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution", "promptExtend"],
  bailian: {
    aspectRatios: BAILIAN_WAN_ASPECT_RATIOS,
    resolutions: ["2K"],
    defaultAspectRatio: "1:1",
    defaultResolution: "2K",
    sizes: BAILIAN_QWEN_SIZES,
    fallbackSize: "2048*2048",
    supportsNegativePrompt: false,
    negativePromptLimit: 0,
    supportsPromptExtend: true,
    promptExtendDefault: true
  },
  limits: {
    references: { image: { min: 0, max: 10, maxBytesPerItem: 10 * MB } }
  }
});
