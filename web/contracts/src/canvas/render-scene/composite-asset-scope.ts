/**
 * 片场/复合资产范围几何纯函数（change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
 *
 * 唯一派生公式：片场范围 = 模型**地面占地**（内容局部三维 AABB 的 x/z 投影，含对象 yaw 与
 * 共同根）等比外扩固定边距后的**地面矩形**，经固定地面投影投到画布。地面矩形四边始终平行
 * 网格，只有地面宽深相等（hx==hz）时退化为菱形。范围**不**再由内容适配矩形外接派生，
 * 因此能真正罩住模型底座而不是屏幕矩形。
 *
 * 投影事实：当前地面观察旋转把地面 `(gx,gz)` 投到画布
 * `screenX = AXIS_X×(gx-gz)`、`screenY = AXIS_Y×(gx+gz)`，`s = sin(CANVAS_CAMERA_PITCH)`。
 * 地面矩形 `(cx,cy,hx,hz)` 的顶点为 `center ± (AXIS_X×hx, AXIS_Y×hx) ± (-AXIS_X×hz, AXIS_Y×hz)`，
 * 边在画布世界（x 右、y 下）斜率为 ±s，外包矩形宽高比为 `1/s`。数值 AXIS_X/AXIS_Y 由
 * 跨语言 golden 锁定并与 Rust `isometric_grid::plan::AXIS_X/AXIS_Y` 一致；更换投影必须同时更新
 * 本常量与两侧测试。Rust `canvas_query::scope` 是运行时事实源，本模块供映射、测试 oracle 与
 * 非运行时计算。
 *
 * 点命中在 Rust 侧另有一层扩展（`scope::pick_contains`）：地面范围只覆盖地面占地，小地面、
 * 较高的模型会把可见身体投影到范围 AABB 顶部之上，因此点选/hover/双击额外接受**模型内容投影
 * 包围盒**（Rust 由呈现字段按与渲染相同的 fit/anchor 公式派生）从范围顶部向上延伸到内容顶部
 * 的条带；条带只覆盖内容包围盒宽度，AABB 内部仍只按平行四边形判定，空白角不命中。drop 与框选
 * 仍只认地面范围。
 */
import type { CompositeAssetScopeShape } from "./wire-scene.js";
import { CANVAS_CAMERA_PITCH } from "../model-focus/canvas-projection.js";

/** 地面投影轴在画布世界的边斜率 `abs(AXIS_Y / AXIS_X) = sin(CANVAS_CAMERA_PITCH)`。 */
export const COMPOSITE_ASSET_DIAMOND_EDGE_SLOPE = Math.sin(CANVAS_CAMERA_PITCH);

/** 地面单位向量在画布世界的 x 分量 `AXIS_X`（与 Rust `isometric_grid::plan::AXIS_X` 一致）。 */
export const COMPOSITE_ASSET_SCOPE_AXIS_X = 0.70710678;

/** 地面单位向量在画布世界的 y 分量 `AXIS_Y`（与 Rust `isometric_grid::plan::AXIS_Y` 一致）。 */
export const COMPOSITE_ASSET_SCOPE_AXIS_Y = Math.sin(CANVAS_CAMERA_PITCH) * COMPOSITE_ASSET_SCOPE_AXIS_X;

/**
 * 范围相对模型地面占地的固定外扩边距（世界单位）。
 *
 * 沿地面轴等比外扩：`k = 1 + margin / max(hx, hz)`，同时乘到 hx/hz，保持地面宽深比。
 */
export const COMPOSITE_ASSET_SCOPE_MARGIN = 16;

/**
 * 点包含的边界容差（画布世界单位）。
 *
 * 用于「边界包含」语义，比任何有意义的范围都小；不作为空白区的交互 padding。
 */
export const COMPOSITE_ASSET_SCOPE_EPSILON = 1e-4;

/** 范围抓手命中方块的边长（画布世界单位，与矩形 `RESIZE_HANDLE_SIZE` 同量级）。 */
export const COMPOSITE_ASSET_SCOPE_HANDLE = 20;

export type ScopeRect = { x: number; y: number; width: number; height: number };
export type ScopePoint = { x: number; y: number };

/**
 * 地面范围：投影中心 `(cx, cy)`（画布世界）与沿地面 +x/+z 轴的半边长 `(hx, hz)`（世界单位）。
 *
 * 由映射层从模型内容局部 AABB + 共同根 + 适配单位派生；Rust 与 TS 由它展开四顶点与抓手。
 */
export type ScopeGround = { cx: number; cy: number; hx: number; hz: number };

/** 范围抓手方向：四顶点（n/e/s/w）与四边中点（ne/se/sw/nw）。 */
export type ScopeHandleId = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

/** 单个范围抓手：方向 id 与其画布世界坐标。 */
export type ScopeHandle = { id: ScopeHandleId; point: ScopePoint };

/** 顶点顺序固定 top → right → bottom → left（y 向下坐标中为顺时针）。 */
export type CompositeAssetScopeGeometry = {
  shape: CompositeAssetScopeShape;
  /** 内容适配基准矩形（规范尺寸，不是范围 AABB）。 */
  base: ScopeRect;
  center: ScopePoint;
  /** 闭合多边形顶点；rect 为四角，地面矩形为 top/right/bottom/left。 */
  vertices: [ScopePoint, ScopePoint, ScopePoint, ScopePoint];
  /** 粗筛用外接矩形；地面矩形时为 `(cx-rx, cy-ry, 2rx, 2ry)`。 */
  aabb: ScopeRect;
  /** 地面矩形外包半径；rect 时为半宽/半高。 */
  radiusX: number;
  radiusY: number;
  /** 8 个抓手中心（四顶点 + 四边中点）。 */
  handles: ScopeHandle[];
  /** 地面半边长（世界单位）；rect 时缺省。 */
  ground?: ScopeGround;
};

function finite(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 规范化范围基准矩形：保证有限、非负尺寸且半径大于零。
 *
 * 极小/非法输入围绕原中心保留最小可点击范围（与 `compositeAssetScopeForNode` 的 min 语义一致），
 * 仅用于几何边界鲁棒性；创建真实 resize 手势仍使用规范节点下限。
 */
export function normalizeScopeBaseRect(rect: ScopeRect, minHalf: number): ScopeRect {
  const half = finite(minHalf) && minHalf > 0 ? minHalf : 32;
  const width = finite(rect.width) ? rect.width : 0;
  const height = finite(rect.height) ? rect.height : 0;
  const x = finite(rect.x) ? rect.x : 0;
  const y = finite(rect.y) ? rect.y : 0;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const w = Math.max(width, half * 2);
  const h = Math.max(height, half * 2);
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

/**
 * 地面矩形 → 画布多边形与抓手。
 *
 * 顶点为 `center ± (AXIS_X×hx, AXIS_Y×hx) ± (-AXIS_X×hz, AXIS_Y×hz)`；四边斜率 ±s，外包矩形
 * 宽高比由 `CANVAS_CAMERA_PITCH` 决定。非法/退化输入围绕中心保留最小地面范围。
 */
export function compositeAssetScopeGround(
  ground: ScopeGround,
  minHalf = 32
): { center: ScopePoint; vertices: CompositeAssetScopeGeometry["vertices"]; aabb: ScopeRect; radiusX: number; radiusY: number; handles: ScopeHandle[] } {
  const ax = COMPOSITE_ASSET_SCOPE_AXIS_X;
  const ay = COMPOSITE_ASSET_SCOPE_AXIS_Y;
  const safe = finite(minHalf) && minHalf > 0 ? minHalf : 32;
  const cx = finite(ground.cx) ? ground.cx : 0;
  const cy = finite(ground.cy) ? ground.cy : 0;
  const minHalfGround = safe / (ax * 2);
  let hx = finite(ground.hx) ? ground.hx : 0;
  let hz = finite(ground.hz) ? ground.hz : 0;
  if (hx + hz < minHalfGround * 2) {
    hx = minHalfGround;
    hz = minHalfGround;
  }
  const top = { x: cx - ax * (hx - hz), y: cy - ay * (hx + hz) };
  const right = { x: cx + ax * (hx + hz), y: cy + ay * (hx - hz) };
  const bottom = { x: cx + ax * (hx - hz), y: cy + ay * (hx + hz) };
  const left = { x: cx - ax * (hx + hz), y: cy - ay * (hx - hz) };
  const radiusX = ax * (hx + hz);
  const radiusY = ay * (hx + hz);
  const mid = (a: ScopePoint, b: ScopePoint): ScopePoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return {
    center: { x: cx, y: cy },
    vertices: [top, right, bottom, left],
    aabb: { x: cx - radiusX, y: cy - radiusY, width: radiusX * 2, height: radiusY * 2 },
    radiusX,
    radiusY,
    handles: [
      { id: "n", point: top },
      { id: "ne", point: mid(top, right) },
      { id: "e", point: right },
      { id: "se", point: mid(right, bottom) },
      { id: "s", point: bottom },
      { id: "sw", point: mid(bottom, left) },
      { id: "w", point: left },
      { id: "nw", point: mid(left, top) }
    ]
  };
}

/**
 * 由基准矩形与形状派生范围几何。
 *
 * - `rect`：范围即基准矩形，顶点为四角，抓手为四角与四边中点；
 * - `isometric-diamond`：范围即 `ground` 派生的地面矩形（四边平行网格）；缺省 `ground` 时
 *   退回基准矩形，避免出现无几何依据的范围。
 */
export function compositeAssetScopeGeometry(
  base: ScopeRect,
  shape: CompositeAssetScopeShape = "rect",
  minHalf = 32,
  ground?: ScopeGround
): CompositeAssetScopeGeometry {
  const normalized = normalizeScopeBaseRect(base, minHalf);
  const cx = normalized.x + normalized.width / 2;
  const cy = normalized.y + normalized.height / 2;
  if (shape === "isometric-diamond" && ground) {
    const derived = compositeAssetScopeGround(ground, minHalf);
    return { shape, base: normalized, ground, ...derived };
  }
  const halfW = normalized.width / 2;
  const halfH = normalized.height / 2;
  const tl = { x: cx - halfW, y: cy - halfH };
  const tr = { x: cx + halfW, y: cy - halfH };
  const br = { x: cx + halfW, y: cy + halfH };
  const bl = { x: cx - halfW, y: cy + halfH };
  const mid = (a: ScopePoint, b: ScopePoint): ScopePoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return {
    shape: "rect",
    base: normalized,
    center: { x: cx, y: cy },
    vertices: [tl, tr, br, bl],
    aabb: { ...normalized },
    radiusX: halfW,
    radiusY: halfH,
    handles: [
      { id: "n", point: mid(tl, tr) },
      { id: "ne", point: tr },
      { id: "e", point: mid(tr, br) },
      { id: "se", point: br },
      { id: "s", point: mid(br, bl) },
      { id: "sw", point: bl },
      { id: "w", point: mid(bl, tl) },
      { id: "nw", point: tl }
    ]
  };
}

/** 多边形是否包含点（凸多边形，含边界；按顶点顺序判定同侧）。 */
export function convexPolygonContains(
  vertices: readonly ScopePoint[],
  point: ScopePoint,
  epsilon = COMPOSITE_ASSET_SCOPE_EPSILON
): boolean {
  let sign = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index]!;
    const b = vertices[(index + 1) % vertices.length]!;
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length <= 0) continue;
    const distance = cross / length;
    if (Math.abs(distance) <= epsilon) continue;
    const current = distance > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (sign !== current) return false;
  }
  return true;
}

/**
 * 范围是否包含世界点（凸多边形含边界判定）。
 *
 * 地面矩形用四顶点凸多边形判定，因此外包矩形空白角为 false；矩形形状退化为轴对齐矩形判定。
 */
export function compositeAssetScopeContains(
  geometry: CompositeAssetScopeGeometry,
  point: ScopePoint
): boolean {
  if (!finite(point.x) || !finite(point.y)) return false;
  if (geometry.shape === "isometric-diamond") {
    return convexPolygonContains(geometry.vertices, point, COMPOSITE_ASSET_SCOPE_EPSILON);
  }
  const { x, y, width, height } = geometry.aabb;
  const eps = COMPOSITE_ASSET_SCOPE_EPSILON;
  return point.x >= x - eps && point.x <= x + width + eps
    && point.y >= y - eps && point.y <= y + height + eps;
}

function rectsOverlapPositive(a: ScopeRect, b: ScopeRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
}

type Axis = ScopePoint;

function projectRange(vertices: readonly ScopePoint[], axis: Axis): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const vertex of vertices) {
    const value = vertex.x * axis.x + vertex.y * axis.y;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

function polygonAxes(vertices: readonly ScopePoint[]): Axis[] {
  const axes: Axis[] = [];
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index]!;
    const b = vertices[(index + 1) % vertices.length]!;
    const edgeX = b.x - a.x;
    const edgeY = b.y - a.y;
    const length = Math.hypot(edgeX, edgeY);
    if (length <= 0) continue;
    // 边法线 = 边方向逆时针旋转 90°；归一化保证 epsilon 与尺度一致。
    axes.push({ x: -edgeY / length, y: edgeX / length });
  }
  return axes;
}

/**
 * 范围是否与框选矩形有**正面积**相交（仅触边不算）。
 *
 * 使用凸多边形 SAT：轴取 x/y 轴与范围边法线。矩形形状退化为现有严格矩形相交判定；地面矩形与
 * AABB 空白角只触发边不产生正面积交叠。
 */
export function compositeAssetScopeIntersectsRect(
  geometry: CompositeAssetScopeGeometry,
  rect: ScopeRect
): boolean {
  const left = Math.min(rect.x, rect.x + rect.width);
  const right = Math.max(rect.x, rect.x + rect.width);
  const top = Math.min(rect.y, rect.y + rect.height);
  const bottom = Math.max(rect.y, rect.y + rect.height);
  const marquee: ScopeRect = { x: left, y: top, width: right - left, height: bottom - top };
  if (!finite(marquee.x) || !finite(marquee.y) || !(marquee.width > 0) || !(marquee.height > 0)) return false;
  // AABB 粗筛：完全分离即无交叠。
  const aabb = geometry.aabb;
  if (!rectsOverlapPositive(aabb, marquee)) return false;
  if (geometry.shape !== "isometric-diamond") return true;
  const marqueeVertices: ScopePoint[] = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom }
  ];
  const axes: Axis[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, ...polygonAxes(geometry.vertices)];
  for (const axis of axes) {
    const a = projectRange(geometry.vertices, axis);
    const b = projectRange(marqueeVertices, axis);
    // 正面积相交：任一轴投影不重叠（含仅触边）即判定分离。
    if (a.max <= b.min || b.max <= a.min) return false;
  }
  return true;
}

/**
 * 范围抓手（8 个）：四顶点 `n/e/s/w` 与四边中点 `ne/se/sw/nw`。
 *
 * 可见抓手与命中区共用同一组中心；与对角顶点差分即缩放轴。普通矩形同样暴露 8 抓手。
 */
export function compositeAssetScopeGrip(geometry: CompositeAssetScopeGeometry): readonly ScopeHandle[] {
  return geometry.handles;
}

/**
 * 抓手是否包含世界点（以抓手中心为心的 `COMPOSITE_ASSET_SCOPE_HANDLE` 方块，含给定容差）。
 *
 * 返回命中的抓手（用于确定缩放方向）；未命中返回 `null`。
 */
export function compositeAssetScopeGripHit(
  geometry: CompositeAssetScopeGeometry,
  point: ScopePoint,
  tolerance = 0
): ScopeHandle | null {
  if (!finite(point.x) || !finite(point.y)) return null;
  const half = COMPOSITE_ASSET_SCOPE_HANDLE / 2 + tolerance;
  let best: ScopeHandle | null = null;
  let bestDistance = Infinity;
  for (const handle of geometry.handles) {
    const dx = Math.abs(point.x - handle.point.x);
    const dy = Math.abs(point.y - handle.point.y);
    if (dx <= half && dy <= half) {
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = handle;
      }
    }
  }
  return best;
}

/** 抓手集合是否包含世界点（任意抓手命中）。 */
export function compositeAssetScopeGripContains(
  geometry: CompositeAssetScopeGeometry,
  point: ScopePoint,
  tolerance = 0
): boolean {
  return compositeAssetScopeGripHit(geometry, point, tolerance) !== null;
}

/**
 * 对角锁定的等比缩放系数（change: design D6）。
 *
 * 给定拖拽抓手 `H`、固定锚点 `A`（对角锁定的固定角）与指针 `P`，把指针位移投影到
 * 缩放轴 `H - A`：`k = 1 + dot(P - H, H - A) / |H - A|²`。非有限/退化输入返回 `1`。
 * 等比缩放规范尺寸 `width = w0×k`、`height = h0×k`；锚点固定，另一维位置按锚点回算。
 */
export function scopeScaleFactor(pointer: ScopePoint, handle: ScopePoint, anchor: ScopePoint): number {
  if (![pointer.x, pointer.y, handle.x, handle.y, anchor.x, anchor.y].every(finite)) return 1;
  const dx = handle.x - anchor.x;
  const dy = handle.y - anchor.y;
  const denominator = dx * dx + dy * dy;
  if (!(denominator > 0)) return 1;
  return 1 + ((pointer.x - handle.x) * dx + (pointer.y - handle.y) * dy) / denominator;
}
