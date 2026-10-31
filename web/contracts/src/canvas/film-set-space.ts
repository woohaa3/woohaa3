/**
 * 片场场景空间 ↔ 画布呈现空间的纯数学
 * （change: 2026-10-23-isolate-film-set-camera-space，design D1/D2）。
 *
 * 片场作品的内容（几何、媒体、镜头距离、焦点偏移、镜头运动）全部使用**场景单位**；画布节点矩形
 * 与画布 viewport 只决定呈现。内容与完整相机姿态共享同一个正等比相似变换：
 *
 * ```
 * world = anchor + s * R(yaw) * scene
 * s     = min(placement.scale, 1) * CANVAS_UNITS_PER_METER * filmSetFit   （= Rust `model_unit`）
 * ```
 *
 * 场景单位就是米：`CANVAS_UNITS_PER_METER` 固定为 64，不再除以 `extent`
 * （change: 2026-10-31-render-models-at-absolute-metric-scale）。
 * 因此透视除法中的 x/z、y/z 不变，屏幕构图不随呈现倍率变化；FOV/aspect/镜头角度留在场景空间。
 * 任何非有限值或非正倍率都显式失败，不构造可产生 NaN 的镜头。
 *
 * 纯函数、无副作用：前端适配、Bevy wire 投影、原生 renderer 与测试共用。Rust 同一公式在
 * `client/bevy/src/model3d/shot_adapter.rs::DisplayUnit` 与 `sample_camera_pose`，共享 fixture 对齐。
 */
import { CANVAS_UNITS_PER_METER } from "./model-focus/types.js";
import { quatRotate, type Vec3 } from "./model-transform.js";
import type { BevyModelPlacement } from "./render-scene/wire-model.js";

/** 场景单位 → 画布世界单位的显示变换（只含等比倍率与绕 Y 轴旋转）。 */
export type FilmSetDisplayTransform = {
  /** 正等比倍率；`world = anchor + scale * R(yaw) * scene`。 */
  scale: number;
  /** 显示容器绕世界 Y 轴 yaw（弧度）。 */
  yaw: number;
};

export type FilmSetDisplayTransformResult =
  | { ok: true; value: FilmSetDisplayTransform }
  | { ok: false; reason: string };

/** 场景空间镜头状态（与 canonical `initialCamera` / `ModelCamera` 同单位）。 */
export type FilmSetSceneCamera = {
  azimuth: number;
  elevation: number;
  distance: number;
  focusOffset: { x: number; y: number; z: number };
};

/** 画布显示用的相机参数（相对世界包围球中心）。 */
export type FilmSetWorldCamera = {
  distance: number;
  focusOffset: Vec3;
  /** 世界方位角（场景方位角 + 容器 yaw）；相机位置必须等于 `D(sceneCameraPosition)`。 */
  azimuth: number;
};

/**
 * 场景单位 → 画布世界的自然倍率（**不含**节点矩形容器适配，与 Rust `model_unit` 同式）。
 *
 * 绝对米制：`min(placement.scale,1) × CANVAS_UNITS_PER_METER`，不除以 `extent`
 * （change: 2026-10-31-render-models-at-absolute-metric-scale）。片场内容脚本按真实尺度建模
 * （站立人物约 1.7 场景单位），因此片场整场的真实大小直接决定它在画布上的大小。节点矩形适配
 * （`filmSetFit`）与画布 zoom 不在这里，因此离屏生产输出可以直接使用它而与呈现无关
 * （design D1/D4）。
 */
export function filmSetNaturalScale(placement: BevyModelPlacement | null, _extent?: number): number {
  const raw = placement?.scale ?? 1;
  const placementScale = Number.isFinite(raw) && raw > 0 ? raw : 1;
  return Math.min(placementScale, 1) * CANVAS_UNITS_PER_METER;
}

/** 显示容器绕 Y 轴旋转（弧度）。 */
export function filmSetDisplayYaw(placement: BevyModelPlacement | null): number {
  const yaw = placement?.yaw ?? 0;
  return Number.isFinite(yaw) ? (yaw * Math.PI) / 180 : 0;
}

/** 校验并构造显示变换（有限、正的等比倍率与有限 yaw）。 */
export function filmSetDisplayTransform(input: {
  scale: number;
  yaw: number;
}): FilmSetDisplayTransformResult {
  if (!Number.isFinite(input.scale) || input.scale <= 0) {
    return { ok: false, reason: `片场显示倍率必须是有限正数（实际 ${input.scale}）` };
  }
  if (!Number.isFinite(input.yaw)) {
    return { ok: false, reason: `片场显示旋转必须是有限数值（实际 ${input.yaw}）` };
  }
  return { ok: true, value: { scale: input.scale, yaw: input.yaw } };
}

/**
 * 由模型资源、placement 与节点矩形容器适配系数派生显示变换。
 *
 * `fit` 缺省 1：离屏生产、静态图片参考等不使用节点矩形的链路据此保持与画布尺寸无关。
 */
export function filmSetDisplayTransformFor(input: {
  placement: BevyModelPlacement | null;
  extent: number;
  fit?: number;
}): FilmSetDisplayTransformResult {
  const fit = input.fit === undefined ? 1 : input.fit;
  if (!Number.isFinite(fit) || fit <= 0) {
    return { ok: false, reason: `片场适配系数必须是有限正数（实际 ${fit}）` };
  }
  return filmSetDisplayTransform({
    scale: filmSetNaturalScale(input.placement, input.extent) * fit,
    yaw: filmSetDisplayYaw(input.placement)
  });
}

/** 场景点 → 画布世界点（锚点已知时使用）。 */
export function mapFilmSetScenePoint(
  transform: FilmSetDisplayTransform,
  anchor: Vec3,
  point: Vec3
): Vec3 | null {
  const rotated = quatRotate(yawQuat(transform.yaw), point);
  const mapped: Vec3 = [
    anchor[0] + rotated[0] * transform.scale,
    anchor[1] + rotated[1] * transform.scale,
    anchor[2] + rotated[2] * transform.scale
  ];
  return mapped.every((value) => Number.isFinite(value)) ? mapped : null;
}

/** 场景向量 → 画布世界向量（不含平移）。 */
export function mapFilmSetSceneVector(
  transform: FilmSetDisplayTransform,
  vector: Vec3
): Vec3 | null {
  const rotated = quatRotate(yawQuat(transform.yaw), vector);
  const mapped: Vec3 = [
    rotated[0] * transform.scale,
    rotated[1] * transform.scale,
    rotated[2] * transform.scale
  ];
  return mapped.every((value) => Number.isFinite(value)) ? mapped : null;
}

/** 画布世界向量 → 场景向量（逆旋转、逆缩放）。 */
export function unmapFilmSetSceneVector(
  transform: FilmSetDisplayTransform,
  vector: Vec3
): Vec3 | null {
  const scaled: Vec3 = [
    vector[0] / transform.scale,
    vector[1] / transform.scale,
    vector[2] / transform.scale
  ];
  const unrotated = quatRotate(yawQuat(-transform.yaw), scaled);
  return unrotated.every((value) => Number.isFinite(value)) ? unrotated : null;
}

/** 画布世界距离 → 场景距离（手势逆映射）。 */
export function unmapFilmSetSceneDistance(
  transform: FilmSetDisplayTransform,
  distance: number
): number | null {
  const value = distance / transform.scale;
  return Number.isFinite(value) ? value : null;
}

/** 场景距离 → 画布世界距离。 */
export function mapFilmSetSceneDistance(transform: FilmSetDisplayTransform, distance: number): number | null {
  const value = distance * transform.scale;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 把场景镜头映射为画布显示镜头。
 *
 * 距离与焦点偏移按同一倍率缩放，焦点偏移与方位角同时按容器旋转（`azimuth_world = azimuth + yaw`，
 * 因为相机位置 `focus + dir(azimuth) × distance` 必须等于 `D(sceneCameraPosition)`）。仰角、
 * FOV 与 aspect 保持场景语义不变。`centerWorld` 是内容在世界中的包围球中心（`D(sceneCenter)`）。
 */
export function mapFilmSetSceneCamera(
  transform: FilmSetDisplayTransform,
  centerWorld: Vec3,
  camera: FilmSetSceneCamera
): FilmSetWorldCamera | null {
  if (!centerWorld.every((value) => Number.isFinite(value))) return null;
  if (!Number.isFinite(camera.distance) || camera.distance <= 0) return null;
  if (!Number.isFinite(camera.azimuth) || !Number.isFinite(camera.elevation)) return null;
  const offset: Vec3 = [camera.focusOffset.x, camera.focusOffset.y, camera.focusOffset.z];
  if (!offset.every((value) => Number.isFinite(value))) return null;
  const focusOffset = mapFilmSetSceneVector(transform, offset);
  const distance = mapFilmSetSceneDistance(transform, camera.distance);
  if (!focusOffset || distance === null) return null;
  return { distance, focusOffset, azimuth: camera.azimuth + transform.yaw };
}

/**
 * 场景相机姿态 → 画布世界姿态（含 position/focus/distane）。
 *
 * 三个关键点都按同一相似变换映射，因此屏幕构图与显示倍率无关（design D2）。任一点或距离非法
 * 时返回 `null`，调用方不得写入或渲染猜测的镜头。
 */
export function mapFilmSetShotPose(
  transform: FilmSetDisplayTransform,
  anchor: Vec3,
  pose: { position: Vec3; focus: Vec3; distance: number }
): { position: Vec3; focus: Vec3; distance: number } | null {
  const focus = mapFilmSetScenePoint(transform, anchor, pose.focus);
  const position = mapFilmSetScenePoint(transform, anchor, pose.position);
  const distance = mapFilmSetSceneDistance(transform, pose.distance);
  if (!focus || !position || distance === null) return null;
  return { position, focus, distance };
}

/**
 * 场景 AABB（**场景单位**，与镜头 distance/focusOffset 同尺度）。
 *
 * 场景单位就是内容脚本单位（站立人物约 1.7），item offset、媒体尺寸与镜头都用它。`placement`
 * 的 scale/节点矩形适配/画布 zoom 都属于呈现，不进入场景值；这里只做有限性检查。
 */
export function filmSetSceneAabb(local: { min: Vec3; max: Vec3 } | null): { min: Vec3; max: Vec3 } | null {
  if (!local) return null;
  if (![...local.min, ...local.max].every((value) => Number.isFinite(value))) return null;
  return { min: [...local.min] as Vec3, max: [...local.max] as Vec3 };
}

/** 场景 yaw → 四元数（绕世界 Y 轴）。 */
function yawQuat(yaw: number): [number, number, number, number] {
  const half = yaw / 2;
  return [0, Math.sin(half), 0, Math.cos(half)];
}
