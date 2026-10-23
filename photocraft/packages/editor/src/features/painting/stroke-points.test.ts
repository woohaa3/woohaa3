/**
 * 笔迹点编码的回归（U31 的域内一半）
 * （change: 2026-10-22-add-photocraft-painting-color-workflows）。
 *
 * 内核 `parse_points` 按位置读
 * `[x, y, pressure?, tiltX?, tiltY?, rotation?, timeMs?, wheel?]`，所以最容易错的不是「有没有
 * 传倾斜」，而是**槽位对齐**：一旦写了倾斜却没写压力，倾斜就会掉进压力槽，整笔的压力与姿态
 * 同时错位。这里把槽位、缺省回退与越界收敛逐条钉住。
 */
import { describe, expect, it } from "vitest";
import { STROKE_POINT_ARITY, strokePoints } from "./stroke-points.js";
import { buildStroke } from "./tool-parameters.js";
import { DEFAULT_BRUSH } from "./tool-parameters.js";
import { buildPencil, buildColorReplacement, buildBackgroundEraser, DEFAULT_PENCIL, DEFAULT_COLOR_REPLACEMENT, DEFAULT_BACKGROUND_ERASER } from "./tool-modes.js";

describe("笔迹点编码的槽位", () => {
  it("没有传感器数据时保持短编码", () => {
    expect(strokePoints([{ x: 1, y: 2 }])).toEqual([[1, 2]]);
    expect(strokePoints([{ x: 1, y: 2, pressure: 0.5 }])).toEqual([[1, 2, 0.5]]);
  });

  it("有倾斜时先写压力，倾斜与旋转按内核顺序落在 3–5", () => {
    const [point] = strokePoints([{ x: 3, y: 4, pressure: 0.25, tiltX: 30, tiltY: -20, rotation: 90 }]);
    expect(point).toEqual([3, 4, 0.25, 30, -20, 90]);
    expect(point!.length).toBeLessThanOrEqual(STROKE_POINT_ARITY);
  });

  it("只有旋转也算有姿态，压力缺省为 1", () => {
    expect(strokePoints([{ x: 5, y: 6, rotation: 45 }])).toEqual([[5, 6, 1, 0, 0, 45]]);
  });

  it("全 0 的倾斜/旋转按缺传感器处理，不补占位", () => {
    expect(strokePoints([{ x: 7, y: 8, tiltX: 0, tiltY: 0, rotation: 0 }])).toEqual([[7, 8]]);
    expect(strokePoints([{ x: 7, y: 8, pressure: 0.4, tiltX: 0, tiltY: 0, rotation: 0 }]))
      .toEqual([[7, 8, 0.4]]);
  });

  it("时间与滚轮只在给出且非缺省时追加，且不越过内核长度", () => {
    expect(strokePoints([{ x: 1, y: 1, tiltX: 10, time: 1234 }])).toEqual([[1, 1, 1, 10, 0, 0, 1234]]);
    expect(strokePoints([{ x: 1, y: 1, tiltX: 10, wheel: 0.5 }])).toEqual([[1, 1, 1, 10, 0, 0, 0, 0.5]]);
    expect(strokePoints([{ x: 1, y: 1, tiltX: 10, time: 9, wheel: 0.5 }]))
      .toEqual([[1, 1, 1, 10, 0, 0, 9, 0.5]]);
    // 滚轮缺省 1 不占位。
    expect(strokePoints([{ x: 1, y: 1, tiltX: 10, wheel: 1 }])).toEqual([[1, 1, 1, 10, 0, 0]]);
    for (const encoded of [
      strokePoints([{ x: 1, y: 1, tiltX: 10, time: 9, wheel: 0.5 }])[0]!,
      strokePoints([{ x: 1, y: 1, tiltX: 10, wheel: 0.5 }])[0]!
    ]) expect(encoded.length).toBeLessThanOrEqual(STROKE_POINT_ARITY);
  });

  it("越界硬件读数收敛而不是让整笔作废", () => {
    // 传感器噪声不该让用户正在画的一笔突然消失。
    const [point] = strokePoints([{ x: 1, y: 1, pressure: 2, tiltX: 400, tiltY: -400, rotation: 999 }]);
    expect(point).toEqual([1, 1, 1, 90, -90, 360]);
  });

  it("非有限值按缺省处理", () => {
    expect(strokePoints([{ x: 1, y: 1, tiltX: Number.NaN, tiltY: Number.POSITIVE_INFINITY, rotation: 20 }]))
      .toEqual([[1, 1, 1, 0, 0, 20]]);
  });
});

describe("带姿态的点能穿过各绘画工具的编译", () => {
  const posed = [{ x: 4, y: 5, pressure: 0.5, tiltX: 25, tiltY: 10, rotation: 180 }];

  it("paint.stroke 保留姿态", () => {
    const params = buildStroke(posed, { ...DEFAULT_BRUSH, size: 10 })!;
    expect(params.points).toEqual([[4, 5, 0.5, 25, 10, 180]]);
  });

  it("铅笔、颜色替换、背景橡皮保留姿态", () => {
    expect(buildPencil(posed, DEFAULT_PENCIL)!.points).toEqual([[4, 5, 0.5, 25, 10, 180]]);
    expect(buildColorReplacement(posed, DEFAULT_COLOR_REPLACEMENT, { size: 6, color: "#ff0000" })!.points)
      .toEqual([[4, 5, 0.5, 25, 10, 180]]);
    expect(buildBackgroundEraser(posed, DEFAULT_BACKGROUND_ERASER)!.points)
      .toEqual([[4, 5, 0.5, 25, 10, 180]]);
  });
});
