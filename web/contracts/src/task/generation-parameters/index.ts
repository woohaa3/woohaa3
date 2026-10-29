/**
 * 生成参数预设：**参数最大集合 → 模型类型预设 → 模型卡片 → 约束**。
 *
 * 三层各自回答一个问题，混在一起就会出现「同一个模型在两个链路上面板不一样」：
 *
 * 1. **参数最大集合**（`controls.ts`）：有限、可穷举的预设控件。新增能力先进这里，
 *    而不是先在某个 Provider 里写死。
 * 2. **类型预设**（`types.ts`）：video 该有时长 / 比例 / 分辨率，image 该有质量 / 数量。
 *    这是「类型」的知识，与厂商无关。
 * 3. **模型卡片**（`cards/`）：在类型预设上剪枝、收窄、声明约束。**目录结构即分类**：
 *    `cards/<image|video>/<vendor>/<model>.ts`。
 *
 * 值域（档位、步长、枚举）不在卡片里：它们来自家族表（`../image-parameters`、
 * `../video-parameters`），按 `providerModelId` 匹配。这样「换一个别名」只加一张卡片，
 * 参数真相不会抄第二份。
 *
 * 约束（`limits.ts`）单独挂在卡片上，因为其中大部分 `inputSchema` 表达不了：
 * 「参考图至少 1 张」「图和视频合计不超过 30」「单个素材 ≤ 10MB」都是跨字段或跨数组的
 * 总量规则。生效值一律 `min(部署级, 模型级)`。
 *
 * 前端不认识任何模型：卡片被 `composePresetCard` 合成一份 `CanvasTaskCatalogModel`，
 * 之后走既有投影（`projectParameterFields`）渲染。**新增一个模型 = 加一个文件 + 登记一行。**
 */
export {
  PARAMETER_CONTROLS,
  PANEL_OWNED_KEYS,
  type ParameterControlKind,
  type ParameterControlSpec
} from "./controls.js";
export { MODEL_TYPE_PRESETS, type ModelTypePreset } from "./types.js";
export {
  MB,
  imageCard,
  videoCard,
  type CardInput,
  type PresetCard,
  type PresetVendor
} from "./card.js";
export {
  effectiveModelLimits,
  type DeployLimits,
  type EffectiveModelLimits,
  type ReferenceKind
} from "./limits.js";
export {
  BUILTIN_PRESET_CARDS,
  IMAGE_CARDS,
  VIDEO_CARDS
} from "./cards/index.js";
export { composePresetCard, type ComposedPresetCard } from "./compose.js";
export { presetCardsOf, presetLimitsOf, referenceBindingsOf } from "./helpers.js";
