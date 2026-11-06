/**
 * 阿里（Alibaba）生图模型的出口。
 *
 * 目录名是**研发厂商**，不是承载通道：万相、Qwen-Image、Z-Image 都是阿里研发的模型，
 * 可以经百炼（Model Studio / DashScope）调用，也可以经 LiteLLM 网关或任何转发方调用。
 * 通道写在卡片的 `providerId` 上，与这里无关。
 *
 * 卡片查找（`alibaba-cards`）＋ 参数面板与请求字段投影（`alibaba-projection`）＋ 像素表与
 * 语义形状（`alibaba-spec`）。家族（`image-parameters`）与百炼 Provider 都从这里按 id 读卡片，
 * 不各自维护版本表。
 */
export {
  ALIBABA_CARDS,
  ALIBABA_SIZE_PRESETS,
  alibabaSizePresetFor,
  alibabaSpecOfCard
} from "./alibaba-cards.js";
export {
  alibabaFamilySchema,
  alibabaNegativePromptField,
  alibabaPromptExtendField,
  alibabaRequestFields
} from "./alibaba-projection.js";
export {
  ALIBABA_QWEN_SIZES,
  ALIBABA_WAN_ASPECT_RATIOS,
  ALIBABA_WAN_PRO_SIZES,
  ALIBABA_WAN_SIZES,
  ALIBABA_Z_IMAGE_ASPECT_RATIOS,
  ALIBABA_Z_IMAGE_SIZES,
  alibabaPixelSize,
  clampAlibabaResolution,
  type AlibabaSizePreset,
  type AlibabaSizeTable
} from "./alibaba-spec.js";
