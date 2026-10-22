/**
 * 模型聚焦：数值钳制
 * （自 `model-focus.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R24）。
 */
import {
  FOCUS_ZOOM_IN_RADIUS_FACTOR,
  MODEL_FOCUS_MAX_DISTANCE,
  MODEL_FOCUS_MAX_FLY_SPEED,
  MODEL_FOCUS_MIN_DISTANCE,
  MODEL_FOCUS_MIN_FLY_SPEED,
  MODEL_FOCUS_PITCH_LIMIT
} from "./types.js";

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 归一化 yaw（弧度，落在 [-PI, PI]）。 */
export function normalizeYaw(yaw: number): number {
  let value = yaw % (2 * Math.PI);
  if (value > Math.PI) value -= 2 * Math.PI;
  if (value < -Math.PI) value += 2 * Math.PI;
  return value;
}

/** 钳制 pitch 到奇点以内。 */
export function clampPitch(pitch: number): number {
  return clamp(pitch, -MODEL_FOCUS_PITCH_LIMIT, MODEL_FOCUS_PITCH_LIMIT);
}

/**
 * 聚焦距离下限：相机可进入包围球内部，但不低于近裁剪面余量。
 */
export function focusDistanceFloor(radius: number): number {
  const safe = Number.isFinite(radius) && radius > 0 ? radius : 0;
  return Math.max(MODEL_FOCUS_MIN_DISTANCE, safe * FOCUS_ZOOM_IN_RADIUS_FACTOR);
}

export function clampDistance(distance: number, radius = 0): number {
  const min = focusDistanceFloor(radius);
  const max = Math.max(MODEL_FOCUS_MAX_DISTANCE, min);
  return clamp(distance, min, max);
}

export function clampFlySpeed(speed: number): number {
  return clamp(speed, MODEL_FOCUS_MIN_FLY_SPEED, MODEL_FOCUS_MAX_FLY_SPEED);
}
