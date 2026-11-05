/**
 * 聚焦模型 placement 直接编辑的共享数学
 * （change: add-model-focus-editing，任务 1.2；design D1/D5）。
 *
 * 本模块无副作用、纯函数：Web 运行时与测试共用。它只描述**浏览器本地**的聚焦编辑数学
 * ——聚焦相机 ray、ray-AABB、camera-facing ray-plane、world delta 与 placement offset 的
 * 逆换算，以及 yaw/scale 的编辑规则。它不进入 ServerCanvas / CanvasCommand / Y.Doc。
 *
 * 与 `model-focus.ts` 共享相机/FOV/坐标约定：聚焦相机 ray 用同一 yaw/pitch/distance/target
 * 与 surface aspect 计算，因此命中与画面一致；placement offset 的换算与 Rust `model_anchor`
 * 的 `offset * 64 * zoom` 一致。
 */
import {
  canvasCameraRotation,
  focusRay,
  MODEL_FOCUS_FOV,
  viewRotation,
  type ModelFocusCamera,
  type Ray
} from "./model-focus.js";
import {
  addVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  quatRotate,
  scaleVec3,
  subVec3,
  type Aabb,
  type Vec3
} from "./model-transform.js";
import type { BevyModelPlacement } from "./render-scene.js";

export type { Ray } from "./model-focus.js";

/** Shift 拖动旋转灵敏度（弧度 / CSS px；design D1）。 */
export const MODEL_EDIT_YAW_RADIANS_PER_PX = 0.02;
/** DOM 单值等比 scale 的编辑范围（design D1）。 */
export const MODEL_SCALE_MIN = 0.35;
export const MODEL_SCALE_MAX = 4.0;
/** placement offset 的单位基准（固定 64 世界单位；change: make-shot-framing-zoom-invariant）。 */
export const MODEL_OFFSET_BASE = 64.0;

/** 编辑用 placement 草稿（与 `parameterPreviewStore` 的 `ModelPlacementDraft` 同构）。 */
export type PlacementDraft = {
  offset: { x: number; y: number; z: number };
  scale: number;
  yaw: number;
};

/**
 * clamp 用户编辑的 scale 到 `0.35..4.0`；非有限值回退 1。
 *
 * 只用于**用户首次编辑 scale**（design D1 / 任务 3.3）：旧 canonical 越界值仍可渲染，
 * 不做数据迁移。
 */
export function clampModelScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MODEL_SCALE_MAX, Math.max(MODEL_SCALE_MIN, scale));
}

/**
 * placement offset 的世界单位换算基准（固定 64；不再乘 viewport zoom）。
 *
 * 模型世界由固定画布嵌入 `world = R × (offset.x*64, offset.y*64, offset.z*64)` 决定
 * （change: make-shot-framing-zoom-invariant，design D2/D5），viewport 不参与。
 */
export function placementOffsetScale(): number {
  return MODEL_OFFSET_BASE;
}

/**
 * 世界空间位移 → placement offset 单位：先按固定嵌入旋转的逆 `R⁻¹`，再除以 64。
 *
 * 与 [`placementOffsetToWorldDelta`] 互为逆。
 */
export function worldDeltaToPlacementOffset(delta: Vec3): { x: number; y: number; z: number } {
  const local = quatRotate(viewRotation(), delta);
  return {
    x: local[0] / MODEL_OFFSET_BASE,
    y: local[1] / MODEL_OFFSET_BASE,
    z: local[2] / MODEL_OFFSET_BASE
  };
}

/** placement offset 单位 → 世界空间位移（`worldDeltaToPlacementOffset` 的逆）。 */
export function placementOffsetToWorldDelta(
  offset: { x: number; y: number; z: number }
): Vec3 {
  return quatRotate(canvasCameraRotation(), [
    offset.x * MODEL_OFFSET_BASE,
    offset.y * MODEL_OFFSET_BASE,
    offset.z * MODEL_OFFSET_BASE
  ]);
}


/** 聚焦相机前向（世界空间，从相机指向 target 的反方向）。 */
export function cameraForwardVector(camera: ModelFocusCamera): Vec3 {
  const cp = Math.cos(camera.pitch);
  return normalizeVec3([
    -Math.sin(camera.yaw) * cp,
    Math.sin(camera.pitch),
    -Math.cos(camera.yaw) * cp
  ]);
}

/**
 * ray 与平面的交点参数 `t`；近平行（`|dot| < 1e-6`）、负交点或非有限结果返回 `null`。
 *
 * 负交点视为无效采样（design D5）：调用方跳过该 sample 而不产生跳变。
 */
export function rayPlaneIntersection(ray: Ray, planePoint: Vec3, planeNormal: Vec3): number | null {
  const denom = dotVec3(ray.direction, planeNormal);
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-6) return null;
  const delta = subVec3(planePoint, ray.origin);
  const t = dotVec3(delta, planeNormal) / denom;
  if (!Number.isFinite(t) || t < 0) return null;
  return t;
}

/** ray 与平面的交点世界坐标；无效（近平行/负交点/非有限）返回 `null`。 */
export function rayPlanePoint(ray: Ray, planePoint: Vec3, planeNormal: Vec3): Vec3 | null {
  const t = rayPlaneIntersection(ray, planePoint, planeNormal);
  if (t === null) return null;
  const point = addVec3(ray.origin, scaleVec3(ray.direction, t));
  return point.every((value) => Number.isFinite(value)) ? point : null;
}

/** 聚焦（透视）相机在 surface 内某点的屏幕 ray（固定使用 `MODEL_FOCUS_FOV`）。 */
export function focusPointerRay(input: {
  point: { x: number; y: number };
  size: { width: number; height: number };
  camera: ModelFocusCamera;
}): Ray {
  return focusRay({ ...input, fov: MODEL_FOCUS_FOV });
}

/** 手势起始：穿过命中的模型 AABB 的焦点，法线为相机 forward 的拖动平面。 */
export type PlacementDrag = {
  mode: "offset" | "yaw";
  /** 手势开始冻结的 canonical/working placement。 */
  origin: PlacementDraft;
  startX: number;
  startY: number;
  /** 相机朝向平面上的起点（世界空间）。 */
  planeOrigin: Vec3;
  /** 平面法线（相机 forward，世界空间）。 */
  planeNormal: Vec3;
};

/**
 * 开始一次模型 placement 手势。
 *
 * `bounds` 为聚焦相机的 ray-AABB 命中目标（`ModelBounds.aabb`）。返回 `null` 表示
 * 该采样不应开始编辑（ray 未命中模型 / 平面无效），调用方忽略而不产生跳变。
 */
export function beginPlacementDrag(input: {
  mode: "offset" | "yaw";
  origin: PlacementDraft;
  x: number;
  y: number;
  camera: ModelFocusCamera;
  surface: { width: number; height: number };
  bounds: Aabb;
}): PlacementDrag | null {
  const ray = focusPointerRay({ point: { x: input.x, y: input.y }, size: input.surface, camera: input.camera });
  const hit = rayAabbPoint(ray, input.bounds);
  if (!hit) return null;
  const planeNormal = cameraForwardVector(input.camera);
  if (!isFiniteVec(planeNormal) || lengthVec3(planeNormal) < 1e-6) return null;
  return {
    mode: input.mode,
    origin: clonePlacement(input.origin),
    startX: input.x,
    startY: input.y,
    planeOrigin: hit,
    planeNormal
  };
}

/**
 * 推进一次 placement 手势并返回完整 preview placement。
 *
 * - `offset`：用当前指针 ray 与起始相机朝向平面求交，world delta 经固定嵌入逆变换换算为 offset；
 * - `yaw`：只使用横向 CSS 像素增量（`0.02 rad/px`）。
 *
 * 返回 `null` 表示该采样无效（近平行/负交点/非有限/不可逆），调用方应**跳过**该帧，
 * 保留上一 preview（不产生跳变、不提交无效 placement）。
 */
export function updatePlacementDrag(
  drag: PlacementDrag,
  input: { x: number; y: number; camera: ModelFocusCamera; surface: { width: number; height: number } }
): PlacementDraft | null {
  if (drag.mode === "yaw") {
    const dx = input.x - drag.startX;
    if (!Number.isFinite(dx)) return null;
    const yaw = drag.origin.yaw + (dx * MODEL_EDIT_YAW_RADIANS_PER_PX * 180) / Math.PI;
    if (!Number.isFinite(yaw)) return null;
    return { offset: { ...drag.origin.offset }, scale: drag.origin.scale, yaw };
  }
  const ray = focusPointerRay({ point: { x: input.x, y: input.y }, size: input.surface, camera: input.camera });
  const point = rayPlanePoint(ray, drag.planeOrigin, drag.planeNormal);
  if (!point) return null;
  const delta = subVec3(point, drag.planeOrigin);
  if (!isFiniteVec(delta)) return null;
  const offset = worldDeltaToPlacementOffset(delta);
  return {
    offset: {
      x: drag.origin.offset.x + offset.x,
      y: drag.origin.offset.y + offset.y,
      z: drag.origin.offset.z + offset.z
    },
    scale: drag.origin.scale,
    yaw: drag.origin.yaw
  };
}

/** 两个 placement 是否在容差内相等（净变化判定）。 */
export function placementEquals(a: BevyModelPlacement, b: BevyModelPlacement, epsilon = 1e-6): boolean {
  return (
    Math.abs(a.offset.x - b.offset.x) < epsilon
    && Math.abs(a.offset.y - b.offset.y) < epsilon
    && Math.abs(a.offset.z - b.offset.z) < epsilon
    && Math.abs(a.scale - b.scale) < epsilon
    && Math.abs(a.yaw - b.yaw) < epsilon
  );
}

function clonePlacement(placement: PlacementDraft): PlacementDraft {
  return {
    offset: { ...placement.offset },
    scale: placement.scale,
    yaw: placement.yaw
  };
}

function rayAabbPoint(ray: Ray, box: Aabb): Vec3 | null {
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
  const t = tmin >= 0 ? tmin : tmax;
  if (!Number.isFinite(t)) return null;
  return addVec3(ray.origin, scaleVec3(ray.direction, t));
}

function isFiniteVec(value: Vec3): boolean {
  return value.length === 3 && value.every((entry) => Number.isFinite(entry));
}
