/**
 * 模型聚焦：模型布局/world bounds/锚点/取景距离
 * （自 `model-focus.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R24）。
 *
 * 与 Rust `model_anchor` / `model_world_aabb` / `focused_model_bounds` 逐位一致；复用 scene-ir 的
 * 规范化 AABB。
 */
import { v2SceneAabb } from "../scene-ir-v2.js";
import {
  addVec3,
  lengthVec3,
  scaleVec3,
  subVec3,
  transformAabb,
  type Aabb,
  type Transform,
  type Vec3
} from "../model-transform.js";
import type { BevyModelPlacement } from "../render-scene/wire-model.js";
import { axisQ, quatMulLocal } from "./math.js";
import { viewRotation } from "./canvas-projection.js";
import { clampDistance } from "./clamp.js";
import {
  CANVAS_UNITS_PER_METER,
  FRAME_PADDING,
  MODEL_FOCUS_FOV,
  type ModelSceneInput
} from "./types.js";

/**
 * 模型根单位缩放（与 Rust `model_unit` 一致）：`placement.scale × CANVAS_UNITS_PER_METER`。
 *
 * 场景单位（= 1 米）固定映射到 `CANVAS_UNITS_PER_METER` 画布单位，**不再除以 `extent`**
 * （change: 2026-10-31-render-models-at-absolute-metric-scale）。因此 1.7 m 的人在任何节点里
 * 都是约 109 画布单位高，20 m 的楼约 1280，跨节点真实可比；模型在世界原点多远也不再影响尺寸。
 *
 * viewport/surface **不**参与：模型世界由内容与 canonical/preview placement 决定。
 * `extent` 参数保留在签名里只为无破坏地迁移既有调用点，不再参与计算。
 */
export function modelUnit(placement: BevyModelPlacement | null, _extent?: number): number {
  const scale = placement?.scale;
  const safeScale = Number.isFinite(scale) && (scale as number) > 0 ? (scale as number) : 1;
  return safeScale * CANVAS_UNITS_PER_METER;
}

export function unionAabb(a: Aabb, b: Aabb): Aabb {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])]
  };
}

/** 模型局部规范空间 AABB（V2）。 */
export function modelLocalAabb(input: ModelSceneInput): Aabb | null {
  if (input.aabb !== undefined) return input.aabb;
  return v2SceneAabb(input.ops);
}

/**
 * 模型经 yaw + `unit` 缩放后的世界 AABB（**相对根锚点**）。
 */
export function modelWorldAabbRelative(input: ModelSceneInput): Aabb | null {
  return modelScaledAabb(input, false);
}

function modelScaledAabb(input: ModelSceneInput, isometric: boolean): Aabb | null {
  const local = modelLocalAabb(input);
  if (!local) return null;
  const yaw = ((input.placement?.yaw ?? 0) * Math.PI) / 180;
  const yawRotation = axisQ([0, 1, 0], yaw);
  const rotation = isometric ? quatMulLocal(viewRotation(), yawRotation) : yawRotation;
  const unit = resolvedUnit(input);
  if (!(Number.isFinite(unit) && unit > 0)) return local;
  const root: Transform = { translation: [0, 0, 0], rotation, scale: [unit, unit, unit] };
  return transformAabb(root, local);
}

/** 解析模型单位：绝对米制单位。 */
function resolvedUnit(input: ModelSceneInput): number {
  return modelUnit(input.placement ?? null, input.extent);
}

/**
 * 模型世界 AABB（含根锚点平移）。`anchor` 为模型根的世界位置（Bevy 世界坐标，y 向上）。
 */
export function modelWorldAabb(input: ModelSceneInput, anchor: Vec3): Aabb | null {
  const relative = modelWorldAabbRelative(input);
  if (!relative) return null;
  return {
    min: addVec3(relative.min, anchor),
    max: addVec3(relative.max, anchor)
  };
}

/** AABB 中心与包围球半径。 */
export function aabbCenterRadius(box: Aabb): { center: Vec3; radius: number } {
  const center = scaleVec3(addVec3(box.min, box.max), 0.5);
  const radius = lengthVec3(subVec3(box.max, box.min)) / 2;
  return { center, radius };
}

/**
 * 聚焦目标（模型世界 AABB、中心与包围球半径）：命中与取景共用同一结果。
 * 返回 null 表示模型不可命中/不可聚焦（空几何或非法数值）。
 */
export function focusTargetFor(input: ModelSceneInput & {
  anchor: Vec3;
}): { aabb: Aabb; center: Vec3; radius: number } | null {
  const relative = modelWorldAabbRelative(input);
  if (!relative) return null;
  const aabb: Aabb = { min: addVec3(relative.min, input.anchor), max: addVec3(relative.max, input.anchor) };
  if (!isFiniteAabb(aabb)) return null;
  const { center, radius } = aabbCenterRadius(aabb);
  return { aabb, center, radius };
}

function isFiniteAabb(box: Aabb): boolean {
  return [...box.min, ...box.max].every((value) => Number.isFinite(value));
}

/**
 * 自动取景距离：让包围球在完整 canvas aspect 内完整入镜。
 */
export function autoFrameDistance(radius: number, fov: number, aspect: number): number {
  const safeRadius = radius > 1e-4 && Number.isFinite(radius) ? radius : 1;
  const safeFov = fov > 1e-3 && fov < Math.PI - 1e-3 ? fov : MODEL_FOCUS_FOV;
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  // 水平半角：2*atan(tan(vFov/2) * aspect)
  const horizontalHalf = Math.atan(Math.tan(safeFov / 2) * safeAspect);
  const effectiveHalf = Math.min(safeFov / 2, horizontalHalf);
  const distance = (safeRadius * FRAME_PADDING) / Math.sin(effectiveHalf);
  return clampDistance(distance, safeRadius);
}
