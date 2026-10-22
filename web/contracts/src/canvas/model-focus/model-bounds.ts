/**
 * 模型聚焦：模型布局/world bounds/锚点/取景距离
 * （自 `model-focus.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R24）。
 *
 * 与 Rust `model_anchor` / `model_world_aabb` / `film_set_fit` 逐位一致；复用 scene-ir 的
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
import { canvasPointToWorld, viewRotation } from "./canvas-projection.js";
import { clampDistance } from "./clamp.js";
import {
  FILM_SET_FIT_MARGIN,
  FRAME_PADDING,
  MODEL_CARD_GAP,
  MODEL_FOCUS_FOV,
  MODEL_SIZE_BASE,
  type ModelSceneInput
} from "./types.js";

/**
 * 模型根单位缩放（与 Rust `model_unit` 一致：`placement.scale * 64 * 3 / extent`）。
 *
 * viewport/surface **不**参与：模型世界由内容与 canonical/preview placement 决定。
 */
export function modelUnit(placement: BevyModelPlacement | null, extent: number): number {
  const scale = placement?.scale ?? 1;
  const safeExtent = extent > 0 && Number.isFinite(extent) ? extent : 1;
  return (scale * 64 * 3) / safeExtent;
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
 * 屏幕投影用的相对 AABB（等距旋转 × yaw × unit）。
 */
export function modelLayoutAabbRelative(input: ModelSceneInput): Aabb | null {
  return modelScaledAabb(input, true);
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

/**
 * 解析模型单位：普通模型用自然单位；片场按 `filmSetFit` 节点矩形等比适配。
 */
function resolvedUnit(input: ModelSceneInput): number {
  if (!input.filmSetFit) return modelUnit(input.placement ?? null, input.extent);
  const scale = input.placement?.scale ?? 1;
  return modelUnit({ ...(input.placement ?? { offset: { x: 0, y: 0, z: 0 }, yaw: 0 }), scale: Math.min(scale, 1) }, input.extent) * filmSetFitFactor(input, input.filmSetFit);
}

/**
 * 片场等比适配系数（与 Rust `film_set_fit` 一致）：让模型等距投影 AABB（含边距）落入节点矩形。
 *
 * 基于**自然单位**（不含 `placement.scale`）计算，与 Rust 相同。无几何或非法数值时返回 `1`。
 */
export function filmSetFitFactor(
  input: ModelSceneInput,
  size: { width: number; height: number }
): number {
  const local = input.aabb !== undefined ? input.aabb : modelLocalAabb(input);
  if (!local) return 1;
  const safeExtent = input.extent > 0 && Number.isFinite(input.extent) ? input.extent : 1;
  const naturalUnit = (64 * 3) / safeExtent;
  const yaw = ((input.placement?.yaw ?? 0) * Math.PI) / 180;
  const layoutRotation = quatMulLocal(viewRotation(), axisQ([0, 1, 0], yaw));
  const projected = transformAabb(
    { translation: [0, 0, 0], rotation: layoutRotation, scale: [naturalUnit, naturalUnit, naturalUnit] },
    local
  );
  const width = Math.max(1e-3, projected.max[0] - projected.min[0]);
  const height = Math.max(1e-3, projected.max[1] - projected.min[1]);
  const availW = Math.max(1, size.width - FILM_SET_FIT_MARGIN * 2);
  const availH = Math.max(1, size.height - FILM_SET_FIT_MARGIN * 2);
  const fit = Math.min(availW / width, availH / height);
  return Number.isFinite(fit) && fit > 0 ? fit : 1;
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
 * 模型根锚点（Bevy 世界坐标，y 向上）——与 Rust `model_anchor` **逐位一致**。
 */
export function modelAnchor(input: {
  nodeX: number;
  nodeY: number;
  nodeWidth: number;
  nodeHeight: number;
  relativeAabb: Aabb | null;
  offset: { x: number; y: number; z: number };
  /** 片场：把模型投影中心对齐节点矩形中心，而非置于卡片下方。 */
  centered?: boolean;
}): Vec3 {
  const size = MODEL_SIZE_BASE;
  if (input.centered && input.relativeAabb) {
    const halfW = (input.relativeAabb.max[0] - input.relativeAabb.min[0]) / 2;
    const halfH = (input.relativeAabb.max[1] - input.relativeAabb.min[1]) / 2;
    const slackX = Math.max(0, input.nodeWidth / 2 - FILM_SET_FIT_MARGIN - halfW);
    const slackY = Math.max(0, input.nodeHeight / 2 - FILM_SET_FIT_MARGIN - halfH);
    const offsetX = Math.max(-slackX, Math.min(slackX, input.offset.x * size));
    const offsetY = Math.max(-slackY, Math.min(slackY, input.offset.y * size));
    const cx = input.nodeX + input.nodeWidth / 2 - (input.relativeAabb.min[0] + input.relativeAabb.max[0]) / 2 + offsetX;
    const cy = input.nodeY + input.nodeHeight / 2 + (input.relativeAabb.min[1] + input.relativeAabb.max[1]) / 2 - offsetY;
    return canvasPointToWorld(cx, cy, input.offset.z * size);
  }
  const cx = input.nodeX + input.nodeWidth / 2 + input.offset.x * size;
  const cardBottom = input.nodeY + input.nodeHeight;
  const top = input.relativeAabb ? Math.max(0, input.relativeAabb.max[1]) : 74.0 - MODEL_CARD_GAP;
  const cy = cardBottom + MODEL_CARD_GAP + top - input.offset.y * size;
  return canvasPointToWorld(cx, cy, input.offset.z * size);
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
