/**
 * 生成模型的参数预设（跨 Provider 共用）。
 *
 * 同一个模型可能由多个 Provider 接入（例如 Seedream 经 Ark / TokenHub / 其它网关），
 * 它们的请求字段不同，但**人类可选的语义集合应当一致**：有哪些分辨率档、支持哪些比例、
 * 是否支持「自适应」。这里按模型身份（含别名/前缀）声明这些预设；Provider 只负责把
 * 预设值翻译成自己的协议字段（Ark 的 `size` 预设、TokenHub 的 `generate_max_pixels` /
 * 像素 `size`、LiteLLM 的原生 `aspect_ratio`/`image_size` 等）。
 *
 * 模型目录来自网关发现或 Provider 内置目录，id 不可穷举；`imageModelPresetFor` 未命中时
 * 由 Provider 回退到自己的通用取值域。
 *
 * Seedream（即梦）的档位由**卡片**提供（每张卡片就是那个版本的能力来源）：`seedream-cards`
 * 把卡片投影成统一的 `SeedreamSizePreset`，这里的预设再从它派生，避免档位/默认值两处各写一套。
 */

import {
  SEEDREAM_SIZE_PRESETS,
  type SeedreamSizePreset
} from "./generation-parameters/cards/image/ark/index.js";

/** 通用图片画幅（TokenHub / Seedream 等）。 */
export const IMAGE_ASPECT_RATIOS_STANDARD = [
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9",
] as const;

/** Gemini 3 Pro Image / Nano Banana 系列共有的画幅。 */
export const GEMINI_IMAGE_ASPECT_RATIOS = [
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
] as const;

/** Gemini 3.1 Flash Image 额外支持的极端画幅。 */
export const GEMINI_FLASH_IMAGE_ASPECT_RATIOS = [
  "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9",
] as const;

/** GPT Image 的画幅；与像素表一一对应。 */
export const GPT_IMAGE_ASPECT_RATIOS = [
  "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9",
] as const;

export const GPT_IMAGE_RESOLUTIONS = ["1K", "2K", "4K"] as const;

export type GenerationImageModelPreset = {
  /** 规范 id，仅用于诊断与测试。 */
  id: string;
  /** 精确匹配的 provider 模型 id（小写）。 */
  aliases?: readonly string[];
  /** 前缀匹配的 provider 模型 id（小写），用于带版本后缀的 id。 */
  prefixes?: readonly string[];
  aspectRatios: readonly string[];
  /** 是否支持「自适应」（不向模型声明比例/尺寸，由模型决定）。 */
  adaptiveAspectRatio: boolean;
  resolutions: readonly string[];
  defaultResolution: string;
};

const HY_IMAGE_PRESET: GenerationImageModelPreset = {
  id: "hy-image-v3.5-preview",
  aliases: [
    "hy-image-v3.5-preview",
    "hy-image-v35-preview",
    "hy-image-3.5-preview",
    "hy3.5-preview",
    "hunyuan-image-3.5-preview",
  ],
  aspectRatios: IMAGE_ASPECT_RATIOS_STANDARD,
  adaptiveAspectRatio: true,
  resolutions: ["1K", "1.5K", "2K"],
  defaultResolution: "1.5K",
};

const GEMINI_PRO_PRESET: GenerationImageModelPreset = {
  id: "gemini-3-pro-image",
  aliases: ["gemini-3-pro-image", "vertex-gemini-3-pro-image"],
  aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
  adaptiveAspectRatio: true,
  resolutions: ["1K", "2K", "4K"],
  defaultResolution: "1K",
};

const GEMINI_FLASH_LITE_PRESET: GenerationImageModelPreset = {
  id: "gemini-3.1-flash-lite-image",
  aliases: ["gemini-3.1-flash-lite-image", "vertex-gemini-3.1-flash-lite-image"],
  aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
  adaptiveAspectRatio: true,
  resolutions: ["1K"],
  defaultResolution: "1K",
};

const GEMINI_FLASH_PRESET: GenerationImageModelPreset = {
  id: "gemini-3.1-flash-image",
  aliases: ["gemini-3.1-flash-image", "vertex-gemini-3.1-flash-image"],
  aspectRatios: GEMINI_FLASH_IMAGE_ASPECT_RATIOS,
  adaptiveAspectRatio: true,
  resolutions: ["512", "1K", "2K", "4K"],
  defaultResolution: "1K",
};

const GEMINI_LEGACY_PRESET: GenerationImageModelPreset = {
  id: "gemini-2.5-flash-image",
  aliases: ["gemini-2.5-flash-image"],
  aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
  adaptiveAspectRatio: true,
  resolutions: ["1K"],
  defaultResolution: "1K",
};

const NANO_BANANA_PRESET: GenerationImageModelPreset = {
  id: "nanobanana-2.1",
  aliases: [
    "nanobanana2.1",
    "nanobanana-2.1",
    "gemini-nano-banana-2.1",
    "nanobanana2",
    "nanobanana-2",
    "gemini-nano-banana-2",
  ],
  aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
  adaptiveAspectRatio: true,
  resolutions: ["1K", "2K", "4K"],
  defaultResolution: "1K",
};

const GPT_IMAGE_PRESET: GenerationImageModelPreset = {
  id: "gpt-image",
  prefixes: ["gpt-image"],
  aspectRatios: GPT_IMAGE_ASPECT_RATIOS,
  adaptiveAspectRatio: true,
  resolutions: GPT_IMAGE_RESOLUTIONS,
  defaultResolution: "1K",
};

/**
 * Seedream（即梦）各版本的分辨率档与画幅来自卡片（`cards/image/ark/seedream-*.ts`）：
 * 同一份数据既描述官方 `size` 像素表，也参与这里的跨 Provider 预设，避免两处各写一套档位。
 *
 * `aspectRatios` 仍声明通用画幅：是否真的能固定比例取决于该版本有没有官方像素表，
 * 具体判断由消费预设的 Provider 查 `seedreamSizePresetFor` 完成。
 */
function seedreamPreset(spec: SeedreamSizePreset): GenerationImageModelPreset {
  return {
    id: spec.id,
    ...(spec.aliases ? { aliases: spec.aliases } : {}),
    ...(spec.prefixes ? { prefixes: spec.prefixes } : {}),
    aspectRatios: IMAGE_ASPECT_RATIOS_STANDARD,
    // 即梦官方「方式 1」：只给分辨率档位、宽高比交给模型，因此支持自适应。
    adaptiveAspectRatio: true,
    resolutions: spec.resolutions,
    defaultResolution: spec.defaultResolution,
  };
}

/** 注册表顺序即匹配优先级：更具体的版本必须排在通用前缀之前。 */
export const IMAGE_MODEL_PRESETS: readonly GenerationImageModelPreset[] = [
  HY_IMAGE_PRESET,
  {
    id: "hy-image-v3",
    aliases: ["hy-image-v3", "hy-image-v3.0", "hy-image-3", "hunyuan-image-3"],
    aspectRatios: IMAGE_ASPECT_RATIOS_STANDARD,
    adaptiveAspectRatio: false,
    resolutions: ["1K"],
    defaultResolution: "1K",
  },
  GEMINI_PRO_PRESET,
  GEMINI_FLASH_LITE_PRESET,
  GEMINI_FLASH_PRESET,
  GEMINI_LEGACY_PRESET,
  NANO_BANANA_PRESET,
  GPT_IMAGE_PRESET,
  ...SEEDREAM_SIZE_PRESETS.map(seedreamPreset),
];

/** 按 provider 模型 id 匹配预设；未命中返回 undefined。 */
export function imageModelPresetFor(modelId: string): GenerationImageModelPreset | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === "") return undefined;
  return IMAGE_MODEL_PRESETS.find((preset) =>
    (preset.aliases?.some((alias) => normalized === alias) ?? false)
    || (preset.prefixes?.some((prefix) => normalized.startsWith(prefix)) ?? false)
  );
}
