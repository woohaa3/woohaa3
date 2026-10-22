/**
 * 模型聚焦：射线与 AABB 命中
 * （自 `model-focus.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R24）。
 *
 * 聚焦透视射线与普通画布正交射线，及 slab 法 ray-AABB 命中；与 Rust 共用同一 yaw/pitch/distance。
 */
import {
  addVec3,
  quatRotate,
  scaleVec3,
  normalizeVec3,
  type Aabb,
  type Quat,
  type Vec3
} from "../model-transform.js";
import { focusCameraPosition, focusCameraRotation } from "./focus-camera.js";
import type { ModelFocusCamera, Ray } from "./types.js";

/**
 * 聚焦（透视）相机的屏幕射线。
 *
 * 与 Rust 聚焦相机使用同一 yaw/pitch/distance/target、FOV 与 surface aspect。`point` 为 canvas
 * 内 CSS 像素坐标（原点左上）。
 */
export function focusRay(input: {
  point: { x: number; y: number };
  size: { width: number; height: number };
  camera: ModelFocusCamera;
  fov: number;
}): Ray {
  const { width, height } = input.size;
  const ndcX = width > 0 ? (input.point.x / width) * 2 - 1 : 0;
  const ndcY = height > 0 ? 1 - (input.point.y / height) * 2 : 0;
  const aspect = height > 0 ? width / height : 1;
  const tanHalf = Math.tan(input.fov / 2);
  const position = focusCameraPosition(input.camera);
  const rotation = focusCameraRotation(input.camera);
  // 相机局部方向 → 世界方向：直接左乘相机旋转（rotation 为 local→world）。
  const localDir: Vec3 = [ndcX * tanHalf * aspect, ndcY * tanHalf, -1];
  return { origin: position, direction: normalizeVec3(quatRotate(rotation, localDir)) };
}

/**
 * 普通（正交）画布相机的屏幕射线：用于双击进入聚焦前的模型命中。
 */
export function orthoRay(input: {
  point: { x: number; y: number };
  size: { width: number; height: number };
  cameraPosition: Vec3;
  cameraRotation: Quat;
  orthoHeight: number;
}): Ray {
  const { width, height } = input.size;
  const ndcX = width > 0 ? (input.point.x / width) * 2 - 1 : 0;
  const ndcY = height > 0 ? 1 - (input.point.y / height) * 2 : 0;
  const aspect = height > 0 ? width / height : 1;
  const halfH = input.orthoHeight;
  const halfW = halfH * aspect;
  const local: Vec3 = [ndcX * halfW, ndcY * halfH, 0];
  const world = addVec3(input.cameraPosition, quatRotate(input.cameraRotation, local));
  return { origin: world, direction: quatRotate(input.cameraRotation, [0, 0, -1]) };
}

/** slab 法 ray-AABB 命中；负交点（AABB 在射线背后）视为未命中。 */
export function rayIntersectsAabb(ray: Ray, box: Aabb): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    const origin = ray.origin[axis];
    const direction = ray.direction[axis];
    if (Math.abs(direction) < 1e-9) {
      if (origin < box.min[axis] || origin > box.max[axis]) return null;
      continue;
    }
    const inv = 1 / direction;
    let t1 = (box.min[axis] - origin) * inv;
    let t2 = (box.max[axis] - origin) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return tmin >= 0 ? tmin : tmax;
}

/** 便捷：命中点世界坐标（未命中返回 null）。 */
export function rayHitPoint(ray: Ray, box: Aabb): Vec3 | null {
  const t = rayIntersectsAabb(ray, box);
  if (t === null) return null;
  return addVec3(ray.origin, scaleVec3(ray.direction, t));
}
