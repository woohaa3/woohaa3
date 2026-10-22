/**
 * 模型聚焦：四元数小工具
 * （自 `model-focus.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R24）。
 */
import type { Quat, Vec3 } from "../model-transform.js";

export function eulerXyz(x: number, y: number, z: number): Quat {
  const qx = axisQ([1, 0, 0], x);
  const qy = axisQ([0, 1, 0], y);
  const qz = axisQ([0, 0, 1], z);
  return quatMulLocal(quatMulLocal(qx, qy), qz);
}

export function axisQ(axis: Vec3, radians: number): Quat {
  const half = radians / 2;
  const s = Math.sin(half);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

export function quatMulLocal(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}
