/**
 * Qwen-Image 2.0（阿里）。
 *
 * 与 2.0 Pro 参数能力相同：接受 `negative_prompt`（≤500 字符）与 `prompt_extend`，
 * 参考图最多 3 张。差别只在出图质量与价格。
 */
import { MB, imageCard } from "../../../card.js";
import {
  ALIBABA_QWEN_SIZES,
  ALIBABA_WAN_ASPECT_RATIOS
} from "./alibaba-spec.js";

export const alibabaQwenImage20 = imageCard({
  id: "qwen-image-2.0",
  title: "Qwen-Image 2.0",
  providerId: "bailian",
  vendor: "alibaba",
  providerModelId: "qwen-image-2.0",
  docs: "https://help.aliyun.com/zh/model-studio/qwen-image-api",
  note: "Qwen-Image 2.0：支持负向提示词（≤500 字），参考图最多 3 张",
  keeps: [
    "prompt",
    "referencesImage",
    "aspectRatio",
    "resolution",
    "negativePrompt",
    "promptExtend"
  ],
  alibaba: {
    aspectRatios: ALIBABA_WAN_ASPECT_RATIOS,
    resolutions: ["2K"],
    defaultAspectRatio: "1:1",
    defaultResolution: "2K",
    sizes: ALIBABA_QWEN_SIZES,
    fallbackSize: "2048*2048",
    supportsNegativePrompt: true,
    negativePromptLimit: 500,
    supportsPromptExtend: true,
    promptExtendDefault: true
  },
  limits: {
    references: { image: { min: 0, max: 3, maxBytesPerItem: 10 * MB } }
  }
});
