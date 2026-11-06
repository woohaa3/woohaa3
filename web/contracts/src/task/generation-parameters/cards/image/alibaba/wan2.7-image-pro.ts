/**
 * 万相 2.7 Pro（阿里）。
 *
 * 万相没有 `negative_prompt` / `prompt_extend`（要提质得开 `thinking_mode`，本期不暴露），
 * 所以卡片不保这两个键。4K 档**只对纯文生图开放**：带参考图时上游只接受 2048*2048 以内，
 * 由 `alibaba` 块的 `referenceResolutionCap` 收口——面板留着 4K，提交时压回 2K。
 *
 * 这份卡片是万相 2.7 Pro 能力的唯一来源：家族（`image-parameters`）与百炼 Provider 都按
 * `providerModelId` 读这里，不另存一份数字。
 */
import { MB, imageCard } from "../../../card.js";
import {
  ALIBABA_WAN_ASPECT_RATIOS,
  ALIBABA_WAN_PRO_SIZES
} from "./alibaba-spec.js";

export const alibabaWan27Pro = imageCard({
  id: "wan2.7-image-pro",
  title: "万相 2.7 Pro",
  providerId: "bailian",
  vendor: "alibaba",
  providerModelId: "wan2.7-image-pro",
  docs: "https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference",
  note: "万相：4K 仅纯文生图，带参考图时封顶 2K",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution"],
  alibaba: {
    aspectRatios: ALIBABA_WAN_ASPECT_RATIOS,
    resolutions: ["1K", "2K", "4K"],
    defaultAspectRatio: "1:1",
    defaultResolution: "2K",
    supportsAdaptiveAspectRatio: false,
    sizes: ALIBABA_WAN_PRO_SIZES,
    fallbackSize: "2048*2048",
    referenceResolutionCap: "2K",
    supportsNegativePrompt: false,
    negativePromptLimit: 0,
    supportsPromptExtend: false,
    promptExtendDefault: false
  },
  limits: {
    references: { image: { min: 0, max: 9, maxBytesPerItem: 10 * MB } }
  }
});
