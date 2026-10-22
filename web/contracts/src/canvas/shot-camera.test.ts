/**
 * 镜头取景数学测试
 * （change: add-model-editor-gizmo-shot-capture，任务 3.1 / design D3）。
 *
 * 覆盖：固定 45° 仰角、AABB 自动 fit、距离 clamp 边界、正交取景尺寸随距离缩放、
 * 方位环/距离手柄拖动、退化回退。
 */
import { describe, expect, it } from "vitest";
import {
  azimuthFromHorizontalDrag,
  clampShotDistance,
  clampShotElevation,
  distanceFromDrag,
  elevationFromVerticalDrag,
  shotDistanceFromScale,
  shotDistanceFromWheel,
  resolveShotCamera,
  shotBoundingRadius,
  shotCameraForward,
  shotCameraRight,
  shotDistanceBounds,
  shotFitDistance,
  shotFocusPlaneHeight,
  SHOT_CAMERA_ELEVATION,
  SHOT_CAMERA_ELEVATION_LIMIT,
  SHOT_CAMERA_FOV
} from "./shot-camera.js";
import { SHOT_CAMERA_DEFAULT_ELEVATION } from "./model-cameras.js";
import type { Aabb } from "./model-transform.js";

const BOX: Aabb = { min: [-1, -1, -1], max: [1, 1, 1] };

describe("shotFitDistance / distance clamp", () => {
  it("包围球越大 fit 距离越大", () => {
    expect(shotFitDistance(2)).toBeGreaterThan(shotFitDistance(1));
  });

  it("退化 radius/aspect 回退为有限正值", () => {
    expect(shotFitDistance(0)).toBeGreaterThan(0);
    expect(Number.isFinite(shotFitDistance(Number.NaN, Number.NaN))).toBe(true);
  });

  it("distance 范围下限放开到可贴近，上限 max(fit*2.2,2.4)", () => {
    const fit = 10;
    const bounds = shotDistanceBounds(fit);
    expect(bounds.min).toBeCloseTo(0.2, 6);
    expect(bounds.max).toBeCloseTo(22, 6);
    // 极小 fit 时落到绝对最小边界。
    const small = shotDistanceBounds(0.01);
    expect(small.min).toBe(0.01);
    expect(small.max).toBe(2.4);
  });

  it("clampShotDistance 钳制到边界，非有限值回退 fit", () => {
    expect(clampShotDistance(0, 10)).toBeCloseTo(0.2, 6);
    expect(clampShotDistance(999, 10)).toBeCloseTo(22, 6);
    expect(clampShotDistance(Number.NaN, 10)).toBe(10);
  });
});

describe("resolveShotCamera", () => {
  it("focus 取 AABB 中心，仰角默认 45°", () => {
    const camera = resolveShotCamera(BOX, { azimuth: 0, distance: 100 });
    expect(camera).not.toBeNull();
    if (!camera) return;
    expect(camera.focus).toEqual([0, 0, 0]);
    expect(camera.elevation).toBeCloseTo(SHOT_CAMERA_ELEVATION, 9);
    // 相机在 focus 上方（固定 45°）。
    expect(camera.position[1]).toBeGreaterThan(camera.focus[1]);
    // 距离被 clamp 进合法范围。
    const bounds = shotDistanceBounds(shotFitDistance(shotBoundingRadius(BOX)));
    expect(camera.distance).toBeLessThanOrEqual(bounds.max + 1e-9);
    expect(camera.distance).toBeGreaterThanOrEqual(bounds.min - 1e-9);
  });

  it("可变仰角：0° 水平、+90° 正上方、-90° 正下方，并钳入奇点容差（change: add-shot-camera-elevation-control）", () => {
    const horizontal = resolveShotCamera(BOX, { azimuth: 0, distance: 5, elevation: 0 })!;
    expect(horizontal.position[1]).toBeCloseTo(horizontal.focus[1], 6);
    expect(horizontal.position[2]).toBeGreaterThan(horizontal.focus[2]);

    // 纯 +Y 与 -Y 方向（azimuth=0；elevation 被钳到 ±89°，仍严格向上/向下，水平偏移很小）。
    const up = resolveShotCamera(BOX, { azimuth: 0, distance: 5, elevation: Math.PI / 2 })!;
    expect(up.position[1]).toBeGreaterThan(up.focus[1]);
    expect(Math.abs(up.position[2] - up.focus[2])).toBeLessThan(0.2);
    const down = resolveShotCamera(BOX, { azimuth: 0, distance: 5, elevation: -Math.PI / 2 })!;
    expect(down.position[1]).toBeLessThan(down.focus[1]);

    // 越界姿态被钳到容差内。
    expect(clampShotElevation(9)).toBeCloseTo(SHOT_CAMERA_ELEVATION_LIMIT, 9);
    expect(clampShotElevation(-9)).toBeCloseTo(-SHOT_CAMERA_ELEVATION_LIMIT, 9);
    const clamped = resolveShotCamera(BOX, { azimuth: 0, distance: 5, elevation: 9 })!;
    expect(clamped.elevation).toBeCloseTo(SHOT_CAMERA_ELEVATION_LIMIT, 9);
    // 缺省仍为 45°。
    expect(resolveShotCamera(BOX, { azimuth: 0, distance: 5 })!.elevation).toBeCloseTo(SHOT_CAMERA_DEFAULT_ELEVATION, 9);
  });

  it("方位角决定相机绕 focus 的水平方向", () => {
    const north = resolveShotCamera(BOX, { azimuth: 0, distance: 5 })!;
    const east = resolveShotCamera(BOX, { azimuth: Math.PI / 2, distance: 5 })!;
    expect(north.position[2]).toBeGreaterThan(0); // az=0 → +Z
    expect(Math.abs(north.position[0])).toBeLessThan(1e-9);
    expect(east.position[0]).toBeGreaterThan(0); // az=90° → +X
  });

  it("退化/非有限 AABB 返回 null", () => {
    expect(resolveShotCamera({ min: [Number.NaN, 0, 0], max: [1, 1, 1] }, { azimuth: 0, distance: 5 })).toBeNull();
  });

  it("focusOffset 加到 AABB 中心；缺省/非法回退到中心（change: 模型编辑 gizmo 焦点）", () => {
    const offset = resolveShotCamera(BOX, { azimuth: 0, distance: 100, focusOffset: { x: 3, y: 4, z: -2 } })!;
    expect(offset.focus).toEqual([3, 4, -2]);
    // 相机绕偏移后的 focus 环绕（position = focus + dir*distance）。
    expect(offset.position[0]).toBeCloseTo(3, 6);
    // 缺省与全零一致。
    const base = resolveShotCamera(BOX, { azimuth: 0, distance: 100 })!;
    const zero = resolveShotCamera(BOX, { azimuth: 0, distance: 100, focusOffset: { x: 0, y: 0, z: 0 } })!;
    expect(zero.focus).toEqual(base.focus);
    // 非有限 offset 回退到中心（不产生 NaN）。
    const bad = resolveShotCamera(BOX, { azimuth: 0, distance: 100, focusOffset: { x: Number.NaN, y: 0, z: 0 } })!;
    expect(bad.focus).toEqual(base.focus);
  });

  it("透视焦点平面高度随距离线性缩放，FOV 固定", () => {
    const near = shotFocusPlaneHeight(10);
    const far = shotFocusPlaneHeight(20);
    expect(far).toBeCloseTo(near * 2, 6);
    expect(shotFocusPlaneHeight(10)).toBeCloseTo(2 * 10 * Math.tan(SHOT_CAMERA_FOV / 2), 6);
    expect(resolveShotCamera(BOX, { azimuth: 0.6, distance: 5 })!.fov).toBeCloseTo(SHOT_CAMERA_FOV, 9);
  });

  it("forward 指向 focus，right 与 up 正交", () => {
    const camera = resolveShotCamera(BOX, { azimuth: 0.6, distance: 5 })!;
    const forward = shotCameraForward(camera);
    const right = shotCameraRight(camera);
    const dot = forward[0] * right[0] + forward[1] * right[1] + forward[2] * right[2];
    expect(dot).toBeCloseTo(0, 6);
    // forward 的 y 分量为负（从上往下看焦点）。
    expect(forward[1]).toBeLessThan(0);
  });
});

describe("拖动", () => {
  it("方位环：一屏对应一周", () => {
    expect(azimuthFromHorizontalDrag(0, 100, 100)).toBeCloseTo(Math.PI * 2, 9);
    expect(azimuthFromHorizontalDrag(0, 50, 100)).toBeCloseTo(Math.PI, 9);
    // 退化宽度回退为 1，不产生 NaN。
    expect(Number.isFinite(azimuthFromHorizontalDrag(0, 10, 0))).toBe(true);
  });

  it("竖直半圆：向上增、向下减并钳入容差（change: add-shot-camera-elevation-control）", () => {
    // 一屏对应 180°：0.5 起始，向上 25%（-25px）= +45°。
    expect(elevationFromVerticalDrag(0.5, -25, 100)).toBeCloseTo(0.5 + Math.PI / 4, 9);
    // 向下拖减小。
    expect(elevationFromVerticalDrag(0.5, 25, 100)).toBeCloseTo(0.5 - Math.PI / 4, 9);
    // 越界被钳到奇点容差。
    expect(elevationFromVerticalDrag(0, -1000, 100)).toBeCloseTo(SHOT_CAMERA_ELEVATION_LIMIT, 9);
    expect(elevationFromVerticalDrag(0, 1000, 100)).toBeCloseTo(-SHOT_CAMERA_ELEVATION_LIMIT, 9);
    // 退化高度回退为 1，不产生 NaN。
    expect(Number.isFinite(elevationFromVerticalDrag(0, 10, 0))).toBe(true);
  });

  it("距离手柄：朝 focus 方向（向下）拉近、反向推远，且 clamp", () => {
    const fit = shotFitDistance(1);
    const base = clampShotDistance(5, fit);
    const towardFocus = distanceFromDrag({ startDistance: base, deltaPixels: 50, surfaceHeight: 720, fitDistance: fit });
    const away = distanceFromDrag({ startDistance: base, deltaPixels: -50, surfaceHeight: 720, fitDistance: fit });
    expect(towardFocus).toBeLessThan(base);
    expect(away).toBeGreaterThan(base);
    const bounds = shotDistanceBounds(fit);
    expect(towardFocus).toBeGreaterThanOrEqual(bounds.min - 1e-9);
    expect(away).toBeLessThanOrEqual(bounds.max + 1e-9);
  });

  it("主画面滚轮向下推远、向上拉近，并停在 fit 边界", () => {
    const fit = shotFitDistance(1);
    const base = clampShotDistance(fit, fit);
    const farther = shotDistanceFromWheel({ distance: base, deltaY: 80, deltaMode: 0, fitDistance: fit });
    const closer = shotDistanceFromWheel({ distance: base, deltaY: -80, deltaMode: 0, fitDistance: fit });
    expect(farther).toBeGreaterThan(base);
    expect(closer).toBeLessThan(base);
    const bounds = shotDistanceBounds(fit);
    const pinned = shotDistanceFromWheel({ distance: base, deltaY: -10_000, deltaMode: 0, fitDistance: fit });
    expect(pinned).toBeCloseTo(bounds.min, 6);
    expect(Number.isFinite(shotDistanceFromWheel({ distance: Number.NaN, deltaY: 10, deltaMode: 0, fitDistance: fit }))).toBe(true);
  });

  it("捏合分开手指缩短 distance", () => {
    const fit = shotFitDistance(1);
    const base = clampShotDistance(fit * 1.4, fit);
    const closer = shotDistanceFromScale({ distance: base, scale: 1.2, fitDistance: fit });
    expect(closer).toBeLessThan(base);
    expect(shotDistanceFromScale({ distance: base, scale: 0, fitDistance: fit })).toBeCloseTo(base, 6);
  });
});
