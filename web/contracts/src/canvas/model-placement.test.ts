/**
 * 聚焦模型 placement 编辑数学测试
 * （change: add-model-focus-editing，任务 1.2）。
 *
 * 覆盖：ray-plane（近平行/负交点）、world delta 逆换算、offset/yaw 手势、scale clamp、
 * placement 相等判定；全部断言有限值与确定性。
 */
import { describe, expect, it } from "vitest";
import {
  beginPlacementDrag,
  cameraForwardVector,
  clampModelScale,
  MODEL_EDIT_YAW_RADIANS_PER_PX,
  MODEL_SCALE_MAX,
  MODEL_SCALE_MIN,
  placementEquals,
  placementOffsetScale,
  placementOffsetToWorldDelta,
  rayPlaneIntersection,
  rayPlanePoint,
  updatePlacementDrag,
  worldDeltaToPlacementOffset,
  type PlacementDraft
} from "./model-placement.js";
import { focusCameraPosition, type ModelFocusCamera } from "./model-focus.js";
import type { Vec3 } from "./model-transform.js";

const surface = { width: 1000, height: 800 };

function camera(overrides: Partial<ModelFocusCamera> = {}): ModelFocusCamera {
  return { target: [0, 0, 0], yaw: 0, pitch: 0, distance: 10, flySpeed: 6, ...overrides };
}

function draft(overrides: Partial<PlacementDraft> = {}): PlacementDraft {
  return { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0, ...overrides };
}

/** 覆盖原点、边长 2 的模型 AABB（屏幕中心处命中）。 */
const unitBounds = { min: [-1, -1, -1] as Vec3, max: [1, 1, 1] as Vec3 };

describe("cameraForwardVector", () => {
  it("yaw=0/pitch=0 时指向 -Z（与 focusCameraPosition 反方向）", () => {
    const cam = camera();
    const forward = cameraForwardVector(cam);
    const position = focusCameraPosition(cam);
    // 相机位于 +Z distance 处、看向原点：forward ≈ (0,0,-1)。
    expect(forward[0]).toBeCloseTo(0, 6);
    expect(forward[1]).toBeCloseTo(0, 6);
    expect(forward[2]).toBeCloseTo(-1, 6);
    expect(position[2]).toBeCloseTo(10, 6);
  });
});

describe("rayPlaneIntersection / rayPlanePoint", () => {
  const ray = { origin: [0, 0, 5] as Vec3, direction: [0, 0, -1] as Vec3 };

  it("正交点返回距离与交点", () => {
    expect(rayPlaneIntersection(ray, [0, 0, 0], [0, 0, 1])).toBeCloseTo(5, 6);
    expect(rayPlanePoint(ray, [0, 0, 0], [0, 0, 1])).toEqual([0, 0, 0]);
  });

  it("近平行返回 null", () => {
    expect(rayPlaneIntersection(ray, [0, 0, 0], [0, 0, 1e-12])).toBeNull();
  });

  it("负交点（平面在射线背后）返回 null", () => {
    expect(rayPlaneIntersection(ray, [0, 0, 10], [0, 0, 1])).toBeNull();
  });
});

describe("offset 换算", () => {
  it("placementOffsetScale = 固定 64（不读取 zoom）", () => {
    expect(placementOffsetScale()).toBe(64);
  });

  it("world delta 与 placement offset 互为逆换算（含固定嵌入旋转）", () => {
    const offset = { x: 0.5, y: -0.25, z: 2 };
    const world = placementOffsetToWorldDelta(offset);
    const back = worldDeltaToPlacementOffset(world);
    expect(back.x).toBeCloseTo(0.5, 9);
    expect(back.y).toBeCloseTo(-0.25, 9);
    expect(back.z).toBeCloseTo(2, 9);
  });

  it("offset 经固定嵌入 R 旋转（不落在单一世界轴）", () => {
    const world = placementOffsetToWorldDelta({ x: 1, y: 0, z: 0 });
    // R 是纯旋转：长度守恒；单位 x 偏移不会只落在单个世界轴上。
    const length = Math.hypot(world[0], world[1], world[2]);
    expect(length).toBeCloseTo(64, 3);
    expect(Math.abs(world[0])).toBeLessThan(64 - 1);
    expect(Math.abs(world[2])).toBeGreaterThan(1);
  });
});

describe("beginPlacementDrag / updatePlacementDrag", () => {
  it("offset 手势在相机朝向平面上连续更新 offset，scale/yaw 不变", () => {
    const cam = camera();
    const start = beginPlacementDrag({
      mode: "offset",
      origin: draft(),
      x: surface.width / 2,
      y: surface.height / 2,
      camera: cam,
      surface,
      bounds: unitBounds
    });
    expect(start).not.toBeNull();
    // 向右下移动：world delta 沿相机平面；offset 应有限且非零。
    const moved = updatePlacementDrag(start!, { x: surface.width / 2 + 64, y: surface.height / 2, camera: cam, surface });
    expect(moved).not.toBeNull();
    expect(moved!.scale).toBe(1);
    expect(moved!.yaw).toBe(0);
    const magnitude = Math.abs(moved!.offset.x) + Math.abs(moved!.offset.y) + Math.abs(moved!.offset.z);
    expect(magnitude).toBeGreaterThan(0);
  });

  it("yaw 手势只用横向像素增量，offset/scale 不变", () => {
    const cam = camera();
    const start = beginPlacementDrag({
      mode: "yaw",
      origin: draft({ offset: { x: 1, y: 2, z: 3 }, scale: 2, yaw: 0 }),
      x: surface.width / 2,
      y: surface.height / 2,
      camera: cam,
      surface,
      bounds: unitBounds
    });
    expect(start).not.toBeNull();
    const moved = updatePlacementDrag(start!, { x: surface.width / 2 + 50, y: 700, camera: cam, surface });
    expect(moved).not.toBeNull();
    // 50 px * 0.02 rad = 1 rad → 度数。
    const expected = (50 * MODEL_EDIT_YAW_RADIANS_PER_PX * 180) / Math.PI;
    expect(moved!.yaw).toBeCloseTo(expected, 6);
    expect(moved!.offset).toEqual({ x: 1, y: 2, z: 3 });
    expect(moved!.scale).toBe(2);
  });

  it("ray 未命中模型时不开始手势", () => {
    const cam = camera();
    const miss = beginPlacementDrag({
      mode: "offset",
      origin: draft(),
      // 屏幕左上角远离中心模型。
      x: 2,
      y: 2,
      camera: cam,
      surface,
      bounds: { min: [100, 100, -1], max: [110, 110, 1] }
    });
    expect(miss).toBeNull();
  });

  it("非法平面交点跳过采样（保留上一 preview）", () => {
    const cam = camera();
    const start = beginPlacementDrag({
      mode: "offset",
      origin: draft(),
      x: surface.width / 2,
      y: surface.height / 2,
      camera: cam,
      surface,
      bounds: unitBounds
    })!;
    // 相机转向与平面近平行的姿态：平面法线仍为原 forward，但这里把指针 ray 换到侧面很偏处仍应有限；
    // 用 NaN 坐标强制无效。
    const invalid = updatePlacementDrag(start, { x: Number.NaN, y: 0, camera: cam, surface });
    expect(invalid).toBeNull();
  });
});

describe("clampModelScale / placementEquals", () => {
  it("scale clamp 到 0.35..4.0", () => {
    expect(clampModelScale(0.1)).toBe(MODEL_SCALE_MIN);
    expect(clampModelScale(10)).toBe(MODEL_SCALE_MAX);
    expect(clampModelScale(2)).toBe(2);
    expect(clampModelScale(Number.NaN)).toBe(1);
  });

  it("placementEquals 容差判定净变化", () => {
    const a = draft();
    expect(placementEquals(a, draft())).toBe(true);
    expect(placementEquals(a, draft({ yaw: 0.5 }))).toBe(false);
    expect(placementEquals(a, draft({ offset: { x: 1e-9, y: 0, z: 0 } }))).toBe(true);
    expect(placementEquals(a, draft({ scale: 1.001 }))).toBe(false);
  });
});
