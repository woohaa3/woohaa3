/**
 * 模型聚焦：相机 pose 与旋转
 * （自 `model-focus.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R24）。
 */
import {
  addVec3,
  crossVec3,
  lengthVec3,
  normalizeVec3,
  scaleVec3,
  subVec3,
  type Quat,
  type Vec3
} from "../model-transform.js";
import type { ModelFocusCamera } from "./types.js";

/**
 * 由 yaw/pitch/distance 求相机位置与朝向（相机看向 target）。
 * 位置 = target + R(yaw,pitch) * (0, 0, distance)。
 */
export function focusCameraPosition(camera: ModelFocusCamera): Vec3 {
  const dir: Vec3 = [
    Math.sin(camera.yaw) * Math.cos(camera.pitch),
    -Math.sin(camera.pitch),
    Math.cos(camera.yaw) * Math.cos(camera.pitch)
  ];
  return addVec3(camera.target, scaleVec3(dir, camera.distance));
}

/** 相机朝向四元数（-Z 看向 target）。使用与 Bevy `Transform::looking_at` 相同语义。 */
export function focusCameraRotation(camera: ModelFocusCamera): Quat {
  const position = focusCameraPosition(camera);
  const forward = normalizeVec3(subVec3(camera.target, position));
  return quatLookRotation(forward, [0, 1, 0]);
}

/** 由前向与 up 求旋转（glam `Quat::from_mat3` 的 right/target/up 基）。 */
export function quatLookRotation(forward: Vec3, up: Vec3): Quat {
  let f = normalizeVec3(forward);
  if (lengthVec3(f) === 0) f = [0, 0, -1];
  const right = normalizeVec3(crossVec3(f, up));
  const trueUp = crossVec3(right, f);
  // 基：X=right, Y=trueUp, Z=-forward（相机看向 -Z）。
  const m00 = right[0], m01 = trueUp[0], m02 = -f[0];
  const m10 = right[1], m11 = trueUp[1], m12 = -f[1];
  const m20 = right[2], m21 = trueUp[2], m22 = -f[2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}
