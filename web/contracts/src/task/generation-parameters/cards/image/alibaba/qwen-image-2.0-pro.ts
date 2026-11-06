/**
 * Qwen-Image 2.0 Pro（阿里）。
 *
 * 2.0 系列是唯一接受 `negative_prompt`（≤500 字符）的一批，同时支持 `prompt_extend`。
 * 一次最多三张参考图（2.1 / 3.0 才是 10 张）。
 */
import { MB, imageCard } from "../../../card.js";
import {
  ALIBABA_QWEN_SIZES,
  ALIBABA_WAN_ASPECT_RATIOS
} from "./alibaba-spec.js";

export const alibabaQwenImage20Pro = imageCard({
  id: "qwen-image-2.0-pro",
  title: "Qwen-Image 2.0 Pro",
  providerId: "bailian",
  vendor: "alibaba",
  providerModelId: "qwen-image-2.0-pro",
  docs: "https://help.aliyun.com/zh/model-studio/qwen-image-edit-api",
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
