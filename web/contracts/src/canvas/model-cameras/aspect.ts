/**
 * 模型镜头契约：画幅解析与尺寸
 * （自 `model-cameras.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R18）。
 */
import { isFiniteNumber } from "../../validation.js";
import { MODEL_CAMERA_ASPECTS, MODEL_CAMERA_MAX_CAPTURE_DIMENSION, type ModelCameraAspect } from "./types.js";

/**
 * 画幅的数值比例（宽 / 高）；非法/未知值回退 `16:9`。
 */
export function modelCameraAspectRatio(aspect: ModelCameraAspect | undefined): number {
  if (!aspect || !MODEL_CAMERA_ASPECTS.includes(aspect)) return 16 / 9;
  const [widthText, heightText] = aspect.split(":");
  const width = Number(widthText);
  const height = Number(heightText);
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) return 16 / 9;
  return width / height;
}

/**
 * 画幅的像素尺寸（capture / preview；保持固定基准宽度预算）。
 *
 * 先按基准宽度推导高度，再在长边超过 `MODEL_CAMERA_MAX_CAPTURE_DIMENSION` 时等比收缩。
 */
export function modelCameraAspectSize(
  aspect: ModelCameraAspect | undefined,
  baseWidth = 1280
): { width: number; height: number } {
  const ratio = modelCameraAspectRatio(aspect);
  const width = Math.max(1, Math.round(baseWidth));
  const height = Math.max(1, Math.round(width / ratio));
  const longest = Math.max(width, height);
  if (longest <= MODEL_CAMERA_MAX_CAPTURE_DIMENSION) return { width, height };
  const scale = MODEL_CAMERA_MAX_CAPTURE_DIMENSION / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}
