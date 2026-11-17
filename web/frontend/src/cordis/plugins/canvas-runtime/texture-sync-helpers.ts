import { rasterizeDrawable, type RasterCanvasFactory } from "./media-raster.js";
import { selectThumbnailTier, type ThumbnailTier } from "./residency/policy.js";
import { TEXTURE_MAX_DIMENSION } from "./texture-constants.js";
export { TEXTURE_MAX_DIMENSION } from "./texture-constants.js";

export function textureErrorOf(outcome: { status: string; error?: unknown }): Error {
  return outcome.error instanceof Error ? outcome.error : new Error(`图片准备${outcome.status}`);
}

/** 按自身宽高比缩放图片并取 RGBA，不填充、不裁剪。 */
export function rasterizeTexture(
  image: HTMLImageElement,
  createCanvas: RasterCanvasFactory,
  maxDimension: number = TEXTURE_MAX_DIMENSION
): { pixels: import("@woohaa3/contracts").ImagePixelSource; width: number; height: number } | null {
  const limit = Math.min(selectThumbnailTier(maxDimension), TEXTURE_MAX_DIMENSION);
  return rasterizeDrawable(image, { width: image.width, height: image.height }, createCanvas, limit);
}

export type { ThumbnailTier };
