/**
 * 矢量形状参数与预设快照的 wire 契约（U08–U16，change:
 * 2026-10-22-add-photocraft-vector-canvas-tools，design D2/D4）。
 *
 * 这里只放**纯数据与纯函数**：形状命令参数的合法范围、预设库快照的有界形态。
 * 与内核 `features/vectors/composition_domain.rs`（`validate_shape_params` /
 * `validate_preset_place`）和 `features/vectors/presets.rs`（`MAX_*` 常量）逐条对应，
 * 因此界面可以在发命令前用同一套范围拒绝非法值，而不是等内核报错。
 *
 * 预算只**引用**既有全局上限（`IMAGE_PROJECT_LIMITS.maxCanvasSide`），不新增工程预算；
 * 本域自己的条目预算与内核同值，改动需同时改两侧。
 */

import { IMAGE_PROJECT_LIMITS } from "../../image-edit.js";

/** 可拖绘/可提交的形状种类（与内核 `DRAW_KINDS` 一致）。 */
/**
 * 内核 `shape.create` / `shape.edit` 真正接受的形状种类。
 *
 * 界面上的「三角形」不是独立种类：它由编辑器编译成 `polygon` + `sides: 3`
 * （见 `packages/editor/src/features/vectors/shape-tools.ts`），因此**不在此列**——
 * 把界面词汇混进 wire 枚举会让「界面能选、内核不认」的悬空值通过校验。
 */
export const VECTOR_SHAPE_KINDS = ["rect", "roundedRect", "ellipse", "polygon", "star", "line", "path"] as const;
export type VectorShapeKind = (typeof VECTOR_SHAPE_KINDS)[number];

/** 路径运算（子路径级填充规则）。 */
export const VECTOR_PATH_OPS = ["combine", "subtract", "intersect", "exclude"] as const;
export type VectorPathOp = (typeof VECTOR_PATH_OPS)[number];

/**
 * 本域预算（与内核同名常量同值；不抬高全局工程预算）。
 *
 * 路径相关预算直接引用 `IMAGE_PROJECT_LIMITS` 的同名字段（唯一权威来源是
 * `rust/project-limits.json`），因此界面、协议与核验器不会各留一份数字。
 */
export const VECTOR_LIMITS = {
  /** 多边形/星形边数范围。 */
  minSides: 3,
  maxSides: 100,
  /** 星形内外比例范围（不含 1）。 */
  minStarRatio: 0.01,
  maxStrokeWidth: 1_000_000,
  /** 单条路径子路径数上限。 */
  maxSubpaths: IMAGE_PROJECT_LIMITS.maxVectorSubpaths,
  /** 已存命名路径数量上限。 */
  maxSavedPaths: IMAGE_PROJECT_LIMITS.maxVectorSavedPaths,
  /** 单个子路径的锚点数量上限。 */
  maxKnotsPerSubpath: IMAGE_PROJECT_LIMITS.maxVectorKnotsPerSubpath,
  /** 一份工程内所有矢量路径的锚点累计上限（解码前预算）。 */
  maxPathPoints: IMAGE_PROJECT_LIMITS.maxVectorPathPoints,
  /** 自定形状条目上限。 */
  maxCustomShapes: 256,
  /** 预设名称字符上限。 */
  maxPresetName: 200,
  /** 预设快照字节上限。 */
  maxSnapshotBytes: 1 << 20,
  /** 坐标可保存范围：画布单边 × 8（与内核 `point_in_canvas` 同口径）。 */
  coordLimit: IMAGE_PROJECT_LIMITS.maxCanvasSide * 8,
} as const;

/** 规范形状参数（解码后的只读投影，不携带第二份几何）。 */
export type VectorShapeParams = {
  kind: VectorShapeKind;
  /** 非直线形状的 `[x, y, 宽, 高]`；直线为 null。 */
  rect: [number, number, number, number] | null;
  /** 直线端点；其余形状为 null。 */
  from: [number, number] | null;
  to: [number, number] | null;
  radii: [number, number, number, number] | null;
  sides: number | null;
  starRatio: number | null;
  weight: number | null;
  fillRule: "nonzero" | "evenodd";
  op: VectorPathOp | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function point(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [x, y] = value;
  if (!finite(x) || !finite(y)) return null;
  if (Math.abs(x) > VECTOR_LIMITS.coordLimit || Math.abs(y) > VECTOR_LIMITS.coordLimit) return null;
  return [x, y];
}

function rect(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [x, y, width, height] = value;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (Math.abs(x) > VECTOR_LIMITS.coordLimit || Math.abs(y) > VECTOR_LIMITS.coordLimit) return null;
  if (width > VECTOR_LIMITS.coordLimit || height > VECTOR_LIMITS.coordLimit) return null;
  return [x, y, width, height];
}

/**
 * 解码 `shape.create` / `shape.edit` 参数。
 *
 * 任何越界都返回 `null`（调用方保留上一份有效草稿），不做静默夹取——与内核一致。
 * 直线只认 `from`/`to`/`weight`；其余形状只认 `rect`，并校验圆角不超过短边一半。
 */
export function decodeVectorShapeParams(input: unknown): VectorShapeParams | null {
  if (!isRecord(input)) return null;
  const kind = VECTOR_SHAPE_KINDS.find(candidate => candidate === input.kind);
  if (!kind) return null;
  const fillRule = input.fillRule === undefined ? "nonzero" : input.fillRule;
  if (fillRule !== "nonzero" && fillRule !== "evenodd") return null;
  const op = input.op === undefined ? null : VECTOR_PATH_OPS.find(candidate => candidate === input.op) ?? null;
  if (input.op !== undefined && op === null) return null;

  if (kind === "line") {
    const from = point(input.from);
    const to = point(input.to);
    if (!from || !to) return null;
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 1e-6) return null;
    const weight = input.weight === undefined ? 1 : input.weight;
    if (!finite(weight) || weight < 0 || weight > VECTOR_LIMITS.maxStrokeWidth) return null;
    return { kind, rect: null, from, to, radii: null, sides: null, starRatio: null, weight, fillRule, op };
  }

  // 路径形状（`kind: "path"`）由 `path` 字段承载几何，这里只校验其余参数。
  const box = kind === "path" ? null : rect(input.rect);
  if (kind !== "path" && !box) return null;

  let radii: [number, number, number, number] | null = null;
  if (input.radii !== undefined) {
    const list = Array.isArray(input.radii) ? input.radii : [input.radii, input.radii, input.radii, input.radii];
    if (list.length !== 4 || !list.every(entry => finite(entry) && entry >= 0)) return null;
    radii = [list[0], list[1], list[2], list[3]] as [number, number, number, number];
    if (box && radii.some(radius => radius > Math.min(box[2], box[3]) / 2)) return null;
  }

  let sides: number | null = null;
  if (kind === "polygon" || kind === "star") {
    const value = input.sides === undefined ? 5 : input.sides;
    if (!Number.isInteger(value) || (value as number) < VECTOR_LIMITS.minSides || (value as number) > VECTOR_LIMITS.maxSides) return null;
    sides = value as number;
  }

  let starRatio: number | null = null;
  if (input.starRatio !== undefined) {
    const value = input.starRatio;
    if (!finite(value) || value < VECTOR_LIMITS.minStarRatio || value > 1) return null;
    if (kind === "star") {
      // 星形必须真的凹进去：1 会退化成正多边形，与请求的种类不符。
      if (value >= 1) return null;
      starRatio = value;
    } else if (value < 1) {
      // 非星形却要凹多边形：内核会把它渲染成星形，同样与请求的 kind 不符。
      return null;
    }
    // 非星形的 1 是上游「正多边形」哨兵值，等价于不提供，保留 null。
  } else if (kind === "star") {
    starRatio = 0.5;
  }

  return { kind, rect: box, from: null, to: null, radii, sides, starRatio, weight: null, fillRule, op };
}

/** 预设库快照里的形状摘要（与内核 `vectorPresetsJson()` 的条目同形）。 */
export type VectorShapePresetEntry = { name: string; digest?: string; subpaths: number };

/** 预设库快照的有界投影（`revision` 是内核工具状态计数，不参与内容身份）。 */
export type VectorShapePresetLibrary = {
  groups: { name: string; shapes: VectorShapePresetEntry[] }[];
  custom: VectorShapePresetEntry[];
  revision?: number;
};

function presetEntry(value: unknown): VectorShapePresetEntry | null {
  if (!isRecord(value)) return null;
  const name = value.name;
  if (typeof name !== "string" || !name.trim() || name.length > VECTOR_LIMITS.maxPresetName) return null;
  const digest = value.digest;
  if (digest !== undefined) {
    if (typeof digest !== "string" || !/^[0-9a-f]{16}$/.test(digest)) return null;
  }
  // 内核快照始终带 `subpaths`：缺字段说明拿到的不是预设快照，按结构非法拒绝，而不是补默认值。
  const subpaths = value.subpaths;
  if (!Number.isInteger(subpaths) || (subpaths as number) < 0 || (subpaths as number) > VECTOR_LIMITS.maxSubpaths) return null;
  return { name, subpaths: subpaths as number, ...(digest === undefined ? {} : { digest }) };
}

/**
 * 解码预设库快照。结构不符或超限返回 `null`，调用方保留上一份有效库。
 *
 * 条目数是**两条**独立预算（组内与自定），都以 `maxCustomShapes` 为上限；不把整库条目相加。
 */
export function decodeVectorShapePresetLibrary(input: unknown): VectorShapePresetLibrary | null {
  if (!isRecord(input)) return null;
  if (!Array.isArray(input.groups) || !Array.isArray(input.custom)) return null;
  if (input.groups.length > VECTOR_LIMITS.maxCustomShapes || input.custom.length > VECTOR_LIMITS.maxCustomShapes) return null;
  const groups: VectorShapePresetLibrary["groups"] = [];
  for (const group of input.groups) {
    if (!isRecord(group)) return null;
    const name = group.name;
    if (typeof name !== "string" || !name.trim() || name.length > VECTOR_LIMITS.maxPresetName) return null;
    if (!Array.isArray(group.shapes) || group.shapes.length > VECTOR_LIMITS.maxCustomShapes) return null;
    const shapes: VectorShapePresetEntry[] = [];
    for (const shape of group.shapes) {
      const entry = presetEntry(shape);
      if (!entry) return null;
      shapes.push(entry);
    }
    groups.push({ name, shapes });
  }
  const custom: VectorShapePresetEntry[] = [];
  for (const shape of input.custom) {
    const entry = presetEntry(shape);
    if (!entry) return null;
    custom.push(entry);
  }
  let revision: number | undefined;
  if (input.revision !== undefined) {
    if (!Number.isInteger(input.revision) || (input.revision as number) < 0 || (input.revision as number) > Number.MAX_SAFE_INTEGER) return null;
    revision = input.revision as number;
  }
  return { groups, custom, ...(revision === undefined ? {} : { revision }) };
}

/** 快照序列化字节是否在预算内（恢复前先拒绝超大输入，不进解析）。 */
export function vectorPresetSnapshotWithinBudget(serialized: string): boolean {
  return serialized.length <= VECTOR_LIMITS.maxSnapshotBytes;
}

/** 路径几何是否可保存：子路径/锚点数有界，每点有限且在可保存范围内。 */
export function vectorPathWithinBudget(input: unknown): boolean {
  if (!isRecord(input) || !Array.isArray(input.subpaths)) return false;
  if (input.subpaths.length === 0 || input.subpaths.length > VECTOR_LIMITS.maxSubpaths) return false;
  let points = 0;
  return input.subpaths.every(subpath => {
    if (!isRecord(subpath) || !Array.isArray(subpath.knots) || subpath.knots.length === 0) return false;
    if (subpath.knots.length > VECTOR_LIMITS.maxKnotsPerSubpath) return false;
    points += subpath.knots.length;
    if (points > VECTOR_LIMITS.maxPathPoints) return false;
    return subpath.knots.every(knot => {
      // 两种锚点写法：`[x, y]` 角点，或 `{anchor, in?, out?}`。
      if (Array.isArray(knot)) return point(knot) !== null;
      if (!isRecord(knot)) return false;
      return point(knot.anchor) !== null
        && (knot.in === undefined || point(knot.in) !== null)
        && (knot.out === undefined || point(knot.out) !== null);
    });
  });
}
