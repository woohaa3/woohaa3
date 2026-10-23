import type { DocumentPoint } from "../shared/tool-parameters.js";
import { CLONE_SOURCE_SLOTS, type CloneOverlay, type CloneSourceSlot } from "./tool-parameters.js";

/**
 * 仿制源叠加预览的几何（change: 2026-10-22-add-photocraft-retouch-workflows，U39 / 设计 D2）。
 *
 * 叠加层必须与落笔取同一份取景：`cloneSource.list` 的槽位（取样点 + 锚点 + 宽高/旋转/翻转）
 * 与 `overlay` 选项。这里只算出**要画什么**（取样窗在文档里的四边形、锚点、不透明度、是否
 * 反相），不碰 DOM、也不写内核——共享画布拿到结果后自己画，避免在共享文件里再解释一遍变换。
 *
 * 与内核一致的映射（上游 `presets/clone_source.rs`）：目标点 `d` 读取源点
 * `source + m · (d − anchor)`，`m = transform_matrix(scale, rotation, flipH, flipV)`。
 * 反向解出「哪块目标区域在采样这个源窗口」：`d = anchor + m⁻¹ · (src − source)`。
 */

export type ScreenPoint = { x: number; y: number };
export type ScreenRect = { x: number; y: number; width: number; height: number };

/** 与上游一致的 2×2 逆变换 `m`（行主序），把目标偏移映射成源偏移。 */
export function cloneTransformMatrix(
  scale: readonly [number, number],
  rotationDegrees: number,
  flipH: boolean,
  flipV: boolean
): readonly [number, number, number, number] {
  const sx = Math.max(1e-3, scale[0] / 100) * (flipH ? -1 : 1);
  const sy = Math.max(1e-3, scale[1] / 100) * (flipV ? -1 : 1);
  // 屏幕上逆时针为正，y 向下的数学里是顺时针：先缩放再旋转。
  const radians = (-rotationDegrees * Math.PI) / 180;
  const s = Math.sin(radians);
  const c = Math.cos(radians);
  const f0 = c * sx;
  const f1 = -s * sy;
  const f2 = s * sx;
  const f3 = c * sy;
  const det = f0 * f3 - f1 * f2;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return [1, 0, 0, 1];
  return [f3 / det, -f1 / det, -f2 / det, f0 / det];
}

/** 目标点 → 源点（与落笔取样同一条映射）；没有取样点时返回 `null`。 */
export function cloneSourcePoint(slot: CloneSourceSlot, point: DocumentPoint): DocumentPoint | null {
  if (!slot.source) return null;
  const anchor = slot.anchor ?? slot.source;
  const [m0, m1, m2, m3] = cloneTransformMatrix([slot.width, slot.height], slot.rotation, slot.flipH, slot.flipV);
  const dx = point.x - anchor[0];
  const dy = point.y - anchor[1];
  return { x: slot.source[0] + m0 * dx + m1 * dy, y: slot.source[1] + m2 * dx + m3 * dy };
}

/**
 * 叠加取样框在文档坐标里的四个角（目标侧）。
 *
 * 取「笔尖直径」大小的源窗口（中心为取样点），按 `m⁻¹` 反推到目标侧；因此旋转/缩放/翻转会
 * 让框一起转。锚点就是取样窗中心落在画布上的位置（`slot.anchor`，还没配对时退化为取样点）。
 * `clipped` 由画布决定是否只显示笔尖内的部分，几何本身不变。没有取样点返回 `null`。
 */
export function cloneOverlayCorners(slot: CloneSourceSlot, size: number, clipped: boolean): DocumentPoint[] | null {
  if (!slot.source) return null;
  const half = Math.max(1, size) / 2;
  const source = slot.source;
  const anchor = slot.anchor ?? source;
  const [m0, m1, m2, m3] = cloneTransformMatrix([slot.width, slot.height], slot.rotation, slot.flipH, slot.flipV);
  const det = m0 * m3 - m1 * m2;
  const inv = Math.abs(det) < 1e-12 ? [1, 0, 0, 1] : [m3 / det, -m1 / det, -m2 / det, m0 / det];
  const window: readonly (readonly [number, number])[] = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half]
  ];
  void clipped;
  return window.map(([dx, dy]) => ({
    x: anchor[0] + inv[0] * dx + inv[1] * dy,
    y: anchor[1] + inv[2] * dx + inv[3] * dy
  }));
}

/** 叠加层是否应该显示（选项关掉、没有活动槽位取样点、落笔中自动隐藏都不画）。 */
export function cloneOverlayVisible(overlay: CloneOverlay, slot: CloneSourceSlot | null, stroking: boolean): boolean {
  if (!overlay.show) return false;
  if (!slot?.source) return false;
  if (overlay.autoHide && stroking) return false;
  return true;
}

/** 叠加层当前有效不透明度（0–1）；选项已钳制，这里只做防御。 */
export function cloneOverlayOpacity(overlay: CloneOverlay): number {
  const percent = Number.isFinite(overlay.opacity) ? overlay.opacity : 100;
  return Math.min(1, Math.max(0, percent / 100));
}

/** 从 `cloneSource.list` 的结果里取活动槽位（索引越界时取列表最后一项，不伪造空槽位）。 */
export function activeCloneSlot(slots: readonly CloneSourceSlot[], active: number): CloneSourceSlot | null {
  if (slots.length === 0) return null;
  const wanted = Number.isFinite(active) ? Math.round(active) : 0;
  const index = Math.min(CLONE_SOURCE_SLOTS - 1, Math.max(0, wanted));
  const exact = slots.find((slot) => slot.index === index);
  if (exact) return exact;
  // 列表缺少该索引（旧宿主只回传部分槽位）时用最后一项：它是这一份列表里最接近的槽位，
  // 而不是凭空造一个没有取样点的空对象。
  return slots[slots.length - 1] ?? null;
}

/** 取样框在屏幕坐标里的位置（共享画布提供文档→客户坐标换算）。 */
export function cloneOverlayScreenCorners(
  slot: CloneSourceSlot,
  size: number,
  clipped: boolean,
  toScreen: (point: DocumentPoint) => ScreenPoint | null
): ScreenPoint[] | null {
  const corners = cloneOverlayCorners(slot, size, clipped);
  if (!corners) return null;
  const screen = corners.map(toScreen);
  return screen.every((point): point is ScreenPoint => point !== null) ? screen : null;
}

/** 取样框的外接矩形（用于四角框或直接填充）。 */
export function boundsOf(points: readonly ScreenPoint[]): ScreenRect | null {
  if (points.length === 0) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * 仿制/修复这一笔该用哪个取样源（U39 多仿制源）。
 *
 * 上游 `clone_source::resolve` 的优先级是：笔迹参数里的 `source`/`offset` 优先，**没有**时才读
 * 会话里的活动槽位。共享画布早年把 app 本地保存的 Alt+取样点显式塞进 `source`，于是「切到
 * 2 号槽位」对之后的每一笔都没有影响：面板显示 2 号槽位的源，落笔却在用 1 号槽位的旧点
 * （真实缺陷）。
 *
 * 所以这里统一给出笔迹的 `source`/`anchor` 补丁：
 * - 活动槽位有取样点 → **不传** `source`/`anchor`，交给内核按该槽位（含它的锚点与变换）取样；
 * - 活动槽位没有取样点、但宿主退回了本地取样点 → 用本地点（旧宿主/精简装配）；
 * - 两者都没有 → `reason` 说明要先取样，调用方据此提示而不是落一笔「成功但无变化」。
 *
 * 对齐关闭时锚点固定为本笔起点，否则一笔之内会被相邻落点拽着走。
 */
export function cloneStrokeSource(
  slot: { source: readonly [number, number] | null; anchor?: readonly [number, number] | null } | null,
  local: readonly [number, number] | null,
  firstPoint: DocumentPoint,
  aligned: boolean
): { source?: readonly [number, number]; anchor?: readonly [number, number] } | { reason: string } {
  const screenAnchor: readonly [number, number] = [firstPoint.x, firstPoint.y];
  if (slot?.source) {
    // 槽位有源：锚点由内核按槽位决定（`aligned` 时还会记忆该槽位的锚点对），不要覆盖。
    return {};
  }
  if (local) {
    return { source: local, anchor: aligned ? (slot?.anchor ?? screenAnchor) : screenAnchor };
  }
  return { reason: "请先 Alt+单击画布设置采样点" };
}

/**
 * 叠加取样框在容器内画出的 SVG 折线（容器 CSS 像素）。
 *
 * 只做几何拼接：四角来自 [`cloneOverlayScreenCorners`]，`opacity` 是画布填充/描边的
 * 不透明度（0–1），`invert` 交给渲染层（反相预览用差集混合）。没有四角时返回 `null`。
 */
export function cloneOverlayPolygon(
  corners: readonly ScreenPoint[],
  opacity: number,
  invert: boolean
): { points: string; opacity: number; invert: boolean } | null {
  if (corners.length < 3) return null;
  const points = corners.map((point) => `${point.x},${point.y}`).join(" ");
  return { points, opacity: Math.min(1, Math.max(0, opacity)), invert };
}
