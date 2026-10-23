/**
 * 笔迹点的线编码
 * （change: 2026-10-22-add-photocraft-painting-color-workflows，U31）。
 *
 * 内核 `parse_points` 接受
 * `[x, y, pressure?, tiltX?, tiltY?, rotation?, timeMs?, wheel?]`：
 *
 * | 下标 | 含义 | 缺省 |
 * | --- | --- | --- |
 * | 0/1 | 源坐标 | 必填 |
 * | 2 | 压力 0–1 | 1 |
 * | 3/4 | 倾斜角（度，W3C `pointer` 约定 −90–90） | 0 |
 * | 5 | 笔杆旋转（度 0–360） | 0 |
 * | 6 | 事件时间（毫秒） | 0 |
 * | 7 | 滚轮/辅助压力 0–1 | 1 |
 *
 * 两条硬约束：
 *
 * 1. **不能提前占位**：只要写了倾斜就必须先写出压力（否则倾斜会掉进压力槽），这是编码里
 *    最容易错的一处；
 * 2. **缺传感器明确回退**：鼠标与不带倾斜的笔没有这些数据，此时保持短编码（`[x, y]` 或
 *    `[x, y, pressure]`），不补 0 占位、不让内核误以为「笔是垂直的但读了传感器」。
 *
 * 采集这些硬件字段的 pointer 采样在共享 `photo-editor-canvas.tsx`（集成负责人），本模块只负责
 * 把拿到的字段如实编码。
 */
import { clamp, roundPixel, type DocumentPoint } from "../shared/tool-parameters.js";

/**
 * 带可选笔姿态的文档坐标点。
 *
 * 共享 `DocumentPoint` 只有 `x/y/pressure`；倾斜/旋转是绘画域扩展，放在这里而不是改共享类型，
 * 避免影响选区/样式定位等只用二维的调用方。
 */
export type StrokePoint = DocumentPoint & {
  /** 倾斜角，度，−90–90（W3C Pointer Events `tiltX`）。 */
  tiltX?: number;
  /** 倾斜角，度，−90–90（`tiltY`）。 */
  tiltY?: number;
  /** 笔杆旋转，度，0–360（`twist`）。 */
  rotation?: number;
  /** 事件时间，毫秒。 */
  time?: number;
  /** 滚轮/辅助压力，0–1；缺省 1。 */
  wheel?: number;
};

/** 编码后的最大下标 + 1（内核接受的最长形态）。 */
export const STROKE_POINT_ARITY = 8;

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * 一个点是否真的带了笔姿态/时间。
 *
 * 全 0 的倾斜与 0 的旋转就是「没有姿态信息」，按缺传感器处理，保持短编码。
 */
function hasPose(point: StrokePoint): boolean {
  const tiltX = finite(point.tiltX) ?? 0;
  const tiltY = finite(point.tiltY) ?? 0;
  const rotation = finite(point.rotation) ?? 0;
  if (tiltX !== 0 || tiltY !== 0 || rotation !== 0) return true;
  // 显式给出的时间/滚轮只在非缺省时才需要编码。
  return finite(point.time) !== null || (finite(point.wheel) !== null && finite(point.wheel) !== 1);
}

/**
 * 开始与增量采样共用编码：坐标取整，保留压力，并在有笔姿态时按内核顺序补齐槽位。
 *
 * 倾斜超出 −90–90 或旋转超出 0–360 时**收敛**而不是拒绝：这些是硬件读数，越界属于传感器噪声，
 * 整笔作废会让用户正在画的一笔突然消失。非有限值按缺省处理。
 */
export function strokePoints(points: readonly StrokePoint[]): number[][] {
  return points.map((point) => {
    const x = roundPixel(point.x);
    const y = roundPixel(point.y);
    if (!hasPose(point)) {
      return point.pressure === undefined ? [x, y] : [x, y, clamp(point.pressure, 0, 1)];
    }
    // 有姿态：压力必须显式写出，否则后面的姿态字段会整体前移一个槽位。
    const pressure = clamp(finite(point.pressure) ?? 1, 0, 1);
    const tiltX = clamp(finite(point.tiltX) ?? 0, -90, 90);
    const tiltY = clamp(finite(point.tiltY) ?? 0, -90, 90);
    const rotation = clamp(finite(point.rotation) ?? 0, 0, 360);
    const encoded = [x, y, pressure, tiltX, tiltY, rotation];
    const time = finite(point.time);
    const wheel = finite(point.wheel);
    // 时间与滚轮是可选尾巴：只在给出且非缺省时才追加，避免无谓加长每一帧。
    if (time !== null) encoded.push(time);
    else if (wheel !== null && wheel !== 1) encoded.push(0);
    if (wheel !== null && wheel !== 1) encoded.push(clamp(wheel, 0, 1));
    return encoded;
  });
}
