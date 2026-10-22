/**
 * 跨语言 shot camera 取景 fixture 对齐
 * （change: add-reusable-bevy-shot-camera，任务 1.2 / design D2）。
 *
 * Rust `shot_camera::framing` 与 Web `shot-camera.ts` 读取同一
 * `contracts/fixtures/shot-camera-framing.json` 并各自断言；两侧任一漂移都会使对应语言测试
 * 失败。fixture 由 Web 数学生成，Rust 侧测试断言完全相同的数值。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  azimuthFromHorizontalDrag,
  distanceFromDrag,
  elevationFromVerticalDrag,
  resolveShotCamera,
  shotBoundingRadius,
  shotFitDistance,
  SHOT_CAMERA_FOV,
  type ShotCamera
} from "./shot-camera.js";
import type { Aabb, Vec3 } from "./model-transform.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "../../fixtures/shot-camera-framing.json"), "utf8")
) as {
  tolerance: number;
  cases: Array<{
    name: string;
    aabb: { min: Vec3; max: Vec3 };
    azimuth: number;
    elevation: number;
    distance: number;
    aspect: string;
    aspectRatio: number;
    focusOffset: Vec3;
    expected: {
      boundingRadius: number;
      fitDistance: number;
      distance: number;
      focus: Vec3;
      position: Vec3;
      fov: number;
    };
  }>;
  dragCases: Array<{
    name: string;
    startAzimuth?: number;
    deltaX?: number;
    surfaceWidth?: number;
    expectedAzimuth?: number;
    startDistance?: number;
    deltaPixels?: number;
    surfaceHeight?: number;
    fitDistance?: number;
    expectedDistance?: number;
    startElevation?: number;
    expectedElevation?: number;
  }>;
};

describe("shot camera framing fixture（Web 侧）", () => {
  for (const testCase of fixture.cases) {
    it(`${testCase.name}：Web 数学与 fixture 一致`, () => {
      const aabb: Aabb = { min: testCase.aabb.min, max: testCase.aabb.max };
      const expected = testCase.expected;

      expect(shotBoundingRadius(aabb)).toBeCloseTo(expected.boundingRadius, 6);
      expect(shotFitDistance(expected.boundingRadius, testCase.aspectRatio)).toBeCloseTo(
        expected.fitDistance,
        6
      );

      const camera: ShotCamera | null = resolveShotCamera(aabb, {
        azimuth: testCase.azimuth,
        elevation: testCase.elevation,
        distance: testCase.distance,
        aspect: testCase.aspect as never,
        focusOffset: {
          x: testCase.focusOffset[0],
          y: testCase.focusOffset[1],
          z: testCase.focusOffset[2]
        }
      });
      expect(camera).not.toBeNull();
      if (!camera) return;
      expect(camera.elevation).toBeCloseTo(testCase.elevation, 9);
      expect(camera.distance).toBeCloseTo(expected.distance, 6);
      for (let index = 0; index < 3; index += 1) {
        expect(camera.focus[index]).toBeCloseTo(expected.focus[index]!, 5);
        expect(camera.position[index]).toBeCloseTo(expected.position[index]!, 5);
      }
      expect(camera.fov).toBeCloseTo(expected.fov, 6);
      expect(SHOT_CAMERA_FOV).toBeCloseTo(expected.fov, 9);
    });
  }

  it("拖动换算与 fixture 一致", () => {
    const orbit = fixture.dragCases.find((entry) => entry.name === "orbit-half-screen")!;
    expect(
      azimuthFromHorizontalDrag(orbit.startAzimuth!, orbit.deltaX!, orbit.surfaceWidth!)
    ).toBeCloseTo(orbit.expectedAzimuth!, 6);

    const distance = fixture.dragCases.find((entry) => entry.name === "distance-in")!;
    expect(
      distanceFromDrag({
        startDistance: distance.startDistance!,
        deltaPixels: distance.deltaPixels!,
        surfaceHeight: distance.surfaceHeight!,
        fitDistance: distance.fitDistance!
      })
    ).toBeCloseTo(distance.expectedDistance!, 6);

    const elevation = fixture.dragCases.find((entry) => entry.name === "elevation-up")!;
    expect(
      elevationFromVerticalDrag(
        elevation.startElevation!,
        elevation.deltaPixels!,
        elevation.surfaceHeight!
      )
    ).toBeCloseTo(elevation.expectedElevation!, 6);
  });
});
