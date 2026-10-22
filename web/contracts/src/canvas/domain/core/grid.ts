/** 节点吸附 / 对齐步长（px） */
export const woohaa3CanvasGridSize = 20;

/** 背景点阵视觉间距；与 20px 的轻吸附步长刻意解耦，对齐 shawn_02。 */
export const woohaa3CanvasBackgroundGap = 32;

/** 背景网格点尺寸（React Flow Background `size`，单位 px） */
export const woohaa3CanvasBackgroundDotSize = 2;

export function snapToAssetGrid(value: number): number {
  return Math.round(value / woohaa3CanvasGridSize) * woohaa3CanvasGridSize;
}

export const woohaa3CanvasSnapThreshold = 5;

export function snapToAssetGridWithinThreshold(value: number, threshold = woohaa3CanvasSnapThreshold): number {
  const snapped = snapToAssetGrid(value);
  return Math.abs(snapped - value) <= threshold ? snapped : value;
}
