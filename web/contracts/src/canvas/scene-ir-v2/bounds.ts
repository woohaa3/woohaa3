/**
 * Scene IR V2：AABB/extent/signature
 * （自 `scene-ir-v2.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R14）。
 *
 * bounds 使用与 validator 相同的规范化 ops 与数学 primitive；含层级、scale、radius 与 overlap。
 */
import {
  aabbOfPoints,
  expandAabb,
  lengthVec3,
  addVec3,
  orientedBoxAabb,
  quatAlignYTo,
  scaleVec3,
  subVec3,
  composeTransform,
  transformOf,
  transformAabb,
  type Aabb,
  type LocalTransform,
  type Transform,
  type Vec3
} from "../model-transform.js";
import { SCENE_IR_V2_VERSION, V2_SHAPE_OPS, type SceneV2Op, type SceneV2ShapeOp } from "./types.js";

/** 根据规范化 V2 IR 求世界局部包围盒（含层级、scale、radius、overlap）。 */
export function v2SceneAabb(ops: readonly SceneV2Op[]): Aabb | null {
  const worldOf = new Map<string, Transform>();
  let result: Aabb | null = null;

  for (const op of ops) {
    if (!isV2ShapeOp(op)) continue;
    const local = transformOf(localOfShape(op));
    const parent = op.parent === null ? null : worldOf.get(op.parent) ?? null;
    const world = parent ? composeTransform(parent, local) : local;
    worldOf.set(op.id, world);

    const box = shapeLocalAabb(op);
    if (box === null) continue;
    const transformed = transformAabb(world, box);
    if (result === null) result = transformed;
    else expandAabb(result, transformed);
  }
  return result;
}

/** 是否为承载层级/几何的 shape op（group 或 solid）。 */
function isV2ShapeOp(op: SceneV2Op): op is SceneV2ShapeOp {
  return V2_SHAPE_OPS.has(op.t);
}

/** 与 V1 `sceneExtent` 兼容的标量：包围盒最大半径 × 2，下限 2。 */
export function v2SceneExtent(ops: readonly SceneV2Op[]): number {
  return v2ExtentFromAabb(v2SceneAabb(ops));
}

/**
 * 由已求得的局部 AABB 派生 extent（与 `v2SceneExtent` 同一公式）。
 *
 * 供 prepared model resource 复用：一次 `v2SceneAabb` 遍历即可同时得到 AABB 与 extent，
 * 避免在派生元数据时重复遍历 mesh 顶点（change: optimize-model-scene-snapshot-hot-path）。
 */
export function v2ExtentFromAabb(box: Aabb | null): number {
  if (box === null) return 2;
  let extent = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    extent = Math.max(extent, Math.abs(box.min[axis]), Math.abs(box.max[axis]));
  }
  return Math.max(1, extent * 2);
}

function localOfShape(op: SceneV2ShapeOp): LocalTransform {
  return { position: op.position, rotation: op.rotation, scale: op.scale };
}

/** primitive 在 **自身局部空间** 的 AABB（未施加层级变换）。 */
function shapeLocalAabb(op: SceneV2ShapeOp): Aabb | null {
  switch (op.t) {
    case "group":
      return null;
    case "box":
      return { min: scaleVec3(op.size, -0.5), max: scaleVec3(op.size, 0.5) };
    case "cylinder":
      return { min: [-op.radius, -op.height / 2, -op.radius], max: [op.radius, op.height / 2, op.radius] };
    case "sphere":
      return { min: [-op.radius, -op.radius, -op.radius], max: [op.radius, op.radius, op.radius] };
    case "capsule":
      return { min: [-op.radius, -op.height / 2, -op.radius], max: [op.radius, op.height / 2, op.radius] };
    case "mesh":
      return aabbOfPoints(op.vertices);
    case "segment": {
      const center = scaleVec3(addVec3(op.from, op.to), 0.5);
      const direction = subVec3(op.to, op.from);
      const length = lengthVec3(direction);
      const rotation = quatAlignYTo(direction);
      const halfLength = length / 2 + op.overlap;
      const halfExtents: Vec3 =
        op.shape === "capsule"
          ? [op.width / 2, halfLength + op.width / 2, op.width / 2]
          : [op.width / 2, halfLength, op.depth / 2];
      return orientedBoxAabb({ translation: center, rotation, scale: [1, 1, 1] }, halfExtents);
    }
    default:
      return null;
  }
}

/**
 * 规范化 V2 IR 的内容签名（design D7）：包含版本、全部 op 与材质参数，不含 placement。
 * 因为 validator 已统一默认值与字段顺序，语义相同的输入得到相同签名。
 */
export function v2SceneSignature(ops: readonly SceneV2Op[]): string {
  return `${SCENE_IR_V2_VERSION}:${JSON.stringify(ops)}`;
}
