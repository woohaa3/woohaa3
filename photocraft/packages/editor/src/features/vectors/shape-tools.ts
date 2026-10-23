/**
 * 形状拖绘几何（U08/U09，change: 2026-10-22-add-photocraft-vector-canvas-tools，design D1/D2）。
 *
 * 与 Rust `features/vectors/gestures.rs` 一一对应：同一套形状种类、修饰键、拒绝条件与参数名。
 * 这一层只做纯计算，不碰文档、不碰历史；拖绘预览画什么、松手提交什么，都由这里决定。
 *
 * 三条规则（与内核同文）：
 * 1. 坐标是**源像素**（取景换算在 `DocumentCoordinatePort` 完成），不做二次缩放；
 * 2. Shift 约束比例/角度、Alt 从中心、零面积与越界几何直接拒绝，不提交半成品；
 * 3. 参数按上游 `shape.create` 的名称与范围生成，非法边数/星形比例/圆角不会被静默夹取。
 *
 * 最后一步固定交给协议解码器 `decodeVectorShapeParams` 复核，避免 UI 与内核对同一参数
 * 各持一套范围。
 *
 * 数值创建（面板输入）走同一个 `shapeCreateParams`，因此「图内拖出的形状」和「填数值创建的
 * 形状」共享几何，不存在第二套。
 */

import { decodeVectorShapeParams } from "@woohaa3/photocraft-protocol";

/** 可拖绘的形状种类（与工具栏子工具一一对应）。 */
export const SHAPE_KINDS = ["rect", "roundedRect", "ellipse", "triangle", "polygon", "star", "line"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

export type ShapeModifiers = {
  /** 约束比例（矩形/椭圆/多边形）或 45° 角度（直线）。 */
  constrain?: boolean;
  /** 以起点为中心向外拖绘。 */
  fromCenter?: boolean;
};

export type ShapeDrag = {
  kind: ShapeKind;
  start: readonly [number, number];
  end: readonly [number, number];
  modifiers?: ShapeModifiers;
  /** 圆角半径（rect / roundedRect）。 */
  radius?: number;
  /** 多边形与星形的边数。 */
  sides?: number;
  /** 星形内外半径比（0.01–1，不含 1）。 */
  starRatio?: number;
  /** 直线粗细。 */
  weight?: number;
};

export type ShapeGeometry = {
  /** 已翻正的 `[x, y, width, height]`。 */
  rect: [number, number, number, number];
  /** 直线端点；其余形状等于 `rect` 的两角。 */
  from: [number, number];
  to: [number, number];
};

/** 一次拖绘在提交前的状态：几何、预览参数或拒绝原因。 */
export type ShapePreview =
  | { ok: true; geometry: ShapeGeometry; params: Record<string, unknown> }
  | { ok: false; message: string };

const CANVAS_SLACK = 8;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function inCanvas(point: readonly [number, number], canvas: readonly [number, number]): boolean {
  const limit = Math.max(Math.max(1, canvas[0]) * CANVAS_SLACK, Math.max(1, canvas[1]) * CANVAS_SLACK);
  return finite(point[0]) && finite(point[1]) && Math.abs(point[0]) <= limit && Math.abs(point[1]) <= limit;
}

function bounded(value: number, low: number, high: number, name: string): number {
  if (!finite(value) || value < low || value > high) throw new Error(`${name}必须在 ${low}–${high} 之间`);
  return value;
}

/**
 * 由拖绘起止点与修饰键计算规范几何。
 *
 * 零面积（拖动距离为 0）抛错，调用方据此取消而不提交——这也是「单击改为尺寸输入」的分支点。
 */
export function shapeGeometry(drag: ShapeDrag, canvas: readonly [number, number] = [8192, 8192]): ShapeGeometry {
  const [sx, sy] = drag.start;
  let [ex, ey] = drag.end;
  if (!inCanvas(drag.start, canvas) || !inCanvas(drag.end, canvas)) throw new Error("形状起点或终点超出文档可保存范围");
  const line = drag.kind === "line";
  if (drag.modifiers?.constrain) {
    if (line) {
      // 直线吸附到 15° 的整数倍角度，长度保持不变。
      const dx = ex - sx;
      const dy = ey - sy;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        const step = Math.PI / 12;
        const angle = Math.round(Math.atan2(dy, dx) / step) * step;
        ex = sx + length * Math.cos(angle);
        ey = sy + length * Math.sin(angle);
      }
    } else {
      // 比例约束：以较大边为准的正方形。
      const side = Math.max(Math.abs(ex - sx), Math.abs(ey - sy));
      ex = sx + side * (ex < sx ? -1 : 1);
      ey = sy + side * (ey < sy ? -1 : 1);
    }
  }
  const [x0, y0, x1, y1] = drag.modifiers?.fromCenter
    ? [sx - Math.abs(ex - sx), sy - Math.abs(ey - sy), sx + Math.abs(ex - sx), sy + Math.abs(ey - sy)]
    : [Math.min(sx, ex), Math.min(sy, ey), Math.max(sx, ex), Math.max(sy, ey)];
  const width = x1 - x0;
  const height = y1 - y0;
  if (line) {
    if (Math.hypot(ex - sx, ey - sy) < 1e-6) throw new Error("直线长度为零");
  } else if (width < 1e-6 || height < 1e-6) {
    throw new Error("形状面积为零，请拖出更大的范围或改用尺寸输入");
  }
  return { rect: [x0, y0, width, height], from: [sx, sy], to: [ex, ey] };
}

/** 由几何与参数编译 `shape.create` 参数（唯一的形状提交入口）。 */
export function shapeCreateParams(drag: ShapeDrag, canvas: readonly [number, number] = [8192, 8192]): Record<string, unknown> {
  const geometry = shapeGeometry(drag, canvas);
  const [x, y, width, height] = geometry.rect;
  if (drag.kind === "line") {
    const weight = bounded(drag.weight ?? 1, 0, 1_000_000, "线宽");
    return checked({ kind: "line", from: geometry.from, to: geometry.to, weight });
  }
  const params: Record<string, unknown> = { kind: drag.kind, rect: [x, y, width, height] };
  const radius = bounded(drag.radius ?? 0, 0, Math.min(width, height) / 2, "圆角半径");
  if (drag.kind === "rect" || drag.kind === "roundedRect") {
    // 圆角矩形必须有正半径：未给时取 10 与短边一半的较小值。
    const radii = drag.kind === "roundedRect" && radius <= 0 ? Math.min(10, Math.min(width, height) / 2) : radius;
    params.radii = [radii, radii, radii, radii];
    return checked(params);
  }
  if (drag.kind === "ellipse") return checked(params);
  const sides = drag.kind === "triangle" ? 3 : (drag.sides ?? 5);
  if (!Number.isInteger(sides) || sides < 3 || sides > 100) throw new Error("多边形的边数必须在 3–100 之间");
  // 上游没有 `triangle` 这个 kind：三角形就是三边正多边形。界面种类在这里归一到内核词汇，
  // 否则会出现「面板里能选、内核不认」的悬空种类。
  if (drag.kind === "triangle") params.kind = "polygon";
  params.sides = sides;
  // 只有星形才发 `starRatio`。上游把 `star_ratio == 1.0` 当作「正多边形」哨兵值，
  // 对多边形显式发 1.0 会被本域白名单判为非法。
  if (drag.kind === "star") {
    const ratio = bounded(drag.starRatio ?? 0.5, 0.01, 1, "星形内外比例");
    if (ratio >= 1) throw new Error("星形内外比例必须小于 1");
    params.starRatio = ratio;
  }
  return checked(params);
}

/**
 * 提交前用协议解码器复算一遍：它是 UI 与内核共享的**唯一** wire 契约
 * （`packages/protocol/src/features/vectors/params.ts`）。
 *
 * 本文件负责把拖绘几何换算成候选参数，协议层负责裁定这些参数是否真的可提交；
 * 两层若漂移，这里立刻抛错而不是把非法值送进内核。返回原始参数，保持命令字面形态。
 */
function checked(params: Record<string, unknown>): Record<string, unknown> {
  const decoded = decodeVectorShapeParams(params);
  if (!decoded) throw new Error("形状参数超出协议允许范围，已拒绝提交");
  // 直线只带 from/to/weight，其余形状只带 rect：解码器不接受多余字段混用。
  return params;
}

/** 拖动中的预览：零面积/越界返回可展示的原因，由叠加层与提示共用。 */
export function shapePreview(drag: ShapeDrag, canvas: readonly [number, number] = [8192, 8192]): ShapePreview {
  try {
    return { ok: true, geometry: shapeGeometry(drag, canvas), params: shapeCreateParams(drag, canvas) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 命中阈值的源像素换算：屏幕阈值除以缩放；非法输入退回屏幕阈值本身。 */
export function hitTolerance(screenPx: number, zoom: number): number {
  if (!finite(screenPx) || !finite(zoom) || zoom <= 0) return Math.max(0, finite(screenPx) ? screenPx : 0);
  return Math.min(1e6, Math.max(1e-4, screenPx / zoom));
}

/** 形状中文名（面板与叠加层提示共用）。 */
export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: "矩形",
  roundedRect: "圆角矩形",
  ellipse: "椭圆",
  triangle: "三角形",
  polygon: "多边形",
  star: "星形",
  line: "直线",
};
