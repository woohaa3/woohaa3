/**
 * 百炼（Model Studio / DashScope）模型的参数投影：**面板 schema + 请求字段**。
 *
 * 放在卡片目录里而不是 `image-parameters`：有没有负向提示词、智能改写默认开还是关、带参考图
 * 时档位怎么收窄，都是这个模型的事实，与走不走 LiteLLM 网关无关。Provider 只决定「什么时候
 * 用、翻成哪个字段名」，不在这里再维护一份百炼知识。
 *
 * 投影分两块：
 * - `bailianFamilySchema`：语义控件（比例 / 分辨率 / 负向提示词 / 智能改写）与默认值，带
 *   `x-pptask-*` 标记；
 * - `bailianRequestFields`：官方 `size`（`宽*高`）+ `watermark` + 两个可选的官方开关。
 *
 * 数据一律来自卡片投影出来的 `BailianSizePreset`，本文件不存模型数字。
 */
import { aspectRatioField, resolutionField } from "../../../../parameter-schema.js";
import {
  bailianPixelSize,
  clampBailianResolution,
  type BailianSizePreset
} from "./bailian-spec.js";

/**
 * 参数面板：比例 + 分辨率（模型有档位时）+ 负向提示词与智能改写（模型支持时）。
 *
 * 百炼**没有** `aspect_ratio`：宽高比只能写进 `size`，而且比例必须落到具体像素（上游不认
 * 「交给模型」的写法），所以这里不提供自适应选项——与即梦的「方式 1」不同。
 */
export function bailianFamilySchema(spec: BailianSizePreset): {
  properties: Record<string, unknown>;
  defaults: Record<string, unknown>;
} {
  const hasTiers = spec.resolutions.length > 0;
  return {
    properties: {
      aspectRatio: aspectRatioField({
        ratios: spec.aspectRatios,
        fallback: spec.defaultAspectRatio,
        title: "比例"
      }),
      ...(hasTiers
        ? {
            resolution: resolutionField({
              tiers: spec.resolutions,
              fallback: spec.defaultResolution,
              title: "图片分辨率"
            })
          }
        : {}),
      // 负向提示词只有 Qwen-Image 2.0 系列接受；其它模型不给控件，免得暴露会被忽略的字段。
      ...(spec.supportsNegativePrompt ? { negativePrompt: bailianNegativePromptField() } : {}),
      // 万相用 `thinking_mode` 提质，不认 `prompt_extend`，所以只有 Qwen / Z-Image 出这个开关。
      ...(spec.supportsPromptExtend
        ? { promptExtend: bailianPromptExtendField(spec.promptExtendDefault) }
        : {})
    },
    defaults: {
      aspectRatio: spec.defaultAspectRatio,
      ...(hasTiers ? { resolution: spec.defaultResolution } : {}),
      ...(spec.supportsNegativePrompt ? { negativePrompt: "" } : {}),
      ...(spec.supportsPromptExtend ? { promptExtend: spec.promptExtendDefault } : {})
    }
  };
}

/** 负向提示词：官方是 `parameters.negative_prompt`，面板沿用 `negativePrompt`。 */
export function bailianNegativePromptField(): Record<string, unknown> {
  return {
    type: "string",
    title: "负向提示词",
    default: "",
    "x-component": "Input.TextArea",
    "x-component-props": { rows: 2 }
  };
}

/** 智能改写：Z-Image 默认关（官方写明会增加费用），Qwen 系列默认开。 */
export function bailianPromptExtendField(enabledByDefault: boolean): Record<string, unknown> {
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
 * `fallbackSize`——百炼不认档位串，所以必须始终有具体像素。
 *
 * `watermark` 固定发 `false`：上游默认就是 false，显式发出去是为了让「无水印」成为契约，
 * 而不是随上游默认值漂移的行为。
 */
export function bailianRequestFields(
  spec: BailianSizePreset | undefined,
  input: Record<string, unknown>,
  options: { hasReferences?: boolean } = {}
): Record<string, string | number | boolean> {
  if (spec === undefined) return { size: "2048*2048", watermark: false };

  const tier = clampBailianResolution(spec, input.resolution, options.hasReferences === true);
  const ratio = readText(input.aspectRatio ?? input.aspect_ratio);
  const pixel = ratio === undefined ? undefined : bailianPixelSize(spec, ratio, tier);
  const explicit = readText(input.size);
  const size = pixel
    ?? (isBailianSize(explicit) ? explicit : undefined)
    ?? spec.fallbackSize;

  const fields: Record<string, string | number | boolean> = { size, watermark: false };

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

/** 百炼的像素写法是 `宽*高`（星号），不是 `WIDTHxHEIGHT`。 */
function isBailianSize(value: string | undefined): value is string {
  return value !== undefined && /^\d{3,5}\*\d{3,5}$/.test(value);
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
