/**
 * Qwen-Image 3.0 Pro（阿里）。
 *
 * 3.0 支持 `prompt_extend`（另有 `prompt_extend_mode` = direct / agent，本期不暴露），
 * 但**不接受 `negative_prompt`**：该参数只在 2.0 系列的 API 参考里逐项列出。
 */
import { MB, imageCard } from "../../../card.js";
import {
  ALIBABA_QWEN_SIZES,
  ALIBABA_WAN_ASPECT_RATIOS
} from "./alibaba-spec.js";

export const alibabaQwenImage30Pro = imageCard({
  id: "qwen-image-3.0-pro",
  title: "Qwen-Image 3.0 Pro",
  providerId: "bailian",
  vendor: "alibaba",
  providerModelId: "qwen-image-3.0-pro",
  docs: "https://help.aliyun.com/zh/model-studio/qwen-image-api",
  note: "Qwen-Image：2K 单档，支持智能改写，不支持负向提示词",
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
