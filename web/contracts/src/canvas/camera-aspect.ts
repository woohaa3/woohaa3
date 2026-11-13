/**
 * 动画播放使用的相机画幅与仰角。
 *
 * 模型镜头子资源已删除；这里只保留 motion IR / 播放投影需要的稳定契约。
 */
import { CANVAS_CAMERA_PITCH } from "./model-focus/canvas-projection.js";

export const CAMERA_ASPECTS = [
  "16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9", "4:1", "1:4", "8:1", "1:8"
] as const;
export type CameraAspect = (typeof CAMERA_ASPECTS)[number];
export const DEFAULT_CAMERA_ASPECT: CameraAspect = "16:9";

export const SHOT_CAMERA_MIN_ELEVATION = -Math.PI / 2;
export const SHOT_CAMERA_MAX_ELEVATION = Math.PI / 2;
export const SHOT_CAMERA_DEFAULT_ELEVATION = CANVAS_CAMERA_PITCH;

export function clampCameraElevation(elevation: number): number {
  if (!Number.isFinite(elevation)) return SHOT_CAMERA_DEFAULT_ELEVATION;
  return Math.min(SHOT_CAMERA_MAX_ELEVATION, Math.max(SHOT_CAMERA_MIN_ELEVATION, elevation));
}
