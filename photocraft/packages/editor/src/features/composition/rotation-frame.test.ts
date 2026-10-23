import { expect, it } from "vitest";
import {
  isValidRotationAngle,
  normalizeRotationAngle,
  pointerAngle,
  rotationAngleFromPointer,
  rotationFootprint
} from "./rotation-frame.js";
import { rotatedCanvasSize } from "./workflows.js";

const size = { width: 40, height: 30 };

it("预览复用界面提示的尺寸式，0/90/180 退化为原尺寸", () => {
  expect(rotatedCanvasSize(size, 0)).toEqual({ width: 40, height: 30 });
  expect(rotatedCanvasSize(size, 90)).toEqual({ width: 30, height: 40 });
  expect(rotatedCanvasSize(size, 180)).toEqual({ width: 40, height: 30 });
  // 预览的尺寸直接取界面提示那一份，避免两套判据。
  for (const degrees of [0, 0.5, 12.5, 45, 179, 359.5, -33]) {
    expect(rotationFootprint(size, degrees).size).toEqual(rotatedCanvasSize(size, degrees));
  }
});

it("45° 按外接矩形扩张并向上取整", () => {
  const next = rotatedCanvasSize(size, 45);
  // 40·cos45 + 30·sin45 ≈ 49.497…
  expect(next).toEqual({ width: 50, height: 50 });
});

it("角点绕新画布中心旋转，中心与新旧画布中心重合", () => {
  const footprint = rotationFootprint(size, 0);
  expect(footprint.size).toEqual({ width: 40, height: 30 });
  expect(footprint.corners[0]).toEqual({ x: 0, y: 0 });
  expect(footprint.corners[2]).toEqual({ x: 40, y: 30 });
  expect(footprint.offset).toEqual({ x: 0, y: 0 });

  const square = rotationFootprint({ width: 40, height: 40 }, 90);
  // 90° 后画布不扩张，左上角转到右上角。
  expect(square.size).toEqual({ width: 40, height: 40 });
  expect(square.corners[0].x).toBeCloseTo(40, 6);
  expect(square.corners[0].y).toBeCloseTo(0, 6);
  expect(square.corners[1].x).toBeCloseTo(40, 6);
  expect(square.corners[1].y).toBeCloseTo(40, 6);
});

it("角度归一到 (-180, 180] 且 180 不变成 -180", () => {
  expect(normalizeRotationAngle(0)).toBe(0);
  expect(normalizeRotationAngle(360)).toBe(0);
  expect(normalizeRotationAngle(180)).toBe(180);
  expect(normalizeRotationAngle(-180)).toBe(180);
  expect(normalizeRotationAngle(190)).toBeCloseTo(-170, 9);
  expect(normalizeRotationAngle(-190)).toBeCloseTo(170, 9);
  expect(normalizeRotationAngle(Number.NaN)).toBe(0);
  // `-0` 归一成 `0`，避免界面上出现「-0.0°」。
  expect(Object.is(normalizeRotationAngle(-0), 0)).toBe(true);
});

it("角度范围与内核一致：|angle| < 360，非法值不提交", () => {
  expect(isValidRotationAngle(0)).toBe(true);
  expect(isValidRotationAngle(359.99)).toBe(true);
  expect(isValidRotationAngle(-359.99)).toBe(true);
  expect(isValidRotationAngle(360)).toBe(false);
  expect(isValidRotationAngle(Number.NaN)).toBe(false);
  expect(isValidRotationAngle(Number.POSITIVE_INFINITY)).toBe(false);
});

it("指针角度以画布中心为原点、顺时针为正（y 向下）", () => {
  expect(pointerAngle({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0, 9);
  expect(pointerAngle({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(90, 9);
  expect(pointerAngle({ x: 0, y: 0 }, { x: -10, y: 0 })).toBeCloseTo(180, 9);
});

it("拖动按增量给角度，可从任意位置起拖并吸附", () => {
  const center = { x: 50, y: 50 };
  const above = { x: 50, y: 0 };
  const right = { x: 100, y: 50 };
  // 从正上方拖到正右方 = 顺时针 90°。
  expect(rotationAngleFromPointer(center, right, {
    startAngle: 0,
    startPointerAngle: pointerAngle(center, above)
  })).toBeCloseTo(90, 9);
  // 起拖位置不在 0° 也不影响结果：增量才是角度。
  expect(rotationAngleFromPointer(center, right, {
    startAngle: 12,
    startPointerAngle: pointerAngle(center, above)
  })).toBeCloseTo(102, 9);
  // 吸附到 15° 网格：raw ≈ 92.3° → 90°。
  expect(rotationAngleFromPointer(center, { x: 100, y: 52 }, {
    startAngle: 0,
    startPointerAngle: pointerAngle(center, above),
    snap: 15
  })).toBeCloseTo(90, 9);
});
