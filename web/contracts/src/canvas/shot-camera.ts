/**
 * 模型镜头（shot camera）取景数学
 * （change: add-model-editor-gizmo-shot-capture，任务 3.1 / design D3）。
 *
 * 纯函数、无副作用：Web 运行时、Bevy 投影与测试共用。移植 Godot `dcf9938:shot_camera.gd`
 * 的轨道、AABB 自动取景、距离 clamp 与正交取景尺寸；只描述**浏览器本地**
 * 派生相机，不进入 ServerCanvas / CanvasCommand / Y.Doc。
 *
 * 持久化的只有 `{id,name,order,azimuth,elevation,distance,aspect?,focusOffset?}`；position、
 * focus、projection、span 都由本模块从当前模型 AABB 与 placement 派生。仰角默认 45°，
 * 可在竖直半圆 `[-90°, +90°]` 内变化（change: add-shot-camera-elevation-control）。
 */
import {
  aabbCenterRadius,
  MODEL_FOCUS_FOV
} from "./model-focus.js";
import {
  SHOT_CAMERA_DEFAULT_ELEVATION,
  SHOT_CAMERA_MAX_ELEVATION,
  SHOT_CAMERA_MIN_ELEVATION
} from "./model-cameras.js";
import { addVec3, crossVec3, lengthVec3, normalizeVec3, scaleVec3, subVec3, type Aabb, type Vec3 } from "./model-transform.js";
import { modelCameraAspectRatio, type ModelCamera } from "./model-cameras.js";

/** 固定仰角（45°；design D3）——作为缺省与兼容默认（change: add-shot-camera-elevation-control）。 */
export const SHOT_CAMERA_ELEVATION = SHOT_CAMERA_DEFAULT_ELEVATION;
/** 仰角规范半圆范围（与 `model-cameras.ts` 一致）。 */
export const SHOT_CAMERA_ELEVATION_RANGE = {
  min: SHOT_CAMERA_MIN_ELEVATION,
  max: SHOT_CAMERA_MAX_ELEVATION
} as const;
/**
 * 拍摄镜头垂直 FOV（弧度）
 * （change: switch-shot-camera-to-perspective）。
 *
 * 与聚焦观察相机一致（`MODEL_FOCUS_FOV`）；拍摄镜头由正交改为透视后用它取景。
 */
export const SHOT_CAMERA_FOV = MODEL_FOCUS_FOV;
/**
 * 拍摄镜头近裁剪面（世界单位）
 * （change: switch-shot-camera-to-perspective）。
 *
 * 透视投影要求 `0 < near < far`，无法真正无 near；取相对目标极小的固定值，使相机贴近或
 * 进入模型时前向几何不被近裁剪面切掉。
 */
export const SHOT_CAMERA_NEAR = 0.001;
/** 自动 fit distance 的下/上系数（design D3）。 */
export const SHOT_CAMERA_FIT_MIN_FACTOR = 0.45;
export const SHOT_CAMERA_FIT_MAX_FACTOR = 2.2;
/**
 * 距离下限的绝对最小值与 fit 比例
 * （change: switch-shot-camera-to-perspective）。
 *
 * 放开下限，使相机能真正拉近到贴近或进入模型（透视 + 极小 near 下仍可见）。
 */
export const SHOT_CAMERA_ABSOLUTE_MIN_DISTANCE = 0.01;
export const SHOT_CAMERA_FIT_MIN_FLOOR_FACTOR = 0.02;
/** 距离上限的绝对最小值（与旧行为一致）。 */
export const SHOT_CAMERA_ABSOLUTE_MAX_DISTANCE = 2.4;
/** 自动取景外扩系数（与聚焦查看一致）。 */
const SHOT_FRAME_PADDING = 1.12;
/** 退化情形下的最小 radius，避免除零。 */
const MIN_RADIUS = 1e-4;

/**
 * 派生相机与手势使用的仰角奇点容差（change: add-shot-camera-elevation-control）。
 *
 * 规范层接受 `[-90°, +90°]`，但实际姿态钳到 `±89°`，避免 camera forward 与世界上方向
 * 共线导致 look-at 退化或翻面。
 */
export const SHOT_CAMERA_ELEVATION_LIMIT = (89 * Math.PI) / 180;

/** 把仰角钳制到奇点容差以内（派生/手势层）；非有限值回退默认 45°。 */
export function clampShotElevation(elevation: number): number {
  if (!Number.isFinite(elevation)) return SHOT_CAMERA_ELEVATION;
  return Math.min(SHOT_CAMERA_ELEVATION_LIMIT, Math.max(-SHOT_CAMERA_ELEVATION_LIMIT, elevation));
}

/** 派生镜头相机（透视；change: switch-shot-camera-to-perspective）。 */
export type ShotCamera = {
  /** 镜头位置（世界坐标）。 */
  position: Vec3;
  /** 观察目标（当前 placement 后模型 AABB 中心）。 */
  focus: Vec3;
  /** 透视垂直 FOV（弧度）。 */
  fov: number;
  /** 方位角（弧度）。 */
  azimuth: number;
  /** 仰角（弧度，竖直半圆 `[-90°, +90°]` 钳入奇点容差）。 */
  elevation: number;
  /** 相机到 focus 距离。 */
  distance: number;
};

/** 由 AABB 求包围球半径（非有限/退化时回退 1）。 */
export function shotBoundingRadius(aabb: Aabb): number {
  const { radius } = aabbCenterRadius(aabb);
  return radius > MIN_RADIUS && Number.isFinite(radius) ? radius : 1;
}

/**
 * 自动 fit distance：Godot bounding-sphere 规则，再乘 padding。
 *
 * 与聚焦查看的 `autoFrameDistance` 同源（垂直 FOV + aspect），但镜头按 16:9 取景。
 */
export function shotFitDistance(radius: number, aspect = 16 / 9): number {
  const safeRadius = radius > MIN_RADIUS && Number.isFinite(radius) ? radius : 1;
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  const verticalHalf = MODEL_FOCUS_FOV / 2;
  const horizontalHalf = Math.atan(Math.tan(verticalHalf) * safeAspect);
  const effectiveHalf = Math.max(1e-3, Math.min(verticalHalf, horizontalHalf));
  return (safeRadius * SHOT_FRAME_PADDING) / Math.sin(effectiveHalf);
}

/** 距离合法范围：下限放开到允许贴近模型，上限为 `max(fit*2.2, 2.4)`（design D3 + switch-shot-camera-to-perspective）。 */
export function shotDistanceBounds(fitDistance: number): { min: number; max: number } {
  const fit = fitDistance > MIN_RADIUS && Number.isFinite(fitDistance) ? fitDistance : 1;
  return {
    min: Math.max(fit * SHOT_CAMERA_FIT_MIN_FLOOR_FACTOR, SHOT_CAMERA_ABSOLUTE_MIN_DISTANCE),
    max: Math.max(fit * SHOT_CAMERA_FIT_MAX_FACTOR, SHOT_CAMERA_ABSOLUTE_MAX_DISTANCE)
  };
}

/** 把距离 clamp 进合法范围；非有限值回退 fit distance。 */
export function clampShotDistance(distance: number, fitDistance: number): number {
  const bounds = shotDistanceBounds(fitDistance);
  if (!Number.isFinite(distance)) return fitDistance;
  return Math.min(bounds.max, Math.max(bounds.min, distance));
}

/**
 * 由方位角、仰角与距离求镜头相机位置：绕世界 Y 轴按 azimuth 环绕、沿竖直半圆按 elevation 抬升/下降。
 *
 * `position = focus + (sin(az)*cos(el), sin(el), cos(az)*cos(el)) * distance`
 * （y 向上世界；与聚焦相机方向约定一致）。`el = 0` 为水平，`+90°` 为正上方，`-90°` 为正下方。
 */
export function shotCameraPosition(focus: Vec3, azimuth: number, distance: number, elevation = SHOT_CAMERA_ELEVATION): Vec3 {
  const el = clampShotElevation(elevation);
  const cosEl = Math.cos(el);
  const dir: Vec3 = [Math.sin(azimuth) * cosEl, Math.sin(el), Math.cos(azimuth) * cosEl];
  return addVec3(focus, scaleVec3(dir, distance));
}

/**
 * 透视取景垂直 FOV（弧度）
 * （change: switch-shot-camera-to-perspective）。
 *
 * 透视下取景由 FOV 决定，不再有随距离缩放的正交半高；`distance` 只改变相机位置与
 * 到目标的距离。保留焦点平面处的世界高度换算（供距离拖动灵敏度使用）。
 */
export function shotFov(): number {
  return SHOT_CAMERA_FOV;
}

/**
 * 焦点平面处的世界高度（垂直方向）：`2 * distance * tan(fov/2)`
 * （change: switch-shot-camera-to-perspective）。
 *
 * 透视下屏幕像素与世界单位的换算依赖到焦点的距离；用它替代正交的 `orthoSize`。
 */
export function shotFocusPlaneHeight(distance: number, fov = SHOT_CAMERA_FOV): number {
  const safeDistance = Number.isFinite(distance) ? distance : 1;
  const safeFov = fov > 0 && fov < Math.PI && Number.isFinite(fov) ? fov : SHOT_CAMERA_FOV;
  return 2 * safeDistance * Math.tan(safeFov / 2);
}

/**
 * 从当前模型 AABB 与镜头记录派生完整透视相机（design D3；change: 模型编辑 gizmo 焦点 /
 * add-shot-camera-elevation-control / switch-shot-camera-to-perspective）。
 *
 * 有效 focus = placement 后模型 AABB 中心 + 镜头 `focusOffset`（缺省零偏移）。distance 以
 * 模型包围球半径自动 fit 并 clamp；focus 偏移不改变自动 fit 的半径基准（仍按模型 AABB）。
 * elevation 缺省 45°，钳入奇点容差。AABB 非法/退化时返回 null。
 */
export function resolveShotCamera(
  aabb: Aabb,
  camera: Pick<ModelCamera, "azimuth" | "distance"> &
    Partial<Pick<ModelCamera, "focusOffset" | "aspect" | "elevation">>
): ShotCamera | null {
  const values = [...aabb.min, ...aabb.max];
  if (!values.every((value) => Number.isFinite(value))) return null;
  const { center, radius } = aabbCenterRadius(aabb);
  const safeRadius = radius > MIN_RADIUS ? radius : 1;
  const aspect = modelCameraAspectRatio(camera.aspect);
  const fitDistance = shotFitDistance(safeRadius, aspect);
  const distance = clampShotDistance(camera.distance, fitDistance);
  const elevation = clampShotElevation(camera.elevation ?? SHOT_CAMERA_ELEVATION);
  const offset = camera.focusOffset;
  const focus: Vec3 =
    offset && Number.isFinite(offset.x) && Number.isFinite(offset.y) && Number.isFinite(offset.z)
      ? addVec3(center, [offset.x, offset.y, offset.z])
      : center;
  return {
    position: shotCameraPosition(focus, camera.azimuth, distance, elevation),
    focus,
    fov: SHOT_CAMERA_FOV,
    azimuth: camera.azimuth,
    elevation,
    distance
  };
}

/**
 * 方位环拖动：一次横向拖动一屏（`surfaceWidth` CSS px）对应一周（design D3 退化回退，
 * 同时作为常规灵敏度的参考实现）。
 */
export function azimuthFromHorizontalDrag(startAzimuth: number, deltaX: number, surfaceWidth: number): number {
  const safeWidth = surfaceWidth > 1 && Number.isFinite(surfaceWidth) ? surfaceWidth : 1;
  return startAzimuth + (deltaX / safeWidth) * Math.PI * 2;
}

/**
 * 竖直半圆拖动（change: add-shot-camera-elevation-control）：一屏竖直拖动对应 180°。
 *
 * `deltaPixels` 为相对起始点的屏幕 y 位移（向下为正）。约定向下拖 → 仰角减小（相机下移、
 * 更仰视），向上拖 → 仰角增大（相机上移、更俯视）。结果 clamp 到奇点容差以内。
 */
export function elevationFromVerticalDrag(startElevation: number, deltaPixels: number, surfaceHeight: number): number {
  const safeHeight = surfaceHeight > 1 && Number.isFinite(surfaceHeight) ? surfaceHeight : 1;
  const delta = Number.isFinite(deltaPixels) ? deltaPixels : 0;
  return clampShotElevation(startElevation - (delta / safeHeight) * Math.PI);
}

/**
 * 距离手柄拖动：把屏幕指针位移换算为距离变化，再 clamp 到合法范围。
 *
 * `deltaPixels` 为相对起始点的**屏幕 y 位移**（向下为正）。约定：把 handle 朝 focus 方向
 * （屏幕上向下，因相机默认俯视）拖动 → 拉近；反向拖动 → 推远。返回 clamp 后的 distance。
 * 透视下用焦点平面高度换算世界/像素（change: 2026-10-07-remove-residual-compatibility：
 * 删除不再使用的 `span` 参数）。
 */
export function distanceFromDrag(input: {
  startDistance: number;
  deltaPixels: number;
  surfaceHeight: number;
  fitDistance: number;
}): number {
  const safeHeight = input.surfaceHeight > 1 && Number.isFinite(input.surfaceHeight) ? input.surfaceHeight : 1;
  const worldPerPixel = shotFocusPlaneHeight(input.startDistance) / safeHeight;
  // 向下（正）→ 朝 focus 靠拢 → 距离变小。
  const deltaWorld = -input.deltaPixels * worldPerPixel;
  return clampShotDistance(input.startDistance + deltaWorld, input.fitDistance);
}

/**
 * 主画面滚轮/触控板：把 `deltaY` 换成当前镜头 distance 的乘性变化，再 clamp 到 fit 边界。
 *
 * `deltaY` 向下为正，距离变大。`deltaMode === 1` 按行而不是像素计灵敏度。
 */
export function shotDistanceFromWheel(input: {
  distance: number;
  deltaY: number;
  deltaMode: number;
  fitDistance: number;
}): number {
  const sensitivity = input.deltaMode === 1 ? 0.03 : 0.0015;
  const delta = Number.isFinite(input.deltaY) ? input.deltaY : 0;
  const factor = Math.exp(delta * sensitivity);
  return clampShotDistance(input.distance * factor, input.fitDistance);
}

/**
 * 主画面捏合：`scale` 为相对手势起点的倍数。分开手指（scale > 1）缩短 distance。
 */
export function shotDistanceFromScale(input: {
  distance: number;
  scale: number;
  fitDistance: number;
}): number {
  if (!Number.isFinite(input.scale) || input.scale <= 0) {
    return clampShotDistance(input.distance, input.fitDistance);
  }
  return clampShotDistance(input.distance / input.scale, input.fitDistance);
}

/** 相机的 forward（-Z 指向 focus）；供渲染层与测试校验朝向。 */
export function shotCameraForward(camera: ShotCamera): Vec3 {
  const forward = subVec3(camera.focus, camera.position);
  const length = lengthVec3(forward);
  if (length <= MIN_RADIUS) return [0, 0, -1];
  return normalizeVec3(forward);
}

/** 相机右方向（forward × up）。 */
export function shotCameraRight(camera: ShotCamera): Vec3 {
  const right = crossVec3(shotCameraForward(camera), [0, 1, 0]);
  const length = lengthVec3(right);
  return length <= MIN_RADIUS ? [1, 0, 0] : normalizeVec3(right);
}
