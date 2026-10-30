/**
 * LiteLLM 系图像模型的参数家族与请求字段映射（共享实现）。
 *
 * 放在 contracts 而不是某个 Provider 里：本地插件（外部 LiteLLM Provider）与远端
 * 托管生成（web/extensions/remote-server）面对的是同一个 LiteLLM 网关，家族判定与字段
 * 翻译必须只有一份，否则同一个 seedream 模型在两条链路上会出不同的参数面板。
 *
 * 面板不再把上游像素串（`1024x1536`）直接摊给用户，而是按模型家族给出
 * 「图片分辨率 + 图片比例」，提交时再翻译成上游可接受字段：
 *
 * - Gemini Image（含 nano banana 别名）：flat `aspect_ratio` / `image_size`，
 *   LiteLLM 会转成 Gemini 的 `generationConfig.imageConfig`；
 * - GPT Image：比例 + 分辨率查表得到像素 `size`，并保留 quality / n 等 OpenAI 字段；
 * - Seedream（即梦）：官方接口没有 `aspect_ratio` / `quality`，宽高比只能写进 `size`。
 *   控件与请求字段的投影在卡片目录里（`cards/image/ark/seedream-projection`），这里只按 id
 *   找到版本、把投影接进网关形状；不拼即梦的控件，也不存版本数字；
 * - 其它图像模型：沿用 OpenAI Images 的像素 `size` schema，避免猜测未知模型能力。
 *
 * 模型目录来自网关发现，id 不可穷举，所以这里只按家族关键字分类；未命中的 id 一律
 * 走 generic，保持既有行为。`auto`（自适应）表示不向上游声明比例/分辨率，由模型决定。
 */

import {
  ADAPTIVE_PARAMETER_VALUE,
  aspectRatioField,
  backgroundField,
  qualityField,
  resolutionField,
  resolvePixelSize,
  type ParameterSelectOption
} from './parameter-schema.js';
import {
  GEMINI_FLASH_IMAGE_ASPECT_RATIOS,
  GEMINI_IMAGE_ASPECT_RATIOS,
  GPT_IMAGE_ASPECT_RATIOS,
  GPT_IMAGE_RESOLUTIONS,
  imageModelPresetFor
} from './model-presets.js';
import { seedreamSizePresetFor } from './generation-parameters/cards/image/ark/index.js';
import {
  seedreamFamilySchema,
  seedreamRequestFields
} from './generation-parameters/cards/image/ark/seedream-projection.js';

export type ImageParameterFamily = 'gemini' | 'gpt-image' | 'seedream' | 'generic';

/** 画幅 + 分辨率 → 像素 `size`（GPT Image 只接受像素串）。 */
const GPT_IMAGE_SIZES: Record<string, Record<string, string>> = {
  '1:1': { '1K': '1024x1024', '2K': '2048x2048', '4K': '2880x2880' },
  '3:2': { '1K': '1536x1024', '2K': '2304x1536', '4K': '3072x2048' },
  '2:3': { '1K': '1024x1536', '2K': '1536x2304', '4K': '2048x3072' },
  '4:3': { '1K': '1024x768', '2K': '2048x1536', '4K': '3072x2304' },
  '3:4': { '1K': '768x1024', '2K': '1536x2048', '4K': '2304x3072' },
  '16:9': { '1K': '1536x864', '2K': '2048x1152', '4K': '3840x2160' },
  '9:16': { '1K': '864x1536', '2K': '1152x2048', '4K': '2160x3840' },
  '21:9': { '1K': '1792x768', '2K': '2560x1088', '4K': '3840x1648' },
};

type SelectOption = ParameterSelectOption;

const GPT_IMAGE_QUALITIES: readonly SelectOption[] = [
  { label: '自动', value: 'auto' },
  { label: '低', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' },
];

/** gpt-image 2.5 额外支持 xhigh / max。 */
const GPT_IMAGE_25_QUALITIES: readonly SelectOption[] = [
  ...GPT_IMAGE_QUALITIES,
  { label: '极高', value: 'xhigh' },
  { label: '最高', value: 'max' },
];

/**
 * 网关发现出来的图像模型按 id 分类；未命中返回 generic。
 *
 * 即梦先按**卡片**匹配（精确 id `doubao-seedream-5-0-pro-260628`、别名 `seedream-5-pro`、
 * 端口前缀 `doubao-seedream-4-5-*`），命中就走 seedream 家族；它必须排在关键字猜测之前——
 * 网关的别名花样太多，但每个版本的能力只有卡片那一份。
 */
export function imageParameterFamily(modelId: string): ImageParameterFamily {
  if (seedreamSizePresetFor(modelId)) return 'seedream';
  const id = modelId.toLowerCase();
  if (id.includes('gpt-image')) return 'gpt-image';
  if (/gemini|nano.?banana|banana/.test(id)) return 'gemini';
  return 'generic';
}

type GeminiImageProfile = {
  aspectRatios: readonly string[];
  resolutions: readonly string[];
};

function geminiProfile(modelId: string): GeminiImageProfile {
  // 与其它 Provider 共用模型级预设；未命中时按 id 关键字回退。
  const preset = imageModelPresetFor(modelId);
  if (preset) return { aspectRatios: preset.aspectRatios, resolutions: preset.resolutions };
  const id = modelId.toLowerCase();
  if (id.includes('lite')) return { aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS, resolutions: ['1K'] };
  // 早期 Nano Banana（Gemini 2.5 Flash Image）只有 1K。
  if (id.includes('2.5')) return { aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS, resolutions: ['1K'] };
  if (id.includes('flash')) {
    return { aspectRatios: GEMINI_FLASH_IMAGE_ASPECT_RATIOS, resolutions: ['512', '1K', '2K', '4K'] };
  }
  return { aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS, resolutions: GPT_IMAGE_RESOLUTIONS };
}

type GptImageProfile = {
  qualities: readonly SelectOption[];
  qualityValues: readonly string[];
  defaultQuality: string;
};

function gptImageProfile(modelId: string): GptImageProfile {
  const extended = modelId.includes('2.5');
  const qualities = extended ? GPT_IMAGE_25_QUALITIES : GPT_IMAGE_QUALITIES;
  return {
    qualities,
    qualityValues: qualities.map((option) => option.value),
    defaultQuality: extended ? 'auto' : 'high',
  };
}

/**
 * 家族专属参数 schema；generic 返回 null，由 provider 保留原有 OpenAI Images schema。
 */
export function imageFamilyParameters(modelId: string): {
  maxReferenceImages: number;
  schemaVersion: string;
  properties: Record<string, unknown>;
  defaults: Record<string, unknown>;
} | null {
  const family = imageParameterFamily(modelId);
  if (family === 'gemini') {
    const profile = geminiProfile(modelId);
    const preset = imageModelPresetFor(modelId);
    const defaultResolution = preset?.defaultResolution ?? '1K';
    return {
      maxReferenceImages: 14,
      schemaVersion: 'litellm-gemini-image/v1',
      properties: {
        resolution: resolutionField({ tiers: profile.resolutions, fallback: defaultResolution, title: '图片分辨率' }),
        aspectRatio: aspectRatioField({
          ratios: profile.aspectRatios,
          fallback: ADAPTIVE_PARAMETER_VALUE,
          adaptive: true,
          title: '图片比例',
        }),
      },
      defaults: { resolution: defaultResolution, aspectRatio: ADAPTIVE_PARAMETER_VALUE },
    };
  }
  if (family === 'gpt-image') {
    const profile = gptImageProfile(modelId);
    const preset = imageModelPresetFor(modelId);
    const resolutions = preset?.resolutions ?? GPT_IMAGE_RESOLUTIONS;
    const aspectRatios = preset?.aspectRatios ?? GPT_IMAGE_ASPECT_RATIOS;
    const defaultResolution = preset?.defaultResolution ?? '1K';
    return {
      maxReferenceImages: 16,
      schemaVersion: 'litellm-gpt-image/v1',
      properties: {
        // 自适应时 `size` 直接是 auto，分辨率不再参与计算。
        resolution: resolutionField({
          tiers: resolutions,
          fallback: defaultResolution,
          title: '图片分辨率',
          hiddenWhen: [{ field: 'aspectRatio', equals: ADAPTIVE_PARAMETER_VALUE }],
        }),
        aspectRatio: aspectRatioField({
          ratios: aspectRatios,
          fallback: '1:1',
          adaptive: true,
          title: '图片比例',
        }),
        quality: qualityField({
          levels: profile.qualities,
          fallback: profile.defaultQuality,
          title: '质量',
        }),
        n: {
          type: 'number',
          title: '数量',
          default: 1,
          minimum: 1,
          maximum: 10,
          'x-component': 'NumberPicker',
        },
        // Azure 文档：`output_format` 只支持 PNG / JPEG（WEBP 不支持），默认 PNG。
        outputFormat: {
          type: 'string',
          title: '输出格式',
          default: 'png',
          'x-component': 'Select',
          enum: [
            { value: 'png', label: 'PNG' },
            { value: 'jpeg', label: 'JPEG' },
          ],
        },
        // 透明背景要求 PNG（见 backgroundField 的注释）：选 transparent 时联动切格式。
        background: backgroundField({
          values: [
            { value: 'auto', label: '自动' },
            { value: 'transparent', label: '透明', requires: { outputFormat: 'png' } },
            { value: 'opaque', label: '不透明' },
          ],
          fallback: 'auto',
        }),
      },
      defaults: {
        resolution: defaultResolution,
        aspectRatio: '1:1',
        quality: profile.defaultQuality,
        n: 1,
        outputFormat: 'png',
        background: 'auto',
      },
    };
  }
  if (family === 'seedream') {
    // 即梦的控件与默认值由卡片目录投影（`cards/image/ark/seedream-projection`）：
    // 家族只负责「这个 id 属于哪个家族、用哪个版本的投影」，不拼厂商控件。
    const spec = seedreamSizePresetFor(modelId)!;
    return {
      maxReferenceImages: spec.maxReferenceImages,
      schemaVersion: 'litellm-seedream/v1',
      ...seedreamFamilySchema(spec),
    };
  }
  return null;
}

/** 把面板参数翻译成 LiteLLM `/images/generations|edits` 的请求字段。 */
export function imageRequestFields(
  modelId: string,
  input: Record<string, unknown>,
): Record<string, string | number> {
  const family = imageParameterFamily(modelId);
  if (family === 'gemini') return geminiImageFields(modelId, input);
  if (family === 'gpt-image') return gptImageImageFields(modelId, input);
  if (family === 'seedream') return seedreamRequestFields(seedreamSizePresetFor(modelId), input);
  return genericImageFields(modelId, input);
}

function geminiImageFields(modelId: string, input: Record<string, unknown>): Record<string, string | number> {
  const profile = geminiProfile(modelId);
  const fields: Record<string, string | number> = {};
  const ratio = readText(input.aspectRatio ?? input.aspect_ratio);
  if (ratio && ratio !== ADAPTIVE_PARAMETER_VALUE && profile.aspectRatios.includes(ratio)) {
    fields.aspect_ratio = ratio;
  }
  const resolution = readText(input.resolution ?? input.image_size ?? input.imageSize);
  if (resolution && profile.resolutions.includes(resolution)) {
    fields.image_size = resolution;
  }
  return fields;
}

function gptImageImageFields(modelId: string, input: Record<string, unknown>): Record<string, string | number> {
  const profile = gptImageProfile(modelId);
  const fields = openAiImageFields(input);
  fields.size = resolveGptImageSize(input);
  fields.quality = enumValue(input.quality, profile.qualityValues, profile.defaultQuality);
  if (fields.moderation === undefined) fields.moderation = 'low';
  return fields;
}

/**
 * 比例/分辨率是当前面板的权威参数，优先于旧草稿里可能残留的像素 `size`；
 * 两者都没有时才回退到显式 `size`（兼容旧数据与直接 API 调用）。
 */
function resolveGptImageSize(input: Record<string, unknown>): string {
  const ratio = readText(input.aspectRatio ?? input.aspect_ratio);
  const resolution = readText(input.resolution);
  if (ratio !== undefined || resolution !== undefined) {
    if (ratio === ADAPTIVE_PARAMETER_VALUE) return ADAPTIVE_PARAMETER_VALUE;
    const safeRatio = ratio && (GPT_IMAGE_ASPECT_RATIOS as readonly string[]).includes(ratio) ? ratio : '1:1';
    const safeResolution = resolution && GPT_IMAGE_SIZES[safeRatio]?.[resolution] ? resolution : '1K';
    return resolvePixelSize({
      table: GPT_IMAGE_SIZES,
      aspectRatio: safeRatio,
      resolution: safeResolution,
      fallback: GPT_IMAGE_SIZES['1:1']!['1K']!,
    });
  }
  const explicit = readText(input.size);
  if (explicit === ADAPTIVE_PARAMETER_VALUE) return explicit;
  if (explicit && /^\d{3,4}x\d{3,4}$/.test(explicit)) return explicit;
  return GPT_IMAGE_SIZES['1:1']!['1K']!;
}

/**
 * 透明背景与输出格式的联动保护。
 *
 * Azure 文档明确 `background: transparent` 要求 `output_format: png`；面板已经会在选中
 * 透明时联动切格式，但旧草稿、批处理、直接调用 API 都可能绕过面板。这里做最后一道：
 * 透明 + 非 png 时把格式**提升为 png**，而不是丢掉 `transparent` —— 用户要的是透明，
 * 悄悄退回不透明会让他看到一张带底色的图却不知道为什么。
 */
function applyTransparency(fields: Record<string, string | number>): void {
  if (fields.background !== 'transparent') return;
  if (fields.output_format === 'png') return;
  fields.output_format = 'png';
  // JPEG 专属的压缩参数在 PNG 下无意义，带上会被严格的上游拒绝。
  delete fields.output_compression;
}

/** OpenAI Images 的 body 字段（gpt-image / dall-e 共用）。 */
function openAiImageFields(input: Record<string, unknown>): Record<string, string | number> {
  const fields: Record<string, string | number> = {};
  const text = (camel: string, snake: string) => {
    const value = input[camel] ?? input[snake];
    if (typeof value === 'string' && value.trim()) fields[snake] = value.trim();
  };
  text('size', 'size');
  text('quality', 'quality');
  text('style', 'style');
  text('responseFormat', 'response_format');
  text('background', 'background');
  text('outputFormat', 'output_format');
  text('moderation', 'moderation');
  text('user', 'user');
  const count = positiveInt(input.n, 0);
  if (count > 0) fields.n = Math.min(10, count);
  const compression = boundedInt(input.outputCompression ?? input.output_compression, 0, 100);
  if (compression !== undefined) fields.output_compression = compression;
  applyTransparency(fields);
  return fields;
}

/**
 * 未识别家族的图像模型沿用既有 OpenAI Images 协议：OpenAI 模型带 quality / n，
 * 其它模型只保留 size（`auto` 不下发）。
 */
function genericImageFields(modelId: string, input: Record<string, unknown>): Record<string, string | number> {
  const fields = openAiImageFields(input);
  if (/gpt-image|dall-e/i.test(modelId)) {
    if (fields.moderation === undefined) fields.moderation = 'low';
    return fields;
  }
  delete fields.quality;
  delete fields.n;
  delete fields.moderation;
  delete fields.background;
  delete fields.output_format;
  delete fields.output_compression;
  delete fields.style;
  delete fields.response_format;
  if (fields.size === 'auto') delete fields.size;
  return fields;
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function boundedInt(value: unknown, minimum: number, maximum: number): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return undefined;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function positiveInt(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number > 0 ? Math.min(8192, number) : fallback;
}
