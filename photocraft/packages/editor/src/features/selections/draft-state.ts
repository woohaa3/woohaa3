/**
 * 选区/蒙版草稿的纯前端部分（U17–U24）。
 *
 * 这里只做三件事：把内核草稿视图解码成有界类型、把界面参数编译成**上游命令真正接受**的形状、
 * 挡住过期候选。它不持有文档，也不复制第二份选区或蒙版；内容永远只由内核产生。
 *
 * 编译函数与 Rust 侧的校验范围一致：越界值在这里夹紧或拒绝，避免“界面能调、确认才报错”。
 */
import { IMAGE_PROJECT_LIMITS } from "@woohaa3/photocraft-protocol";
import { type DocumentPoint, clamp, roundPixel } from "../shared/tool-parameters.js";
import type { SelectionMode } from "./tool-parameters.js";

/** 选区运算方式（面板与测试共用；唯一定义仍在 `tool-parameters.ts`）。 */
export type { SelectionMode };

/** 草稿种类，与内核 `DraftKind::id()` 一一对应。 */
export type SelectionDraftKind = "modify" | "magnetic" | "colorRange" | "grow" | "similar" | "refine" | "quickMask" | "smart";

/** 选区包围盒 `[x, y, w, h]`（源像素）。 */
export type SelectionRect = [number, number, number, number];
/** 边界线段 `[x0, y0, x1, y1]`，与画布叠加层同一约定。 */
export type SelectionSegment = [number, number, number, number];

/** 内核草稿视图（`selectionDraftStateJson()`）。 */
export type SelectionDraftState =
  | { active: false }
  | {
      active: true;
      kind: SelectionDraftKind;
      document: number;
      revision: number;
      /** 草稿属于别的活动文档：可见但禁止确认（切标签/父子回写后）。 */
      stale: boolean;
      bounds: SelectionRect | null;
      maskBounds: SelectionRect | null;
      invalid: boolean;
    };

const KINDS: readonly SelectionDraftKind[] = ["modify", "magnetic", "colorRange", "grow", "similar", "refine", "quickMask", "smart"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rect(value: unknown): SelectionRect | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  return [value[0] as number, value[1] as number, value[2] as number, value[3] as number];
}

/** 解码草稿视图；结构非法返回 `null`（界面显示“无法读取草稿”而不是猜）。 */
export function decodeDraftState(input: unknown): SelectionDraftState | null {
  if (!isRecord(input) || typeof input.active !== "boolean") return null;
  if (!input.active) return { active: false };
  const kind = KINDS.find((entry) => entry === input.kind);
  if (!kind) return null;
  if (typeof input.document !== "number" || typeof input.revision !== "number") return null;
  return {
    active: true,
    kind,
    document: input.document,
    revision: input.revision,
    stale: input.stale === true,
    bounds: rect(input.bounds),
    maskBounds: rect(input.maskBounds),
    invalid: input.invalid === true
  };
}

/** 草稿是否仍属于当前文档与修订（过期候选一律丢弃）。 */
export function draftBelongsTo(
  state: SelectionDraftState | null,
  owner: { document: number; revision: number }
): boolean {
  if (state?.active !== true || state.stale) return false;
  return state.document === owner.document && state.revision === owner.revision;
}

/**
 * 迟到的异步候选是否应丢弃。
 *
 * `requested` 是发起时的请求序号，`current` 是最新序号；两者不同即丢弃，绝不覆盖更新的候选。
 */
export function isStaleResult(requested: number, current: number): boolean {
  return requested !== current;
}

// ------------------------------------------------------------------ U17 单行/单列

export type LineAxis = "row" | "column";

/** `selectLine` 参数：单击点决定落在哪一行/列，跨度由内核覆盖整个画布。 */
export function selectLineParams(point: DocumentPoint, options: { line?: LineAxis; mode?: SelectionMode; canvas: { width: number; height: number } }): Record<string, unknown> | null {
  const { width, height } = options.canvas;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || width <= 0 || height <= 0) return null;
  const x = Math.floor(point.x);
  const y = Math.floor(point.y);
  // 图外单击不生成半截手势（与内核的拒绝条件一致，避免先往返一次内核才报错）。
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  return { x, y, line: options.line ?? "row", mode: options.mode ?? "replace" };
}

// ------------------------------------------------------------------ U18 多边形/磁性套索

/** 磁性/多边形套索至少 3 个锚点；不足返回 `null`，调用方不提交。 */
export function magneticLassoParams(
  points: readonly DocumentPoint[],
  options: { mode?: SelectionMode; width?: number; contrast?: number; close?: "magnetic" | "straight"; trace?: boolean; canvas: { width: number; height: number } } = { canvas: { width: 0, height: 0 } }
): Record<string, unknown> | null {
  if (points.length < 3) return null;
  if (!points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) return null;
  const { width, height } = options.canvas;
  const clampX = (x: number) => (width > 0 ? clamp(x, 0, width) : x);
  const clampY = (y: number) => (height > 0 ? clamp(y, 0, height) : y);
  const params: Record<string, unknown> = {
    // 追踪由内核完成（`trace` 缺省为 true）；界面从不自己猜边界。
    points: points.map((point) => [roundPixel(clampX(point.x)), roundPixel(clampY(point.y))]),
    width: clamp(options.width ?? 10, 1, 256),
    contrast: clamp(options.contrast ?? 10, 1, 100),
    close: options.close ?? "magnetic",
    mode: options.mode ?? "replace",
    antiAlias: true,
    feather: 0
  };
  // 多边形套索：锚点序列就是最终边界，关闭内核追踪（`trace:false` 时 width/contrast 不参与）。
  if (options.trace === false) {
    params.trace = false;
    delete params.width;
    delete params.contrast;
  }
  return params;
}

/** 多边形套索的锚点序列编辑：追加、回退、闭合判定（不含 DOM 与内核）。 */
export class LassoAnchors {
  private points: DocumentPoint[] = [];
  append(point: DocumentPoint): void {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    this.points.push({ x: point.x, y: point.y });
  }
  /** 回退最后一个锚点（Backspace）；没有锚点时返回 false。 */
  retreat(): boolean {
    return this.points.pop() !== undefined;
  }
  clear(): void {
    this.points = [];
  }
  get length(): number {
    return this.points.length;
  }
  /** 至少三个锚点才可闭合；双击/闭合键都走这里。 */
  canClose(): boolean {
    return this.points.length >= 3;
  }
  /** 闭合前的锚点副本（调用方不得改动内部数组）。 */
  snapshot(): DocumentPoint[] {
    return this.points.map((point) => ({ ...point }));
  }
}

// ------------------------------------------------------------------ U19 命名选区 / Grow / Similar

export const NAMED_SELECTION_MAX_LENGTH = 200;

/** 命名选区名称：去空白后非空且不超长；非法返回 `null`。 */
export function normalizeSelectionName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > NAMED_SELECTION_MAX_LENGTH) return null;
  return trimmed;
}

/** `select.grow` / `select.similar` 参数（按颜色，不是几何 Expand）。 */
export function colorGrowParams(tolerance: number, sampleAllLayers = false): Record<string, unknown> {
  return { tolerance: clamp(Math.round(tolerance), 0, 255), sampleAllLayers };
}

// ------------------------------------------------------------------ U20 快速蒙版

/** 快速蒙版笔迹参数：目标固定为临时选择通道，不落到图层像素或像素蒙版。 */
export function quickMaskStrokeParams(
  points: readonly DocumentPoint[],
  brush: { size: number; hardness?: number; opacity?: number; color?: string }
): Record<string, unknown> | null {
  if (points.length === 0) return null;
  if (!points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) return null;
  return {
    points: points.map((point) => [point.x, point.y]),
    size: clamp(brush.size, 1, 5000),
    hardness: clamp(brush.hardness ?? 1, 0, 1),
    opacity: clamp(brush.opacity ?? 1, 0, 1),
    flow: 1,
    color: brush.color ?? "#ffffff",
    // 临时目标由内核写进候选文档；这里显式声明，避免沿用画笔当前目标。
    target: "quickMask"
  };
}

/**
 * 上游的"进入/退出快速蒙版"命令 id。
 *
 * 它**不能**被界面直接 `dispatch`：内核会改正式文档，而本域没有任何草稿记录，
 * 之后 `paintQuickMask` 报"没有活动的快速蒙版会话"、保存却照常成功。所有入口
 * （Q 键、菜单、脚本、将来的自动化）都必须先经本域会话。
 */
export const QUICK_MASK_COMMAND = "select.editInQuickMaskMode";

/** 该命令是否必须改道本域会话（而不是走共享 `run()` 直通内核）。 */
export function isQuickMaskCommand(id: string): boolean {
  return id === QUICK_MASK_COMMAND;
}

// ------------------------------------------------------------------ U21 传统分割

export type SmartSelectKind = "object" | "subject" | "sky" | "focusArea" | "removeBackground";

/** 传统分割的参数编译：只发命令接受的字段。 */
export function smartSelectParams(
  kind: SmartSelectKind,
  options: { mode?: SelectionMode; point?: DocumentPoint; rect?: SelectionRect; threshold?: number; softness?: number; range?: number; noise?: number; sampleAllLayers?: boolean; output?: "selection" | "mask" } = {}
): Record<string, unknown> {
  // 采样层的缺省值按种类区分（移除背景默认只采当前层），所以由下方分支自己决定。
  const base = smartSelectBase(kind, { ...options, sampleAllLayers: options.sampleAllLayers });
  // `output` 是本域草稿的意图，确认时由内核决定是否补一步选区→蒙版；移除背景本身就是蒙版。
  if (options.output === "mask" && kind !== "removeBackground") base.output = "mask";
  return base;
}

function smartSelectBase(
  kind: SmartSelectKind,
  options: { mode?: SelectionMode; point?: DocumentPoint; rect?: SelectionRect; threshold?: number; softness?: number; range?: number; noise?: number; sampleAllLayers?: boolean }
): Record<string, unknown> {
  const sampleAllLayers = options.sampleAllLayers ?? true;
  switch (kind) {
    case "object": {
      const params: Record<string, unknown> = { mode: options.mode ?? "replace", sampleAllLayers };
      if (options.rect) {
        const [x, y, width, height] = options.rect;
        if (width > 0 && height > 0) params.rect = [x, y, width, height];
      }
      if (options.point) params.point = [Math.round(options.point.x), Math.round(options.point.y)];
      return params;
    }
    case "subject":
      // 上游 `select.subject` 只接受采样层与组合模式：主体由本地传统分割算出，没有额外阈值。
      return { mode: options.mode ?? "replace", sampleAllLayers };
    case "sky":
      return { mode: options.mode ?? "replace", sampleAllLayers, threshold: clamp(options.threshold ?? 50, 0, 100), softness: clamp(options.softness ?? 50, 0, 100) };
    case "focusArea":
      return { mode: options.mode ?? "replace", sampleAllLayers, range: clamp(options.range ?? 0.5, 0, 1), noise: clamp(options.noise ?? 0, 0, 1) };
    case "removeBackground":
      return { sampleAllLayers: options.sampleAllLayers ?? false, refine: true };
  }
}

// ------------------------------------------------------------------ U22 色彩范围

export type ColorRangePreset =
  | "sampledColors"
  | "reds"
  | "yellows"
  | "greens"
  | "cyans"
  | "blues"
  | "magentas"
  | "highlights"
  | "midtones"
  | "shadows"
  | "skinTones";

/** 取样点按点击顺序保存；`+` 是取样，`-` 是减去取样。 */
export type SamplePoint = { point: DocumentPoint; operation: "+" | "-" };

/** 取样序列：保持点击顺序，供内核 `order` 复现。 */
export class SamplePoints {
  private items: SamplePoint[] = [];
  add(point: DocumentPoint, operation: "+" | "-" = "+"): boolean {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    this.items.push({ point: { x: point.x, y: point.y }, operation });
    return true;
  }
  /** 撤销最后一次取样（吸管的“回退”）。 */
  undo(): boolean {
    return this.items.pop() !== undefined;
  }
  clear(): void {
    this.items = [];
  }
  get length(): number {
    return this.items.length;
  }
  snapshot(): SamplePoint[] {
    return this.items.map((item) => ({ point: { ...item.point }, operation: item.operation }));
  }
}

/**
 * `select.colorRange` 参数。
 *
 * 取样点与减去取样点分开上交，同时给出点击顺序 `order`；`localized` 需要至少一个取样点，
 * `detectFaces` 上游未实现——这里直接拒绝，不把“看起来能开”的开关交给用户。
 */
export function colorRangeParams(options: {
  samples?: readonly SamplePoint[];
  preset?: ColorRangePreset;
  color?: string;
  colors?: readonly string[];
  fuzziness?: number;
  mode?: SelectionMode;
  invert?: boolean;
  localized?: boolean;
  range?: number;
  tonalRange?: number | [number, number];
  sampleAllLayers?: boolean;
  detectFaces?: boolean;
}): Record<string, unknown> | null {
  if (options.detectFaces) return null;
  const samples = options.samples ?? [];
  const points = samples.filter((sample) => sample.operation === "+").map((sample) => [roundPixel(sample.point.x), roundPixel(sample.point.y)]);
  const subtractPoints = samples.filter((sample) => sample.operation === "-").map((sample) => [roundPixel(sample.point.x), roundPixel(sample.point.y)]);
  const preset = options.preset ?? "sampledColors";
  const hasColor = options.color !== undefined || (options.colors?.length ?? 0) > 0;
  if (points.length === 0 && subtractPoints.length === 0 && preset === "sampledColors" && !hasColor) return null;
  if ((options.localized ?? false) && points.length === 0) return null;
  const params: Record<string, unknown> = {
    select: preset,
    fuzziness: clamp(options.fuzziness ?? 40, 0, 200),
    mode: options.mode ?? "replace",
    invert: options.invert ?? false,
    localized: options.localized ?? false,
    sampleAllLayers: options.sampleAllLayers ?? true
  };
  if (points.length) params.points = points;
  if (subtractPoints.length) params.subtractPoints = subtractPoints;
  if (samples.length) params.order = samples.map((sample) => sample.operation);
  if (options.color !== undefined) params.color = options.color;
  if (options.colors?.length) params.colors = [...options.colors];
  if (options.localized) params.range = clamp(options.range ?? 100, 0, 100);
  if (options.tonalRange !== undefined) params.tonalRange = options.tonalRange;
  return params;
}

// ------------------------------------------------------------------ U23 选择并遮住

export type RefineOutput = "selection" | "layerMask" | "newLayer" | "newLayerWithMask" | "newDocument" | "newDocumentWithMask";

export const REFINE_OUTPUTS: readonly { id: RefineOutput; label: string; opensDocument?: boolean }[] = [
  { id: "selection", label: "选区" },
  { id: "layerMask", label: "像素蒙版" },
  { id: "newLayer", label: "新图层" },
  { id: "newLayerWithMask", label: "新图层（含蒙版）" },
  { id: "newDocument", label: "新文档", opensDocument: true },
  { id: "newDocumentWithMask", label: "新文档（含蒙版）", opensDocument: true }
];

/** 手工修边笔迹（前景=按图像重新细化，背景=保留原边缘）。 */
export type RefineStroke = { points: readonly DocumentPoint[]; mode: "foreground" | "background"; size?: number };

export type RefineEdgeInput = {
  radius?: number;
  smartRadius?: boolean;
  smooth?: number;
  feather?: number;
  contrast?: number;
  shiftEdge?: number;
  decontaminate?: boolean;
  amount?: number;
  output?: RefineOutput;
  sampleAllLayers?: boolean;
  strokes?: readonly RefineStroke[];
};

/** 边缘细化的界面范围；越界直接夹紧（与 Rust `refine_edge_params` 一致）。 */
export function refineEdgeParams(input: RefineEdgeInput = {}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    radius: clamp(input.radius ?? 0, 0, 250),
    smartRadius: input.smartRadius ?? false,
    smooth: clamp(input.smooth ?? 0, 0, 100),
    feather: clamp(input.feather ?? 0, 0, 1000),
    contrast: clamp(input.contrast ?? 0, 0, 100),
    shiftEdge: clamp(input.shiftEdge ?? 0, -100, 100),
    output: input.output ?? "selection",
    sampleAllLayers: input.sampleAllLayers ?? false
  };
  if (input.decontaminate) {
    params.decontaminate = true;
    params.amount = clamp(input.amount ?? 100, 0, 100);
  }
  const strokes = (input.strokes ?? []).filter((stroke) => stroke.points.length > 0);
  if (strokes.length) {
    params.refineStrokes = strokes.map((stroke) => ({
      points: stroke.points.map((point) => [roundPixel(point.x), roundPixel(point.y)]),
      mode: stroke.mode === "background" ? "subtract" : "add",
      size: clamp(stroke.size ?? 20, 1, 500)
    }));
  }
  return params;
}

/** 某个输出是否需要占用「新文档」名额。 */
export function refineOutputOpensDocument(output: RefineOutput): boolean {
  return output === "newDocument" || output === "newDocumentWithMask";
}

/**
 * 净化颜色会把"选区/像素蒙版"输出**升级**为"新图层（含蒙版）"（上游 `refine_edge`：去色需要新像素）。
 *
 * 面板必须显式报出这个真实结果：否则用户选了"选区"、勾了净化颜色，确认后却多出一个图层且选区变空，
 * 看起来像"输出设置没生效"。这里只做**显示层**的映射，不改用户的选择，也不暗中改下拉框。
 */
export function refineEffectiveOutput(output: RefineOutput, decontaminate: boolean | undefined): RefineOutput {
  return decontaminate && (output === "selection" || output === "layerMask") ? "newLayerWithMask" : output;
}

/** `refineEffectiveOutput` 的结果是否与用户所选不同（用于提示"输出已被升级"）。 */
export function refineOutputUpgraded(output: RefineOutput, decontaminate: boolean | undefined): boolean {
  return refineEffectiveOutput(output, decontaminate) !== output;
}

// ------------------------------------------------------------------ U24 像素蒙版属性

export type MaskViewMode = "off" | "gray" | "overlay";

/** 像素蒙版属性视图（`layerMaskProperties()`）。 */
export type MaskProperties = {
  layer: number | null;
  mask: { enabled: boolean; linked: boolean; density: number; feather: number } | null;
  view: MaskViewMode | null;
  editTarget: "pixels" | "mask";
};

export function decodeMaskProperties(input: unknown): MaskProperties | null {
  if (!isRecord(input)) return null;
  const layer = typeof input.layer === "number" ? input.layer : null;
  const rawMask = input.mask;
  let mask: MaskProperties["mask"] = null;
  if (isRecord(rawMask)) {
    if (typeof rawMask.density !== "number" || typeof rawMask.feather !== "number") return null;
    if (!Number.isFinite(rawMask.density) || !Number.isFinite(rawMask.feather)) return null;
    mask = {
      enabled: rawMask.enabled !== false,
      linked: rawMask.linked !== false,
      density: clamp(rawMask.density, 0, 100),
      feather: clamp(rawMask.feather, 0, 1000)
    };
  }
  const view = input.view === "gray" || input.view === "overlay" ? input.view : null;
  return { layer, mask, view, editTarget: input.editTarget === "mask" ? "mask" : "pixels" };
}

/** 蒙版密度（0–100 → 内核 0–1 由内核换算；这里只负责界面范围）。 */
export function clampMaskDensity(value: number): number {
  return clamp(value, 0, 100);
}

/** 非破坏羽化半径（源像素）。 */
export function clampMaskFeather(value: number): number {
  return clamp(value, 0, Math.min(1000, IMAGE_PROJECT_LIMITS.maxFeatherSourcePixels * 10));
}

/** `layer.layerMask.edit` 参数：至少一个属性。 */
export function layerMaskEditParams(edit: { density?: number; feather?: number; layer?: number }): Record<string, unknown> | null {
  const params: Record<string, unknown> = {};
  if (edit.density !== undefined) params.density = clampMaskDensity(edit.density);
  if (edit.feather !== undefined) params.feather = clampMaskFeather(edit.feather);
  if (params.density === undefined && params.feather === undefined) return null;
  if (edit.layer !== undefined) params.layer = edit.layer;
  return params;
}

/** 查看蒙版（`view.layerMask`）：查看是会话状态，不写内容历史。 */
export function maskViewParams(mode: MaskViewMode | "toggleGray" | "toggleOverlay", layer?: number): Record<string, unknown> {
  return layer === undefined ? { mode } : { mode, layer };
}
