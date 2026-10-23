/**
 * 形状布尔运算与路径变换（U13/U14，change: 2026-10-22-add-photocraft-vector-canvas-tools，
 * design D3/D4）。
 *
 * 轮廓与填充规则由内核计算（上游 `layer.combineShapes.*`、`path.transform`、`select.convertToShape`）；
 * 本模块只做三件事：
 *
 * 1. 把界面动作映射成**具体命令 id**（一次点击一次命令，一步历史）；
 * 2. 在提交前裁定前置条件（需要哪些形状层、选区是否存在、变换参数是否有限），
 *    非法时不发命令——不留半成品；
 * 3. 明确层序与填充规则说明，供面板文案与验收引用。
 */

/** 五种布尔运算（与上游命令一一对应）。 */
export const BOOLEAN_OPS = ["unite", "subtractFrontShape", "intersectShapeAreas", "excludeOverlappingShapes", "mergeShapeComponents"] as const;
export type BooleanOp = (typeof BOOLEAN_OPS)[number];

export const BOOLEAN_LABELS: Record<BooleanOp, string> = {
  unite: "合并形状",
  subtractFrontShape: "减去顶层形状",
  intersectShapeAreas: "相交形状区域",
  excludeOverlappingShapes: "排除重叠形状",
  mergeShapeComponents: "合并形状组件",
};

/** 每种运算的语义说明：层序与填充规则不靠界面猜。 */
export const BOOLEAN_NOTES: Record<BooleanOp, string> = {
  unite: "所有选中形状的并集；最底层保留自己的路径运算，上层按合并叠加。",
  subtractFrontShape: "从最底层形状中减去上层形状覆盖的区域；层序即相减方向。",
  intersectShapeAreas: "只保留所有选中形状共同覆盖的区域。",
  excludeOverlappingShapes: "保留各自覆盖但不重叠的区域（异或）。",
  mergeShapeComponents: "把路径运算烘焙成普通轮廓；容差控制曲线近似精度。",
};

export type BooleanPrerequisite = {
  /** 选中形状层数（单选一个形状层时改其组件运算）。 */
  shapeLayers: number;
  /** 活动层是否形状层。 */
  activeIsShape: boolean;
  readonly: boolean;
};

/** 提交前裁定：不满足条件的动作直接禁用并在界面写明原因。 */
export function booleanAvailability(op: BooleanOp, state: BooleanPrerequisite): { enabled: true } | { enabled: false; reason: string } {
  if (state.readonly) return { enabled: false, reason: "当前编辑器为只读" };
  if (!state.activeIsShape) return { enabled: false, reason: "请先选中形状图层" };
  if (op !== "mergeShapeComponents" && state.shapeLayers < 2) {
    return { enabled: false, reason: "布尔运算需要选中至少两个形状图层" };
  }
  return { enabled: true };
}

/** 命令 id（`layer.combineShapes.*`）。 */
export function booleanCommand(op: BooleanOp): string {
  return `layer.combineShapes.${op}`;
}

/**
 * 提交参数：多选形状层时不带 `layer`（上游据此合并整层）；
 * 单选时用 `subpath` 改组件运算，`tolerance` 只对合并组件有效。
 */
export function booleanParams(op: BooleanOp, options: { layer?: number | null; subpath?: number | null; tolerance?: number } = {}): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (options.layer != null) params.layer = options.layer;
  if (options.subpath != null) params.subpath = options.subpath;
  if (op === "mergeShapeComponents" && options.tolerance != null) {
    if (!Number.isFinite(options.tolerance) || options.tolerance < 0.05 || options.tolerance > 10) {
      throw new Error("合并组件的容差必须在 0.05–10 px 之间");
    }
    params.tolerance = options.tolerance;
  }
  return params;
}

/** 路径变换：仿射矩阵 `[a,b,c,d,e,f]`，由内核 `path.transform` 应用。 */
export type PathTransform = readonly [number, number, number, number, number, number];

export function transformParams(target: { name: string; layer?: number | null }, matrix: PathTransform): Record<string, unknown> {
  if (matrix.length !== 6 || matrix.some(value => !Number.isFinite(value))) throw new Error("路径变换矩阵必须是六个有限数值");
  const [a, b, c, d, e, f] = matrix;
  return { name: target.name, ...(target.layer == null ? {} : { layer: target.layer }), matrix: [a, b, c, d, e, f] };
}

/** 平移/旋转/缩放的常用矩阵，避免各处手写。 */
export const PATH_MATRIX = {
  translate: (dx: number, dy: number): PathTransform => [1, 0, 0, 1, dx, dy],
  scale: (sx: number, sy = sx): PathTransform => [sx, 0, 0, sy, 0, 0],
  rotate: (degrees: number): PathTransform => {
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return [cos, sin, -sin, cos, 0, 0];
  },
} as const;

/** 裁切路径：引用某个已存路径名；平直度 0 = 打印机默认。 */
export function clippingPathParams(name: string, flatness = 0): Record<string, unknown> {
  if (!name.trim()) throw new Error("裁切路径必须引用一个已存路径");
  if (!Number.isFinite(flatness) || flatness < 0 || flatness > 100) throw new Error("平直度必须在 0–100 之间");
  return { name, flatness };
}

/**
 * 选区转形状：由内核描摹选区轮廓（`select.convertToShape`）。
 *
 * `tolerance` 是简化容差（0.5–10 px），决定轮廓精度；不传用上游默认 2 px。
 */
export function selectionToShapeParams(options: { tolerance?: number; fill?: string; name?: string } = {}): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (options.tolerance != null) {
    if (!Number.isFinite(options.tolerance) || options.tolerance < 0.5 || options.tolerance > 10) {
      throw new Error("选区转形状的容差必须在 0.5–10 px 之间");
    }
    params.tolerance = options.tolerance;
  }
  if (options.fill) params.fill = options.fill;
  if (options.name) params.name = options.name;
  return params;
}

/** 路径转选区（与裁切路径/变换同一族）。 */
export function pathToSelectionParams(target: { name: string }, options: { feather?: number; mode?: "replace" | "add" | "subtract" | "intersect" } = {}): Record<string, unknown> {
  const params: Record<string, unknown> = { name: target.name };
  if (options.feather != null) {
    if (!Number.isFinite(options.feather) || options.feather < 0) throw new Error("羽化半径不能为负");
    params.feather = options.feather;
  }
  if (options.mode) params.mode = options.mode;
  return params;
}
