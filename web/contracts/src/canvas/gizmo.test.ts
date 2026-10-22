/**
 * 编辑 gizmo 投影与命中测试
 * （change: add-model-editor-gizmo-shot-capture，任务 2.2 / 3.2）。
 */
import { describe, expect, it } from "vitest";
import {
  distanceToSegment,
  focusAxisDragWorldDelta,
  focusGizmoGeometry,
  hitFocusGizmo,
  hitModelGizmo,
  hitShotGizmo,
  makeFocusProjector,
  makeShotProjector,
  modelGizmoGeometry,
  rotateY,
  shotElevationSemicirclePoints,
  shotGizmoGeometry,
  shotOrbitPoints,
  yawRingPoints,
  FOCUS_GIZMO_AXIS_HIT_CSS,
  MODEL_GIZMO_CENTER_HIT_CSS,
  SHOT_ELEVATION_RING_HIT_CSS,
  SHOT_ORIGIN_HIT_RADIUS_CSS,
  SHOT_RING_HIT_RADIUS_CSS
} from "./gizmo.js";
import { MODEL_FOCUS_FOV } from "./model-focus.js";
import { resolveShotCamera, shotBoundingRadius, shotFitDistance } from "./shot-camera.js";
import type { Aabb } from "./model-transform.js";

const BOX: Aabb = { min: [-1, -1, -1], max: [1, 1, 1] };
const SURFACE = { width: 1000, height: 800 };

describe("distanceToSegment", () => {
  it("点到线段最短距离", () => {
    expect(distanceToSegment({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0, 9);
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3, 9);
    expect(distanceToSegment({ x: -4, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(4, 9);
  });
});

describe("焦点三轴 gizmo（change: 模型编辑 gizmo 焦点）", () => {
  // 俯视 + Y 映射投影器：x→右、z→下、y→上（屏幕 y 向下取负）。
  const project = (world: [number, number, number]) => ({ x: world[0] * 50 + 500, y: 400 - world[1] * 50 + world[2] * 10 });

  it("命中 X/Y/Z 轴", () => {
    const geometry = focusGizmoGeometry({ focus: [0, 0, 0], radius: 2 });
    const length = geometry.axisLength;
    expect(hitFocusGizmo({ pointer: project([length / 2, 0, 0]), geometry, project })?.axis).toBe("x");
    expect(hitFocusGizmo({ pointer: project([0, length / 2, 0]), geometry, project })?.axis).toBe("y");
    expect(hitFocusGizmo({ pointer: project([0, 0, length / 2]), geometry, project })?.axis).toBe("z");
  });

  it("远超阈值不命中", () => {
    const geometry = focusGizmoGeometry({ focus: [0, 0, 0], radius: 2 });
    expect(hitFocusGizmo({ pointer: { x: 900, y: 100 }, geometry, project })).toBeNull();
  });

  it("focusGizmoGeometry 半径非法回退 1", () => {
    const geometry = focusGizmoGeometry({ focus: [1, 2, 3], radius: Number.NaN });
    expect(geometry.axisLength).toBeCloseTo(1.15, 9);
    expect(geometry.origin).toEqual([1, 2, 3]);
  });

  it("focusAxisDragWorldDelta 把屏幕位移投影到轴并按比例换算", () => {
    expect(
      focusAxisDragWorldDelta({
        axis: "x",
        deltaScreen: { x: 50, y: 0 },
        axisStart: { x: 0, y: 0 },
        axisEnd: { x: 100, y: 0 },
        axisLength: 10
      })
    ).toBeCloseTo(5, 9); // 50px * (10/100)
    // 垂直位移在该轴上无分量。
    expect(
      focusAxisDragWorldDelta({ axis: "x", deltaScreen: { x: 0, y: 40 }, axisStart: { x: 0, y: 0 }, axisEnd: { x: 100, y: 0 }, axisLength: 10 })
    ).toBeCloseTo(0, 9);
    // 退化线段返回 null。
    expect(
      focusAxisDragWorldDelta({ axis: "x", deltaScreen: { x: 10, y: 0 }, axisStart: { x: 5, y: 5 }, axisEnd: { x: 5, y: 5 }, axisLength: 10 })
    ).toBeNull();
  });

  it("轴命中阈值常量用于判定", () => {
    const geometry = focusGizmoGeometry({ focus: [0, 0, 0], radius: 2 });
    const length = geometry.axisLength;
    const xMid = project([length / 2, 0, 0]);
    const just = hitFocusGizmo({ pointer: { x: xMid.x, y: xMid.y + FOCUS_GIZMO_AXIS_HIT_CSS - 1 }, geometry, project });
    expect(just?.axis).toBe("x");
  });
});

describe("模型 gizmo 命中", () => {
  const geometry = modelGizmoGeometry({ focus: [0, 0, 0], radius: 2 });
  // 俯视投影器：直接把 XZ 平面映射到屏幕。
  const project = (world: [number, number, number]) => ({ x: world[0] * 50 + 500, y: world[2] * 50 + 400 });

  it("中心点命中 center", () => {
    const hit = hitModelGizmo({ pointer: { x: 500, y: 400 }, geometry, project });
    expect(hit?.handle).toBe("center");
  });

  it("环上命中 yaw-ring，环外超出阈值不命中", () => {
    const ringPoint = yawRingPoints(geometry, 8)[0]!;
    const screen = project(ringPoint);
    const hit = hitModelGizmo({ pointer: screen, geometry, project });
    expect(hit?.handle).toBe("yaw-ring");
    // 远离 gizmo 不命中。
    expect(hitModelGizmo({ pointer: { x: 900, y: 100 }, geometry, project })).toBeNull();
  });

  it("中心阈值边界", () => {
    const hit = hitModelGizmo({
      pointer: { x: 500 + MODEL_GIZMO_CENTER_HIT_CSS - 1, y: 400 },
      geometry,
      project
    });
    expect(hit?.handle).toBe("center");
    const miss = hitModelGizmo({
      pointer: { x: 500 + MODEL_GIZMO_CENTER_HIT_CSS + 5, y: 400 },
      geometry,
      project
    });
    expect(miss?.handle).not.toBe("center");
  });
});

describe("shot gizmo 命中", () => {
  const radius = shotBoundingRadius(BOX);
  const camera = resolveShotCamera(BOX, { azimuth: 0.4, distance: shotFitDistance(radius) * 1.4 })!;
  const geometry = shotGizmoGeometry({
    focus: camera.focus,
    cameraPosition: camera.position,
    distance: camera.distance,
    radius
  });
  const project = makeShotProjector({
    focus: camera.focus,
    cameraPosition: camera.position,
    fov: camera.fov,
    surface: SURFACE
  });

  it("镜头原点命中 shot-origin", () => {
    const origin = project(geometry.cameraPosition)!;
    const hit = hitShotGizmo({ pointer: origin, geometry, project });
    expect(hit?.handle).toBe("shot-origin");
  });

  it("远离 gizmo 不命中", () => {
    // 取原点与焦点投影都远离的位置。
    const origin = project(geometry.cameraPosition)!;
    const focus = project(geometry.focus)!;
    const far = { x: origin.x + 400, y: origin.y + 400 };
    expect(Math.hypot(far.x - focus.x, far.y - focus.y)).toBeGreaterThan(SHOT_RING_HIT_RADIUS_CSS);
    expect(hitShotGizmo({ pointer: far, geometry, project })).toBeNull();
  });

  it("阈值常量符合 design D3", () => {
    expect(SHOT_ORIGIN_HIT_RADIUS_CSS).toBe(36);
    expect(SHOT_RING_HIT_RADIUS_CSS).toBe(28);
    expect(SHOT_ELEVATION_RING_HIT_CSS).toBeGreaterThan(0);
  });

  it("竖直半圆几何：端点 ±90°、水平中点在 focus 高度、半径与方位环一致", () => {
    const points = shotElevationSemicirclePoints(geometry, 4);
    expect(points).toHaveLength(5);
    const first = points[0]!;
    const last = points[4]!;
    // 端点分别在 focus 正下方与正上方。
    expect(first[1]).toBeLessThan(geometry.focus[1]);
    expect(last[1]).toBeGreaterThan(geometry.focus[1]);
    // 中点（index 2）位于水平面。
    const mid = points[2]!;
    expect(mid[1]).toBeCloseTo(geometry.focus[1], 6);
  });

  it("球笼半径不随仰角缩放：环/弧半径为相机到焦点的完整距离（change: add-shot-camera-elevation-control）", () => {
    for (const elevationDeg of [0, 30, 45, 75]) {
      const elevation = (elevationDeg * Math.PI) / 180;
      const cam = resolveShotCamera(BOX, {
        azimuth: 0.4,
        elevation,
        distance: shotFitDistance(radius) * 1.4,
        aspect: "16:9"
      })!;
      const geo = shotGizmoGeometry({
        focus: cam.focus,
        cameraPosition: cam.position,
        distance: cam.distance,
        radius
      });
      // 赤道环与竖直半圆的半径都应等于完整距离，且与仰角无关。
      const equator = shotOrbitPoints(geo, 12)[0]!;
      expect(Math.hypot(equator[0]! - geo.focus[0], equator[2]! - geo.focus[2])).toBeCloseTo(cam.distance, 4);
      const arcPoint = shotElevationSemicirclePoints(geo, 12)[6]!;
      const arcRadius = Math.hypot(
        Math.hypot(arcPoint[0]! - geo.focus[0], arcPoint[2]! - geo.focus[2]),
        arcPoint[1]! - geo.focus[1]
      );
      expect(arcRadius).toBeCloseTo(cam.distance, 4);
      // 相机本身落在竖直半圆上。
      const camRadius = Math.hypot(
        Math.hypot(cam.position[0]! - geo.focus[0], cam.position[2]! - geo.focus[2]),
        cam.position[1]! - geo.focus[1]
      );
      expect(camRadius).toBeCloseTo(cam.distance, 4);
    }
  });

  it("命中竖直半圆返回 elevation-ring（change: add-shot-camera-elevation-control）", () => {
    const points = shotElevationSemicirclePoints(geometry, 8);
    // 取靠近 focus 上方附近的一段屏幕中点，避免与水平环/原点重叠。
    const sample = points[5]!;
    const screen = project(sample)!;
    const hit = hitShotGizmo({ pointer: screen, geometry, project });
    expect(hit?.handle).toBe("elevation-ring");
  });
});

describe("聚焦透视投影器", () => {
  const camera = { target: [0, 0, 0] as [number, number, number], yaw: 0, pitch: 0, distance: 10, flySpeed: 6 };
  const project = makeFocusProjector({ camera, surface: SURFACE, fov: MODEL_FOCUS_FOV });

  it("焦点投影到屏幕中心", () => {
    const center = project([0, 0, 0])!;
    expect(center.x).toBeCloseTo(SURFACE.width / 2, 3);
    expect(center.y).toBeCloseTo(SURFACE.height / 2, 3);
  });

  it("相机后方点不可投影", () => {
    expect(project([0, 0, 999])).toBeNull();
  });
});

describe("rotateY", () => {
  it("绕 Y 轴旋转 90° 交换 X/Z", () => {
    const rotated = rotateY([1, 0, 0], Math.PI / 2);
    expect(rotated[0]).toBeCloseTo(0, 9);
    expect(rotated[2]).toBeCloseTo(-1, 9);
  });
});
