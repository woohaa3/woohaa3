import type { PptaskDescription } from '@sdppp/pptask';
import { aspectRatioField, resolutionField } from '@woohaa3/contracts';
import {
  ARK_PROVIDER_ID,
  assertArkModel,
  type ArkCatalogModel,
  type ArkVideoMode,
  type ArkVideoSpec,
} from './catalog.js';

const VIDEO_RATIO_OPTIONS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;
const VIDEO_RATIOS = ['adaptive', ...VIDEO_RATIO_OPTIONS] as const;
const MODE_LABELS: Record<ArkVideoMode, string> = {
  omni_reference: '全能参考',
  first_last_frame: '首尾帧',
  edit_video: '视频编辑',
  first_frame: '首帧',
};

const SEEDANCE_IMAGE_REFERENCE = /^(?:asset:\/\/[^/]+|https:\/\/)/i;

type Reference = { url: string; role: string };

/**
 * Seedance 创建任务的请求体。
 *
 * content 顺序：text → image_url → video_url → audio_url。
 * 图片接受 `asset://` 或 HTTPS；视频和音频必须是 HTTPS。
 * 时长区间含两端。编辑模式时长为 -1、比例为 adaptive。
 */
export function buildSeedanceCreateBody(
  modelId: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const spec = assertArkModel(modelId, 'video').video;
  if (!spec) throw new Error(`Unsupported Ark model: ${modelId}`);
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const mode = readMode(input.generationMode, spec.modes);
  const imageRefs = collectReferences(input.urls ?? input.images, 'image').slice(0, spec.maxImages + 1);
  const videoRefs = collectReferences(input.videoUrls, 'video');
  const audioRefs = collectReferences(input.audioUrls, 'audio');
  if (imageRefs.length > spec.maxImages) throw new Error(`参考图最多 ${spec.maxImages} 张`);
  if (videoRefs.length > spec.maxVideos) {
    throw new Error(spec.maxVideos === 0 ? '该模型不支持参考视频' : `参考视频最多 ${spec.maxVideos} 个`);
  }
  if (audioRefs.length > spec.maxAudios) {
    throw new Error(spec.maxAudios === 0 ? '该模型不支持参考音频' : `参考音频最多 ${spec.maxAudios} 个`);
  }
  const hasVisual = imageRefs.length + videoRefs.length > 0;
  if (!prompt && !hasVisual && audioRefs.length === 0) throw new Error('提示词不能为空');
  if (audioRefs.length > 0 && !hasVisual && !spec.audioOnly) {
    throw new Error('该模型不能只传音频，需要至少一张参考图或一段参考视频');
  }

  const content: Array<Record<string, unknown>> = [];
  if (prompt) content.push({ type: 'text', text: prompt });
  for (const reference of imageRefs) {
    const uri = String(reference.url);
    if (!SEEDANCE_IMAGE_REFERENCE.test(uri)) {
      throw new Error('Seedance 图片参考必须是 Provider 素材引用或可访问的 HTTPS 地址');
    }
    content.push({ type: 'image_url', role: imageRole(reference.role, spec), image_url: { url: uri } });
  }
  for (const reference of videoRefs) {
    if (!/^https:\/\//i.test(reference.url)) throw new Error('Seedance 视频参考需要可访问的 HTTPS 地址');
    content.push({ type: 'video_url', role: 'reference_video', video_url: { url: reference.url } });
  }
  for (const reference of audioRefs) {
    if (!/^https:\/\//i.test(reference.url)) throw new Error('Seedance 音频参考需要可访问的 HTTPS 地址');
    content.push({ type: 'audio_url', role: 'reference_audio', audio_url: { url: reference.url } });
  }

  const editing = mode === 'edit_video';
  const duration = readDuration(input, spec, editing);
  const body: Record<string, unknown> = {
    model: modelId,
    content,
    duration,
    ratio: editing || mode === 'first_last_frame'
      ? 'adaptive'
      : enumValue(input.ratio ?? input.aspect_ratio ?? input.aspectRatio, VIDEO_RATIOS, 'adaptive'),
    resolution: explicitEnum(input.resolution, spec.resolutions, '720p', '分辨率'),
  };
  if (spec.generateAudio) {
    const audio = input.generate_audio ?? input.generateAudio;
    body.generate_audio = typeof audio === 'boolean' ? audio : true;
  }
  if (typeof input.seed === 'number') body.seed = input.seed;
  if (typeof input.cameraFixed === 'boolean') body.camera_fixed = input.cameraFixed;
  if (input.returnLastFrame === true) body.return_last_frame = true;
  if (editing) body.omni_reference_task_type = 'edit';
  const format = input.output_format ?? input.outputFormat;
  if (format === 'mp4' || format === 'mov') {
    if (!(spec.formats as readonly string[]).includes(format)) {
      throw new Error(`该模型的输出格式只支持 ${spec.formats.join('、')}`);
    }
    body.output_format = format;
  }
  return body;
}

export function describeArkVideo(modelId: string, model: ArkCatalogModel): PptaskDescription {
  const spec = model.video;
  if (!spec) throw new Error(`Unsupported Ark model: ${modelId}`);
  const hideRatio = [
    ...(spec.modes.includes('edit_video') ? [{ field: 'generationMode', equals: 'edit_video' }] : []),
    ...(spec.modes.includes('first_last_frame') ? [{ field: 'generationMode', equals: 'first_last_frame' }] : []),
  ];
  const properties: Record<string, unknown> = {
    prompt: { type: 'string', title: '提示词', 'x-component': 'Input.TextArea' },
    urls: referenceSchema('参考图', 'reference-image', spec.maxImages),
  };
  if (spec.maxVideos > 0) properties.videoUrls = referenceSchema('参考视频', 'reference-video', spec.maxVideos);
  if (spec.maxAudios > 0) properties.audioUrls = referenceSchema('参考音频', 'reference-audio', spec.maxAudios);
  if (spec.modes.length > 1) {
    properties.generationMode = {
      type: 'string',
      title: '模式',
      default: spec.modes[0],
      enum: spec.modes.map((value) => ({ value, label: MODE_LABELS[value] })),
    };
  }
  properties.durationSeconds = {
    type: 'number',
    title: '时长',
    default: 5,
    minimum: spec.minDuration,
    maximum: spec.maxDuration,
    step: 1,
    unit: '秒',
    ...(spec.modes.includes('edit_video')
      ? { 'x-hidden-when': [{ field: 'generationMode', equals: 'edit_video' }] }
      : {}),
  };
  properties.ratio = aspectRatioField({
    ratios: VIDEO_RATIO_OPTIONS,
    adaptive: { value: 'adaptive' },
    fallback: 'adaptive',
    title: '比例',
    hiddenWhen: hideRatio,
  });
  properties.resolution = resolutionField({ tiers: spec.resolutions, fallback: '720p', title: '分辨率' });
  if (spec.generateAudio) {
    properties.generateAudio = { type: 'boolean', title: '生成音频', default: true, 'x-component': 'Switch' };
  }
  if (spec.formats.length > 1) {
    properties.outputFormat = {
      type: 'string',
      title: '输出格式',
      default: 'mp4',
      enum: spec.formats.map((value) => ({ value, label: value.toUpperCase() })),
    };
  }
  const promptOptional = spec.family.startsWith('seedance-2');
  return {
    providerId: ARK_PROVIDER_ID,
    modelId,
    modelType: 'video',
    title: model.title,
    inputSchema: {
      type: 'object',
      ...(promptOptional ? {} : { required: ['prompt'] }),
      properties,
    },
    defaultInput: {
      prompt: '',
      urls: [],
      ...(spec.maxVideos > 0 ? { videoUrls: [] } : {}),
      ...(spec.maxAudios > 0 ? { audioUrls: [] } : {}),
      ...(spec.modes.length > 1 ? { generationMode: spec.modes[0] } : {}),
      durationSeconds: 5,
      ratio: 'adaptive',
      resolution: '720p',
      ...(spec.generateAudio ? { generateAudio: true } : {}),
      ...(spec.formats.length > 1 ? { outputFormat: 'mp4' } : {}),
    },
    capabilities: {
      mediaKind: 'video',
      operations: ['text-to-video', 'image-to-video'],
      cancel: false,
    },
  };
}

function readDuration(input: Record<string, unknown>, spec: ArkVideoSpec, editing: boolean): number {
  if (editing) return -1;
  const value = Number(input.durationSeconds ?? input.duration);
  if (Number.isInteger(value) && value >= spec.minDuration && value <= spec.maxDuration) return value;
  return 5;
}

function readMode(value: unknown, modes: readonly ArkVideoMode[]): ArkVideoMode {
  return typeof value === 'string' && (modes as readonly string[]).includes(value)
    ? value as ArkVideoMode
    : modes[0]!;
}

function collectReferences(value: unknown, defaultRole: string): Reference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Reference[] => {
    if (typeof item === 'string') return [{ url: item, role: defaultRole }];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.url !== 'string') return [];
    return [{ url: record.url, role: typeof record.role === 'string' ? record.role : defaultRole }];
  });
}

function imageRole(role: string, spec: ArkVideoSpec): string {
  if (role === 'first_frame' || role === 'last_frame') {
    if (spec.family === 'seedance-1.0-fast' && role === 'last_frame') {
      throw new Error('该模型不支持尾帧');
    }
    return role;
  }
  if (spec.family === 'seedance-1.0-pro' || spec.family === 'seedance-1.0-fast') return 'first_frame';
  return 'reference_image';
}

function referenceSchema(title: string, semantic: string, maxItems: number): Record<string, unknown> {
  return {
    type: 'array',
    title,
    maxItems,
    'x-pptask-semantic': semantic,
    'x-component': 'Upload',
  };
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : fallback;
}

function explicitEnum<T extends string>(value: unknown, values: readonly T[], fallback: T, label: string): T {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T;
  throw new Error(`${label}只支持 ${values.join('、')}`);
}
