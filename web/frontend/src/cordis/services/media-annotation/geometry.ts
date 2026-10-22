/**
 * 媒体中立的标注几何与绘制契约
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 5.1）。
 *
 * 从视频编辑模块提取的纯逻辑：内容区域映射（排除 letterbox）、归一化坐标 ↔ 内容像素、
 * 以及可在 Canvas 2D 上重绘的 shape 绘制。图片聚焦编辑与视频编辑 Dialog 共用同一份受控
 * 几何与绘制规则，避免两套映射漂移。
 *
 * 无 DOM/React 依赖；坐标以**内容区域归一化**表达，缩放/DPR/letterbox 不改变语义。
 */
import type { ImageEditShape, VideoEditAnnotationShape } from "@woohaa3/contracts";

/** 容器内的实际内容显示矩形（CSS px，已排除 letterbox）。 */
export type ContentRect = { x: number; y: number; width: number; height: number };

/** 归一化 shape 点。 */
export type NormalizedPoint = { x: number; y: number };

/** 绘制所需的 shape 视图（图片/视频共用字段子集）。 */
export type DrawableShape = {
  tool: "pen" | "rect";
  color: string;
  points: readonly NormalizedPoint[];
};

/** 线宽解析：图片用源像素线宽，视频用受控 strokeWidth。 */
export type ShapeStrokeResolver = (shape: DrawableShape) => number;

/** 数值钳制；非有限值回退到 min。 */
export function clampRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 归一化坐标分量钳制到 `[0, 1]`。 */
export function clampUnit(value: number): number {
  return clampRange(value, 0, 1);
}

/**
 * 计算内容在容器中的实际显示矩形（`object-fit: contain`）。
 *
 * letterbox 区域不属于内容；shape 坐标相对该矩形归一化。图片 sourceWidth/Height 与视频
 * videoWidth/Height 语义一致。
 */
export function getContentRect(
  contentWidth: number,
  contentHeight: number,
  containerWidth: number,
  containerHeight: number
): ContentRect {
  const cw = contentWidth > 0 ? contentWidth : containerWidth;
  const ch = contentHeight > 0 ? contentHeight : containerHeight;
  if (cw <= 0 || ch <= 0 || containerWidth <= 0 || containerHeight <= 0) {
    return { x: 0, y: 0, width: Math.max(0, containerWidth), height: Math.max(0, containerHeight) };
  }
  const scale = Math.min(containerWidth / cw, containerHeight / ch);
  const width = cw * scale;
  const height = ch * scale;
  return { x: (containerWidth - width) / 2, y: (containerHeight - height) / 2, width, height };
}

/** 容器内 client 坐标 → 内容区域归一化坐标；落在 letterbox 外返回 null。 */
export function toNormalizedPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  content: ContentRect
): NormalizedPoint | null {
  if (content.width <= 0 || content.height <= 0) return null;
  return {
    x: clampUnit((clientX - rect.left - content.x) / content.width),
    y: clampUnit((clientY - rect.top - content.y) / content.height)
  };
}

/** 内容区域归一化坐标 → 容器像素坐标。 */
export function toContentPixel(point: NormalizedPoint, content: ContentRect): NormalizedPoint {
  return { x: content.x + point.x * content.width, y: content.y + point.y * content.height };
}

/** 归一化坐标是否落在真实内容区域内（letterbox 外为 false）。 */
export function isInsideContent(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  content: ContentRect
): boolean {
  if (content.width <= 0 || content.height <= 0) return false;
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  return x >= content.x && x <= content.x + content.width && y >= content.y && y <= content.y + content.height;
}

/**
 * 在给定内容矩形上绘制 shape（绘制预览与合成共用同一映射）。
 *
 * `strokeWidth` 由调用方解析：图片为源像素线宽经内容矩形缩放后的像素值，视频为受控
 * strokeWidth。默认按 `1`。
 */
export function drawShape(
  context: CanvasRenderingContext2D,
  shape: DrawableShape,
  content: ContentRect,
  strokeWidth = 1
): void {
  if (shape.points.length < 2) return;
  const points = shape.points.map((point) => toContentPixel(point, content));
  context.save();
  context.strokeStyle = shape.color;
  context.lineWidth = strokeWidth;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  if (shape.tool === "pen") {
    context.moveTo(points[0]!.x, points[0]!.y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
  } else {
    const [start, end] = points;
    context.strokeRect(start!.x, start!.y, end!.x - start!.x, end!.y - start!.y);
  }
  context.restore();
}

/** 由视频 shape 派生媒体中立绘制视图。 */
export function drawableFromVideoShape(shape: VideoEditAnnotationShape): DrawableShape {
  return { tool: shape.tool, color: shape.color, points: shape.points };
}

/** 由图片 shape 派生媒体中立绘制视图。 */
export function drawableFromImageShape(shape: ImageEditShape): DrawableShape {
  return { tool: shape.tool, color: shape.color, points: shape.points };
}

/**
 * 图片源像素线宽 → 目标内容矩形像素线宽
 * （源像素 1:1 显示时为 1，缩放到 `content.width / sourceWidth` 倍）。
 */
export function imageStrokeWidthInContent(
  widthInSourcePixels: number,
  content: ContentRect,
  sourceWidth: number
): number {
  if (sourceWidth <= 0) return widthInSourcePixels;
  return Math.max(1, (widthInSourcePixels * content.width) / sourceWidth);
}

/**
 * 图片聚焦的像素映射：给定源尺寸与可用内容矩形，计算 fit 缩放（1 源像素 = zoom CSS px）。
 * 100% 定义为 1:1；fit 可取更小值以完整容纳大图。
 */
export function imageFitZoom(
  sourceWidth: number,
  sourceHeight: number,
  content: ContentRect
): number {
  if (sourceWidth <= 0 || sourceHeight <= 0) return 1;
  return Math.min(content.width / sourceWidth, content.height / sourceHeight);
}
