/**
 * Z-Image Turbo（阿里云百炼）。
 *
 * 只能文生图：`maxReferenceImages` 为 0，所以卡片不保 `referencesImage`（面板不出现上传），
 * 请求也不带 `urls`。档位只有 1K，但比例最全（含 21:9）。
 *
 * `prompt_extend` 默认**关**：官方写明「开启会增加费用」，与 Qwen 系列的默认开不同，
 * 所以默认值写在卡片自己的 `bailian` 块里。
 */
import { imageCard } from "../../../card.js";
import {
  BAILIAN_Z_IMAGE_ASPECT_RATIOS,
  BAILIAN_Z_IMAGE_SIZES
} from "./bailian-spec.js";

export const bailianZImageTurbo = imageCard({
  id: "z-image-turbo",
  title: "Z-Image Turbo",
  providerId: "bailian",
  vendor: "bailian",
  providerModelId: "z-image-turbo",
  docs: "https://help.aliyun.com/zh/model-studio/z-image-api-reference",
  note: "Z-Image：只能文生图，1K 单档，智能改写默认关（会增加费用）",
  keeps: ["prompt", "aspectRatio", "resolution", "promptExtend"],
  bailian: {
    aspectRatios: BAILIAN_Z_IMAGE_ASPECT_RATIOS,
    resolutions: ["1K"],
    defaultAspectRatio: "1:1",
    defaultResolution: "1K",
    sizes: BAILIAN_Z_IMAGE_SIZES,
    fallbackSize: "1024*1536",
    supportsNegativePrompt: false,
    negativePromptLimit: 0,
    supportsPromptExtend: true,
    promptExtendDefault: false
  }
});
