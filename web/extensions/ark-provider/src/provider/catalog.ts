/**
 * 火山方舟公开 Model ID。
 *
 * 目录是内置的公开 Model ID，用来区分文本、生图和生视频以及参数。
 * 产品里真正发起请求时用推理接入点 ID（`ep-`），没配接入点的模型不注册。
 * 文本只收仍在售、未标记即将下线的对话模型。图片和视频把文档仍列出的即将下线型号也收进来，
 * 因为它们的请求参数和在售型号不是同一套。向量、3D 不在生成类型里，不注册。
 * `ep-` 推理接入点看不出类型，不进这份目录。
 */

export const ARK_PROVIDER_ID = 'ark';
export const ARK_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const ARK_SEEDREAM_5_PRO_MODEL = 'doubao-seedream-5-0-pro-260628';

export type ArkKind = 'language' | 'image' | 'video';
export type ArkImageFamily = 'pro' | 'sequential';
export type ArkVideoMode = 'omni_reference' | 'first_last_frame' | 'edit_video' | 'first_frame';

/**
 * Ark 图片模型的**端点形状**：走哪种请求形态、支不支持图层拆分。
 *
 * 能力数字（分辨率档位、参考图上限、输出格式、透明背景）**不在这里**——它们在卡片的
 * `@woohaa3/contracts` 里（`cards/image/ark/seedream-*.ts`）。目录只声明「有哪些模型、
 * 每个模型走哪种端点」，图片模型没有卡片即视为不可用。
 */
export type ArkImageSpec = {
  family: ArkImageFamily;
  layerDecomposition: boolean;
};

export type ArkVideoSpec = {
  family: 'seedance-2.5' | 'seedance-2.0' | 'seedance-2.0-limited' | 'seedance-1.0-pro' | 'seedance-1.0-fast';
  minDuration: number;
  maxDuration: number;
  resolutions: readonly string[];
  formats: readonly ('mp4' | 'mov')[];
  maxImages: number;
  maxVideos: number;
  maxAudios: number;
  /** 可以只传音频、不传图片或视频。 */
  audioOnly: boolean;
  modes: readonly ArkVideoMode[];
  generateAudio: boolean;
};

export type ArkCatalogModel = {
  id: string;
  kind: ArkKind;
  title: string;
  image?: ArkImageSpec;
  video?: ArkVideoSpec;
};

const PRO_IMAGE: ArkImageSpec = {
  family: 'pro',
  layerDecomposition: true,
};

const SEQUENTIAL_IMAGE: ArkImageSpec = { family: 'sequential', layerDecomposition: false };

const SEEDANCE_25: ArkVideoSpec = {
  family: 'seedance-2.5',
  minDuration: 4,
  maxDuration: 30,
  resolutions: ['480p', '720p', '1080p'],
  formats: ['mp4', 'mov'],
  maxImages: 30,
  maxVideos: 10,
  maxAudios: 10,
  audioOnly: true,
  modes: ['omni_reference', 'first_last_frame', 'edit_video'],
  generateAudio: true,
};

const SEEDANCE_20: ArkVideoSpec = {
  family: 'seedance-2.0',
  minDuration: 4,
  maxDuration: 15,
  resolutions: ['480p', '720p', '1080p', '4k'],
  formats: ['mp4'],
  maxImages: 9,
  maxVideos: 3,
  maxAudios: 3,
  audioOnly: false,
  modes: ['omni_reference', 'first_last_frame', 'edit_video'],
  generateAudio: true,
};

const SEEDANCE_20_LIMITED: ArkVideoSpec = {
  ...SEEDANCE_20,
  family: 'seedance-2.0-limited',
  resolutions: ['480p', '720p'],
};

const SEEDANCE_10_PRO: ArkVideoSpec = {
  family: 'seedance-1.0-pro',
  minDuration: 2,
  maxDuration: 12,
  resolutions: ['480p', '720p', '1080p'],
  formats: ['mp4'],
  maxImages: 2,
  maxVideos: 0,
  maxAudios: 0,
  audioOnly: false,
  modes: ['first_frame', 'first_last_frame'],
  generateAudio: false,
};

const SEEDANCE_10_FAST: ArkVideoSpec = {
  ...SEEDANCE_10_PRO,
  family: 'seedance-1.0-fast',
  maxImages: 1,
  modes: ['first_frame'],
};

function language(id: string, title: string): ArkCatalogModel {
  return { id, kind: 'language', title };
}

function image(id: string, title: string, spec: ArkImageSpec): ArkCatalogModel {
  return { id, kind: 'image', title, image: spec };
}

function video(id: string, title: string, spec: ArkVideoSpec): ArkCatalogModel {
  return { id, kind: 'video', title, video: spec };
}



export const ARK_CATALOG: readonly ArkCatalogModel[] = [
  language('doubao-seed-evolving', 'Doubao Seed Evolving'),
  language('doubao-seed-2-1-pro-260915', 'Doubao Seed 2.1 Pro'),
  language('doubao-seed-2-1-lite-260915', 'Doubao Seed 2.1 Lite'),
  language('doubao-seed-2-1-turbo-260628', 'Doubao Seed 2.1 Turbo'),
  language('doubao-seed-2-1-pro-260628', 'Doubao Seed 2.1 Pro 260628'),
  language('doubao-seed-2-0-lite-260428', 'Doubao Seed 2.0 Lite'),
  language('doubao-seed-2-0-mini-260428', 'Doubao Seed 2.0 Mini'),
  language('doubao-seed-character-260628', 'Doubao Seed Character'),
  language('doubao-seed-character-251128', 'Doubao Seed Character 251128'),
  language('doubao-seed-translation-250915', 'Doubao Seed Translation'),
  language('glm-5-3-flash-260828', 'GLM 5.3 Flash'),
  language('glm-5-2-260617', 'GLM 5.2'),
  language('deepseek-v4-1-flash-260910', 'DeepSeek V4.1 Flash'),
  language('deepseek-v4-pro-ga-260813', 'DeepSeek V4 Pro'),
  language('deepseek-v4-flash-ga-260731', 'DeepSeek V4 Flash'),
  image('doubao-seedream-5-0-pro-260628', 'Seedream 5.0 Pro', PRO_IMAGE),
  image('doubao-seedream-5-0-flash-260915', 'Seedream 5.0 Flash', PRO_IMAGE),
  image('doubao-seedream-5-0-260128', 'Seedream 5.0 Lite', SEQUENTIAL_IMAGE),
  image('doubao-seedream-4-5-251128', 'Seedream 4.5', SEQUENTIAL_IMAGE),
  image('doubao-seedream-4-0-250828', 'Seedream 4.0', SEQUENTIAL_IMAGE),
  video('doubao-seedance-2-5-260628', 'Seedance 2.5', SEEDANCE_25),
  video('doubao-seedance-2-0-260128', 'Seedance 2.0', SEEDANCE_20),
  video('doubao-seedance-2-0-fast-260128', 'Seedance 2.0 Fast', SEEDANCE_20_LIMITED),
  video('doubao-seedance-2-0-mini-260615', 'Seedance 2.0 Mini', SEEDANCE_20_LIMITED),
  video('doubao-seedance-1-0-pro-250528', 'Seedance 1.0 Pro', SEEDANCE_10_PRO),
  video('doubao-seedance-1-0-pro-fast-251015', 'Seedance 1.0 Pro Fast', SEEDANCE_10_FAST),
];

/** 文档给出的等价 Model ID，目录里只保留一个，调用时仍接受别名。 */
const ALIASES: Record<string, string> = {
  'doubao-seedream-5-0-lite-260128': 'doubao-seedream-5-0-260128',
};

export function findArkModel(modelId: string): ArkCatalogModel | undefined {
  const id = ALIASES[modelId] ?? modelId;
  return ARK_CATALOG.find((model) => model.id === id);
}

export function assertArkModel(modelId: string, kind?: ArkKind): ArkCatalogModel {
  const model = findArkModel(modelId);
  if (!model || (kind && model.kind !== kind)) {
    throw new Error(`Unsupported Ark model: ${modelId}`);
  }
  return model;
}

/** 去掉末尾斜杠；旧的视频任务创建地址自动收回 API 根路径。 */
export function arkApiRoot(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/contents\/generations\/tasks$/i, '');
}
