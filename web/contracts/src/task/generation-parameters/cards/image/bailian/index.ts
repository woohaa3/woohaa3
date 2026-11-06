/**
 * 百炼（阿里云 Model Studio）生图模型的出口。
 *
 * 卡片查找（`bailian-cards`）＋ 参数面板与请求字段投影（`bailian-projection`）＋ 像素表与
 * 语义形状（`bailian-spec`）。家族（`image-parameters`）与百炼 Provider 都从这里按 id 读卡片，
 * 不各自维护版本表。
 */
export {
  BAILIAN_CARDS,
  BAILIAN_SIZE_PRESETS,
  bailianSizePresetFor,
  bailianSpecOfCard
} from "./bailian-cards.js";
export {
  bailianFamilySchema,
  bailianNegativePromptField,
  bailianPromptExtendField,
  bailianRequestFields
} from "./bailian-projection.js";
export {
  BAILIAN_QWEN_SIZES,
  BAILIAN_WAN_ASPECT_RATIOS,
  BAILIAN_WAN_PRO_SIZES,
  BAILIAN_WAN_SIZES,
  BAILIAN_Z_IMAGE_ASPECT_RATIOS,
  BAILIAN_Z_IMAGE_SIZES,
  bailianPixelSize,
  clampBailianResolution,
  type BailianSizePreset,
  type BailianSizeTable
} from "./bailian-spec.js";
