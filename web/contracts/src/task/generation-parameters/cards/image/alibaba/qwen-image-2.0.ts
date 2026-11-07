/**
 * Qwen-Image 2.0（阿里）。
 *
 * 与 2.0 Pro 参数能力相同：接受 `negative_prompt`（≤500 字符）与 `prompt_extend`，
 * 参考图最多 3 张。差别只在出图质量与价格。
 *
 * `negative_prompt` 的归属有两份文档打架：新版生图与编辑 API 参考（3.0 / 2.1 那页）写「仅
 * qwen-image-3.0 系列支持此参数」，而 2.0 自己的文生图页仍把它列为 2.0 系列的参数（≤500 字符）。
 * 这里按 2.0 的页面保留——它是这份模型的专属文档，比一页以 3.0 为主语的总表更具体；发出去即使
 * 被忽略也只是退化成本文生图，不会 400。
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
    supportsAdaptiveAspectRatio: false,
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
