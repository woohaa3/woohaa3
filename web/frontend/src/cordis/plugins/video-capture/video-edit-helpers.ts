/**
 * 视频编辑 dialog 的纯辅助
 * （change: 2026-09-28-split-frontend-god-plugins，task 5；从 video-edit-dialog.tsx 拆出）。
 */
import type { VideoEditAnnotationShape, VideoEditIntent } from "@woohaa3/contracts";
import type { ContentRect } from "./video-geometry.js";
import { drawShape as drawSharedShape } from "../../services/media-annotation/geometry.js";

export type Tool = "pen" | "rect";
export type TimelineDragMode = "move" | "resize-start" | "resize-end";

/**
 * showcase/test 注入的初始状态（生产不传）。仅用于展示已有草稿、undo/redo、错误与 busy 态，
 * 不参与任何网络或规范状态写入。
 */
export type VideoEditStorySeed = {
  intents?: readonly VideoEditIntent[];
  activeIntentId?: string;
  tool?: Tool;
  busy?: boolean;
  error?: string | null;
  video?: { duration: number; currentTime: number; width: number; height: number };
};

export type TimelineDrag = {
  id: string;
  mode: TimelineDragMode;
  originX: number;
  originStart: number;
  originEnd?: number;
};

/** 浏览器安全错误 → 可恢复的用户提示（跨域 tainted canvas 不产出空白图）。 */
export function toSafePreviewError(error: unknown): string {
  if (error instanceof DOMException && error.name === "SecurityError") {
    return "视频跨域限制导致标记图无法生成，请使用已导入画布的同源视频。";
  }
  if (error instanceof Error && error.message) return error.message;
  return "标记图生成失败";
}

export function copyIntent(intent: VideoEditIntent): VideoEditIntent {
  return {
    ...intent,
    annotationShapes: intent.annotationShapes.map((shape) => ({ ...shape, points: shape.points.map((point) => ({ ...point })) })),
    ...(intent.annotationPreview ? { annotationPreview: { ...intent.annotationPreview } } : {})
  };
}

/** 在给定内容矩形上绘制 shape（绘制预览与合成共用同一映射，design D5）。 */
export function drawShape(context: CanvasRenderingContext2D, shape: VideoEditAnnotationShape, content: ContentRect): void {
  drawSharedShape(context, { tool: shape.tool, color: shape.color, points: shape.points }, content, shape.strokeWidth);
}

export function createShapeId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `annotation-${random}`;
  return `annotation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createIntentId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `video-edit-${random}`;
  return `video-edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isTextEditingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === "TEXTAREA" || tag === "INPUT" || element.isContentEditable === true;
}
