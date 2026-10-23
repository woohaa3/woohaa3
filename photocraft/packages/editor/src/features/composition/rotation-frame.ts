/**
 * 任意角度整图旋转的纯几何（U52）。
 *
 * 与 `rotateArbitraryParams` 分开：那里只产出命令参数，这里算**预览**用的新画布尺寸、
 * 原始画布在新画布里的四个角，以及把指针位置换算成角度。尺寸式只有一份——`workflows.ts`
 * 的 `rotatedCanvasSize`（与内核 `mode_cmds::rotated_size` 同式），本文件直接复用，
 * 避免预览与提示两套判据。
 *
 * 与内核同一约定：上游 `image.rotation.arbitrary` 以**旧画布中心**为旋转中心，画布扩张到
 * `rotated_size`，内容居中放进新画布。
 */

import { rotatedCanvasSize } from "./workflows.js";

export type RotationPoint = { x: number; y: number };
export type RotationRect = { x: number; y: number; width: number; height: number };

const EPSILON = 1e-6;

/** 把角度归一到 `(-180, 180]`。 */
export function normalizeRotationAngle(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  let angle = ((degrees + 180) % 360 + 360) % 360 - 180;
  if (angle <= -180 + EPSILON) angle = 180;
  return Object.is(angle, -0) ? 0 : angle;
}

/** 角度是否被 `image.rotation.arbitrary` 接受（`|angle| < 360`，且不必为整）。 */
export function isValidRotationAngle(degrees: number): boolean {
  return Number.isFinite(degrees) && Math.abs(degrees) < 360;
}

export type RotationFootprint = {
  /** 旋转后的画布尺寸。 */
  size: { width: number; height: number };
  /** 旧画布在新画布坐标系里的位置（居中，可能带 `0.5` 的半像素偏移）。 */
  rect: RotationRect;
  /** 旧画布的四个角在新画布坐标系里：左上、右上、右下、左下。 */
  corners: [RotationPoint, RotationPoint, RotationPoint, RotationPoint];
  /** 新旧画布中心之差；旋转围绕旧中心，因此内容整体落在新画布中心。 */
  offset: RotationPoint;
};

/** 整图旋转后的画面几何：新画布尺寸 + 旧画布在新画布里的四角。 */
export function rotationFootprint(size: { width: number; height: number }, degrees: number): RotationFootprint {
  const next = rotatedCanvasSize(size, degrees);
  const offset = { x: (next.width - size.width) / 2, y: (next.height - size.height) / 2 };
  const radians = (degrees * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  // 旧画布中心既是旋转中心，也是新画布中心。
  const center = { x: next.width / 2, y: next.height / 2 };
  const halfWidth = size.width / 2;
  const halfHeight = size.height / 2;
  const rotate = ([x, y]: [number, number]): RotationPoint => ({
    x: center.x + x * cos - y * sin,
    y: center.y + x * sin + y * cos
  });
  return {
    size: next,
    rect: { x: offset.x, y: offset.y, width: size.width, height: size.height },
    corners: [
      rotate([-halfWidth, -halfHeight]),
      rotate([halfWidth, -halfHeight]),
      rotate([halfWidth, halfHeight]),
      rotate([-halfWidth, halfHeight])
    ],
    offset
  };
}

/**
 * 把指针位置换算成绕画布中心的旋转角度（度，`(-180, 180]`）。
 *
 * `pointer` 与 `center` 都在**屏幕**坐标系时也能用：只要两者同一坐标系，差值就够。
 * `startAngle` 是按下时的角度，`startPointerAngle` 是按下时的指针角度；用增量而不是绝对
 * 位置，这样从任何位置起拖都连续。
 */
export function rotationAngleFromPointer(
  center: RotationPoint,
  pointer: RotationPoint,
  options: { startAngle?: number; startPointerAngle?: number; snap?: number } = {}
): number {
  const pointerAngle = (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI;
  const delta = pointerAngle - (options.startPointerAngle ?? pointerAngle);
  const raw = (options.startAngle ?? 0) + delta;
  const snapped = options.snap && options.snap > 0 ? Math.round(raw / options.snap) * options.snap : raw;
  return normalizeRotationAngle(snapped);
}

/** 指针角度（度）：按下时记一次，拖动时只比增量。 */
export function pointerAngle(center: RotationPoint, pointer: RotationPoint): number {
  return (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI;
}
