import { IMAGE_PROJECT_LIMITS } from "@woohaa3/photocraft-protocol";
import { type DocumentPoint, clamp, type PixelRect, roundPixel } from "../shared/tool-parameters.js";

/** 选区运算方式（与内核 `mode` 取值一致）。 */
export type SelectionMode = "replace" | "add" | "subtract" | "intersect";

/** 对掩码边界做奇偶射线判定，支持不相连选区和减选形成的孔洞。 */
export function pointInSelection(point: DocumentPoint, segments: readonly (readonly number[])[]): boolean {
  let inside = false;
  for (const [x0, y0, x1, y1] of segments) {
    const cross = (point.x - x0) * (y1 - y0) - (point.y - y0) * (x1 - x0);
    if (Math.abs(cross) < 1e-6 && point.x >= Math.min(x0, x1) && point.x <= Math.max(x0, x1)
      && point.y >= Math.min(y0, y1) && point.y <= Math.max(y0, y1)) return true;
    if ((y0 > point.y) !== (y1 > point.y) && point.x < x0 + (point.y - y0) * (x1 - x0) / (y1 - y0)) inside = !inside;
  }
  return inside;
}

/** 羽化半径钳制到首期公开范围（0–100 源像素）。 */
export function clampFeather(radius: number): number {
  return clamp(radius, 0, IMAGE_PROJECT_LIMITS.maxFeatherSourcePixels);
}

/** 归一化拖拽框：任意方向的起止点都得到左上原点 + 正尺寸。 */
export function normalizeMarquee(start: DocumentPoint, end: DocumentPoint): PixelRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x: roundPixel(x),
    y: roundPixel(y),
    width: Math.max(0, roundPixel(Math.abs(end.x - start.x))),
    height: Math.max(0, roundPixel(Math.abs(end.y - start.y)))
  };
}

/** `select.rect` 参数。 */
export function buildRectSelection(
  rect: PixelRect,
  options: { mode?: SelectionMode; ellipse?: boolean; feather?: number } = {}
): Record<string, unknown> {
  return {
    x: roundPixel(rect.x),
    y: roundPixel(rect.y),
    width: Math.max(0, roundPixel(rect.width)),
    height: Math.max(0, roundPixel(rect.height)),
    mode: options.mode ?? "replace",
    ellipse: options.ellipse ?? false,
    antiAlias: true,
    feather: clampFeather(options.feather ?? 0)
  };
}

/** `select.modify.feather` 参数。 */
export function buildFeather(radius: number): Record<string, unknown> {
  return { radius: clampFeather(radius) };
}

/** 套索至少需要 3 个点；不足时返回 `null`（调用方不提交半截手势）。 */
export function buildLasso(
  points: readonly DocumentPoint[],
  options: { mode?: SelectionMode; feather?: number } = {}
): Record<string, unknown> | null {
  if (points.length < 3) return null;
  return {
    points: points.map((point) => [roundPixel(point.x), roundPixel(point.y)]),
    mode: options.mode ?? "replace",
    feather: clampFeather(options.feather ?? 0)
  };
}
