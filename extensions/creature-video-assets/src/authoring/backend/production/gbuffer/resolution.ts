import type { GbufferSpatialTransform } from './contracts.js';

export const GBUFFER_DIMENSION_MULTIPLE = 16;
export const GBUFFER_MAX_DIMENSION = 1920;
export const GBUFFER_DEFAULT_SIZE: [number, number] = [1280, 704];
export const GBUFFER_RESOLUTION_POLICY = 'preserve-aspect-pad16-v1' as const;

function alignUp(value: number): number {
  return Math.ceil(value / GBUFFER_DIMENSION_MULTIPLE) * GBUFFER_DIMENSION_MULTIPLE;
}

function validDimension(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数`);
}

/**
 * Plan the single geometry transform shared by RGB, Alpha/Mask and every frame.
 *
 * Inputs within the model's 1920×1920 range keep their original dimensions.
 * Larger inputs scale down uniformly. The scaled image is then centred on the
 * next 16-aligned canvas; odd padding puts the extra pixel on right/bottom.
 */
export function planGbufferResolution(originalSize: [number, number]): GbufferSpatialTransform {
  const [originalWidth, originalHeight] = originalSize;
  validDimension(originalWidth, '原始宽度');
  validDimension(originalHeight, '原始高度');

  const scale = Math.min(
    1,
    GBUFFER_MAX_DIMENSION / originalWidth,
    GBUFFER_MAX_DIMENSION / originalHeight,
  );
  const scaledWidth = Math.max(1, Math.round(originalWidth * scale));
  const scaledHeight = Math.max(1, Math.round(originalHeight * scale));
  const modelWidth = alignUp(scaledWidth);
  const modelHeight = alignUp(scaledHeight);
  if (modelWidth > GBUFFER_MAX_DIMENSION || modelHeight > GBUFFER_MAX_DIMENSION) {
    throw new Error(`规划后的模型尺寸超出 ${GBUFFER_MAX_DIMENSION}：${modelWidth}×${modelHeight}`);
  }
  const horizontal = modelWidth - scaledWidth;
  const vertical = modelHeight - scaledHeight;
  const left = Math.floor(horizontal / 2);
  const top = Math.floor(vertical / 2);
  const padding = {
    left,
    right: horizontal - left,
    top,
    bottom: vertical - top,
  };
  return {
    sourceSize: originalSize,
    scaledSize: [scaledWidth, scaledHeight],
    inferenceSize: [modelWidth, modelHeight],
    destinationRect: [left, top, scaledWidth, scaledHeight],
    padding,
    scale,
    fit: 'contain',
    policy: GBUFFER_RESOLUTION_POLICY,
    coordinateConvention: 'top-left-pixels',
  };
}

/** Validate dimensions before submitting to Cosmos or accepting its output. */
export function validateGbufferModelSize(size: [number, number]): void {
  const [width, height] = size;
  validDimension(width, '模型宽度');
  validDimension(height, '模型高度');
  if (width % GBUFFER_DIMENSION_MULTIPLE || height % GBUFFER_DIMENSION_MULTIPLE) {
    throw new Error(`模型尺寸必须是 ${GBUFFER_DIMENSION_MULTIPLE} 的倍数：${width}×${height}`);
  }
  if (width > GBUFFER_MAX_DIMENSION || height > GBUFFER_MAX_DIMENSION) {
    throw new Error(`模型尺寸单边不能超过 ${GBUFFER_MAX_DIMENSION}：${width}×${height}`);
  }
}

/** Crop rectangle that restores the scaled content from model-space output. */
export function outputCrop(transform: GbufferSpatialTransform): [number, number, number, number] {
  return [
    transform.padding.left,
    transform.padding.top,
    transform.scaledSize[0],
    transform.scaledSize[1],
  ];
}
