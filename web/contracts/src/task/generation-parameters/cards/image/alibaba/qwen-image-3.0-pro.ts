/**
 * Qwen-Image 3.0 Pro（阿里）。
 *
 * 3.0 支持 `prompt_extend`（另有 `prompt_extend_mode` = direct / agent，本期不暴露），
 * 并接受 `negative_prompt`：新版生图与编辑 API 参考在 `negative_prompt` 下写明「仅
 * qwen-image-3.0 系列支持此参数」。2.0 自己的文生图页仍把它列为 2.0 的参数（两份文档打架，
 * 见 `qwen-image-2.0.ts`），2.1 则两处都没有——所以只有 2.1 确定不支持。
 *
 * 参考图上限：3.0 系列是 1–3 张（2.1 系列是 1–10 张）。
 *
 * 比例给一档「自适应」：官方写「不指定 `size` 时，模型根据提示词自动推荐分辨率」，所以选自适应
 * 就是整条 `size` 不发（`size: "auto"` 上游不认）。
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
  docs: "https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference",
  note: "Qwen-Image：2K 单档，支持智能改写与负向提示词",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution", "negativePrompt", "promptExtend"],
  alibaba: {
    aspectRatios: ALIBABA_WAN_ASPECT_RATIOS,
    resolutions: ["2K"],
    defaultAspectRatio: "1:1",
    defaultResolution: "2K",
    supportsAdaptiveAspectRatio: true,
    sizes: ALIBABA_QWEN_SIZES,
    fallbackSize: "2048*2048",
    // 官方只写「仅 qwen-image-3.0 系列支持此参数」，没有给长度上限（2.0 的 500 字符只属于
    // 2.0 那页），所以不截断：`0` = 该代没有已知上限。
    supportsNegativePrompt: true,
    negativePromptLimit: 0,
    supportsPromptExtend: true,
    promptExtendDefault: true
  },
  limits: {
    references: { image: { min: 0, max: 3, maxBytesPerItem: 10 * MB } }
  }
});
