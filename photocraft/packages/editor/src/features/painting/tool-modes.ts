/**
 * 绘画工具的模式/容差/采样参数
 * （change: 2026-10-22-add-photocraft-painting-color-workflows，U27/U28/U29/U31/U34）。
 *
 * 这里只做**参数编译**：把界面上的工具设置编成内核已有命令的 `params`，并做与内核一致的范围
 * 钳制。参数名与上游 `CommandSpec` 逐字一致，因此不复制另一套语义：
 *
 * - 铅笔 `paint.pencil`（`autoErase`、`size`、`brush` 补丁）；
 * - 颜色替换 `paint.colorReplacement`（`mode`/`tolerance`/`sampling`/`limits`）；
 * - 渐变 `paint.gradient`（`from`/`to`/`style`/`stops`/`transparency`/`opacity`/`mode`）；
 * - 油漆桶 `paint.bucket`（`tolerance`/`contiguous`/`antiAlias`/`sampleAllLayers`/`opacity`/`mode`）；
 * - 背景橡皮 `paint.backgroundEraser`（`sampling`/`limits`/`tolerance`/`protectForegroundColor`）；
 * - 魔术橡皮 `paint.magicEraser`（`tolerance`/`contiguous`/`antiAlias`/`sampleAllLayers`/`opacity`）；
 * - 对称 `paint.setSymmetry` / `paint.symmetryFromPath` / `paint.symmetryDisable`；
 * - 吸管 `document.sampleColor`（`size`/`sampleLayer`）。
 *
 * 所有函数对非法输入返回 `null`（而不是悄悄改成别的值），由调用方决定提示还是拒绝。
 */
import { clamp, type DocumentPoint } from "../shared/tool-parameters.js";
import { clampBrushSize } from "./tool-parameters.js";
import { strokePoints, type StrokePoint } from "./stroke-points.js";

/**
 * 绘画混合模式（与内核 `paint.stroke` 的 `mode` 取值一致）。
 *
 * 清单在 `blend-modes.ts`（笔迹编译也要用）；这里重新导出，保持本模块的既有导入面。
 */
export { PAINT_BLEND_MODES, isPaintBlendMode, type PaintBlendMode } from "./blend-modes.js";
import { isPaintBlendMode, type PaintBlendMode } from "./blend-modes.js";

/** 背景橡皮的取样方式。 */
export type EraserSampling = "continuous" | "once" | "backgroundSwatch";
export const ERASER_SAMPLINGS: readonly EraserSampling[] = ["continuous", "once", "backgroundSwatch"];

/** 背景橡皮／颜色替换的边界方式。 */
export type EraserLimits = "discontiguous" | "contiguous" | "findEdges";
export const ERASER_LIMITS: readonly EraserLimits[] = ["discontiguous", "contiguous", "findEdges"];

/** 渐变样式（与内核一致）。 */
export type GradientStyle = "linear" | "radial" | "angle" | "reflected" | "diamond";
export const GRADIENT_STYLES: readonly GradientStyle[] = ["linear", "radial", "angle", "reflected", "diamond"];

/**
 * 插值方式（内核 `io::bake_gradient::Method` 的四个合法名字）。
 *
 * 省略时用内核的直线色标；给了 `method` 内核会把 Photoshop 式插值烘焙成密集色标。
 * `smoothness` 只在该模式下有意义，因此两者一起暴露。
 */
export const GRADIENT_METHODS = ["classic", "perceptual", "linear", "smooth"] as const;
export type GradientMethod = (typeof GRADIENT_METHODS)[number];

/** 渐变色标：位置 0–1 + `#rrggbb`／`foreground`／`background`。 */
export type GradientStop = { location: number; color: string };
/** 渐变透明度色标：位置 0–1 + 不透明度 0–100。 */
export type GradientOpacityStop = { location: number; opacity: number };

/** 吸管采样层策略（与内核 `document.sampleColor` 的 `sampleLayer` 一致）。 */
export type SampleLayers = "current" | "currentAndBelow" | "all" | "allNoAdjustments" | "currentAndBelowNoAdjustments";
export const SAMPLE_LAYERS: readonly SampleLayers[] = ["current", "currentAndBelow", "all", "allNoAdjustments", "currentAndBelowNoAdjustments"];

/** 平均采样尺寸（内核允许的点采样与方框边长）。 */
export const SAMPLE_SIZES = [1, 3, 5, 11, 31, 51, 101] as const;
export type SampleSize = (typeof SAMPLE_SIZES)[number] | "point";

/** 对称模式（与 `photocraft_paint::symmetry::SymmetryMode` 的 id 一致：垂直/水平/双轴/对角）。 */
export type SymmetryMode = "vertical" | "horizontal" | "dual" | "diagonal";
export const SYMMETRY_MODES: readonly SymmetryMode[] = ["vertical", "horizontal", "dual", "diagonal"];

const COLOR_STOP = /^(#[0-9a-f]{6}|foreground|background)$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finite(value: unknown, min: number, max: number): number | null {
  if (!isFiniteNumber(value)) return null;
  return clamp(value, min, max);
}

// ---------------------------------------------------------------- 铅笔（U27）

export type PencilSettings = {
  /** 自动擦除：在底色上画背景色（与内核 `autoErase` 一致）。 */
  autoErase: boolean;
  /** 笔头尺寸（源像素）。 */
  size: number;
  /** 颜色 `#rrggbb`。 */
  color: string;
};

export const DEFAULT_PENCIL: PencilSettings = { autoErase: false, size: 4, color: "#000000" };

/** `paint.pencil` 参数：铅笔是硬边笔尖（`brush.hardness = 1`），不暴露软边与流量。 */
export function buildPencil(
  points: readonly StrokePoint[],
  settings: PencilSettings,
  options: { target?: "pixels" | "mask"; zoom?: number; mode?: PaintBlendMode } = {},
): Record<string, unknown> | null {
  if (points.length === 0) return null;
  const size = clampBrushSize(settings.size);
  if (!isFiniteNumber(size) || !COLOR_STOP.test(settings.color)) return null;
  const mode = options.mode ?? "normal";
  if (!isPaintBlendMode(mode)) return null;
  return {
    points: strokePoints(points),
    size,
    color: settings.color,
    mode,
    autoErase: settings.autoErase,
    zoom: options.zoom && options.zoom > 0 ? options.zoom : 1,
    brush: { hardness: 1, spacing: 0.05, smoothing: { enabled: false, amount: 0 }, flow: 1, opacity: 1 },
    target: options.target ?? "pixels"
  };
}

// ---------------------------------------------------------------- 颜色替换（U27）

/** 颜色替换的匹配维度（与内核 `paint.colorReplacement` 的 `mode` 一致）。 */
export type ColorReplacementMode = "hue" | "saturation" | "color" | "luminosity";
export const COLOR_REPLACEMENT_MODES: readonly ColorReplacementMode[] = ["hue", "saturation", "color", "luminosity"];

export type ColorReplacementSettings = {
  mode: ColorReplacementMode;
  /** 容差 0–100（内核按百分比解释）。 */
  tolerance: number;
  sampling: EraserSampling;
  limits: EraserLimits;
  /** 抗锯齿边缘。 */
  antiAlias: boolean;
  /**
   * 笔头尺寸（源像素）。
   *
   * 必须是本工具自己的设置：早期面板借用背景橡皮的 `size`，于是「在颜色替换里改笔头，
   * 背景橡皮的笔头也跟着变」，与「逐工具冻结笔迹设置」相悖。省略时仍回落到背景橡皮的
   * 尺寸，保持既有调用方与旧工程行为不变。
   */
  size?: number;
};

export const DEFAULT_COLOR_REPLACEMENT: ColorReplacementSettings = {
  mode: "color",
  tolerance: 30,
  sampling: "continuous",
  limits: "contiguous",
  antiAlias: true
};

/**
 * `paint.colorReplacement` 参数：整笔一组设置，`points` 带压力。
 *
 * 拒绝未知的模式/采样/边界，而不是退回默认值——工具面板显示的就是实际行为的来源。
 */
export function buildColorReplacement(
  points: readonly StrokePoint[],
  settings: ColorReplacementSettings,
  paint: { size: number; color: string; target?: "pixels" | "mask" },
): Record<string, unknown> | null {
  if (points.length === 0) return null;
  if (!COLOR_REPLACEMENT_MODES.includes(settings.mode)) return null;
  if (!ERASER_SAMPLINGS.includes(settings.sampling)) return null;
  if (!ERASER_LIMITS.includes(settings.limits)) return null;
  if (!COLOR_STOP.test(paint.color)) return null;
  const tolerance = finite(settings.tolerance, 0, 100);
  // 尺寸优先取本工具自己的设置；只有旧调用方省略时才回落到背景橡皮的尺寸。
  const size = clampBrushSize(settings.size ?? paint.size);
  if (tolerance === null || !isFiniteNumber(size)) return null;
  return {
    points: strokePoints(points),
    size,
    color: paint.color,
    mode: settings.mode,
    tolerance,
    sampling: settings.sampling,
    limits: settings.limits,
    antiAlias: settings.antiAlias,
    target: paint.target ?? "pixels"
  };
}

// ---------------------------------------------------------------- 渐变（U28）

export type GradientSettings = {
  style: GradientStyle;
  stops: GradientStop[];
  transparency: GradientOpacityStop[];
  /** 反向。 */
  reverse: boolean;
  /** 不透明度 1–100。 */
  opacity: number;
  /** 抖动以减少色带。 */
  dither: boolean;
  /** 插值方式；省略时用内核的直线色标。 */
  method?: GradientMethod;
  /** 插值平滑度 0–100；只在给了 `method` 时随命令发出（内核默认 100）。 */
  smoothness?: number;
};

export const DEFAULT_GRADIENT: GradientSettings = {
  style: "linear",
  stops: [
    { location: 0, color: "foreground" },
    { location: 1, color: "background" }
  ],
  transparency: [],
  reverse: false,
  opacity: 100,
  dither: true
};

/**
 * `paint.gradient` 参数：端点固定在源坐标，色标必须单调、位置有限。
 *
 * 少于两个色标或非法颜色时返回 `null`，不生成「整层填充」替代。
 */
export function buildGradient(
  from: DocumentPoint,
  to: DocumentPoint,
  settings: GradientSettings,
  options: { target?: "pixels" | "mask"; mode?: PaintBlendMode } = {},
): Record<string, unknown> | null {
  if (![from.x, from.y, to.x, to.y].every(isFiniteNumber)) return null;
  if (from.x === to.x && from.y === to.y) return null;
  if (!GRADIENT_STYLES.includes(settings.style)) return null;
  if (settings.stops.length < 2 || settings.stops.length > 64) return null;
  const stops: [number, string][] = [];
  let previous = -1;
  for (const stop of settings.stops) {
    if (!isFiniteNumber(stop.location) || stop.location < 0 || stop.location > 1) return null;
    if (stop.location < previous) return null;
    if (!COLOR_STOP.test(stop.color)) return null;
    previous = stop.location;
    stops.push([stop.location, stop.color]);
  }
  const transparency: [number, number][] = [];
  previous = -1;
  for (const stop of settings.transparency) {
    if (!isFiniteNumber(stop.location) || stop.location < 0 || stop.location > 1) return null;
    if (stop.location < previous) return null;
    const opacity = finite(stop.opacity, 0, 100);
    if (opacity === null) return null;
    previous = stop.location;
    transparency.push([stop.location, opacity]);
  }
  const opacity = finite(settings.opacity, 1, 100);
  if (opacity === null) return null;
  const mode = options.mode ?? "normal";
  if (!isPaintBlendMode(mode)) return null;
  // 未知插值方式整笔拒绝：静默退回直线色标会让「界面选了 Perceptual、实际按直线画」通过验收。
  if (settings.method !== undefined && !GRADIENT_METHODS.includes(settings.method)) return null;
  const smoothness = settings.smoothness === undefined ? null : finite(settings.smoothness, 0, 100);
  if (settings.smoothness !== undefined && smoothness === null) return null;
  return {
    from: [from.x, from.y],
    to: [to.x, to.y],
    style: settings.style,
    stops,
    ...(transparency.length ? { transparency } : {}),
    reverse: settings.reverse,
    opacity,
    dither: settings.dither,
    mode,
    ...(settings.method ? { method: settings.method } : {}),
    // `smoothness` 只在给了 `method` 时才发：没有插值方式时它不起作用，发了只会让人误解。
    ...(settings.method && smoothness !== null ? { smoothness } : {}),
    target: options.target ?? "pixels"
  };
}

// ---------------------------------------------------------------- 油漆桶（U28）

export type BucketSettings = {
  /** 容差 0–255（与内核 `paint.bucket` 一致，不是百分比）。 */
  tolerance: number;
  contiguous: boolean;
  antiAlias: boolean;
  sampleAllLayers: boolean;
  /** 不透明度 1–100。 */
  opacity: number;
};

export const DEFAULT_BUCKET: BucketSettings = {
  tolerance: 32,
  contiguous: true,
  antiAlias: true,
  sampleAllLayers: false,
  opacity: 100
};

/** `paint.bucket` 参数：点击处一个点，其余为填充设置。 */
export function buildBucket(point: DocumentPoint, color: string, settings: BucketSettings, options: { target?: "pixels" | "mask" } = {}): Record<string, unknown> | null {
  if (![point.x, point.y].every(isFiniteNumber)) return null;
  if (!COLOR_STOP.test(color)) return null;
  const tolerance = finite(settings.tolerance, 0, 255);
  const opacity = finite(settings.opacity, 1, 100);
  if (tolerance === null || opacity === null) return null;
  return {
    x: point.x,
    y: point.y,
    color,
    tolerance,
    contiguous: settings.contiguous,
    antiAlias: settings.antiAlias,
    sampleAllLayers: settings.sampleAllLayers,
    opacity,
    target: options.target ?? "pixels"
  };
}

/** 油漆桶也可以填当前图案（`contents: "pattern"`）；图案由 layers 域拥有，这里只透传 id/名。 */
export function buildPatternBucket(point: DocumentPoint, pattern: string, settings: BucketSettings): Record<string, unknown> | null {
  if (!pattern.trim() || pattern.length > 200 || pattern.includes("\0")) return null;
  const base = buildBucket(point, "foreground", settings);
  return base ? { ...base, contents: "pattern", pattern } : null;
}

// ---------------------------------------------------------------- 背景橡皮（U29）

export type BackgroundEraserSettings = {
  sampling: EraserSampling;
  limits: EraserLimits;
  /** 容差 0–100。 */
  tolerance: number;
  /** 保护前景色。 */
  protectForegroundColor: boolean;
  size: number;
  hardness: number;
};

export const DEFAULT_BACKGROUND_ERASER: BackgroundEraserSettings = {
  sampling: "continuous",
  limits: "contiguous",
  tolerance: 50,
  protectForegroundColor: false,
  size: 30,
  hardness: 1
};

export function buildBackgroundEraser(
  points: readonly StrokePoint[],
  settings: BackgroundEraserSettings,
  options: { target?: "pixels" | "mask"; seed?: number } = {},
): Record<string, unknown> | null {
  if (points.length === 0) return null;
  if (!ERASER_SAMPLINGS.includes(settings.sampling)) return null;
  if (!ERASER_LIMITS.includes(settings.limits)) return null;
  const tolerance = finite(settings.tolerance, 0, 100);
  const hardness = finite(settings.hardness, 0, 1);
  const size = clampBrushSize(settings.size);
  if (tolerance === null || hardness === null || !isFiniteNumber(size)) return null;
  return {
    points: strokePoints(points),
    size,
    hardness,
    sampling: settings.sampling,
    limits: settings.limits,
    tolerance,
    protectForegroundColor: settings.protectForegroundColor,
    ...(isFiniteNumber(options.seed) ? { seed: options.seed } : {}),
    target: options.target ?? "pixels"
  };
}

// ---------------------------------------------------------------- 魔术橡皮（U29）

export type MagicEraserSettings = {
  tolerance: number;
  contiguous: boolean;
  antiAlias: boolean;
  sampleAllLayers: boolean;
  /** 不透明度 1–100。 */
  opacity: number;
};

export const DEFAULT_MAGIC_ERASER: MagicEraserSettings = {
  tolerance: 32,
  contiguous: true,
  antiAlias: true,
  sampleAllLayers: false,
  opacity: 100
};

export function buildMagicEraser(point: DocumentPoint, settings: MagicEraserSettings, options: { target?: "pixels" | "mask" } = {}): Record<string, unknown> | null {
  if (![point.x, point.y].every(isFiniteNumber)) return null;
  const tolerance = finite(settings.tolerance, 0, 255);
  const opacity = finite(settings.opacity, 1, 100);
  if (tolerance === null || opacity === null) return null;
  return {
    x: point.x,
    y: point.y,
    tolerance,
    contiguous: settings.contiguous,
    antiAlias: settings.antiAlias,
    sampleAllLayers: settings.sampleAllLayers,
    opacity,
    target: options.target ?? "pixels"
  };
}

// ---------------------------------------------------------------- 对称（U33）

export type SymmetrySettings = {
  mode: SymmetryMode;
  /** 源坐标中心。 */
  center: [number, number];
  /** 绕中心的旋转（度）。 */
  rotation: number;
};

/** `paint.setSymmetry` 参数。 */
export function buildSymmetry(settings: SymmetrySettings): Record<string, unknown> | null {
  if (!SYMMETRY_MODES.includes(settings.mode)) return null;
  const [x, y] = settings.center;
  if (![x, y, settings.rotation].every(isFiniteNumber)) return null;
  return { mode: settings.mode, center: [x, y], rotation: settings.rotation };
}

/**
 * `paint.symmetryFromPath` 参数：只消费规范路径快照，默认取当前工作路径。
 *
 * 路径几何归 vectors 域，这里不构造第二份路径模型，只传递来源名（`work`／`layer`／保存的路径名）。
 */
export function buildSymmetryFromPath(source = "work"): Record<string, unknown> | null {
  const name = source.trim();
  if (!name || name.length > 200 || name.includes("\0")) return null;
  return { name };
}

/** `paint.symmetryDisable` 参数（无参，保留显式空对象便于命令行记录）。 */
export function buildSymmetryDisable(): Record<string, unknown> {
  return {};
}

/** 未启用时的只读状态。 */
export type SymmetryState = { enabled: false } | ({ enabled: true } & Record<string, unknown>);

/** 解码 `symmetryStateJson()` 的有界结果；非法结构返回 `null`。 */
export function decodeSymmetryState(input: unknown): SymmetryState | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.enabled === false) return { enabled: false };
  if (value.enabled !== true) return null;
  const mode = typeof value.mode === "string" && SYMMETRY_MODES.includes(value.mode as SymmetryMode) ? value.mode : undefined;
  const center = Array.isArray(value.center) && value.center.length === 2 && value.center.every(isFiniteNumber)
    ? (value.center as [number, number])
    : undefined;
  const rotation = isFiniteNumber(value.rotation) ? value.rotation : 0;
  // `path` 对称没有中心/旋转，只有来源与段数。
  if (mode) return { enabled: true, mode, center, rotation };
  if (typeof value.source === "string") {
    return { enabled: true, mode: "path", source: value.source, segments: isFiniteNumber(value.segments) ? value.segments : 0 };
  }
  return null;
}

// ---------------------------------------------------------------- 吸管（U34）

export type EyedropperSettings = {
  size: SampleSize;
  sampleLayer: SampleLayers;
  /**
   * 取色目标：前景或背景色。
   *
   * 这是**画布 Alt 取色**的目标（共享画布把结果写回哪个色板），不是 `document.sampleColor`
   * 的参数：内核只返回色值。域面板没有可写颜色端口，因此面板只报告色值，不提供这个开关。
   */
  target: "foreground" | "background";
};

export const DEFAULT_EYEDROPPER: EyedropperSettings = { size: 1, sampleLayer: "all", target: "foreground" };

/** `document.sampleColor` 参数。`size` 为 `point` 或 `SAMPLE_SIZES` 之一。 */
export function buildSampleColor(point: DocumentPoint, settings: EyedropperSettings): Record<string, unknown> | null {
  if (![point.x, point.y].every(isFiniteNumber)) return null;
  const size = settings.size === "point" || (SAMPLE_SIZES as readonly number[]).includes(settings.size) ? settings.size : null;
  if (size === null) return null;
  if (!SAMPLE_LAYERS.includes(settings.sampleLayer)) return null;
  return { x: point.x, y: point.y, size, sampleLayer: settings.sampleLayer };
}

/** 吸管结果：`null` 表示图外或透明（内核明确返回空值，不假装取到颜色）。 */
export type SampledColor = { hex: string; alpha: number; rgba: [number, number, number, number] };

export function decodeSampledColor(input: unknown): SampledColor | null | undefined {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.hex !== "string" || !/^#[0-9a-f]{6}$/.test(value.hex)) return undefined;
  if (!isFiniteNumber(value.alpha) || value.alpha < 0 || value.alpha > 1) return undefined;
  if (!Array.isArray(value.rgba) || value.rgba.length !== 4 || !value.rgba.every(isFiniteNumber)) return undefined;
  return { hex: value.hex, alpha: value.alpha, rgba: value.rgba as [number, number, number, number] };
}
