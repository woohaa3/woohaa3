/**
 * Qwen-Image 2.1 Pro（阿里）。
 *
 * 2.1 系列**不接受 `negative_prompt`**：新版生图与编辑 API 参考与生图总览两处都只把它留给
 * 3.0 系列。`prompt_extend` 仍在。参考图上限从 2.0 的 3 张放宽到 10 张。
 *
 * 比例给一档「自适应」：官方写「不指定 `size` 时，模型根据提示词自动推荐分辨率」，所以选自适应
 * 就是整条 `size` 不发（`size: "auto"` 上游不认）。
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
  docs: "https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference",
  note: "Qwen-Image 2.1：2K 单档，参考图 10 张，不支持负向提示词",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution", "promptExtend"],
  alibaba: {
    aspectRatios: ALIBABA_WAN_ASPECT_RATIOS,
    resolutions: ["2K"],
    defaultAspectRatio: "1:1",
    defaultResolution: "2K",
    supportsAdaptiveAspectRatio: true,
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
