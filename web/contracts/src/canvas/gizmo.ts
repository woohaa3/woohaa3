/**
 * 编辑 gizmo 投影与屏幕空间命中
 * （change: add-model-editor-gizmo-shot-capture，任务 2.2 / 3.2 / design D1/D3）。
 *
 * 纯函数、无副作用：把模型 placement gizmo（相机朝向平面位移中心 + 世界 Y 轴 yaw 环）与
 * 镜头 shot gizmo（水平方位环 + 竖直仰角半圆 + 距离段 + frustum）投影到屏幕，并按**固定
 * CSS 像素**命中宽度解析被拖动的 handle。Web 运行时用同一结果绘制（Bevy）与命中，保证画面与命中一致。
 *
 * 只描述**浏览器本地**的编辑 affordance，不进入 ServerCanvas / CanvasCommand / Y.Doc；
 * 不提供逐轴平移、X/Z 旋转、roll 或任何 scale handle。
 */
import type { ModelFocusCamera } from "./model-focus.js";
import { crossVec3, dotVec3, lengthVec3, normalizeVec3, subVec3, type Vec3 } from "./model-transform.js";

/** 命中阈值（CSS px；design D3）。 */
export const SHOT_RING_HIT_RADIUS_CSS = 28;
export const SHOT_ORIGIN_HIT_RADIUS_CSS = 36;
export const SHOT_DISTANCE_SEGMENT_HIT_CSS = 14;
/** 竖直半圆命中阈值（CSS px；change: add-shot-camera-elevation-control）。 */
export const SHOT_ELEVATION_RING_HIT_CSS = 24;
/** 模型 gizmo 命中阈值（CSS px）。 */
export const MODEL_GIZMO_CENTER_HIT_CSS = 18;
export const MODEL_GIZMO_RING_HIT_CSS = 12;

export type ScreenPoint = { x: number; y: number };
export type ScreenSurface = { width: number; height: number };

/** 世界点 → 屏幕点（含相机透视/正交投影）；不可投影返回 null。 */
export type Projector = (world: Vec3) => ScreenPoint | null;

export type GizmoHandle = "center" | "yaw-ring" | "orbit-ring" | "elevation-ring" | "distance" | "shot-origin";

export type GizmoHit = { handle: GizmoHandle; distanceCss: number };

/** 点到线段的最短距离（CSS px）。 */
export function distanceToSegment(point: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  if (lengthSq <= 1e-9) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + abx * t), point.y - (a.y + aby * t));
}

/**
 * 模型 placement gizmo 的世界几何：中心点、yaw 环半径、环所在平面。
 *
 * 中心 = 模型 focus（AABB 中心）；yaw 环位于过中心的水平面（世界 Y 轴法线），半径取
 * 包围球半径的固定比例（屏幕投影后仍可命中）。
 */
export type ModelGizmoGeometry = {
  center: Vec3;
  /** 世界 Y 轴环半径。 */
  ringRadius: number;
};

export function modelGizmoGeometry(input: { focus: Vec3; radius: number }): ModelGizmoGeometry {
  const radius = input.radius > 1e-3 && Number.isFinite(input.radius) ? input.radius : 1;
  return { center: input.focus, ringRadius: radius * 1.15 };
}

/** yaw 环的世界采样点（世界 Y 轴水平环）。 */
export function yawRingPoints(geometry: ModelGizmoGeometry, segments = 48): Vec3[] {
  const points: Vec3[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    points.push([
      geometry.center[0] + Math.cos(angle) * geometry.ringRadius,
      geometry.center[1],
      geometry.center[2] + Math.sin(angle) * geometry.ringRadius
    ]);
  }
  return points;
}

/**
 * 命中模型 placement gizmo：优先中心 handle，其次 yaw 环。
 *
 * 使用固定 CSS 像素阈值；不可投影的采样被跳过。
 */
export function hitModelGizmo(input: {
  pointer: ScreenPoint;
  geometry: ModelGizmoGeometry;
  project: Projector;
}): GizmoHit | null {
  const center = input.project(input.geometry.center);
  if (center) {
    const centerDistance = Math.hypot(input.pointer.x - center.x, input.pointer.y - center.y);
    if (centerDistance <= MODEL_GIZMO_CENTER_HIT_CSS) return { handle: "center", distanceCss: centerDistance };
  }
  const ring = yawRingPoints(input.geometry);
  let best: GizmoHit | null = null;
  for (let index = 0; index < ring.length; index += 1) {
    const a = input.project(ring[index]!);
    const b = input.project(ring[(index + 1) % ring.length]!);
    if (!a || !b) continue;
    const distance = distanceToSegment(input.pointer, a, b);
    if (distance <= MODEL_GIZMO_RING_HIT_CSS && (!best || distance < best.distanceCss)) {
      best = { handle: "yaw-ring", distanceCss: distance };
    }
  }
  return best;
}

/** 镜头 shot gizmo 世界几何：focus、相机位置、方位环半径。 */
export type ShotGizmoGeometry = {
  focus: Vec3;
  cameraPosition: Vec3;
  /** 方位环半径（世界单位）。 */
  ringRadius: number;
};

export function shotGizmoGeometry(input: {
  focus: Vec3;
  cameraPosition: Vec3;
  distance: number;
  radius: number;
}): ShotGizmoGeometry {
  const radius = input.radius > 1e-3 && Number.isFinite(input.radius) ? input.radius : 1;
  return { focus: input.focus, cameraPosition: input.cameraPosition, ringRadius: radius * 1.15 };
}

/** 以 focus 为心的水平方位环采样点（球笼赤道：半径 = 相机到焦点的完整距离）。 */
export function shotOrbitPoints(geometry: ShotGizmoGeometry, segments = 48): Vec3[] {
  const d = subVec3(geometry.cameraPosition, geometry.focus);
  // 赤道半径取相机到焦点的完整距离（拖动方位/仰角时不变），使 gizmo 成为稳定球笼；
  // 若用水平投影（d·cos el），拖动仰角会让整条环随 cos 缩放。
  const distance = lengthVec3(d);
  const ringRadius = distance > 1e-3 ? distance : geometry.ringRadius;
  const points: Vec3[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    points.push([
      geometry.focus[0] + Math.cos(angle) * ringRadius,
      geometry.focus[1],
      geometry.focus[2] + Math.sin(angle) * ringRadius
    ]);
  }
  return points;
}

/**
 * 竖直半圆仰角轨道采样点（change: add-shot-camera-elevation-control）。
 *
 * 位于「过 focus、包含世界 Y 轴与当前方位径向」的竖直平面内，从 `-90°`（正下方）经水平
 * 到 `+90°`（正上方）。半径与方位环一致，使两条轨道形成同一尺寸的笼状。
 * 返回**开弧**采样（端点包含，共 `segments + 1` 个点）。
 */
export function shotElevationSemicirclePoints(geometry: ShotGizmoGeometry, segments = 32): Vec3[] {
  const d = subVec3(geometry.cameraPosition, geometry.focus);
  const horizontal = Math.hypot(d[0], d[2]);
  // 半圆半径取相机到焦点的**完整距离**（拖动仰角时不变），相机在各仰角都落在这条弧上；
  // 若改用水平投影（d·cos el），拖动仰角会让整条弧随 cos 缩放。
  const distance = lengthVec3(d);
  const radius = distance > 1e-3 ? distance : geometry.ringRadius;
  const radial: Vec3 = horizontal > 1e-3 ? [d[0] / horizontal, 0, d[2] / horizontal] : [0, 0, 1];
  const points: Vec3[] = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = -Math.PI / 2 + (index / segments) * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    points.push([
      geometry.focus[0] + radial[0] * cos * radius,
      geometry.focus[1] + sin * radius,
      geometry.focus[2] + radial[2] * cos * radius
    ]);
  }
  return points;
}

/**
 * 命中 shot gizmo：优先镜头原点（36px），其次水平方位环（28px）与竖直半圆（24px），
 * 最后距离段（14px）。
 */
export function hitShotGizmo(input: {
  pointer: ScreenPoint;
  geometry: ShotGizmoGeometry;
  project: Projector;
}): GizmoHit | null {
  const origin = input.project(input.geometry.cameraPosition);
  if (origin) {
    const d = Math.hypot(input.pointer.x - origin.x, input.pointer.y - origin.y);
    if (d <= SHOT_ORIGIN_HIT_RADIUS_CSS) return { handle: "shot-origin", distanceCss: d };
  }
  const ring = shotOrbitPoints(input.geometry);
  let best: GizmoHit | null = null;
  for (let index = 0; index < ring.length; index += 1) {
    const a = input.project(ring[index]!);
    const b = input.project(ring[(index + 1) % ring.length]!);
    if (!a || !b) continue;
    const distance = distanceToSegment(input.pointer, a, b);
    if (distance <= SHOT_RING_HIT_RADIUS_CSS && (!best || distance < best.distanceCss)) {
      best = { handle: "orbit-ring", distanceCss: distance };
    }
  }
  if (best) return best;
  // 竖直半圆：与水平环同优先级段，命中距离更近者胜出（change: add-shot-camera-elevation-control）。
  const semicircle = shotElevationSemicirclePoints(input.geometry);
  for (let index = 0; index < semicircle.length - 1; index += 1) {
    const a = input.project(semicircle[index]!);
    const b = input.project(semicircle[index + 1]!);
    if (!a || !b) continue;
    const distance = distanceToSegment(input.pointer, a, b);
    if (distance <= SHOT_ELEVATION_RING_HIT_CSS && (!best || distance < best.distanceCss)) {
      best = { handle: "elevation-ring", distanceCss: distance };
    }
  }
  if (best) return best;
  const focus = input.project(input.geometry.focus);
  if (origin && focus) {
    const distance = distanceToSegment(input.pointer, origin, focus);
    if (distance <= SHOT_DISTANCE_SEGMENT_HIT_CSS) return { handle: "distance", distanceCss: distance };
  }
  return null;
}

/**
 * 由聚焦相机（透视）构造世界 → 屏幕投影器。
 *
 * 与 `focusRay` 一致的针孔模型：相机基 + fov + surface，屏幕 y 向下。不可投影返回 null。
 */
export function makeFocusProjector(input: {
  camera: ModelFocusCamera;
  surface: ScreenSurface;
  fov: number;
}): Projector {
  const cameraPosition = focusCameraPositionLocal(input.camera);
  const forward = normalizeVec3(subVec3(input.camera.target, cameraPosition));
  const right = normalizeVec3(crossVec3(forward, [0, 1, 0]));
  const up = crossVec3(right, forward);
  const width = input.surface.width > 0 ? input.surface.width : 1;
  const height = input.surface.height > 0 ? input.surface.height : 1;
  const focal = height / (2 * Math.tan(input.fov / 2));
  return (world: Vec3): ScreenPoint | null => {
    const rel = subVec3(world, cameraPosition);
    const z = dotVec3(rel, forward);
    if (!Number.isFinite(z) || z <= 1e-4) return null;
    const x = dotVec3(rel, right);
    const y = dotVec3(rel, up);
    return {
      x: width / 2 + (x * focal) / z,
      y: height / 2 - (y * focal) / z
    };
  };
}

/**
 * 拍摄镜头投影器：透视针孔模型
 * （change: switch-shot-camera-to-perspective）。
 *
 * 与聚焦相机投影（`makeFocusProjector`）同源：世界点经相机基（forward/right/up）分解后按
 * `focal/z` 投影，`focal = height / (2*tan(fov/2))`。相机后方（`z <= eps`）不可投影。
 */
export function makeShotProjector(input: {
  focus: Vec3;
  cameraPosition: Vec3;
  fov: number;
  surface: ScreenSurface;
}): Projector {
  const forward = normalizeVec3(subVec3(input.focus, input.cameraPosition));
  if (lengthVec3(forward) < 1e-6) return () => null;
  const right = normalizeVec3(crossVec3(forward, [0, 1, 0]));
  const up = crossVec3(right, forward);
  const width = input.surface.width > 0 ? input.surface.width : 1;
  const height = input.surface.height > 0 ? input.surface.height : 1;
  const fov = Number.isFinite(input.fov) && input.fov > 0 && input.fov < Math.PI ? input.fov : Math.PI / 3;
  const focal = height / (2 * Math.tan(fov / 2));
  return (world: Vec3): ScreenPoint | null => {
    const rel = subVec3(world, input.cameraPosition);
    const z = dotVec3(rel, forward);
    const x = dotVec3(rel, right);
    const y = dotVec3(rel, up);
    if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (z <= 1e-4) {
      // 相机自身眼点位于视轴上，透视下退化为投影中心（镜头 gizmo 的 origin handle）；
      // 其它近/后点不可投影，避免穿模命中。
      if (Math.hypot(x, y) <= 1e-4) return { x: width / 2, y: height / 2 };
      return null;
    }
    const px = width / 2 + (x * focal) / z;
    const py = height / 2 - (y * focal) / z;
    return Number.isFinite(px) && Number.isFinite(py) ? { x: px, y: py } : null;
  };
}

/** 局部复现聚焦相机位置（避免循环依赖 focusPointerRay）。 */
function focusCameraPositionLocal(camera: ModelFocusCamera): Vec3 {
  const dir: Vec3 = [
    Math.sin(camera.yaw) * Math.cos(camera.pitch),
    -Math.sin(camera.pitch),
    Math.cos(camera.yaw) * Math.cos(camera.pitch)
  ];
  return [
    camera.target[0] + dir[0] * camera.distance,
    camera.target[1] + dir[1] * camera.distance,
    camera.target[2] + dir[2] * camera.distance
  ];
}

/** 便捷：世界向量绕 Y 轴旋转给定角度（gizmo 绘制与命中测试共用）。 */
export function rotateY(vector: Vec3, radians: number): Vec3 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [vector[0] * cos + vector[2] * sin, vector[1], -vector[0] * sin + vector[2] * cos];
}

// ── 焦点三轴位移 gizmo（change: 模型编辑 gizmo 焦点 / replace-model-node-focus-interactions） ──

/** 焦点 gizmo 轴（世界坐标）。 */
export type FocusAxis = "x" | "y" | "z";

/** 焦点 gizmo 轴命中阈值（CSS px）。 */
export const FOCUS_GIZMO_AXIS_HIT_CSS = 12;

/** 焦点三轴 gizmo 的世界几何：原点 + 三轴端点（长度按模型半径缩放）。 */
export type FocusGizmoGeometry = {
  origin: Vec3;
  axisLength: number;
  x: Vec3;
  y: Vec3;
  z: Vec3;
};

/** 由焦点与模型半径构造三轴 gizmo；半径非法时回退 1。 */
export function focusGizmoGeometry(input: { focus: Vec3; radius: number }): FocusGizmoGeometry {
  const radius = input.radius > 1e-3 && Number.isFinite(input.radius) ? input.radius : 1;
  const length = radius * 1.15;
  return {
    origin: input.focus,
    axisLength: length,
    x: [input.focus[0] + length, input.focus[1], input.focus[2]],
    y: [input.focus[0], input.focus[1] + length, input.focus[2]],
    z: [input.focus[0], input.focus[1], input.focus[2] + length]
  };
}

/**
 * 命中焦点三轴 gizmo：在阈值内取距离最近的轴；无命中返回 null。
 *
 * 只暴露 X/Y/Z 三个平移轴（不含旋转/缩放/统一 handle）；不可投影的轴被跳过。
 */
export function hitFocusGizmo(input: {
  pointer: ScreenPoint;
  geometry: FocusGizmoGeometry;
  project: Projector;
}): { axis: FocusAxis; distanceCss: number } | null {
  const origin = input.project(input.geometry.origin);
  let best: { axis: FocusAxis; distanceCss: number } | null = null;
  const axes: ReadonlyArray<[FocusAxis, Vec3]> = [
    ["x", input.geometry.x],
    ["y", input.geometry.y],
    ["z", input.geometry.z]
  ];
  for (const [axis, endpoint] of axes) {
    const tip = input.project(endpoint);
    if (!origin || !tip) continue;
    const distance = distanceToSegment(input.pointer, origin, tip);
    if (distance <= FOCUS_GIZMO_AXIS_HIT_CSS && (!best || distance < best.distanceCss)) {
      best = { axis, distanceCss: distance };
    }
  }
  return best;
}

/**
 * 轴拖动 → 世界位移：把屏幕拖动投影到该轴的屏幕方向，再按「世界长度 / 屏幕像素」换算。
 *
 * `axisScreen` 为该轴的屏幕线段（起点=焦点，终点=轴端点）。线段退化（投影失败/长度为 0）
 * 时返回 `null`（跳过该采样，不产生跳变）。返回沿该轴的**世界**位移（可为负）。
 */
export function focusAxisDragWorldDelta(input: {
  axis: FocusAxis;
  deltaScreen: ScreenPoint;
  axisStart: ScreenPoint;
  axisEnd: ScreenPoint;
  axisLength: number;
}): number | null {
  const sx = input.axisEnd.x - input.axisStart.x;
  const sy = input.axisEnd.y - input.axisStart.y;
  const screenLength = Math.hypot(sx, sy);
  if (!Number.isFinite(screenLength) || screenLength < 1e-3) return null;
  if (!(input.axisLength > 0) || !Number.isFinite(input.axisLength)) return null;
  const ux = sx / screenLength;
  const uy = sy / screenLength;
  const projected = input.deltaScreen.x * ux + input.deltaScreen.y * uy;
  const worldPerPixel = input.axisLength / screenLength;
  const delta = projected * worldPerPixel;
  return Number.isFinite(delta) ? delta : null;
}
