/**
 * 模型聚焦：画布坐标 ↔ 世界投影
 * （自 `model-focus.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R24）。
 *
 * 固定嵌入（不读 viewport 的计算）与屏幕投影互逆；供 picking、网格逆投影与焦点命中复用。
 */
import { quatRotate, type Quat, type Vec3 } from "../model-transform.js";
import { eulerXyz } from "./math.js";
import type { CanvasViewport } from "./types.js";

/** 普通画布相机俯仰角；修改此处即可统一调整画布等距视角。 */
export const CANVAS_CAMERA_PITCH = (30 * Math.PI) / 180;

/**
 * 等距视角（与 Rust `grid::view_rotation()` 逐位一致：EulerRot::XYZ, CANVAS_CAMERA_PITCH, -PI/4, 0）。
 */
export function viewRotation(): Quat {
  const x = CANVAS_CAMERA_PITCH;
  const y = -Math.PI / 4;
  return eulerXyz(x, y, 0);
}

/** 画布正交相机朝向：等距 lookat，模型保持竖直。 */
export function canvasCameraRotation(): Quat {
  const rotation = viewRotation();
  return [-rotation[0], -rotation[1], -rotation[2], rotation[3]];
}

/**
 * 固定画布坐标 → 世界（change: make-shot-framing-zoom-invariant，design D2）。
 *
 * `cx` / `cy` 为画布 CSS 坐标（y 向下），`depth` 为画布观察深度；结果是
 * `R × (cx, -cy, depth)`，原点固定为世界零点，**不**读取 viewport 或 surface。
 */
export function canvasPointToWorld(cx: number, cy: number, depth: number): Vec3 {
  return quatRotate(canvasCameraRotation(), [cx, -cy, depth]);
}

/** `canvasPointToWorld` 的逆（不依赖 viewport/surface）。 */
export function worldToCanvasPoint(world: Vec3): { x: number; y: number; depth: number } {
  const q = quatRotate(viewRotation(), world);
  return { x: q[0], y: -q[1], depth: q[2] };
}

/**
 * 屏幕 CSS 点 → 世界（固定观察深度）：`R × ((sx - tx)/z, -(sy - ty)/z, depth)`。
 */
export function screenPointToWorld(
  screen: { x: number; y: number },
  depth: number,
  viewport: CanvasViewport
): Vec3 {
  const z = safeZoom(viewport.zoom);
  return quatRotate(canvasCameraRotation(), [
    (screen.x - viewport.x) / z,
    -(screen.y - viewport.y) / z,
    depth
  ]);
}

/** 世界点在 viewport 下的 canvas CSS 坐标（y 向下）；满足 `screen = canvas × zoom + pan`。 */
export function screenPointFromWorld(world: Vec3, viewport: CanvasViewport): { x: number; y: number } {
  const z = safeZoom(viewport.zoom);
  const q = quatRotate(viewRotation(), world);
  return { x: viewport.x + z * q[0], y: viewport.y - z * q[1] };
}

/** 正 zoom 的防御读取。 */
export function safeZoom(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}
