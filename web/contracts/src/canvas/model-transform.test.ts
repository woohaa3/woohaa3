/**
 * V2 局部变换数学测试（change: enhance-model-scene-authoring-api，任务 2.1）。
 *
 * 用已知的层级组合与 Bevy/glam 等价语义固定 `[x,y,z]` 度数 + intrinsic Y-X-Z 规则，
 * 防止 executor / extent / Bevy / native 各自解释导致漂移。
 */
import { describe, expect, it } from "vitest";
import {
  composeTransform,
  quatAlignYTo,
  quatFromEulerYXZDegrees,
  quatRotate,
  transformOf,
  transformPoint
} from "./model-transform.js";

function approx(a: readonly number[], b: readonly number[]): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i += 1) expect(a[i]).toBeCloseTo(b[i], 5);
}

describe("quatFromEulerYXZDegrees", () => {
  it("returns identity for zero rotation", () => {
    approx(quatFromEulerYXZDegrees([0, 0, 0]), [0, 0, 0, 1]);
  });

  it("uses the fixed intrinsic Y-X-Z order", () => {
    // 90° 绕每个轴分别验证：intrinsic Y-X-Z 等价 qy * qx * qz。
    approx(quatRotate(quatFromEulerYXZDegrees([0, 90, 0]), [1, 0, 0]), [0, 0, -1]);
    approx(quatRotate(quatFromEulerYXZDegrees([90, 0, 0]), [0, 1, 0]), [0, 0, 1]);
    approx(quatRotate(quatFromEulerYXZDegrees([0, 0, 90]), [1, 0, 0]), [0, 1, 0]);
  });

  it("composes intrinsic Y then X then Z", () => {
    const q = quatFromEulerYXZDegrees([90, 90, 0]);
    // 先绕 Z(0)，再绕 X(90°)，再绕 Y(90°)：Y 旋转把 X 后的 +Z 映射出去。
    approx(quatRotate(q, [1, 0, 0]), [0, 0, -1]);
  });
});

describe("hierarchy composition", () => {
  it("composes parent translation/rotation/scale onto child", () => {
    const parent = transformOf({ position: [10, 0, 0], rotation: [0, 90, 0], scale: [2, 2, 2] });
    const child = transformOf({ position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    const world = composeTransform(parent, child);
    // parent.scale * child.t = [2,0,0]；绕 Y 90° → [0,0,-2]；+ parent.t = [10,0,-2]。
    approx(world.translation, [10, 0, -2]);
    approx(world.scale, [2, 2, 2]);
  });

  it("matches Bevy mul semantics for multi-level hierarchy (golden)", () => {
    // 两级非单位变换；结果与 Bevy `Transform::mul_transform` 逐位一致（golden 固定）。
    const root = transformOf({ position: [1, 2, 3], rotation: [10, 20, 30], scale: [2, 1, 0.5] });
    const mid = transformOf({ position: [0.5, 0, -1], rotation: [0, 45, 0], scale: [1, 2, 1] });
    const leaf = transformOf({ position: [1, 1, 0], rotation: [0, 0, 90], scale: [1, 1, 1] });
    const world = composeTransform(composeTransform(root, mid), leaf);
    approx(world.translation, [1.5547955611480468, 5.22690487750242, 1.335089346541143]);
    approx(world.rotation, [0.370790322579228, 0.33347642114890697, 0.7733042730685528, 0.39154631204140533]);
    approx(world.scale, [2, 2, 0.5]);
  });

  it("transformPoint applies scale before rotation before translation", () => {
    const transform = transformOf({ position: [1, 0, 0], rotation: [0, 90, 0], scale: [2, 1, 1] });
    approx(transformPoint(transform, [1, 0, 0]), [1, 0, -2]);
  });
});

describe("quatAlignYTo", () => {
  it("aligns +Y to +Y and handles reverse deterministically", () => {
    approx(quatAlignYTo([0, 1, 0]), [0, 0, 0, 1]);
    const reversed = quatAlignYTo([0, -1, 0]);
    // 反向使用固定 +X 轴 180°：与任意接近 -Y 的输入得到同一结果。
    approx(quatAlignYTo([0, -1, 1e-9]), reversed);
  });

  it("maps +Y onto the given direction", () => {
    const direction: [number, number, number] = [1, 1, 0];
    const rotated = quatRotate(quatAlignYTo(direction), [0, 1, 0]);
    const normalized: [number, number, number] = [
      direction[0] / Math.hypot(...direction),
      direction[1] / Math.hypot(...direction),
      direction[2] / Math.hypot(...direction)
    ];
    approx(rotated, normalized);
  });
});
