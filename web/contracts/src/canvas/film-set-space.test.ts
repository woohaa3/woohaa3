/**
 * 片场场景空间 ↔ 画布呈现空间回归
 * （change: 2026-10-23-isolate-film-set-camera-space，任务 1.2 / 5.1 / design D2）。
 *
 * 核心断言：同一相似变换下，内容关键点与完整相机姿态的**归一化屏幕投影**在任意正等比显示倍率
 * 下不变；违规变换显式失败。这是纯数学回归，不代替真实 GPU 像素验收。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  filmSetDisplayTransform,
  filmSetDisplayTransformFor,
  filmSetNaturalScale,
  filmSetSceneAabb,
  mapFilmSetSceneCamera,
  mapFilmSetScenePoint,
  mapFilmSetSceneVector,
  mapFilmSetShotPose,
  unmapFilmSetSceneDistance,
  unmapFilmSetSceneVector
} from "./film-set-space.js";
import { CANVAS_UNITS_PER_METER } from "./model-focus/types.js";
import { shotCameraPosition } from "./shot-camera.js";
import type { Vec3 } from "./model-transform.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(here, "../../fixtures/film-set-space.json"), "utf8")) as {
  tolerance: number;
  cases: Array<{
    name: string;
    display: { scale: number; yaw: number };
    boundsCenter: Vec3;
    camera: { azimuth: number; elevation: number; distance: number; focusOffset: Vec3 };
    expected: { distance: number; focusOffset: Vec3; focus: Vec3 };
  }>;
};

describe("片场显示变换 fixture", () => {
  for (const testCase of fixture.cases) {
    it(`${testCase.name}：世界相机与 fixture 一致`, () => {
      const display = filmSetDisplayTransform(testCase.display);
      expect(display.ok).toBe(true);
      if (!display.ok) return;
      const mapped = mapFilmSetSceneCamera(display.value, testCase.boundsCenter, {
        azimuth: testCase.camera.azimuth,
        elevation: testCase.camera.elevation,
        distance: testCase.camera.distance,
        focusOffset: {
          x: testCase.camera.focusOffset[0],
          y: testCase.camera.focusOffset[1],
          z: testCase.camera.focusOffset[2]
        }
      });
      expect(mapped).not.toBeNull();
      if (!mapped) return;
      expect(mapped.distance).toBeCloseTo(testCase.expected.distance, 5);
      for (let axis = 0; axis < 3; axis += 1) {
        expect(mapped.focusOffset[axis]).toBeCloseTo(testCase.expected.focusOffset[axis]!, 5);
        expect(testCase.boundsCenter[axis] + mapped.focusOffset[axis]).toBeCloseTo(
          testCase.expected.focus[axis]!,
          5
        );
      }
    });
  }
});

/** 透视投影的归一化屏幕坐标（x/z, y/z）；相似变换下应不变。 */
function normalizedProjection(eye: Vec3, target: Vec3, point: Vec3): { x: number; y: number } {
  const forward = normalize(sub(target, eye));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const relative = sub(point, eye);
  const depth = dot(relative, forward);
  return { x: dot(relative, right) / depth, y: dot(relative, up) / depth };
}

describe("相似变换保持构图不变", () => {
  const sceneCenter: Vec3 = [1.5, 0.85, -0.4];
  const scenePoints: Vec3[] = [
    [0, 0, 0],
    [0.235, 1.365, -0.025],
    [-0.8, 1.7, 0.6],
    [1.1, 2.73, -0.9]
  ];
  const camera = { azimuth: 0.35, elevation: 0.22, distance: 2.65, focusOffset: { x: 0.2, y: 0.1, z: 0 } };

  it("同一镜头在 0.1×–8× 容器倍率下投影一致（含旋转）", () => {
    const baseline = (() => {
      const display = filmSetDisplayTransform({ scale: 1, yaw: 0 });
      if (!display.ok) throw new Error(display.reason);
      const mapped = mapFilmSetSceneCamera(display.value, sceneCenter, camera);
      if (!mapped) throw new Error("map failed");
      const focus: Vec3 = [
        sceneCenter[0] + mapped.focusOffset[0],
        sceneCenter[1] + mapped.focusOffset[1],
        sceneCenter[2] + mapped.focusOffset[2]
      ];
      const eye = shotCameraPosition(focus, camera.azimuth, mapped.distance, camera.elevation);
      return { eye, focus, points: scenePoints.map((point) => normalizedProjection(eye, focus, point)) };
    })();
    for (const scale of [0.1, 0.25, 1, 2.5, 8]) {
      for (const yaw of [0, 0.7, -1.9]) {
        const display = filmSetDisplayTransform({ scale, yaw });
        if (!display.ok) throw new Error(display.reason);
        const anchor: Vec3 = [0, 0, 0];
        const center = mapFilmSetScenePoint(display.value, anchor, sceneCenter);
        expect(center).not.toBeNull();
        if (!center) return;
        const mapped = mapFilmSetSceneCamera(display.value, center, camera);
        expect(mapped).not.toBeNull();
        if (!mapped) return;
        const focus: Vec3 = [
          center[0] + mapped.focusOffset[0],
          center[1] + mapped.focusOffset[1],
          center[2] + mapped.focusOffset[2]
        ];
        const eye = shotCameraPosition(focus, mapped.azimuth, mapped.distance, camera.elevation);
        const projected = scenePoints.map((point) => {
          const world = mapFilmSetScenePoint(display.value, anchor, point);
          if (!world) throw new Error("point mapping failed");
          return normalizedProjection(eye, focus, world);
        });
        for (let index = 0; index < projected.length; index += 1) {
          expect(projected[index]!.x).toBeCloseTo(baseline.points[index]!.x, 5);
          expect(projected[index]!.y).toBeCloseTo(baseline.points[index]!.y, 5);
        }
      }
    }
  });

  it("非法显示变换显式失败，不构造 NaN 镜头", () => {
    expect(filmSetDisplayTransform({ scale: 0, yaw: 0 }).ok).toBe(false);
    expect(filmSetDisplayTransform({ scale: -1, yaw: 0 }).ok).toBe(false);
    expect(filmSetDisplayTransform({ scale: Number.NaN, yaw: 0 }).ok).toBe(false);
    expect(filmSetDisplayTransform({ scale: 1, yaw: Number.POSITIVE_INFINITY }).ok).toBe(false);
    const display = filmSetDisplayTransform({ scale: 1, yaw: 0 });
    if (!display.ok) return;
    expect(mapFilmSetSceneCamera(display.value, [0, 0, 0], { ...camera, distance: 0 })).toBeNull();
    expect(mapFilmSetSceneCamera(display.value, [0, 0, 0], { ...camera, distance: Number.NaN })).toBeNull();
    expect(mapFilmSetSceneCamera(display.value, [0, 0, 0], {
      ...camera,
      focusOffset: { x: Number.NaN, y: 0, z: 0 }
    })).toBeNull();
    expect(filmSetDisplayTransformFor({ placement: null, extent: 2, fit: 0 }).ok).toBe(false);
  });

  it("世界 ↔ 场景逆映射回到原值（手势不做累计缩放）", () => {
    const display = filmSetDisplayTransform({ scale: 3.5, yaw: 0.9 });
    if (!display.ok) return;
    const scene: Vec3 = [0.235, 1.365, -0.025];
    const world = mapFilmSetSceneVector(display.value, scene);
    expect(world).not.toBeNull();
    if (!world) return;
    const back = unmapFilmSetSceneVector(display.value, world);
    expect(back).not.toBeNull();
    if (!back) return;
    for (let axis = 0; axis < 3; axis += 1) expect(back[axis]).toBeCloseTo(scene[axis]!, 9);
    const distance = unmapFilmSetSceneDistance(display.value, 3.5 * 2.65);
    expect(distance).toBeCloseTo(2.65, 9);
  });

  it("完整姿态映射：三个关键点同倍率（position/focus/distance）", () => {
    const display = filmSetDisplayTransform({ scale: 2, yaw: 0 });
    if (!display.ok) return;
    const anchor: Vec3 = [10, -3, 4];
    const pose = { position: [1, 3, 2] as Vec3, focus: [0, 1, 0] as Vec3, distance: 3 };
    const mapped = mapFilmSetShotPose(display.value, anchor, pose);
    expect(mapped).not.toBeNull();
    if (!mapped) return;
    expect(mapped.distance).toBeCloseTo(6, 9);
    expect(mapped.focus).toEqual([10, -1, 4]);
    expect(mapped.position).toEqual([12, 3, 8]);

    // 相机分量（距离/焦点偏移/方位角）与姿态映射同源：position 必须由同一轨道公式得到。
    const cameraMapped = mapFilmSetSceneCamera(display.value, anchor, {
      azimuth: 0.5,
      elevation: 0.3,
      distance: 3,
      focusOffset: { x: 0, y: 1, z: 0 }
    });
    expect(cameraMapped).not.toBeNull();
    if (!cameraMapped) return;
    expect(cameraMapped.azimuth).toBeCloseTo(0.5, 9);
    expect(cameraMapped.distance).toBeCloseTo(6, 9);
    const focus: Vec3 = [anchor[0], anchor[1] + 2, anchor[2]];
    const position = shotCameraPosition(focus, cameraMapped.azimuth, cameraMapped.distance, 0.3);
    const scenePosition = shotCameraPosition([0, 1, 0], 0.5, 3, 0.3);
    expect(position[0]).toBeCloseTo(anchor[0] + scenePosition[0] * 2, 6);
    expect(position[1]).toBeCloseTo(anchor[1] + scenePosition[1] * 2, 6);
    expect(position[2]).toBeCloseTo(anchor[2] + scenePosition[2] * 2, 6);
  });

  it("场景 AABB 只做有限性校验，不乘呈现倍率", () => {
    expect(filmSetSceneAabb({ min: [0, 0, 0], max: [1, 2, 3] })).toEqual({ min: [0, 0, 0], max: [1, 2, 3] });
    expect(filmSetSceneAabb({ min: [0, Number.NaN, 0], max: [1, 1, 1] })).toBeNull();
    // 绝对米制：1 场景单位 = CANVAS_UNITS_PER_METER 画布单位，且与 extent 无关。
    expect(filmSetNaturalScale(null, 2)).toBeCloseTo(CANVAS_UNITS_PER_METER, 9);
    expect(filmSetNaturalScale(null, 40)).toBeCloseTo(CANVAS_UNITS_PER_METER, 9);
    expect(filmSetNaturalScale({ offset: { x: 0, y: 0, z: 0 }, scale: 0.5, yaw: 0 }, 2))
      .toBeCloseTo(CANVAS_UNITS_PER_METER / 2, 9);
  });
});

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}
