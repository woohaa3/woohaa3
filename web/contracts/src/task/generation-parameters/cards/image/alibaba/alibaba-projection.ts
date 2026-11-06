/**
 * 阿里生图模型的参数投影：**面板 schema + 请求字段**。
 *
 * 放在卡片目录里而不是 `image-parameters`：有没有负向提示词、智能改写默认开还是关、带参考图
 * 时档位怎么收窄，都是这个模型的事实，与走不走 LiteLLM 网关无关。Provider 只决定「什么时候
 * 用、翻成哪个字段名」，不在这里再维护一份厂商知识。
 *
 * 投影分两块：
 * - `alibabaFamilySchema`：语义控件（比例 / 分辨率 / 负向提示词 / 智能改写）与默认值，带
 *   `x-pptask-*` 标记；
 * - `alibabaRequestFields`：官方 `size`（`宽*高`）+ `watermark` + 两个可选的官方开关。
 *
 * 数据一律来自卡片投影出来的 `AlibabaSizePreset`，本文件不存模型数字。
 */
import {
  ADAPTIVE_PARAMETER_VALUE,
  aspectRatioField,
  isAdaptiveParameterValue,
  resolutionField
} from "../../../../parameter-schema.js";
import {
  alibabaPixelSize,
  clampAlibabaResolution,
  type AlibabaSizePreset
} from "./alibaba-spec.js";

/**
 * 参数面板：比例 + 分辨率（模型有档位时）+ 负向提示词与智能改写（模型支持时）。
 *
 * 这套 API **没有** `aspect_ratio`：宽高比只能写进 `size`。所以「自适应」不是一种取值，而是
 * **省略 `size`**——Qwen-Image 官方写明「不指定 `size` 时，模型根据提示词自动推荐分辨率」。
 * 只有支持这一语义的模型才给自适应选项（见 `supportsAdaptiveAspectRatio`）；万相与 Z-Image
 * 省略 `size` 只是退回固定默认尺寸，不给这个选项。
 */
export function alibabaFamilySchema(spec: AlibabaSizePreset): {
  properties: Record<string, unknown>;
  defaults: Record<string, unknown>;
} {
  const hasTiers = spec.resolutions.length > 0;
  const adaptive = spec.supportsAdaptiveAspectRatio;
  return {
    properties: {
      aspectRatio: aspectRatioField({
        ratios: spec.aspectRatios,
        // 支持自适应时默认就交给模型：这才是模型在「用户没表达比例诉求」时的最佳行为。
        fallback: adaptive ? ADAPTIVE_PARAMETER_VALUE : spec.defaultAspectRatio,
        ...(adaptive ? { adaptive: true } : {}),
        title: "比例"
      }),
      ...(hasTiers
        ? {
            resolution: resolutionField({
              tiers: spec.resolutions,
              fallback: spec.defaultResolution,
              title: "图片分辨率",
              // 自适应时整条 `size` 不发，档位就没有意义了：留着会让人以为还能选 1K/2K。
              ...(adaptive ? { hiddenWhen: [{ field: "aspectRatio", equals: ADAPTIVE_PARAMETER_VALUE }] } : {})
            })
          }
        : {}),
      // 负向提示词只有 Qwen-Image 3.0 系列接受；其它模型不给控件，免得暴露会被忽略的字段。
      ...(spec.supportsNegativePrompt ? { negativePrompt: alibabaNegativePromptField() } : {}),
      // 万相用 `thinking_mode` 提质，不认 `prompt_extend`，所以只有 Qwen / Z-Image 出这个开关。
      ...(spec.supportsPromptExtend
        ? { promptExtend: alibabaPromptExtendField(spec.promptExtendDefault) }
        : {})
    },
    defaults: {
      aspectRatio: adaptive ? ADAPTIVE_PARAMETER_VALUE : spec.defaultAspectRatio,
      ...(hasTiers ? { resolution: spec.defaultResolution } : {}),
      ...(spec.supportsNegativePrompt ? { negativePrompt: "" } : {}),
      ...(spec.supportsPromptExtend ? { promptExtend: spec.promptExtendDefault } : {})
    }
  };
}

/** 负向提示词：官方是 `parameters.negative_prompt`，面板沿用 `negativePrompt`。 */
export function alibabaNegativePromptField(): Record<string, unknown> {
  return {
    type: "string",
    title: "负向提示词",
    default: "",
    "x-component": "Input.TextArea",
    "x-component-props": { rows: 2 }
  };
}

/** 智能改写：Z-Image 默认关（官方写明会增加费用），Qwen 系列默认开。 */
export function alibabaPromptExtendField(enabledByDefault: boolean): Record<string, unknown> {
  return {
    type: "boolean",
    title: "智能改写提示词",
    default: enabledByDefault,
    "x-component": "Switch"
  };
}

/**
 * 请求字段（DashScope 同步生图的 `parameters`）。
 *
 * 顺序即优先级：比例 + 档位能查到官方像素值就给 `宽*高`；查不到退回模型自己的
 * `fallbackSize`——这套 API 不认档位串，所以必须始终有具体像素。
 *
 * **例外是自适应**：选了 `auto` 且模型声明支持时，`size` 整个不出现。官方语义就是「不指定
 * `size` 时由模型根据提示词推荐」，发 `size: "auto"` 反而会被拒（DashScope 只认 `宽*高`）。
 *
 * `watermark` 固定发 `false`：上游默认就是 false，显式发出去是为了让「无水印」成为契约，
 * 而不是随上游默认值漂移的行为。
 */
export function alibabaRequestFields(
  spec: AlibabaSizePreset | undefined,
  input: Record<string, unknown>,
  options: { hasReferences?: boolean } = {}
): Record<string, string | number | boolean> {
  if (spec === undefined) return { size: "2048*2048", watermark: false };

  const tier = clampAlibabaResolution(spec, input.resolution, options.hasReferences === true);
  const ratio = readText(input.aspectRatio ?? input.aspect_ratio);
  const adaptive = spec.supportsAdaptiveAspectRatio
    && ratio !== undefined
    && isAdaptiveParameterValue(ratio);
  const pixel = ratio === undefined || adaptive ? undefined : alibabaPixelSize(spec, ratio, tier);
  const explicit = readText(input.size);
  const size = pixel
    ?? (isAlibabaSize(explicit) ? explicit : undefined)
    ?? spec.fallbackSize;

  const fields: Record<string, string | number | boolean> = adaptive
    ? { watermark: false }
    : { size, watermark: false };

  // 负向提示词按模型上限截断：上游对超长直接 400，截断比整单失败更可用。
  if (spec.supportsNegativePrompt) {
    const negative = readText(input.negativePrompt ?? input.negative_prompt);
    if (negative !== undefined && negative !== "") {
      fields.negative_prompt = spec.negativePromptLimit > 0
        ? negative.slice(0, spec.negativePromptLimit)
        : negative;
    }
  }
  if (spec.supportsPromptExtend) {
    fields.prompt_extend = typeof input.promptExtend === "boolean"
      ? input.promptExtend
      : spec.promptExtendDefault;
  }
  return fields;
}

/** 百炼通道的像素写法是 `宽*高`（星号），不是 `WIDTHxHEIGHT`。 */
function isAlibabaSize(value: string | undefined): value is string {
  return value !== undefined && /^\d{3,5}\*\d{3,5}$/.test(value);
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
