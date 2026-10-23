/**
 * 绘画、笔刷动态与颜色的纯协议声明
 * （change: 2026-10-22-add-photocraft-painting-color-workflows，U27–U36）。
 *
 * 本文件只声明**数据形状与有界校验**：没有 DOM、没有 WASM、没有编辑器状态。命令参数与内核
 * `CommandSpec` 逐字一致，因此协议校验与内核校验说的是同一件事。
 *
 * 为什么放在协议包：渐变/色板/工具预设会被宿主保存与跨文档复制，它们的上界必须与内核共享
 * 一份，而不是各层各写一套。
 */

/** 渐变色标的最大数量（与内核 `gradient.presets.*` 的上界一致）。 */
export const MAX_GRADIENT_STOPS = 64;
/** 工具预设单条 `options` 的上限（与内核 64 KiB 一致）。 */
export const MAX_TOOL_PRESET_OPTIONS_BYTES = 64 * 1024;
/** 工具预设条目上限（比内核 1000 更保守，避免整库进偏好存储）。 */
export const MAX_TOOL_PRESETS = 200;
/** 色板/渐变预设名称上限。 */
export const MAX_PRESET_NAME_CHARS = 255;
/** 吸管平均采样尺寸（与内核一致）。 */
export const SAMPLE_SIZES = [1, 3, 5, 11, 31, 51, 101] as const;

/** 渐变色标：位置 0–1 + 固定色或活的前/背景色。 */
export type GradientStopInput = readonly [location: number, color: string];
/** 渐变透明度色标：位置 0–1 + 不透明度 0–100。 */
export type GradientTransparencyInput = readonly [location: number, opacity: number];

const STOP_COLOR = /^(#[0-9a-f]{6}|foreground|background)$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 预设名称是否合法（去空格后 1–255 字符，无 NUL）。 */
export function isValidPresetName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_PRESET_NAME_CHARS && !value.includes("\0");
}

/**
 * 校验并规范化渐变色标表。
 *
 * 拒绝（返回 `null`）：少于两个或多于 {@link MAX_GRADIENT_STOPS} 个色标、位置越界或乱序、
 * 颜色既不是 `#rrggbb` 也不是 `foreground`/`background`。不排序、不补齐——静默修补会让
 * 界面显示与落笔不一致。
 */
export function normalizeGradientStops(input: unknown): [number, string][] | null {
  if (!Array.isArray(input) || input.length < 2 || input.length > MAX_GRADIENT_STOPS) return null;
  const stops: [number, string][] = [];
  let previous = -1;
  for (const raw of input) {
    if (!Array.isArray(raw) || raw.length !== 2) return null;
    const [location, color] = raw as unknown[];
    if (!isFiniteNumber(location) || location < 0 || location > 1 || location < previous) return null;
    if (typeof color !== "string" || !STOP_COLOR.test(color)) return null;
    previous = location;
    stops.push([location, color]);
  }
  return stops;
}

/** 校验并规范化渐变透明度色标表；空数组合法（不透明）。 */
export function normalizeGradientTransparency(input: unknown): [number, number][] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > MAX_GRADIENT_STOPS) return null;
  const stops: [number, number][] = [];
  let previous = -1;
  for (const raw of input) {
    if (!Array.isArray(raw) || raw.length !== 2) return null;
    const [location, opacity] = raw as unknown[];
    if (!isFiniteNumber(location) || location < 0 || location > 1 || location < previous) return null;
    if (!isFiniteNumber(opacity) || opacity < 0 || opacity > 100) return null;
    previous = location;
    stops.push([location, opacity]);
  }
  return stops;
}

/** 渐变预设的规范形（`gradient.presets.new` / `list` 的元素）。 */
export type GradientPresetInput = {
  name: string;
  stops: [number, string][];
  transparency: [number, number][];
};

/** 校验一条渐变预设；任何一处非法整条拒绝。 */
export function normalizeGradientPreset(input: unknown): GradientPresetInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!isValidPresetName(value.name)) return null;
  const stops = normalizeGradientStops(value.stops);
  const transparency = normalizeGradientTransparency(value.transparency);
  if (!stops || !transparency) return null;
  return { name: value.name, stops, transparency };
}

/** 吸管采样尺寸是否在内核允许的集合内（`"point"` 是 1 的别名）。 */
export function isSampleSize(value: unknown): value is number | "point" {
  return value === "point" || (typeof value === "number" && (SAMPLE_SIZES as readonly number[]).includes(value));
}

/** 吸管采样层策略（与内核 `document.sampleColor` 一致）。 */
export const SAMPLE_LAYER_IDS = ["current", "currentAndBelow", "all", "allNoAdjustments", "currentAndBelowNoAdjustments"] as const;
export type SampleLayerId = (typeof SAMPLE_LAYER_IDS)[number];

export function isSampleLayer(value: unknown): value is SampleLayerId {
  return typeof value === "string" && (SAMPLE_LAYER_IDS as readonly string[]).includes(value);
}

/**
 * `document.sampleColor` 参数校验（只校验，不改写）。
 *
 * 坐标必须是有限数：内核用它们索引源像素，`NaN`/`Infinity` 会在转换时变成别的有效坐标。
 */
export function validateSampleColorParams(input: unknown): { x: number; y: number; size: number | "point"; sampleLayer: SampleLayerId } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return null;
  const size = value.size === undefined ? 1 : value.size;
  if (!isSampleSize(size)) return null;
  const sampleLayer = value.sampleLayer === undefined ? "all" : value.sampleLayer;
  if (!isSampleLayer(sampleLayer)) return null;
  return { x: value.x, y: value.y, size, sampleLayer };
}

/** 工具预设 `options` 的序列化字节数（供保存前的预算检查）。 */
export function toolPresetOptionsBytes(options: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(options ?? {})).length;
  } catch {
    // 循环引用等不可序列化结构：按超限处理，而不是抛给调用方。
    return MAX_TOOL_PRESET_OPTIONS_BYTES + 1;
  }
}

/** 工具预设是否在预算内（名称 + 非对象参数都拒绝）。 */
export function validateToolPreset(input: unknown): { name: string; tool: string; options: Record<string, unknown> } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!isValidPresetName(value.name)) return null;
  if (typeof value.tool !== "string" || !value.tool.trim() || value.tool.length > 64) return null;
  const options = value.options === undefined ? {} : value.options;
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  if (toolPresetOptionsBytes(options) > MAX_TOOL_PRESET_OPTIONS_BYTES) return null;
  return { name: value.name, tool: value.tool, options: options as Record<string, unknown> };
}

/** 对称模式（与 `photocraft_paint` 的 `SymmetryMode::id` 一致）。 */
export const SYMMETRY_MODE_IDS = ["vertical", "horizontal", "dual", "diagonal"] as const;
export type SymmetryModeId = (typeof SYMMETRY_MODE_IDS)[number];

export function isSymmetryMode(value: unknown): value is SymmetryModeId {
  return typeof value === "string" && (SYMMETRY_MODE_IDS as readonly string[]).includes(value);
}

/**
 * `paint.setSymmetry` 参数校验。
 *
 * 中心必须是两个有限数；旋转必须是有限数（内核会归一化到 0–360）。省略中心表示画布中心，
 * 因此这里允许缺省但不接受半个坐标。
 */
export function validateSymmetryParams(input: unknown): { mode: SymmetryModeId; center?: [number, number]; rotation: number } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!isSymmetryMode(value.mode)) return null;
  let center: [number, number] | undefined;
  if (value.center !== undefined && value.center !== null) {
    if (!Array.isArray(value.center) || value.center.length !== 2 || !value.center.every(isFiniteNumber)) return null;
    center = [value.center[0] as number, value.center[1] as number];
  }
  const rotation = value.rotation === undefined ? 0 : value.rotation;
  if (!isFiniteNumber(rotation)) return null;
  return { mode: value.mode, ...(center ? { center } : {}), rotation };
}

/** 绘画域独占的命令前缀（含结尾点；与内核 `PAINTING_COMMAND_PREFIXES` 逐字一致）。 */
export const PAINTING_COMMAND_PREFIXES = ["paint.", "swatches.", "gradient.presets.", "tool.presets.", "brush.presets."] as const;
/** 绘画域独占的完整命令 id。 */
export const PAINTING_COMMAND_IDS = ["document.sampleColor", "brush.defineFromSelection", "brush.get", "brush.texturePattern"] as const;
/** 本域原生补齐的命令（上游只在 egui 外壳提供）。 */
export const PAINTING_NATIVE_COMMANDS = ["tool.reset", "tool.resetAll"] as const;

/** 命令是否归绘画域所有（与内核同一个判定）。 */
export function ownsPaintingCommand(id: string): boolean {
  return (PAINTING_NATIVE_COMMANDS as readonly string[]).includes(id)
    || (PAINTING_COMMAND_IDS as readonly string[]).includes(id)
    || PAINTING_COMMAND_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** 本域新增的工具 id（工具面板与快捷键共用一份）。 */
export const PAINTING_TOOL_IDS = ["brush", "pencil", "colorReplacement", "eraser", "backgroundEraser", "magicEraser", "gradient", "bucket", "eyedropper"] as const;
export type PaintingToolId = (typeof PAINTING_TOOL_IDS)[number];

export function isPaintingToolId(value: unknown): value is PaintingToolId {
  return typeof value === "string" && (PAINTING_TOOL_IDS as readonly string[]).includes(value);
}

/** 响应曲线的点数上限（与内核 `ResponseCurve::MAX_POINTS` 一致）。 */
export const MAX_CURVE_POINTS = 16;
/** 笔刷纹理缩放的可接受范围（内核钳制到 0.01–10）。 */
export const TEXTURE_SCALE_RANGE = [0.01, 10] as const;
/** 散布量上限（内核 10 = 1000%）。 */
export const MAX_SCATTER = 10;

/**
 * 绘制可用的混合模式（内核 `BlendMode` 的图层模式子集）。
 *
 * `passThrough` 只对组有意义、`clear` 已由 `erase` 表达，两者都不在此列。
 */
export const PAINT_BLEND_MODE_IDS = [
  "normal", "dissolve", "darken", "multiply", "colorBurn", "linearBurn", "darkerColor",
  "lighten", "screen", "colorDodge", "linearDodge", "lighterColor",
  "overlay", "softLight", "hardLight", "vividLight", "linearLight", "pinLight", "hardMix",
  "difference", "exclusion", "subtract", "divide", "hue", "saturation", "color", "luminosity"
] as const;
export type PaintBlendModeId = (typeof PAINT_BLEND_MODE_IDS)[number];

/** 内核 `commands::blend_from_str` 的宽容匹配：忽略大小写、空格、`_`、`-`、括号。 */
export function normalizeBlendModeId(value: unknown): PaintBlendModeId | null {
  if (typeof value !== "string") return null;
  const want = value.toLowerCase().replace(/[\s_\-()]/g, "");
  return (PAINT_BLEND_MODE_IDS as readonly string[]).find((id) => id.toLowerCase() === want) as PaintBlendModeId | undefined ?? null;
}

/**
 * 校验响应曲线的点集（`[[input, output], …]`）。
 *
 * 与内核一致：0–1、按输入递增、2–{@link MAX_CURVE_POINTS} 点。**不**排序、不裁剪：静默修补会
 * 让界面看到一条曲线、落笔用另一条。
 */
export function normalizeCurvePoints(input: unknown): [number, number][] | null {
  if (!Array.isArray(input) || input.length < 2 || input.length > MAX_CURVE_POINTS) return null;
  const points: [number, number][] = [];
  let previous = -1;
  for (const raw of input) {
    if (!Array.isArray(raw) || raw.length !== 2) return null;
    const [x, y] = raw as unknown[];
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    if (x <= previous) return null;
    previous = x;
    points.push([x, y]);
  }
  return points;
}

/** 一次 `paint.stroke` 的混合模式是否可绘制。 */
export function isPaintableBlendMode(value: unknown): value is PaintBlendModeId {
  return normalizeBlendModeId(value) !== null;
}
