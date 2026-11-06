/**
 * V2 模型局部变换数学（change: enhance-model-scene-authoring-api，任务 2.1）。
 *
 * 与 Bevy `Transform` 组合语义 **逐位对齐**，使 executor、extent 计算、Bevy 运行时
 * 与原生 renderer 用同一套局部层级规则：
 *
 * - local transform = `T(position) * R(euler) * S(scale)`；
 * - world = parentWorld * local，其中 `a * b` 的平移为
 *   `a.t + a.r * (a.s * b.t)`，旋转为 `a.r * b.r`，缩放为 `a.s * b.s`；
 * - `rotation: [x, y, z]` 为角度制，固定按 intrinsic Y-X-Z 组合（`R = Ry * Rx * Rz`），
 *   与 Bevy `Quat::from_euler(EulerRot::YXZ, x, y, z)` 一致。
 *
 * 本模块无副作用、纯函数，浏览器 / Canvas Service / 测试共用。Scene IR 仍是运行时 DTO。
 */

export type Vec3 = [number, number, number];
/** 四元数 `[x, y, z, w]`（与 glam/Bevy 内存顺序一致）。 */
export type Quat = [number, number, number, number];

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/** `[x,y,z]` 角度（度）→ intrinsic Y-X-Z 四元数，等价于 `qy * qx * qz`。 */
export function quatFromEulerYXZDegrees(rotation: Vec3): Quat {
  const [x, y, z] = rotation.map((value) => value * (Math.PI / 180)) as Vec3;
  return quatMul(quatMul(axisAngle([0, 1, 0], y), axisAngle([1, 0, 0], x)), axisAngle([0, 0, 1], z));
}

/** 轴角（弧度）→ 四元数；轴会先归一化，零轴返回单位四元数。 */
export function axisAngle(axis: Vec3, radians: number): Quat {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  if (length === 0) return [...IDENTITY_QUAT];
  const half = radians / 2;
  const s = Math.sin(half) / length;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

/** 四元数乘法 `a * b`（先应用 b，再应用 a）。 */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}

/** 用四元数旋转向量（Bevy/glam 同式）。 */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 * cross(q.xyz, v); result = v + w * t + cross(q.xyz, t)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx)
  ];
}

/** 局部变换：平移 + 旋转 + 缩放（缩放先于旋转施加）。 */
export type LocalTransform = {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
};

/** 已求值的变换（旋转为四元数），用于层级组合与包围盒计算。 */
export type Transform = {
  translation: Vec3;
  rotation: Quat;
  scale: Vec3;
};

export function transformOf(local: LocalTransform): Transform {
  return {
    translation: [...local.position],
    rotation: quatFromEulerYXZDegrees(local.rotation),
    scale: [...local.scale]
  };
}

/**
 * 组合父/子变换：`result = parent * child`，与 Bevy `Transform::mul` 完全一致。
 *
 * ```
 * result.translation = parent.translation + parent.rotation * (parent.scale * child.translation)
 * result.rotation    = parent.rotation * child.rotation
 * result.scale       = parent.scale * child.scale
 * ```
 */
export function composeTransform(parent: Transform, child: Transform): Transform {
  const scaledChild = mulVec3(parent.scale, child.translation);
  const rotated = quatRotate(parent.rotation, scaledChild);
  return {
    translation: [
      parent.translation[0] + rotated[0],
      parent.translation[1] + rotated[1],
      parent.translation[2] + rotated[2]
    ],
    rotation: quatMul(parent.rotation, child.rotation),
    scale: mulVec3(parent.scale, child.scale)
  };
}

/** 把点从局部空间变换到该变换的父空间。 */
export function transformPoint(transform: Transform, point: Vec3): Vec3 {
  const scaled = mulVec3(transform.scale, point);
  const rotated = quatRotate(transform.rotation, scaled);
  return [
    rotated[0] + transform.translation[0],
    rotated[1] + transform.translation[1],
    rotated[2] + transform.translation[2]
  ];
}

/** 轴向包围盒（含 min/max）。 */
export type Aabb = { min: Vec3; max: Vec3 };

export function aabbOfPoints(points: readonly Vec3[]): Aabb | null {
  if (points.length === 0) return null;
  const min: Vec3 = [...points[0]];
  const max: Vec3 = [...points[0]];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  return { min, max };
}

export function expandAabb(target: Aabb, other: Aabb): void {
  for (let axis = 0; axis < 3; axis += 1) {
    target.min[axis] = Math.min(target.min[axis], other.min[axis]);
    target.max[axis] = Math.max(target.max[axis], other.max[axis]);
  }
}

/**
 * 有向盒（由 `center` + 旋转 + 半尺寸描述）的父空间 AABB。
 *
 * 用 `abs(R) * halfExtents` 得到旋转后各轴投影长度，避免对 8 个角点排序。
 */
export function orientedBoxAabb(transform: Transform, halfExtents: Vec3): Aabb {
  const centered = transformPoint(transform, [0, 0, 0]);
  const axes: Vec3[] = [
    quatRotate(transform.rotation, [transform.scale[0], 0, 0]),
    quatRotate(transform.rotation, [0, transform.scale[1], 0]),
    quatRotate(transform.rotation, [0, 0, transform.scale[2]])
  ];
  const extent: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    extent[axis] =
      Math.abs(axes[0][axis]) * halfExtents[0] +
      Math.abs(axes[1][axis]) * halfExtents[1] +
      Math.abs(axes[2][axis]) * halfExtents[2];
  }
  return {
    min: [centered[0] - extent[0], centered[1] - extent[1], centered[2] - extent[2]],
    max: [centered[0] + extent[0], centered[1] + extent[1], centered[2] + extent[2]]
  };
}

/**
 * 把子空间 AABB 变换到父空间（8 角点法），用于层级 extent 累加。
 */
export function transformAabb(transform: Transform, box: Aabb): Aabb {
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i += 1) {
    const corner: Vec3 = [
      i & 1 ? box.max[0] : box.min[0],
      i & 2 ? box.max[1] : box.min[1],
      i & 4 ? box.max[2] : box.min[2]
    ];
    corners.push(transformPoint(transform, corner));
  }
  return aabbOfPoints(corners) as Aabb;
}

export function mulVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

export function subVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scaleVec3(a: Vec3, factor: number): Vec3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

export function lengthVec3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function normalizeVec3(v: Vec3): Vec3 {
  const length = lengthVec3(v);
  return length === 0 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length];
}

export function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

export function dotVec3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

const UP: Vec3 = [0, 1, 0];

/**
 * 稳定地把模型局部 `+Y` 轴对齐到给定方向 **所在的直线**。
 *
 * 方向先规范化到 canonical 半空间（`y < 0` 或 `y == 0` 时按 `x`、`z` 字典序取负），
 * 使 `from→to` 与 `to→from` 得到同一四元数，端点交换不改变几何范围（spec「端点顺序变化」/
 * design D4）。方向接近 ±Y 时使用固定备用轴，不依赖浮点噪声随机翻转。
 */
export function quatAlignYTo(direction: Vec3): Quat {
  let d = normalizeVec3(direction);
  if (lengthVec3(d) === 0) return [...IDENTITY_QUAT];
  // canonical：以 y 为主、x/z 为次地选一个方向代表整条线。
  if (d[1] < 0 || (d[1] === 0 && (d[0] < 0 || (d[0] === 0 && d[2] < 0)))) {
    d = [-d[0], -d[1], -d[2]];
  }
  const dot = d[1];
  if (dot < -1 + 1e-6) {
    // 反向：绕固定 +X 轴转 180°，保证任意 -Y 输入得到同一结果。
    return axisAngle([1, 0, 0], Math.PI);
  }
  if (dot > 1 - 1e-6) return [...IDENTITY_QUAT];
  const axis = normalizeVec3(crossVec3(UP, d));
  return axisAngle(axis, Math.acos(Math.max(-1, Math.min(1, dot))));
}
