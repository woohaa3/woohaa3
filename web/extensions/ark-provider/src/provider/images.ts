import type { PptaskDescription } from '@sdppp/pptask';
import {
  aspectRatioField,
  imageModelPresetFor,
  resolutionField,
  seedreamPixelSize,
  seedreamSizePresetFor,
  seedreamSupportsAspectRatio,
} from '@woohaa3/contracts';
import { ARK_PROVIDER_ID, assertArkModel, type ArkCatalogModel, type ArkImageSpec } from './catalog.js';

/**
 * Seedream（即梦）生图请求体。
 *
 * 5.0 pro / flash 只出单图，支持图层拆分。lite 与 4.x 支持组图
 * （`sequential_image_generation=auto`），参考图加成图不超过 15 张。
 *
 * 即梦官方接口没有 `aspect_ratio`：宽高比只能写进 `size`。面板因此给「图片比例 +
 * 图片分辨率」两个控件，这里按 contracts 的官方像素表（`seedream-presets`）把比例
 * 翻成 `WIDTHxHEIGHT`；比例选「自适应」时只发分辨率档位，由模型结合 prompt 决定宽高。
 */
export function buildArkSeedreamRequestBody(
  model: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const spec = assertArkModel(model, 'image').image;
  if (!spec) throw new Error(`Unsupported Ark model: ${model}`);
  const layerDecomposition = Boolean(input.layer_decomposition ?? input.layerDecomposition);
  const images = normalizeImages(input.image ?? input.images ?? input.urls);
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';

  if (input.stream === true) throw new Error('ark Seedream does not support streaming output');
  if (input.tools != null) throw new Error('ark Seedream does not support tools');
  if (spec.layerDecomposition) {
    if (input.sequential_image_generation != null || input.sequentialImageGeneration != null) {
      throw new Error('ark Seedream 5.0 Pro does not support sequential_image_generation');
    }
    if (layerDecomposition && images.length !== 1) {
      throw new Error('ark Seedream 5.0 Pro layer decomposition requires exactly one source image');
    }
    if (!layerDecomposition && !prompt) {
      throw new Error('ark Seedream 5.0 Pro image generation requires a non-empty prompt');
    }
  } else if (layerDecomposition) {
    throw new Error('ark Seedream does not support layer decomposition');
  } else if (!prompt) {
    throw new Error('ark Seedream image generation requires a non-empty prompt');
  }
  if (images.length > spec.maxImages) {
    throw new Error(spec.layerDecomposition
      ? 'ark Seedream 5.0 Pro supports at most 10 reference images'
      : `ark Seedream supports at most ${spec.maxImages} reference images`);
  }

  const size = resolveSeedreamSize(model, input, spec, layerDecomposition);
  const outputFormat = normalizeEnum(
    input.output_format ?? input.outputFormat ?? 'jpeg',
    spec.outputFormats,
    'output_format',
  );
  const responseFormat = normalizeEnum(
    input.response_format ?? input.responseFormat ?? 'url',
    ['url', 'b64_json'] as const,
    'response_format',
  );
  const body: Record<string, unknown> = {
    model,
    size,
    output_format: outputFormat,
    response_format: responseFormat,
    watermark: input.watermark == null ? true : Boolean(input.watermark),
  };
  if (prompt) body.prompt = prompt;
  if (images.length) body.image = images.length === 1 ? images[0] : images;

  if (spec.layerDecomposition) {
    body.layer_decomposition = layerDecomposition;
    const background = normalizeEnum(
      input.background ?? 'opaque',
      ['transparent', 'opaque'] as const,
      'background',
    );
    if (background === 'transparent') {
      if (images.length !== 1 || layerDecomposition) {
        throw new Error('ark Seedream 5.0 Pro transparent background requires single-image editing mode');
      }
      if (outputFormat !== 'png') {
        throw new Error('ark Seedream 5.0 Pro transparent background requires output_format=png');
      }
    }
    if (!layerDecomposition) body.background = background;
  } else if (input.background === 'transparent') {
    throw new Error('ark Seedream does not support transparent background');
  }

  if (spec.family === 'sequential') applySequential(body, input, images.length);
  const optimizeMode = (input.optimize_prompt_options as Record<string, unknown> | undefined)?.mode
    ?? input.optimizePromptMode;
  if (optimizeMode != null && optimizeMode !== '') {
    body.optimize_prompt_options = {
      mode: normalizeEnum(optimizeMode, ['standard', 'fast'] as const, 'optimize_prompt_options.mode'),
    };
  }
  return body;
}

export function describeArkImage(modelId: string, model: ArkCatalogModel): PptaskDescription {
  const spec = model.image;
  if (!spec) throw new Error(`Unsupported Ark model: ${modelId}`);
  // 与其它 Provider 共用模型级预设（Seedream 5 pro/lite、4.5、4.0 的档位一致）。
  const preset = imageModelPresetFor(modelId);
  // 即梦官方的 size / 比例语义在 contracts，Ark 只负责翻译成请求字段。
  const seedream = seedreamSizePresetFor(modelId);
  const imageSizes = seedream?.resolutions ?? preset?.resolutions ?? spec.sizes;
  const defaultImageSize = seedream?.defaultResolution ?? preset?.defaultResolution ?? '2K';
  const supportsRatio = seedream ? seedreamSupportsAspectRatio(seedream) : false;
  const properties: Record<string, unknown> = {
    prompt: { type: 'string', title: '提示词', 'x-component': 'Input.TextArea' },
    urls: {
      type: 'array',
      title: '参考图',
      maxItems: spec.maxImages,
      'x-pptask-semantic': 'reference-image',
      'x-component': 'Upload',
    },
    // 即梦没有 `aspect_ratio`：比例选具体画幅时才查表下发像素 size，
    // 选「自适应」就只发档位，由模型结合 prompt 决定宽高（官方推荐用法）。
    ...(supportsRatio
      ? {
          aspectRatio: aspectRatioField({
            ratios: seedream!.aspectRatios,
            fallback: 'auto',
            adaptive: true,
            title: '图片比例',
            hiddenWhen: [{ field: 'layerDecomposition', equals: true }],
          }),
        }
      : {}),
    size: resolutionField({ tiers: imageSizes, fallback: defaultImageSize, title: '图片分辨率' }),
    outputFormat: selectSchema('输出格式', spec.outputFormats, 'jpeg'),
    watermark: { type: 'boolean', title: '水印', default: true, 'x-component': 'Switch' },
  };
  if (spec.layerDecomposition) {
    properties.layerDecomposition = { type: 'boolean', title: '图层拆分', default: false, 'x-component': 'Switch' };
    properties.background = selectSchema('背景', ['opaque', 'transparent'], 'opaque');
  }
  if (spec.family === 'sequential') {
    properties.sequentialImageGeneration = selectSchema('组图', ['disabled', 'auto'], 'disabled');
    properties.sequentialMaxImages = {
      type: 'number',
      title: '组图张数',
      default: 4,
      minimum: 1,
      maximum: 15,
      'x-component': 'NumberPicker',
      'x-hidden-when': [{ field: 'sequentialImageGeneration', equals: 'disabled' }],
    };
  }
  return {
    providerId: ARK_PROVIDER_ID,
    modelId,
    modelType: 'image',
    title: model.title,
    inputSchema: {
      type: 'object',
      ...(spec.layerDecomposition ? {} : { required: ['prompt'] }),
      properties,
    },
    defaultInput: {
      prompt: '',
      urls: [],
      ...(supportsRatio ? { aspectRatio: 'auto' } : {}),
      size: defaultImageSize,
      outputFormat: 'jpeg',
      watermark: true,
      ...(spec.layerDecomposition ? { layerDecomposition: false, background: 'opaque' } : {}),
      ...(spec.family === 'sequential' ? { sequentialImageGeneration: 'disabled', sequentialMaxImages: 4 } : {}),
    },
    capabilities: {
      mediaKind: 'image',
      operations: ['text-to-image', 'image-to-image'],
      cancel: false,
      ...(spec.layerDecomposition ? { layerDecomposition: true } : {}),
      maxReferenceImages: spec.maxImages,
    },
  };
}

function applySequential(body: Record<string, unknown>, input: Record<string, unknown>, imageCount: number): void {
  const mode = normalizeEnum(
    input.sequential_image_generation ?? input.sequentialImageGeneration ?? 'disabled',
    ['disabled', 'auto'] as const,
    'sequential_image_generation',
  );
  body.sequential_image_generation = mode;
  if (mode !== 'auto') return;
  const cap = 15 - imageCount;
  if (cap < 1) throw new Error('ark Seedream group generation needs room for at least one output image');
  const requested = positiveInt(input.sequentialMaxImages ?? input.max_images, Math.min(4, cap));
  if (requested > cap) {
    throw new Error('ark Seedream reference images plus generated images must be at most 15');
  }
  body.sequential_image_generation_options = { max_images: requested };
}

function normalizeImages(value: unknown): string[] {
  const values = value == null || value === '' ? [] : Array.isArray(value) ? value : [value];
  return values.map((item, index) => {
    const record = item && typeof item === 'object' ? item as Record<string, any> : undefined;
    const candidate = typeof item === 'string'
      ? item.trim()
      : typeof record?.url === 'string'
        ? record.url.trim()
        : record?.inlineData?.data
          ? `data:${record.inlineData.mimeType || 'image/png'};base64,${record.inlineData.data}`
          : '';
    if (!candidate) throw new Error(`ark Seedream image[${index}] is empty or invalid`);
    if (!/^https?:\/\//i.test(candidate) && !/^data:image\/[a-z0-9.+-]+;base64,/i.test(candidate)) {
      throw new Error(`ark Seedream image[${index}] must be an HTTP(S) URL or image data URL`);
    }
    return candidate;
  });
}

/**
 * 即梦的 `size`。
 *
 * 官方两种写法二选一：分辨率档位（1K/1.5K/2K/3K/4K）或像素值 `WIDTHxHEIGHT`。比例只能
 * 通过像素值表达，所以：
 *
 * - 比例是具体画幅且该版本有官方像素表 → 查表得到像素值（真正固定宽高比）；
 * - 比例是「自适应」/未选 → 下发分辨率档位（官方推荐的「方式 1」）；
 * - 旧草稿里直接写像素 `size` 的，仍按各家族原有规则校验。
 *
 * 图层拆分（仅 5.0 pro / flash）只能用档位，比例控件对应的画幅在这里不参与。
 */
function resolveSeedreamSize(
  model: string,
  input: Record<string, unknown>,
  arkSpec: ArkImageSpec,
  layerDecomposition: boolean,
): string {
  const preset = seedreamSizePresetFor(model);
  const tiers = preset?.resolutions ?? arkSpec.sizes;
  const requested = typeof input.size === 'string' ? input.size.trim() : '';
  const ratio = typeof input.aspectRatio === 'string'
    ? input.aspectRatio.trim()
    : typeof input.aspect_ratio === 'string' ? input.aspect_ratio.trim() : '';
  const fixedRatio = ratio !== '' && ratio.toLowerCase() !== 'auto' && ratio.toLowerCase() !== 'adaptive';

  // 图层拆分场景官方默认 `auto`（跟随原图尺寸），且只接受档位。
  if (layerDecomposition && requested.toLowerCase() === 'auto') return 'auto';
  // 档位写错（如给 5.0 pro 选 4K）要报错，不能悄悄回退到默认档。
  if (requested !== '' && !tiers.includes(requested) && !/^\d+x\d+$/i.test(requested)) {
    throw new Error(`ark Seedream ${model} does not support size: ${requested}`);
  }
  const tier = tiers.includes(requested) ? requested : preset?.defaultResolution ?? '2K';

  if (fixedRatio && !layerDecomposition) {
    if (!preset || !seedreamSupportsAspectRatio(preset)) {
      throw new Error(`ark Seedream ${model} has no official size table for aspect ratios`);
    }
    const pixel = seedreamPixelSize(preset, ratio, tier);
    if (!pixel) throw new Error(`ark Seedream ${model} does not support ${ratio} at ${tier}`);
    return pixel;
  }
  if (arkSpec.family === 'pro') return normalizeProSize(input.size, layerDecomposition);
  return normalizePresetSize(input.size, arkSpec.sizes);
}

function normalizeProSize(value: unknown, layerDecomposition: boolean): string {
  const size = String(value || (layerDecomposition ? 'auto' : '2K')).trim();
  const preset = size.toUpperCase();
  if (['1K', '1.5K', '2K'].includes(preset)) return preset;
  if (layerDecomposition) {
    if (size.toLowerCase() === 'auto') return 'auto';
    throw new Error('ark Seedream 5.0 Pro layer decomposition size must be one of: auto, 1K, 1.5K, 2K');
  }
  const match = /^(\d+)x(\d+)$/i.exec(size);
  if (!match) throw new Error('ark Seedream 5.0 Pro generation size must be 1K, 1.5K, 2K, or WIDTHxHEIGHT');
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const ratio = width / height;
  if (pixels < 921600 || pixels > 4624220 || ratio < 1 / 16 || ratio > 16) {
    throw new Error('ark Seedream 5.0 Pro custom size must have 921600-4624220 pixels and an aspect ratio between 1:16 and 16:1');
  }
  return `${width}x${height}`;
}

function normalizePresetSize(value: unknown, presets: readonly string[]): string {
  const size = String(value || '2K').trim().toUpperCase();
  if ((presets as readonly string[]).includes(size)) return size;
  throw new Error(`ark Seedream size must be one of: ${presets.join(', ')}`);
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const normalized = String(value).trim().toLowerCase() as T;
  if (!allowed.includes(normalized)) {
    throw new Error(`ark Seedream ${field} must be one of: ${allowed.join(', ')}`);
  }
  return normalized;
}

function positiveInt(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function selectSchema(title: string, values: readonly string[], fallback: string): Record<string, unknown> {
  return {
    type: 'string',
    title,
    default: fallback,
    'x-component': 'Select',
    enum: values.map((value) => ({ value, label: value })),
  };
}

export type { ArkImageSpec };
