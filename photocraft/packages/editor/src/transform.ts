/**
 * 图片聚焦的适应窗口换算
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 4.5；
 *   change: 2026-10-16-integrate-photocraft-image-editing 删掉旧标注编辑器后只保留适应窗口换算）。
 *
 * 图片呈现和透明交互层共用工作区取景与公共内容矩形；本模块提供「适应窗口」缩放，
 * 手势源↔屏幕换算使用相同的文档尺寸与缩放（`photo-editor-canvas.tsx`）。
 */

export type SurfaceRect = { x: number; y: number; width: number; height: number };

/** 计算适应窗口缩放：完整容纳图片（可低于手动下限）。 */
export function fitZoomFor(sourceWidth: number, sourceHeight: number, rect: SurfaceRect): number {
  if (sourceWidth <= 0 || sourceHeight <= 0 || rect.width <= 0 || rect.height <= 0) return 1;
  return Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
}
