/**
 * 视频 dialog 的纯几何/时间工具
 * （change: port-video-editing-dialogs，任务 2.2 / 3.3；design D5）。
 *
 * 无 DOM/React 依赖：内容区域映射（排除 object-fit letterbox）、归一化坐标、
 * 时间钳制与稳定尾帧时间都可在 node 环境单测。
 */
import { VIDEO_FRAME_EPSILON_SECONDS, type VideoEditAnnotationShape } from "@woohaa3/contracts";
import {
  clampRange,
  clampUnit,
  drawShape as drawSharedShape,
  getContentRect,
  toContentPixel as toContentPixelShared,
  toNormalizedPoint as toNormalizedPointShared,
  type ContentRect
} from "../../services/media-annotation/geometry.js";

export type { ContentRect } from "../../services/media-annotation/geometry.js";

/** 数值钳制；非有限值回退到 min。 */
export { clampRange, clampUnit };

/**
 * 计算视频内容在容器中的实际显示矩形（`object-fit: contain`）。
 * letterbox 区域不属于内容；shape 坐标相对该矩形归一化（design D5）。
 */
export function getVideoContentRect(
  videoWidth: number,
  videoHeight: number,
  containerWidth: number,
  containerHeight: number
): ContentRect {
  return getContentRect(videoWidth, videoHeight, containerWidth, containerHeight);
}

/** 容器内 client 坐标 → 内容区域归一化坐标；落在 letterbox 外返回 null。 */
export function toNormalizedPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  content: ContentRect
): { x: number; y: number } | null {
  return toNormalizedPointShared(clientX, clientY, rect, content);
}

/** 内容区域归一化坐标 → 容器像素坐标。 */
export function toContentPixel(point: { x: number; y: number }, content: ContentRect): { x: number; y: number } {
  return toContentPixelShared(point, content);
}

/**
 * 稳定尾帧时间：不超过 duration，且不落在 `ended` 空白帧。
 * duration 未知（<=0）时返回 0。
 */
export function resolveLastVideoFrameTime(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, duration - VIDEO_FRAME_EPSILON_SECONDS);
}

/** 稳定首帧时间（0）。 */
export function resolveFirstVideoFrameTime(): number {
  return 0;
}

/** `mm:ss.xx` 时间显示。 */
export function formatVideoTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalCentiseconds = Math.round(safe * 100);
  const minutes = Math.floor(totalCentiseconds / 6000);
  const remainder = ((totalCentiseconds % 6000) / 100).toFixed(2).padStart(5, "0");
  return `${String(minutes).padStart(2, "0")}:${remainder}`;
}

/** 尾部时间轴拖动/区间编辑最小跨度（秒）。 */
export const MIN_RANGE_SECONDS = 0.05;

/**
 * 拖动时间轴区间/点时把 start/end 钳制到 `[0, duration]`，且区间跨度 ≥ 0.05（design D7）。
 */
export function clampTimelineRange(input: {
  startSeconds: number;
  endSeconds?: number;
  duration: number;
}): { startSeconds: number; endSeconds?: number } {
  const duration = Math.max(0, Number.isFinite(input.duration) ? input.duration : 0);
  const start = clampRange(input.startSeconds, 0, duration);
  if (input.endSeconds === undefined) return { startSeconds: start };
  let end = clampRange(input.endSeconds, 0, duration);
  // 保持最小跨度：若终点太靠近起点，往后推；到边界则往前压。
  if (end - start < MIN_RANGE_SECONDS) {
    if (start + MIN_RANGE_SECONDS <= duration) {
      end = start + MIN_RANGE_SECONDS;
    } else {
      return { startSeconds: Math.max(0, end - MIN_RANGE_SECONDS), endSeconds: end };
    }
  }
  return { startSeconds: start, endSeconds: end };
}

/** 把 shape 归一化 points 映射到目标内容矩形像素（绘制/命中/合成共用，design D5）。 */
export function shapeToPixels(shape: VideoEditAnnotationShape, content: ContentRect): Array<{ x: number; y: number }> {
  return shape.points.map((point) => toContentPixel(point, content));
}

/** 在内容矩形上绘制 shape（绘制预览与合成共用；委托媒体中立实现）。 */
export function drawVideoShape(
  context: CanvasRenderingContext2D,
  shape: VideoEditAnnotationShape,
  content: ContentRect
): void {
  drawSharedShape(
    context,
    { tool: shape.tool, color: shape.color, points: shape.points },
    content,
    shape.strokeWidth
  );
}

export { drawSharedShape };
