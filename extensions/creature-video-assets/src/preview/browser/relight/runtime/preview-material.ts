import * as THREE from 'three';

import type { RelightLabMaterialSettings, RelightRenderMode } from '../model/lab-settings.js';
import { relightAzimuths, type RelightLightingSettings } from '../model/lighting.js';
import type { RelightMaterialSettings } from '../model/material.js';
import { RELIGHT_PREVIEW_FRAGMENT_SHADER } from './preview-fragment-shader.js';
import { RELIGHT_PREVIEW_VERTEX_SHADER } from './preview-vertex-shader.js';

type Rect = readonly [number, number, number, number];
type Texture = InstanceType<typeof THREE.Texture>;
type Uniforms = Record<string, { value: unknown }>;

export interface RelightPreviewLayerBinding {
  texture: Texture;
  atlasRect: Rect;
  canvasRect: Rect;
}

export interface RelightPreviewFrameBinding {
  body: RelightPreviewLayerBinding;
  surface: RelightPreviewLayerBinding;
  material?: RelightPreviewLayerBinding;
  mask?: RelightPreviewLayerBinding & { channel: 0 | 1 | 2 | 3 };
  baseColor?: RelightPreviewLayerBinding;
  originalBlur?: RelightPreviewLayerBinding;
  shadowDepth?: RelightPreviewLayerBinding;
  /** Lab sources keep authored alpha/mask silhouettes; legacy assets may opt into a depth crop. */
  useDepthForegroundMask?: boolean;
  mirrored?: boolean;
  normalDecode: { scale: readonly [number, number, number]; bias: readonly [number, number, number] };
  deLitRange: readonly [number, number];
  logicalAspect: number;
  visibleBounds: Rect;
  materialProfile: {
    roughnessScale: number; roughnessBias: number; roughnessMin: number; roughnessMax: number; diffuseWrap: number;
  };
  appearance?: {
    slope: readonly [number, number, number];
    bias: readonly [number, number, number];
    dewhite: boolean;
  };
}

export interface RelightPreviewLightPose {
  readonly directionalWorld: InstanceType<typeof THREE.Vector3>;
  readonly directionalView: InstanceType<typeof THREE.Vector3>;
  readonly pointWorld: InstanceType<typeof THREE.Vector3>;
  readonly pointView: InstanceType<typeof THREE.Vector3>;
}

interface FallbackTextures {
  transparentColor: InstanceType<typeof THREE.DataTexture>;
  neutralSurface: InstanceType<typeof THREE.DataTexture>;
  neutralMaterial: InstanceType<typeof THREE.DataTexture>;
  opaqueMask: InstanceType<typeof THREE.DataTexture>;
}

const SWIZZLE: Readonly<Record<RelightLabMaterialSettings['normalSwizzle'], number>> = {
  XYZ: 0, XZY: 1, YXZ: 2, YZX: 3, ZXY: 4, ZYX: 5,
};

const RENDER_STATE: Readonly<Record<RelightRenderMode, readonly [base: number, debug: number, unlit: number]>> = {
  'original-unlit': [0, 0, 1], 'original-relit': [0, 0, 0],
  'inverse-relit': [1, 0, 0], 'hybrid-relit': [2, 0, 0], 'delit-relit': [3, 0, 0],
  normal: [2, 1, 0], ndotl: [2, 2, 0], depth: [2, 3, 0], roughness: [2, 4, 0],
  metallic: [2, 5, 0], specular: [2, 6, 0], 'baked-lighting': [2, 7, 0], alpha: [2, 8, 0],
};

function fallbackTexture(rgba: readonly [number, number, number, number], colorSpace: string = THREE.NoColorSpace):
InstanceType<typeof THREE.DataTexture> {
  const texture = new THREE.DataTexture(new Uint8Array(rgba), 1, 1, THREE.RGBAFormat);
  texture.colorSpace = colorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

function createFallbacks(): FallbackTextures {
  return {
    transparentColor: fallbackTexture([255, 255, 255, 0], THREE.SRGBColorSpace),
    neutralSurface: fallbackTexture([128, 128, 255, 128]),
    neutralMaterial: fallbackTexture([128, 179, 0, 255]),
    opaqueMask: fallbackTexture([255, 255, 255, 255]),
  };
}

const uniform = <T>(value: T): { value: T } => ({ value });

function textureUniforms(fallbacks: FallbackTextures): Uniforms {
  return {
    uBodyMap: uniform(fallbacks.transparentColor), uSurfaceMap: uniform(fallbacks.neutralSurface),
    uMaterialMap: uniform(fallbacks.neutralMaterial), uMaskMap: uniform(fallbacks.opaqueMask),
    uBaseColorMap: uniform(fallbacks.transparentColor), uOriginalBlurMap: uniform(fallbacks.transparentColor),
    uShadowDepthMap: uniform(fallbacks.neutralMaterial),
    uBodyRect: uniform(new THREE.Vector4()), uSurfaceRect: uniform(new THREE.Vector4()),
    uMaterialRect: uniform(new THREE.Vector4(0, 0, 1, 1)), uMaskRect: uniform(new THREE.Vector4(0, 0, 1, 1)),
    uBaseColorRect: uniform(new THREE.Vector4(0, 0, 1, 1)), uOriginalBlurRect: uniform(new THREE.Vector4(0, 0, 1, 1)),
    uShadowDepthRect: uniform(new THREE.Vector4(0, 0, 1, 1)),
    uBodyCanvasRect: uniform(new THREE.Vector4()), uSurfaceCanvasRect: uniform(new THREE.Vector4()),
    uMaterialCanvasRect: uniform(new THREE.Vector4(0, 0, 1, 1)), uMaskCanvasRect: uniform(new THREE.Vector4(0, 0, 1, 1)),
    uBaseColorCanvasRect: uniform(new THREE.Vector4(0, 0, 1, 1)),
    uOriginalBlurCanvasRect: uniform(new THREE.Vector4(0, 0, 1, 1)),
    uShadowDepthCanvasRect: uniform(new THREE.Vector4(0, 0, 1, 1)),
  };
}

function createUniforms(fallbacks: FallbackTextures): Uniforms {
  const own = {
    ...textureUniforms(fallbacks),
    uNormalScale: uniform(new THREE.Vector3(2, 2, 2)), uNormalBias: uniform(new THREE.Vector3(-1, -1, -1)),
    uAppearanceSlope: uniform(new THREE.Vector3(1, 1, 1)), uAppearanceBias: uniform(new THREE.Vector3()),
    uDeLitRange: uniform(new THREE.Vector2(-.7, .7)), uViewport: uniform(new THREE.Vector2(1, 1)),
    uSpriteSize: uniform(new THREE.Vector2(1, 1)), uObjectNormalToView: uniform(new THREE.Matrix3()),
    uAlbedoTint: uniform(new THREE.Color('#ffffff')), uNormalAxisFlip: uniform(new THREE.Vector3(1, 1, 1)),
    uDirectionalDirection: uniform(new THREE.Vector3(0, 0, 1)), uDirectionalColor: uniform(new THREE.Color('#ffffff')),
    uPointPosition: uniform(new THREE.Vector3(0, 2, -2)), uPointColor: uniform(new THREE.Color('#ffb36b')),
    uHemisphereDirection: uniform(new THREE.Vector3(0, 1, 0)), uHemisphereSky: uniform(new THREE.Color('#7f91b5')),
    uHemisphereGround: uniform(new THREE.Color('#242018')),
    uHasMaterial: uniform(0), uHasMask: uniform(0), uHasBaseColor: uniform(0), uHasOriginalBlur: uniform(0),
    uHasShadowDepth: uniform(0), uMaskChannel: uniform(0), uDewhite: uniform(0), uReady: uniform(0),
    uGbufferEnabled: uniform(1), uLightingEnabled: uniform(1), uMirrorX: uniform(0),
    uBaseColorMode: uniform(2), uDebugView: uniform(0), uUnlit: uniform(1),
    uSplitView: uniform(0), uSplitPosition: uniform(.5),
    uDetailStrength: uniform(.65), uDetailMin: uniform(.72), uDetailMax: uniform(1.32),
    uDeLightStrength: uniform(.6), uAlbedoGain: uniform(1), uExposureCompensation: uniform(0),
    uNormalSpace: uniform(0), uNormalSwizzle: uniform(0), uNormalStrength: uniform(.75), uNormalizeNormal: uniform(1),
    uUseRoughnessMap: uniform(1), uRoughnessFallback: uniform(.7), uRoughnessScale: uniform(.2),
    uRoughnessBias: uniform(.56), uRoughnessMin: uniform(.5), uRoughnessMax: uniform(.9),
    uUseMetallicMap: uniform(0), uMetallicFallback: uniform(0), uMetallicScale: uniform(1),
    uMetallicBias: uniform(0), uMetallicThreshold: uniform(0), uForceNonMetal: uniform(1),
    uWrapDiffuse: uniform(1), uDiffuseWrap: uniform(.1), uSpecularEnabled: uniform(1), uSpecularIntensity: uniform(.25),
    uRimEnabled: uniform(0), uRimIntensity: uniform(.18), uRimPower: uniform(3),
    uDepthPositionEnabled: uniform(0), uInvertDepth: uniform(0), uDepthMin: uniform(0), uDepthMax: uniform(1),
    uDepthBias: uniform(0), uCharacterThickness: uniform(.3), uSelfShadowEnabled: uniform(0),
    uSelfShadowStrength: uniform(.9), uSelfShadowLength: uniform(.18), uSelfShadowBias: uniform(.012),
    uSelfShadowSoftness: uniform(.018), uFrameShadowEnabled: uniform(1), uFrameShadowStrength: uniform(.46),
    uFrameShadowRelief: uniform(.65), uAlphaTest: uniform(.02),
    uDirectionalIntensity: uniform(2), uPointEnabled: uniform(0), uPointIntensity: uniform(18),
    uPointDistance: uniform(10), uPointDecay: uniform(2), uHemisphereIntensity: uniform(.25),
  } satisfies Uniforms;
  return THREE.UniformsUtils.merge([THREE.UniformsLib.lights, own]) as Uniforms;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
}

function setRect(target: InstanceType<typeof THREE.Vector4>, value: Rect): void { target.fromArray(value); }

function bindLayer(uniforms: Uniforms, prefix: string, layer: RelightPreviewLayerBinding): void {
  uniforms[`${prefix}Map`].value = layer.texture;
  setRect(uniforms[`${prefix}Rect`].value as InstanceType<typeof THREE.Vector4>, layer.atlasRect);
  setRect(uniforms[`${prefix}CanvasRect`].value as InstanceType<typeof THREE.Vector4>, layer.canvasRect);
}

export class RelightPreviewMaterial extends THREE.ShaderMaterial {
  private readonly fallbacks: FallbackTextures;
  private readonly directionalWorld = new THREE.Vector3(0, 0, 1);
  private readonly directionalView = new THREE.Vector3(0, 0, 1);
  private readonly pointWorld = new THREE.Vector3(0, 2, 2);
  private readonly pointView = new THREE.Vector3(0, 2, -2);
  private readonly lightTargetWorld = new THREE.Vector3();
  private readonly modelViewMatrixScratch = new THREE.Matrix4();
  private readonly lightPose: RelightPreviewLightPose;

  constructor() {
    const fallbacks = createFallbacks();
    super({
      name: 'RelightLabPreviewMaterial', uniforms: createUniforms(fallbacks),
      vertexShader: RELIGHT_PREVIEW_VERTEX_SHADER, fragmentShader: RELIGHT_PREVIEW_FRAGMENT_SHADER,
      lights: true, transparent: true, depthTest: true, depthWrite: true,
      side: THREE.DoubleSide, toneMapped: true,
    });
    this.fallbacks = fallbacks;
    this.lightPose = {
      directionalWorld: this.directionalWorld, directionalView: this.directionalView,
      pointWorld: this.pointWorld, pointView: this.pointView,
    };
  }

  bind(frame: RelightPreviewFrameBinding): void {
    const uniforms = this.uniforms;
    uniforms.uReady.value = 0;
    bindLayer(uniforms, 'uBody', frame.body);
    bindLayer(uniforms, 'uSurface', frame.surface);
    this.bindOptionalLayer('uMaterial', frame.material, this.fallbacks.neutralMaterial);
    this.bindOptionalLayer('uMask', frame.mask, this.fallbacks.opaqueMask);
    this.bindOptionalLayer('uBaseColor', frame.baseColor, frame.body.texture);
    this.bindOptionalLayer('uOriginalBlur', frame.originalBlur, frame.body.texture);
    this.bindOptionalLayer('uShadowDepth', frame.shadowDepth, frame.material?.texture ?? this.fallbacks.neutralMaterial);
    uniforms.uHasMaterial.value = frame.material ? 1 : 0;
    uniforms.uHasMask.value = frame.mask ? 1 : 0;
    uniforms.uHasBaseColor.value = frame.baseColor ? 1 : 0;
    uniforms.uHasOriginalBlur.value = frame.originalBlur ? 1 : 0;
    uniforms.uHasShadowDepth.value = frame.shadowDepth ? 1 : 0;
    uniforms.uMaskChannel.value = frame.mask?.channel ?? 0;
    uniforms.uMirrorX.value = frame.mirrored ? 1 : 0;
    (uniforms.uNormalScale.value as InstanceType<typeof THREE.Vector3>).fromArray(frame.normalDecode.scale);
    (uniforms.uNormalBias.value as InstanceType<typeof THREE.Vector3>).fromArray(frame.normalDecode.bias);
    (uniforms.uDeLitRange.value as InstanceType<typeof THREE.Vector2>).fromArray(frame.deLitRange);
    (uniforms.uAppearanceSlope.value as InstanceType<typeof THREE.Vector3>).fromArray(frame.appearance?.slope ?? [1, 1, 1]);
    (uniforms.uAppearanceBias.value as InstanceType<typeof THREE.Vector3>).fromArray(frame.appearance?.bias ?? [0, 0, 0]);
    uniforms.uDewhite.value = frame.appearance?.dewhite ? 1 : 0;
    uniforms.uReady.value = 1;
  }

  updateLighting(settings: RelightLightingSettings, now: number,
    camera: InstanceType<typeof THREE.Camera>): RelightPreviewLightPose {
    const azimuths = relightAzimuths(settings, now);
    const azimuth = THREE.MathUtils.degToRad(azimuths.directional);
    const elevation = THREE.MathUtils.degToRad(settings.directional.elevation);
    const horizontal = Math.cos(elevation);
    this.directionalWorld.set(Math.sin(azimuth) * horizontal, Math.sin(elevation), Math.cos(azimuth) * horizontal);
    this.directionalView.copy(this.directionalWorld).transformDirection(camera.matrixWorldInverse);
    const pointRadians = THREE.MathUtils.degToRad(azimuths.point);
    this.pointWorld.set(Math.sin(pointRadians) * settings.point.radius, settings.point.height,
      Math.cos(pointRadians) * settings.point.radius).add(this.lightTargetWorld);
    this.pointView.copy(this.pointWorld).applyMatrix4(camera.matrixWorldInverse);
    (this.uniforms.uHemisphereDirection.value as InstanceType<typeof THREE.Vector3>)
      .set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
    this.syncLightUniforms(settings);
    return this.lightPose;
  }

  updateLabMaterial(settings: RelightLabMaterialSettings): void {
    this.syncColorMaterial(settings);
    this.syncNormalMaterial(settings);
    this.syncSurfaceMaterial(settings);
    this.syncShadowMaterial(settings);
  }

  updateMaterial(settings: RelightMaterialSettings): void {
    this.uniforms.uGbufferEnabled.value = settings.isGbufferEnabled ? 1 : 0;
  }

  setRenderMode(mode: RelightRenderMode, splitView: boolean, splitPosition: number): void {
    const [baseColorMode, debugView, unlit] = RENDER_STATE[mode];
    this.uniforms.uBaseColorMode.value = baseColorMode;
    this.uniforms.uDebugView.value = debugView;
    this.uniforms.uUnlit.value = unlit;
    this.uniforms.uSplitView.value = splitView ? 1 : 0;
    this.uniforms.uSplitPosition.value = clamp(splitPosition, .05, .95);
  }

  syncObjectSpaceNormal(mesh: InstanceType<typeof THREE.Object3D>, camera: InstanceType<typeof THREE.Camera>): void {
    mesh.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);
    this.modelViewMatrixScratch.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
    (this.uniforms.uObjectNormalToView.value as InstanceType<typeof THREE.Matrix3>).getNormalMatrix(this.modelViewMatrixScratch);
  }

  setViewport(width: number, height: number): void {
    (this.uniforms.uViewport.value as InstanceType<typeof THREE.Vector2>).set(width, height);
  }

  setSpriteSize(width: number, height: number): void {
    (this.uniforms.uSpriteSize.value as InstanceType<typeof THREE.Vector2>).set(width, height);
  }

  setLightTarget(x: number, y: number, z: number): void { this.lightTargetWorld.set(x, y, z); }

  dispose(): void {
    for (const texture of Object.values(this.fallbacks)) texture.dispose();
    super.dispose();
  }

  private bindOptionalLayer(prefix: string, layer: RelightPreviewLayerBinding | undefined, fallback: Texture): void {
    const resolved = layer ?? { texture: fallback, atlasRect: [0, 0, 1, 1] as Rect, canvasRect: [0, 0, 1, 1] as Rect };
    bindLayer(this.uniforms, prefix, resolved);
  }

  private syncLightUniforms(settings: RelightLightingSettings): void {
    const uniforms = this.uniforms;
    uniforms.uLightingEnabled.value = settings.enabled ? 1 : 0;
    (uniforms.uDirectionalDirection.value as InstanceType<typeof THREE.Vector3>).copy(this.directionalView);
    (uniforms.uDirectionalColor.value as InstanceType<typeof THREE.Color>).set(settings.directional.color);
    uniforms.uDirectionalIntensity.value = settings.enabled ? settings.directional.intensity : 0;
    (uniforms.uPointPosition.value as InstanceType<typeof THREE.Vector3>).copy(this.pointView);
    (uniforms.uPointColor.value as InstanceType<typeof THREE.Color>).set(settings.point.color);
    uniforms.uPointEnabled.value = settings.enabled && settings.point.enabled ? 1 : 0;
    uniforms.uPointIntensity.value = settings.point.intensity;
    uniforms.uPointDistance.value = settings.point.distance;
    uniforms.uPointDecay.value = settings.point.decay;
    (uniforms.uHemisphereSky.value as InstanceType<typeof THREE.Color>).set(settings.hemisphere.skyColor);
    (uniforms.uHemisphereGround.value as InstanceType<typeof THREE.Color>).set(settings.hemisphere.groundColor);
    uniforms.uHemisphereIntensity.value = settings.enabled ? settings.hemisphere.intensity : 0;
  }

  private syncColorMaterial(settings: RelightLabMaterialSettings): void {
    const uniforms = this.uniforms;
    uniforms.uDetailStrength.value = clamp(settings.detailStrength, 0, 1);
    uniforms.uDetailMin.value = Math.max(0, settings.detailMin);
    uniforms.uDetailMax.value = Math.max(uniforms.uDetailMin.value as number, settings.detailMax);
    uniforms.uDeLightStrength.value = clamp(settings.deLightStrength, 0, 1);
    uniforms.uAlbedoGain.value = Math.max(0, settings.albedoGain);
    (uniforms.uAlbedoTint.value as InstanceType<typeof THREE.Color>).set(settings.albedoTint);
    uniforms.uExposureCompensation.value = clamp(settings.exposureCompensation, -8, 8);
  }

  private syncNormalMaterial(settings: RelightLabMaterialSettings): void {
    const uniforms = this.uniforms;
    uniforms.uNormalSpace.value = settings.normalSpace === 'object' ? 1 : 0;
    uniforms.uNormalSwizzle.value = SWIZZLE[settings.normalSwizzle];
    (uniforms.uNormalAxisFlip.value as InstanceType<typeof THREE.Vector3>).set(
      settings.flipNormalX ? -1 : 1, settings.flipNormalY ? -1 : 1, settings.flipNormalZ ? -1 : 1,
    );
    uniforms.uNormalStrength.value = clamp(settings.normalStrength, 0, 4);
    uniforms.uNormalizeNormal.value = settings.normalizeNormal ? 1 : 0;
  }

  private syncSurfaceMaterial(settings: RelightLabMaterialSettings): void {
    const uniforms = this.uniforms;
    uniforms.uUseRoughnessMap.value = settings.roughnessUseMap ? 1 : 0;
    uniforms.uRoughnessFallback.value = clamp(settings.roughnessFallback, 0, 1);
    uniforms.uRoughnessScale.value = clamp(settings.roughnessScale, 0, 4);
    uniforms.uRoughnessBias.value = clamp(settings.roughnessBias, -1, 1);
    uniforms.uRoughnessMin.value = clamp(settings.roughnessMin, .08, 1);
    uniforms.uRoughnessMax.value = clamp(settings.roughnessMax, .08, 1);
    uniforms.uUseMetallicMap.value = settings.metallicUseMap ? 1 : 0;
    uniforms.uMetallicFallback.value = clamp(settings.metallicFallback, 0, 1);
    uniforms.uMetallicScale.value = clamp(settings.metallicScale, 0, 4);
    uniforms.uMetallicBias.value = clamp(settings.metallicBias, -1, 1);
    uniforms.uMetallicThreshold.value = clamp(settings.metallicThreshold, 0, 1);
    uniforms.uForceNonMetal.value = settings.forceNonMetal ? 1 : 0;
    uniforms.uWrapDiffuse.value = settings.wrapDiffuse ? 1 : 0;
    uniforms.uDiffuseWrap.value = clamp(settings.diffuseWrap, 0, 1);
    uniforms.uSpecularEnabled.value = settings.specularEnabled ? 1 : 0;
    uniforms.uSpecularIntensity.value = clamp(settings.specularIntensity, 0, 4);
    uniforms.uRimEnabled.value = settings.rimEnabled ? 1 : 0;
    uniforms.uRimIntensity.value = clamp(settings.rimIntensity, 0, 4);
    uniforms.uRimPower.value = clamp(settings.rimPower, .01, 16);
  }

  private syncShadowMaterial(settings: RelightLabMaterialSettings): void {
    const uniforms = this.uniforms;
    uniforms.uDepthPositionEnabled.value = settings.depthPositionEnabled ? 1 : 0;
    uniforms.uInvertDepth.value = settings.invertDepth ? 1 : 0;
    const depthA = clamp(settings.depthMin, 0, 1);
    const depthB = clamp(settings.depthMax, 0, 1);
    uniforms.uDepthMin.value = Math.min(depthA, depthB);
    uniforms.uDepthMax.value = Math.max(depthA, depthB);
    uniforms.uDepthBias.value = clamp(settings.depthBias, -1, 1);
    uniforms.uCharacterThickness.value = clamp(settings.characterThickness, 0, 10);
    uniforms.uSelfShadowEnabled.value = settings.selfShadowEnabled ? 1 : 0;
    uniforms.uSelfShadowStrength.value = clamp(settings.selfShadowStrength, 0, 1);
    uniforms.uSelfShadowLength.value = clamp(settings.selfShadowLength, 0, 1);
    uniforms.uSelfShadowBias.value = clamp(settings.selfShadowBias, 0, .25);
    uniforms.uSelfShadowSoftness.value = clamp(settings.selfShadowSoftness, 0, .25);
    uniforms.uFrameShadowEnabled.value = settings.frameShadowEnabled ? 1 : 0;
    uniforms.uFrameShadowStrength.value = clamp(settings.frameShadowStrength, 0, 1);
    uniforms.uFrameShadowRelief.value = clamp(settings.frameShadowRelief, 0, 2);
    uniforms.uAlphaTest.value = clamp(settings.alphaTest, 0, 1);
  }
}
