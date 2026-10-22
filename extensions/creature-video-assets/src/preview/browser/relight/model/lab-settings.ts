export const RELIGHT_RENDER_MODES = [
  'original-unlit', 'original-relit', 'inverse-relit', 'hybrid-relit', 'delit-relit',
  'normal', 'ndotl', 'depth', 'roughness', 'metallic', 'specular', 'baked-lighting', 'alpha',
] as const;

export type RelightRenderMode = typeof RELIGHT_RENDER_MODES[number];
export type RelightBaseColorMode = 'original' | 'inverse' | 'hybrid' | 'delit';
export type RelightNormalSpace = 'view' | 'object';
export type RelightNormalSwizzle = 'XYZ' | 'XZY' | 'YXZ' | 'YZX' | 'ZXY' | 'ZYX';
export type RelightAlignment = 'centered-letterbox' | 'stretch';
export type RelightOutputHeight = 0 | 224 | 384 | 512;

export interface RelightLabMaterialSettings {
  baseColorMode: RelightBaseColorMode;
  detailStrength: number;
  detailMin: number;
  detailMax: number;
  deLightStrength: number;
  albedoGain: number;
  albedoTint: string;
  exposureCompensation: number;
  normalSpace: RelightNormalSpace;
  normalSwizzle: RelightNormalSwizzle;
  flipNormalX: boolean;
  flipNormalY: boolean;
  flipNormalZ: boolean;
  normalStrength: number;
  normalizeNormal: boolean;
  roughnessUseMap: boolean;
  roughnessFallback: number;
  roughnessScale: number;
  roughnessBias: number;
  roughnessMin: number;
  roughnessMax: number;
  metallicUseMap: boolean;
  metallicFallback: number;
  metallicScale: number;
  metallicBias: number;
  metallicThreshold: number;
  forceNonMetal: boolean;
  wrapDiffuse: boolean;
  diffuseWrap: number;
  specularEnabled: boolean;
  specularIntensity: number;
  rimEnabled: boolean;
  rimIntensity: number;
  rimPower: number;
  depthPositionEnabled: boolean;
  invertDepth: boolean;
  depthMin: number;
  depthMax: number;
  depthBias: number;
  characterThickness: number;
  selfShadowEnabled: boolean;
  selfShadowStrength: number;
  selfShadowLength: number;
  selfShadowBias: number;
  selfShadowSoftness: number;
  frameShadowEnabled: boolean;
  frameShadowStrength: number;
  frameShadowRelief: number;
  alphaTest: number;
}

export interface RelightProcessingSettings {
  blurRadius: number;
  alignment: RelightAlignment;
  blackToAlpha: boolean;
  blackAlphaThreshold: number;
  blackAlphaSoftness: number;
  edgeFeather: number;
  edgeBleed: boolean;
  bleedRadius: number;
  nearestFilter: boolean;
}

export interface RelightPlacementSettings {
  scale: number;
  pivotX: number;
  pivotY: number;
}

export interface RelightReferenceSettings {
  visible: boolean;
  roughness: number;
  metalness: number;
  color: string;
}

export interface RelightViewportSettings {
  showGrid: boolean;
  outputHeight: RelightOutputHeight;
  reference: RelightReferenceSettings;
}

export interface RelightPlaybackSettings {
  playing: boolean;
  loop: boolean;
  rate: 0.25 | 0.5 | 1 | 2;
}

export const RELIGHT_LAB_MATERIAL_DEFAULTS: Readonly<RelightLabMaterialSettings> = {
  baseColorMode: 'hybrid', detailStrength: .65, detailMin: .72, detailMax: 1.32,
  deLightStrength: .6, albedoGain: 1, albedoTint: '#ffffff', exposureCompensation: 0,
  normalSpace: 'view', normalSwizzle: 'XYZ', flipNormalX: false, flipNormalY: false,
  flipNormalZ: false, normalStrength: .75, normalizeNormal: true,
  roughnessUseMap: true, roughnessFallback: .7, roughnessScale: .2,
  roughnessBias: .56, roughnessMin: .5, roughnessMax: .9,
  metallicUseMap: false, metallicFallback: 0, metallicScale: 1, metallicBias: 0,
  metallicThreshold: 0, forceNonMetal: true, wrapDiffuse: true, diffuseWrap: .1,
  specularEnabled: true, specularIntensity: .25, rimEnabled: false,
  rimIntensity: .18, rimPower: 3, depthPositionEnabled: false, invertDepth: false,
  depthMin: 0, depthMax: 1, depthBias: 0, characterThickness: .3,
  selfShadowEnabled: false, selfShadowStrength: .9, selfShadowLength: .18,
  selfShadowBias: .012, selfShadowSoftness: .018, frameShadowEnabled: true,
  frameShadowStrength: .46, frameShadowRelief: .65, alphaTest: .02,
};

export const RELIGHT_PROCESSING_DEFAULTS: Readonly<RelightProcessingSettings> = {
  blurRadius: 32, alignment: 'centered-letterbox', blackToAlpha: false,
  blackAlphaThreshold: .04, blackAlphaSoftness: .08, edgeFeather: 1,
  edgeBleed: true, bleedRadius: 4, nearestFilter: false,
};

export const RELIGHT_PLACEMENT_DEFAULTS: Readonly<RelightPlacementSettings> = {
  scale: 1, pivotX: 0, pivotY: 0,
};

export const RELIGHT_VIEWPORT_DEFAULTS: Readonly<RelightViewportSettings> = {
  showGrid: true, outputHeight: 0,
  reference: { visible: true, roughness: .55, metalness: 0, color: '#808080' },
};

export const RELIGHT_PLAYBACK_DEFAULTS: Readonly<RelightPlaybackSettings> = {
  playing: false, loop: true, rate: 1,
};

export function isRelightRenderMode(value: unknown): value is RelightRenderMode {
  return typeof value === 'string' && (RELIGHT_RENDER_MODES as readonly string[]).includes(value);
}

export function baseColorModeForRenderMode(mode: RelightRenderMode): RelightBaseColorMode {
  if (mode === 'original-unlit' || mode === 'original-relit') return 'original';
  if (mode === 'inverse-relit') return 'inverse';
  if (mode === 'delit-relit') return 'delit';
  return 'hybrid';
}
