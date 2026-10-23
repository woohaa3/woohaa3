import type { FeatureToolId } from "../index.js";


/**
 * 画布工具。
 *
 * `pen` 与修饰工具（`clone` / `heal` / `retouch`）在 P4–P7 加入：它们与前几项一样只产生
 * 文档坐标手势，具体语义由内核命令决定。
 */
export type EditorToolId = "none" | "pan" | FeatureToolId;

/** 文档坐标下的像素矩形。 */
export type PixelRect = { x: number; y: number; width: number; height: number };

/** 文档坐标点。 */
export type DocumentPoint = {
  x: number;
  y: number;
  pressure?: number;
  /**
   * 笔姿态（change: 2026-10-22-add-photocraft-painting-color-workflows，U31）。
   *
   * 直接对应 W3C Pointer Events 的真实字段，不做任何传感器伪造：鼠标与不带姿态的笔不赋值，
   * `stroke-points.ts` 因此保持短编码（不补 0 占位）。`rotation` 对应 `twist`，`time` 对应
   * `event.timeStamp`。
   */
  tiltX?: number;
  tiltY?: number;
  rotation?: number;
  time?: number;
  wheel?: number;
};

/** 画布视图：使用共享取景换算的图片客户矩形反映射。 */
export type CanvasViewport = {
  /** 图片在当前聚焦取景下的客户坐标左/上/宽/高。 */
  left: number;
  top: number;
  width: number;
  height: number;
  /** 文档尺寸（画布坐标 = 文档像素）。 */
  documentWidth: number;
  documentHeight: number;
};

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function roundPixel(value: number): number {
  return Math.round(value);
}

/**
 * 屏幕（`clientX`/`clientY`）→ 文档坐标。
 *
 * 用画布元素的**变换后**客户矩形做线性反映射：`文档尺寸 / 客户矩形尺寸` 即总比例，因此不必
 * 关心 CSS 缩放/平移/变换原点。选区默认钳制；绘画传入 false 保留图外采样，避免将路径压到边缘。
 * 元素未布局（宽或高为 0）或输入非有限数时返回 `null`
 * （不做静默 0 值）。
 */
export function screenToDocument(clientX: number, clientY: number, viewport: CanvasViewport, constrain = true): DocumentPoint | null {
  const { left, top, width, height, documentWidth, documentHeight } = viewport;
  if (![clientX, clientY, left, top, width, height, documentWidth, documentHeight].every(Number.isFinite)
    || width <= 0 || height <= 0 || documentWidth <= 0 || documentHeight <= 0) return null;
  const x = ((clientX - left) / width) * documentWidth;
  const y = ((clientY - top) / height) * documentHeight;
  return {
    x: constrain ? clamp(x, 0, documentWidth) : x,
    y: constrain ? clamp(y, 0, documentHeight) : y
  };
}

/** `paint.stroke` 的 `brush` 补丁（笔刷设置面板改的是这里，不是命令标量）。 */
export function brushSettingsPatch(patch: Record<string, unknown>): Record<string, unknown> {
  return { brush: patch };
}
