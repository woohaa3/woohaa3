/**
 * Qwen-Image 2.1 Pro（阿里）。
 *
 * 2.1 系列同样**不接受 `negative_prompt`**（生图总览明确写了），但保留 `prompt_extend`。
 * 参考图上限从 2.0 的 3 张放宽到 10 张。
 */
import { MB, imageCard } from "../../../card.js";
import {
  ALIBABA_QWEN_SIZES,
  ALIBABA_WAN_ASPECT_RATIOS
} from "./alibaba-spec.js";

export const alibabaQwenImage21Pro = imageCard({
  id: "qwen-image-2.1-pro",
  title: "Qwen-Image 2.1 Pro",
  providerId: "bailian",
  vendor: "alibaba",
  providerModelId: "qwen-image-2.1-pro",
  docs: "https://help.aliyun.com/zh/model-studio/qwen-image-api",
  note: "Qwen-Image 2.1：2K 单档，参考图 10 张，不支持负向提示词",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution", "promptExtend"],
  alibaba: {
    aspectRatios: ALIBABA_WAN_ASPECT_RATIOS,
    resolutions: ["2K"],
    defaultAspectRatio: "1:1",
    defaultResolution: "2K",
    sizes: ALIBABA_QWEN_SIZES,
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
