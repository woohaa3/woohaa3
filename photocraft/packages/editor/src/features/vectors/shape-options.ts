/**
 * 形状工具的当前参数（U08/U09，change: 2026-10-22-add-photocraft-vector-canvas-tools）。
 *
 * 面板里选的圆角/边数/内外比例/线宽与描边必须同时作用于**图内拖绘**，否则会出现「面板显示圆角
 * 10、拖出来却是直角」这种只有接线后才暴露的错位。参数是工具状态（不进文档、不进历史），
 * 因此用域内小 store 而不是往共享控制器或文档模型里塞字段。
 */

export type ShapeToolOptions = {
  /** rect / roundedRect 的圆角半径（源像素）。 */
  radius: number;
  /** 多边形与星形的边数。 */
  sides: number;
  /** 星形内外半径比（0.01–<1）。 */
  starRatio: number;
  /** 直线线宽。 */
  weight: number;
  /** 拖绘时附带的描边参数（与 `shape.create` 的 `stroke` 同形）；`null` 表示无描边。 */
  stroke: Record<string, unknown> | null;
};

const DEFAULTS: ShapeToolOptions = { radius: 0, sides: 5, starRatio: 0.5, weight: 2, stroke: null };

let current: ShapeToolOptions = DEFAULTS;
const listeners = new Set<() => void>();

/** 「单击改为尺寸输入」的请求：起点与被点次数（同一位置连点也要能再次触发）。 */
export type ShapeSizeRequest = { point: [number, number]; id: number };
let sizeRequest: ShapeSizeRequest = { point: [0, 0], id: 0 };
const sizeListeners = new Set<() => void>();

export function shapeToolOptions(): ShapeToolOptions {
  return current;
}

export function setShapeToolOptions(patch: Partial<ShapeToolOptions>): void {
  const next = { ...current, ...patch };
  const same = (Object.keys(next) as (keyof ShapeToolOptions)[]).every(key =>
    key === "stroke" ? JSON.stringify(next.stroke) === JSON.stringify(current.stroke) : next[key] === current[key]);
  if (same) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeShapeToolOptions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 请求尺寸输入（单击画布但没拖出面积时）。
 *
 * 形状工具在真实 UI 里的行为：单击 = 打开「新建形状」的尺寸输入，而不是什么都没发生。
 * 请求放在同一份工具状态 store 里，因为面板与画布都要看它（面板开输入、画布清提示）。
 */
export function shapeSizeRequest(): ShapeSizeRequest {
  return sizeRequest;
}

export function requestShapeSize(point: readonly [number, number]): void {
  sizeRequest = { point: [point[0], point[1]], id: sizeRequest.id + 1 };
  for (const listener of sizeListeners) listener();
}

export function subscribeShapeSizeRequest(listener: () => void): () => void {
  sizeListeners.add(listener);
  return () => sizeListeners.delete(listener);
}
