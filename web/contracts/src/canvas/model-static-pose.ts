/**
 * 模型静态姿势的有效求值与真实几何核验
 * （change: 2026-11-15-add-model-script-static-poses，任务 1.3 / 3.1）。
 *
 * 唯一数学规则：`B` 为结构/绑定 TRS，`S` 为静态姿势通道，`A` 为该时刻动画实际接管的通道。
 *
 * ```text
 * local.rotation    = B.rotation × (A.rotation ?? S.rotation ?? identity)
 * local.translation = B.position + (A.position ?? S.position ?? 0)   // 父空间偏移
 * local.scale       = B.scale
 * world             = parent.world × local
 * ```
 *
 * 通道“接管”按显式存在性判断，不按值是否为零。本模块是纯函数，浏览器、Canvas Service 与
 * MCP 核验共用；Rust 侧有同一规则的实现和测试向量。
 */
import {
  composeTransform,
  quatFromEulerYXZDegrees,
  transformOf,
  type Aabb,
  type Quat,
  type Transform,
  type Vec3
} from "./model-transform.js";
import { v2ShapeLocalBounds, v2ShapeLocalTransform } from "./scene-ir-v2/bounds.js";
import type { SceneV2GroupOp, SceneV2MeshOp, SceneV2Op, SceneV2Pose, SceneV2ShapeOp } from "./scene-ir-v2.js";

/** 渲染器必须显式声明支持的静态姿势能力（change: 2026-11-15-add-model-script-static-poses）。 */
export const MODEL_STATIC_POSE_CAPABILITY = "model-static-pose-v1" as const;

/** 当帧动画实际接管的通道；显式存在即接管，零值同样覆盖。 */
export type PoseAnimationChannels = {
  rotation?: Vec3;
  position?: Vec3;
};

const IDENTITY_TRANSLATION: Vec3 = [0, 0, 0];

export function isGroupOp(op: SceneV2Op): op is SceneV2GroupOp {
  return op.t === "group";
}

/** 承载层级/几何的 shape op（排除 material 与场景动画）。 */
export function isShapeOp(op: SceneV2Op): op is SceneV2ShapeOp {
  return op.t === "group" || op.t === "box" || op.t === "cylinder" || op.t === "sphere"
    || op.t === "capsule" || op.t === "mesh" || op.t === "segment";
}

/** 有效局部变换：绑定 TRS + 按通道覆盖的静态姿势/动画。 */
export function effectiveGroupTransform(
  group: Pick<SceneV2GroupOp, "position" | "rotation" | "scale" | "pose">,
  animation?: PoseAnimationChannels
): Transform {
  const bind = transformOf(group);
  const pose = group.pose;
  const rotationDelta = animation?.rotation !== undefined
    ? quatFromEulerYXZDegrees(animation.rotation)
    : pose?.rotation
      ? quatFromEulerYXZDegrees(pose.rotation)
      : null;
  const positionDelta = animation?.position ?? pose?.position ?? IDENTITY_TRANSLATION;
  return {
    translation: [
      bind.translation[0] + positionDelta[0],
      bind.translation[1] + positionDelta[1],
      bind.translation[2] + positionDelta[2]
    ],
    rotation: rotationDelta ? (multiplyQuat(bind.rotation, rotationDelta) as Quat) : bind.rotation,
    scale: bind.scale
  };
}

/** 与 `composeTransform` 的旋转乘法一致：先应用子旋转，再用父旋转。 */
function multiplyQuat(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}

/** 按真实层级求每个 op 的世界变换（激活部分只覆盖实际接管通道）。 */
export function composeModelHierarchy(
  ops: readonly SceneV2Op[],
  channels?: ReadonlyMap<string, PoseAnimationChannels>
): Map<string, Transform> {
  const byId = new Map<string, SceneV2ShapeOp>();
  for (const op of ops) if (isShapeOp(op)) byId.set(op.id, op);
  const world = new Map<string, Transform>();
  const visiting = new Set<string>();
  const resolve = (id: string): Transform | null => {
    const cached = world.get(id);
    if (cached) return cached;
    const op = byId.get(id);
    if (!op || visiting.has(id)) return null;
    visiting.add(id);
    const parent = op.parent === null ? null : resolve(op.parent);
    visiting.delete(id);
    if (op.parent !== null && !parent) return null;
    const local = isGroupOp(op)
      ? effectiveGroupTransform(op, channels?.get(id))
      : v2ShapeLocalTransform(op);
    const result = parent ? composeTransform(parent, local) : local;
    world.set(id, result);
    return result;
  };
  for (const id of byId.keys()) resolve(id);
  return world;
}

export type ModelPoseFootSurface = {
  /** 左右脚真实蒙皮表面的最低高度（模型 Y 轴，米）；无法分类时为 null。 */
  left: number | null;
  right: number | null;
  classification: "skin-weights" | "unknown";
  reason?: string;
};

export type ModelPoseGeometry = {
  /** 真实变形顶点的局部 AABB（未含实例摆放）。 */
  aabb: Aabb | null;
  footSurface: ModelPoseFootSurface;
  /** 少量关节端点（世界=模型局部空间），辅助定位；不冒充脚底。 */
  joints: Array<{ id: string; world: Vec3 }>;
  skinnedVertexCount: number;
  /** 几何核验只证明数值/几何，不证明平衡、接触或自然度。 */
  verification: "sampled-data-only";
};

const geometryCache = new WeakMap<readonly SceneV2Op[], ModelPoseGeometry>();

/** 由实际 FK/LBS 求当前姿势的局部 AABB、脚表面最低高度与关节端点。 */
export function evaluateModelPoseGeometry(ops: readonly SceneV2Op[]): ModelPoseGeometry {
  const cached = geometryCache.get(ops);
  if (cached) return cached;
  // Full affine matrices retain shear from rotated descendants of non-uniform scales.
  const world = new Map<string, number[]>();
  for (const op of ops) {
    if (!isShapeOp(op)) continue;
    const local = transformMatrix(op.t === "group" ? effectiveGroupTransform(op) : v2ShapeLocalTransform(op));
    const parent = op.parent === null ? undefined : world.get(op.parent);
    world.set(op.id, parent ? multiplyMat4(parent, local) : local);
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  let skinnedVertexCount = 0;
  let classified = false;
  const footMin: { left: number | null; right: number | null } = { left: null, right: null };
  const joints: Array<{ id: string; world: Vec3 }> = [];

  for (const op of ops) {
    if (isGroupOp(op)) {
      const transform = world.get(op.id);
      if (transform) joints.push({ id: op.id, world: applyMat4(transform, [0, 0, 0]) });
      continue;
    }
    if (!isShapeOp(op)) continue;
    if (op.t === "mesh" && op.skin) {
      const skin = skinnedSurface(op, world);
      if (!skin) continue;
      skinnedVertexCount += skin.vertices.length;
      for (const index of new Set(op.faces.flat())) {
        const vertex = skin.vertices[index]!;
        include(vertex);
        const side = skin.footSide[index];
        if (side === 0) continue;
        classified = true;
        if (side < 0) footMin.left = footMin.left === null ? vertex[1] : Math.min(footMin.left, vertex[1]);
        else footMin.right = footMin.right === null ? vertex[1] : Math.min(footMin.right, vertex[1]);
      }
      continue;
    }
    const bounds = v2ShapeLocalBounds(op);
    const matrix = world.get(op.id);
    if (!bounds || !matrix) continue;
    if (op.t === "sphere" || op.t === "cylinder" || op.t === "capsule" || (op.t === "segment" && op.shape === "capsule")) {
      const center = applyMat4(matrix, [0, 0, 0]);
      const halfY = (bounds.max[1] - bounds.min[1]) / 2;
      const radius = op.t === "segment" ? op.width / 2 : op.radius;
      const extent = [0, 1, 2].map(axis => {
        const row = [matrix[axis]!, matrix[axis + 4]!, matrix[axis + 8]!];
        if (op.t === "sphere") return radius * Math.hypot(...row);
        if (op.t === "cylinder") return radius * Math.hypot(row[0]!, row[2]!) + halfY * Math.abs(row[1]!);
        return radius * Math.hypot(...row) + Math.max(0, halfY - radius) * Math.abs(row[1]!);
      });
      include(center.map((value, axis) => value - extent[axis]!) as Vec3);
      include(center.map((value, axis) => value + extent[axis]!) as Vec3);
      continue;
    }
    const points = op.t === "mesh" ? [...new Set(op.faces.flat())].map(index => op.vertices[index]!) : corners(bounds);
    for (const point of points) {
      include(applyMat4(matrix, point));
    }
  }

  const geometry: ModelPoseGeometry = {
    aabb: any ? { min, max } : null,
    footSurface: {
      left: footMin.left,
      right: footMin.right,
      classification: classified ? "skin-weights" : "unknown",
      ...(classified ? {} : { reason: "没有可按脚部权重分类的蒙皮顶点；不以脚踝端点或绑定 AABB 冒充脚底" })
    },
    joints,
    skinnedVertexCount,
    verification: "sampled-data-only"
  };
  if (ops.length > 0) geometryCache.set(ops, geometry);
  return geometry;

  function include(point: Vec3): void {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || !Number.isFinite(point[2])) return;
    any = true;
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  }
}

/** CPU LBS：每个顶点按完整 indices/weights/inverseBind 变形，返回模型局部世界坐标。 */
function skinnedSurface(
  mesh: SceneV2MeshOp,
  world: ReadonlyMap<string, readonly number[]>
): { vertices: Vec3[]; footSide: Int8Array } | null {
  const skin = mesh.skin;
  if (!skin) return null;
  const matrices = skin.jointIds.map((id, index) => {
    const joint = world.get(id);
    const inverse = skin.inverseBindMatrices[index];
    if (!joint || !inverse) return null;
    // 完整仿射矩阵：jointWorld × inverseBind（保留绑定矩阵的缩放/剪切，不解成 TRS）。
    return multiplyMat4(joint, inverse);
  });
  if (matrices.some((entry) => entry === null)) return null;
  const side = footSideOf(skin.jointIds);
  const vertices: Vec3[] = [];
  const footSide = new Int8Array(mesh.vertices.length);
  for (let vertexIndex = 0; vertexIndex < mesh.vertices.length; vertexIndex += 1) {
    const indices = skin.indices[vertexIndex] ?? [];
    const weights = skin.weights[vertexIndex] ?? [];
    const source = mesh.vertices[vertexIndex]!;
    let x = 0;
    let y = 0;
    let z = 0;
    let totalWeight = 0;
    let leftWeight = 0;
    let rightWeight = 0;
    for (let influence = 0; influence < indices.length; influence += 1) {
      const weight = weights[influence] ?? 0;
      const matrix = matrices[indices[influence]!];
      if (!matrix || weight === 0) continue;
      const posed = applyMat4(matrix, source);
      x += posed[0] * weight;
      y += posed[1] * weight;
      z += posed[2] * weight;
      totalWeight += weight;
      const jointSide = side[indices[influence]!] ?? 0;
      if (jointSide < 0) leftWeight += weight;
      else if (jointSide > 0) rightWeight += weight;
    }
    if (totalWeight <= 0) {
      vertices.push(source);
      continue;
    }
    // Match the renderer's weighted sum exactly. Valid skin weights may differ from 1
    // within the protocol tolerance; renormalizing here would report different geometry.
    vertices.push([x, y, z]);
    // 固定分类：脚/趾权重合计 ≥ 0.5 才视为脚表面；否则不参与接地核验。
    const dominant = leftWeight >= rightWeight ? leftWeight : rightWeight;
    if (dominant / totalWeight >= 0.5) footSide[vertexIndex] = leftWeight >= rightWeight ? -1 : 1;
  }
  return { vertices, footSide };
}

/** 关节名 → 脚侧：含 Foot/Toe 且带 Left/Right 的关节参与脚底分类。 */
function footSideOf(jointIds: readonly string[]): Int8Array {
  const side = new Int8Array(jointIds.length);
  jointIds.forEach((id, index) => {
    const name = id.slice(id.lastIndexOf(".") + 1);
    if (!/foot|toe/i.test(name)) return;
    if (/left/i.test(name)) side[index] = -1;
    else if (/right/i.test(name)) side[index] = 1;
  });
  return side;
}

/** 列主序 4x4：T × R × S（与 Bevy `Transform::to_matrix` 同义）。 */
function transformMatrix(transform: Transform): number[] {
  const [x, y, z, w] = transform.rotation;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  const [sx, sy, sz] = transform.scale;
  const [tx, ty, tz] = transform.translation;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1
  ];
}

/** 列主序 4x4 乘法：`a × b`（先 b 后 a）。 */
function multiplyMat4(a: readonly number[], b: readonly number[]): number[] {
  const result = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let k = 0; k < 4; k += 1) value += (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0);
      result[column * 4 + row] = value;
    }
  }
  return result;
}

/** 列主序仿射矩阵作用于点。 */
function applyMat4(matrix: readonly number[], point: Vec3): Vec3 {
  const [x, y, z] = point;
  return [
    (matrix[0] ?? 1) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0),
    (matrix[1] ?? 0) * x + (matrix[5] ?? 1) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0),
    (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 1) * z + (matrix[14] ?? 0)
  ];
}

function corners(bounds: Aabb): Vec3[] {
  return Array.from({ length: 8 }, (_, index) => [
    index & 1 ? bounds.max[0] : bounds.min[0],
    index & 2 ? bounds.max[1] : bounds.min[1],
    index & 4 ? bounds.max[2] : bounds.min[2]
  ] as Vec3);
}

/** 一份模型脚本声明的静态姿势摘要（供 `world_model_pose` 只读资源）。 */
export type ModelStaticPoseSummary = {
  capability: typeof MODEL_STATIC_POSE_CAPABILITY;
  /** 已声明姿势的 group，按脚本声明顺序。 */
  poses: Array<{ groupId: string; rotation?: Vec3; position?: Vec3 }>;
  /** 受影响关节 id（与 group 同集合，便于助手核对真实关节名）。 */
  affectedJoints: string[];
  geometry: ModelPoseGeometry;
  verification: "sampled-data-only";
  limitations: string[];
};

export function describeModelStaticPose(ops: readonly SceneV2Op[]): ModelStaticPoseSummary {
  const poses = ops.flatMap((op) => {
    if (!isGroupOp(op) || !op.pose) return [];
    const pose: SceneV2Pose = op.pose;
    return [{ groupId: op.id, ...(pose.rotation ? { rotation: pose.rotation } : {}), ...(pose.position ? { position: pose.position } : {}) }];
  });
  return {
    capability: MODEL_STATIC_POSE_CAPABILITY,
    poses,
    affectedJoints: poses.map((pose) => pose.groupId),
    geometry: evaluateModelPoseGeometry(ops),
    verification: "sampled-data-only",
    limitations: ["只核验数值与几何；不代表平衡、接触、自然度或视觉验收"]
  };
}
