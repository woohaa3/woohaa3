/**
 * 直接调整与调整图层共用的参数构建（change: 2026-10-22-add-photocraft-adjustment-workflows）。
 *
 * 这里只负责**结构**（哪些键、默认值、控件范围），值域复核仍由内核解析器完成；界面用同一个
 * 函数生成直接调整（`image.adjustments.*`）、自动/匹配命令与调整图层（`layer.setAdjustment`）
 * 参数，避免两条路径给出不同形状。
 *
 * 是否**可开始**不在这里判断：只有内核命令门（`directAdjustmentTargetsJson` 的 `kinds` /
 * `commands`）说了算，界面按它的结果渲染入口。
 */
import { clamp } from "../shared/tool-parameters.js";
import { isRecord } from "../shared/panels.js";

/** 已实现的逐类调整（命令后缀 `image.adjustments.<kind>`），顺序即菜单顺序。 */
export const ADJUSTMENT_KINDS = [
  "brightnessContrast",
  "exposure",
  "hueSaturation",
  "curves",
  "levels",
  "colorBalance",
  "blackWhite",
  "photoFilter",
  "channelMixer",
  "invert",
  "posterize",
  "threshold",
  "gradientMap",
  "selectiveColor",
  "vibrance"
] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

export const ADJUSTMENT_LABELS: Record<AdjustmentKind, string> = {
  brightnessContrast: "亮度/对比度",
  exposure: "曝光度",
  hueSaturation: "色相/饱和度",
  curves: "曲线",
  levels: "色阶",
  colorBalance: "色彩平衡",
  blackWhite: "黑白",
  photoFilter: "照片滤镜",
  channelMixer: "通道混合器",
  invert: "反相",
  posterize: "色调分离",
  threshold: "阈值",
  gradientMap: "渐变映射",
  selectiveColor: "可选颜色",
  vibrance: "自然饱和度"
};

/** 自动校正与匹配/替换颜色命令（整条命令 id），与内核 `ADJUSTMENT_COMMANDS` 一致。 */
export const ADJUSTMENT_COMMANDS = [
  "image.autoTone",
  "image.autoContrast",
  "image.autoColor",
  "image.adjustments.desaturate",
  "image.adjustments.equalize",
  "image.adjustments.shadowsHighlights",
  "image.adjustments.replaceColor",
  "image.adjustments.matchColor"
] as const;
export type AdjustmentCommand = (typeof ADJUSTMENT_COMMANDS)[number];

export const COMMAND_LABELS: Record<AdjustmentCommand, string> = {
  "image.autoTone": "自动色调",
  "image.autoContrast": "自动对比度",
  "image.autoColor": "自动颜色",
  "image.adjustments.desaturate": "去色",
  "image.adjustments.equalize": "均衡",
  "image.adjustments.shadowsHighlights": "阴影/高光",
  "image.adjustments.replaceColor": "替换颜色",
  "image.adjustments.matchColor": "匹配颜色"
};

/** 色相/饱和度的六个色域（与内核存储顺序一致）。 */
export const HUE_RANGES = ["reds", "yellows", "greens", "cyans", "blues", "magentas"] as const;
export type HueRangeId = (typeof HUE_RANGES)[number];
export const HUE_RANGE_LABELS: Record<HueRangeId, string> = {
  reds: "红色",
  yellows: "黄色",
  greens: "绿色",
  cyans: "青色",
  blues: "蓝色",
  magentas: "洋红"
};

/** 可选颜色的九个范围（比色相多出黑白灰）。 */
export const SELECTIVE_RANGES = ["reds", "yellows", "greens", "cyans", "blues", "magentas", "whites", "neutrals", "blacks"] as const;
export type SelectiveRangeId = (typeof SELECTIVE_RANGES)[number];
export const SELECTIVE_RANGE_LABELS: Record<SelectiveRangeId, string> = {
  reds: "红色",
  yellows: "黄色",
  greens: "绿色",
  cyans: "青色",
  blues: "蓝色",
  magentas: "洋红",
  whites: "白色",
  neutrals: "中性色",
  blacks: "黑色"
};

/** 曲线的四个目标通道（总 RGB 加 R/G/B 单通道）。 */
export const CURVE_CHANNELS = ["rgb", "red", "green", "blue"] as const;
export type CurveChannel = (typeof CURVE_CHANNELS)[number];
export const CURVE_CHANNEL_LABELS: Record<CurveChannel, string> = {
  rgb: "RGB",
  red: "红",
  green: "绿",
  blue: "蓝"
};

/** 没有参数、确认即作用的调整类型：界面必须给出一个「开始调整」动作才可达。 */
export const PARAMETERLESS_KINDS: readonly AdjustmentKind[] = ["invert"];

/** 没有参数、确认即作用的命令（自动校正、去色、均衡）。 */
export const PARAMETERLESS_COMMANDS: readonly AdjustmentCommand[] = [
  "image.autoTone",
  "image.autoContrast",
  "image.autoColor",
  "image.adjustments.desaturate",
  "image.adjustments.equalize"
];

/** 目标是否没有可控参数（界面只渲染一个开始/应用动作）。 */
export function isParameterlessTarget(target: string): boolean {
  return (PARAMETERLESS_KINDS as readonly string[]).includes(target)
    || (PARAMETERLESS_COMMANDS as readonly string[]).includes(target);
}

/** 照片滤镜预设（与内核 `PHOTO_FILTERS` 的 id 一致，颜色仅供界面预览）。 */
export const PHOTO_FILTER_PRESETS = [
  { id: "warming85", label: "加温滤镜 (85)", color: "#ec8a00" },
  { id: "warmingLBA", label: "加温滤镜 (LBA)", color: "#fa9600" },
  { id: "warming81", label: "加温滤镜 (81)", color: "#ebb113" },
  { id: "cooling80", label: "冷却滤镜 (80)", color: "#006dff" },
  { id: "coolingLBB", label: "冷却滤镜 (LBB)", color: "#005dff" },
  { id: "cooling82", label: "冷却滤镜 (82)", color: "#00b5ff" },
  { id: "red", label: "红色", color: "#ea1a1a" },
  { id: "orange", label: "橙色", color: "#f38417" },
  { id: "yellow", label: "黄色", color: "#f9e31c" },
  { id: "green", label: "绿色", color: "#19c919" },
  { id: "cyan", label: "青色", color: "#1dcbea" },
  { id: "blue", label: "蓝色", color: "#1d35ea" },
  { id: "violet", label: "紫色", color: "#9b1dea" },
  { id: "magenta", label: "洋红", color: "#e318e3" },
  { id: "sepia", label: "棕褐色", color: "#ac7a33" },
  { id: "deepRed", label: "深红", color: "#ff0000" },
  { id: "deepBlue", label: "深蓝", color: "#0022cd" },
  { id: "deepEmerald", label: "深翠绿", color: "#008c00" },
  { id: "deepYellow", label: "深黄", color: "#ffd500" },
  { id: "underwater", label: "水下", color: "#00c2b1" }
] as const;

export type CurvePoint = [number, number];
/** 铅笔曲线的 256 个输出级（0–255）。 */
export type CurveMap = number[];
/** 单个色阶通道（输入/输出端点与伽马）。 */
export type LevelsChannel = { inBlack: number; gamma: number; inWhite: number; outBlack: number; outWhite: number };

export function identityCurve(): CurvePoint[] {
  return [[0, 0], [255, 255]];
}

export function identityLevels(): LevelsChannel {
  return { inBlack: 0, gamma: 1, inWhite: 255, outBlack: 0, outWhite: 255 };
}

/** 每类调整的中性参数：新建调整层或首次打开直接调整时使用。 */
export function defaultAdjustmentParams(kind: AdjustmentKind): Record<string, unknown> {
  switch (kind) {
    case "brightnessContrast":
      return { brightness: 0, contrast: 0 };
    case "exposure":
      return { exposure: 0, offset: 0, gamma: 1 };
    case "hueSaturation":
      return { hue: 0, saturation: 0, lightness: 0 };
    case "curves":
      return { points: identityCurve() };
    case "levels":
      return { ...identityLevels() };
    case "colorBalance":
      return { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true };
    case "blackWhite":
      return { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 };
    case "photoFilter":
      return { filter: "warming85", density: 25, preserveLuminosity: true };
    case "channelMixer":
      return { red: [100, 0, 0, 0], green: [0, 100, 0, 0], blue: [0, 0, 100, 0] };
    case "invert":
      return {};
    case "posterize":
      return { levels: 4 };
    case "threshold":
      return { level: 128 };
    case "gradientMap":
      return { stops: [[0, "#000000"], [1, "#ffffff"]] };
    case "selectiveColor":
      return { method: "relative", reds: [0, 0, 0, 0] };
    case "vibrance":
      return { vibrance: 0, saturation: 0 };
  }
}

export function buildBrightnessContrast(brightness: number, contrast: number, legacy = false): Record<string, unknown> {
  return {
    brightness: clamp(brightness, -150, 150),
    contrast: clamp(contrast, -50, 100),
    ...(legacy ? { legacy: true } : {})
  };
}

export function buildExposure(exposure: number, offset: number, gamma: number): Record<string, unknown> {
  return {
    exposure: clamp(exposure, -20, 20),
    offset: clamp(offset, -0.5, 0.5),
    gamma: clamp(gamma, 0.01, 9.99)
  };
}

export function buildHueSaturation(
  hue: number,
  saturation: number,
  lightness: number,
  extra: { colorize?: boolean; ranges?: Partial<Record<HueRangeId, Record<string, unknown>>> } = {}
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    hue: clamp(hue, -180, 180),
    saturation: clamp(saturation, -100, 100),
    lightness: clamp(lightness, -100, 100)
  };
  if (extra.colorize !== undefined) params.colorize = extra.colorize;
  for (const range of HUE_RANGES) {
    const value = extra.ranges?.[range];
    if (value) params[range] = { ...value };
  }
  return params;
}

/** 单个色域的补丁；四个范围滑杆必须按顺序给出（内核再规范化）。 */
export function buildHueRange(
  hue: number,
  saturation: number,
  lightness: number,
  bounds?: readonly [number, number, number, number]
): Record<string, unknown> {
  const range: Record<string, unknown> = {
    hue: clamp(hue, -180, 180),
    saturation: clamp(saturation, -100, 100),
    lightness: clamp(lightness, -100, 100)
  };
  if (bounds) range.range = bounds.map((value) => clamp(value, -360, 360));
  return range;
}

/** 曲线点：复制并四舍五入到整级，去掉重复输入。 */
export function buildCurvePoints(points: readonly CurvePoint[]): CurvePoint[] {
  const seen = new Set<number>();
  const out: CurvePoint[] = [];
  for (const [x, y] of [...points].sort((a, b) => a[0] - b[0])) {
    const input = Math.round(clamp(x, 0, 255));
    if (seen.has(input)) continue;
    seen.add(input);
    out.push([input, Math.round(clamp(y, 0, 255))]);
  }
  return out;
}

/**
 * 曲线参数：只写实际编辑过的通道。
 *
 * `points` 是总 RGB，`red`/`green`/`blue` 是单通道；切换通道时**其它通道原样保留**（内核按
 * 增量合并），因此这里不去补默认曲线，避免把未编辑的通道覆盖成恒等。
 */
export function buildCurves(
  channel: CurveChannel,
  points: readonly CurvePoint[],
  extra: { pencil?: boolean; smooth?: number } = {}
): Record<string, unknown> {
  const params: Record<string, unknown> = channel === "rgb" ? { points: buildCurvePoints(points) } : { [channel]: buildCurvePoints(points) };
  if (extra.pencil !== undefined) params.pencil = extra.pencil;
  if (extra.smooth !== undefined) params.smooth = clamp(extra.smooth, 0, 10);
  return params;
}

/**
 * 铅笔曲线的通道参数：整条 256 级映射（`pencil: true` 时内核按映射求值）。
 *
 * 点曲线与铅笔曲线共用同一个 `points`/分通道键，模式由 `pencil` 决定；这里只写当前通道，
 * 其它通道保持原样（内核按增量合并），因此切通道不会覆盖别的曲线。
 */
export function buildCurveMap(
  channel: CurveChannel,
  map: readonly number[],
  extra: { pencil?: boolean; smooth?: number } = {}
): Record<string, unknown> {
  const outputs = Array.from({ length: 256 }, (_, index) => clamp(map[index] ?? index, 0, 255));
  const params: Record<string, unknown> = channel === "rgb" ? { points: outputs } : { [channel]: outputs };
  // 铅笔映射只在铅笔模式下有意义：构造器默认打开它，避免把 256 级数组当点曲线解析。
  params.pencil = extra.pencil ?? true;
  if (extra.smooth !== undefined) params.smooth = clamp(extra.smooth, 0, 10);
  return params;
}

export function buildLevels(channel: LevelsChannel): Record<string, unknown> {
  return {
    inBlack: clamp(channel.inBlack, 0, 253),
    gamma: clamp(channel.gamma, 0.01, 9.99),
    inWhite: clamp(channel.inWhite, 2, 255),
    outBlack: clamp(channel.outBlack, 0, 255),
    outWhite: clamp(channel.outWhite, 0, 255)
  };
}

/** 色阶分通道补丁（`red`/`green`/`blue` 各自一组端点）。 */
export function buildLevelsChannel(channel: "red" | "green" | "blue", values: LevelsChannel): Record<string, unknown> {
  return { [channel]: buildLevels(values) };
}

export function buildColorBalance(
  shadows: readonly [number, number, number],
  midtones: readonly [number, number, number],
  highlights: readonly [number, number, number],
  preserveLuminosity = true
): Record<string, unknown> {
  const tone = (values: readonly [number, number, number]) => values.map((value) => clamp(value, -100, 100));
  return {
    shadows: tone(shadows),
    midtones: tone(midtones),
    highlights: tone(highlights),
    preserveLuminosity
  };
}

/** 通道混合器的一行：`[红, 绿, 蓝, 常数]` 百分比。 */
export function buildMixerRow(values: readonly [number, number, number, number]): number[] {
  return values.map((value) => clamp(value, -200, 200));
}

export function buildChannelMixer(
  rows: { red?: readonly [number, number, number, number]; green?: readonly [number, number, number, number]; blue?: readonly [number, number, number, number]; gray?: readonly [number, number, number, number] },
  monochrome = false
): Record<string, unknown> {
  const params: Record<string, unknown> = { monochrome };
  for (const key of ["red", "green", "blue", "gray"] as const) {
    const row = rows[key];
    if (row) params[key] = buildMixerRow(row);
  }
  return params;
}

export function buildVibrance(vibrance: number, saturation: number): Record<string, unknown> {
  return { vibrance: clamp(vibrance, -100, 100), saturation: clamp(saturation, -100, 100) };
}

export function buildBlackWhite(
  weights: Partial<Record<HueRangeId, number>> = {},
  tint?: { enabled: boolean; color: string }
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const defaults: Record<HueRangeId, number> = { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 };
  for (const range of HUE_RANGES) params[range] = clamp(weights[range] ?? defaults[range], -200, 300);
  if (tint) {
    params.tint = tint.enabled;
    params.tintColor = normalizeHexColor(tint.color) ?? "#e1d3b3";
  }
  return params;
}

export function buildPhotoFilter(filter: string, density: number, color?: string, preserveLuminosity = true): Record<string, unknown> {
  const params: Record<string, unknown> = { filter, density: clamp(density, 0, 100), preserveLuminosity };
  const hex = color ? normalizeHexColor(color) : null;
  if (hex) params.color = hex;
  return params;
}

export function buildPosterize(levels: number): Record<string, unknown> {
  return { levels: Math.round(clamp(levels, 2, 255)) };
}

export function buildThreshold(level: number): Record<string, unknown> {
  return { level: Math.round(clamp(level, 1, 255)) };
}

/** 渐变映射站点：位置 0–1 严格递增，颜色 `#rrggbb`。 */
export function buildGradientStops(stops: readonly (readonly [number, string])[]): Array<[number, string]> {
  return stops
    .map(([position, color]) => [clamp(position, 0, 1), normalizeHexColor(color) ?? "#000000"] as [number, string])
    .sort((a, b) => a[0] - b[0]);
}

/**
 * 插入一个站点：落在最大间隔的中点，颜色按两侧线性插值。
 *
 * 直接追加 `[1, color]` 会与已有末站点同位置，内核要求位置严格递增 ⇒ 整份参数被判非法，
 * 所以新站点必须真的放进空隙里。
 */
export function insertGradientStop(stops: readonly (readonly [number, string])[]): Array<[number, string]> {
  const sorted = buildGradientStops(stops.length >= 2 ? stops : [[0, "#000000"], [1, "#ffffff"]]);
  if (sorted.length >= 64) return sorted;
  let gap = 0;
  let widest = -1;
  for (let index = 0; index < sorted.length - 1; index++) {
    const width = sorted[index + 1]![0] - sorted[index]![0];
    if (width > widest) { widest = width; gap = index; }
  }
  const left = sorted[gap]!;
  const right = sorted[gap + 1]!;
  // 间隔太窄时没有可用的合法位置（位置只能是有限小数），保持原样而不是生成重复位置。
  if (!(widest > 0.002)) return sorted;
  const position = Math.round(((left[0] + right[0]) / 2) * 1000) / 1000;
  return [...sorted.slice(0, gap + 1), [position, mixHex(left[1], right[1], 0.5)], ...sorted.slice(gap + 1)];
}

/** 两个 `#rrggbb` 的线性混合（用于新增站点的初始颜色）。 */
export function mixHex(from: string, to: string, ratio: number): string {
  const a = normalizeHexColor(from) ?? "#000000";
  const b = normalizeHexColor(to) ?? "#000000";
  const channel = (offset: number) => {
    const start = parseInt(a.slice(offset, offset + 2), 16);
    const end = parseInt(b.slice(offset, offset + 2), 16);
    return Math.round(clamp(start + (end - start) * clamp(ratio, 0, 1), 0, 255))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** 可选颜色：`method` 加一个范围的 `[青, 洋红, 黄, 黑]` 百分比。 */
export function buildSelectiveColor(
  method: "relative" | "absolute",
  range: SelectiveRangeId,
  values: readonly [number, number, number, number]
): Record<string, unknown> {
  return { method, [range]: values.map((value) => clamp(value, -100, 100)) };
}

/** 黑/灰/白场吸管参数：点取样或直接给颜色。 */
export function buildEyedropper(
  point: "black" | "gray" | "white",
  sample: { at: [number, number]; size?: number } | { color: [number, number, number] }
): Record<string, unknown> {
  if ("color" in sample) return { point, color: sample.color.map((value) => clamp(value, 0, 1)) };
  return { point, at: [Math.round(sample.at[0]), Math.round(sample.at[1])], ...(sample.size ? { size: clamp(sample.size, 1, 101) } : {}) };
}

/** 阴影/高光：全部键都是 0–100 的量或克制的色调补偿。 */
export function buildShadowsHighlights(values: {
  shadowAmount?: number;
  shadowTone?: number;
  shadowRadius?: number;
  highlightAmount?: number;
  highlightTone?: number;
  highlightRadius?: number;
  color?: number;
  midtone?: number;
  blackClip?: number;
  whiteClip?: number;
}): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, range] of [
    ["shadowAmount", [0, 100]],
    ["shadowTone", [0, 100]],
    ["shadowRadius", [0, 2500]],
    ["highlightAmount", [0, 100]],
    ["highlightTone", [0, 100]],
    ["highlightRadius", [0, 2500]],
    ["color", [-100, 100]],
    ["midtone", [-100, 100]],
    ["blackClip", [0, 50]],
    ["whiteClip", [0, 50]]
  ] as const) {
    const value = values[key];
    if (value !== undefined) params[key] = clamp(value, range[0], range[1]);
  }
  return params;
}

/** 替换颜色：目标色 + 匹配容差 + HSL 偏移；局部化聚类需要取色点。 */
export function buildReplaceColor(values: {
  color: string;
  fuzziness?: number;
  hue?: number;
  saturation?: number;
  lightness?: number;
  localized?: boolean;
  range?: number;
  points?: readonly (readonly [number, number])[];
}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    color: normalizeHexColor(values.color) ?? "#000000",
    fuzziness: clamp(values.fuzziness ?? 40, 0, 200),
    hue: clamp(values.hue ?? 0, -180, 180),
    saturation: clamp(values.saturation ?? 0, -100, 100),
    lightness: clamp(values.lightness ?? 0, -100, 100)
  };
  if (values.localized !== undefined) {
    params.localized = values.localized;
    params.range = clamp(values.range ?? 100, 0, 100);
    if (values.points?.length) params.points = values.points.map(([x, y]) => [x, y]);
  }
  return params;
}

/**
 * 匹配颜色：同文档统计，或指定会话里的另一份文档作为来源。
 *
 * `source` 是内核会话文档索引（界面从 `directAdjustmentTargets().documents` 拿到的同一套下标）；
 * 来源统计由内核在草稿的冻结快照上取，来源文档本身不会被修改。省略 `source` 时不生成该键，
 * 表示按本图统计（Photoshop 的 Source: None）。
 */
export function buildMatchColor(values: {
  luminance?: number;
  intensity?: number;
  fade?: number;
  neutralize?: boolean;
  useSelectionInTarget?: boolean;
  /** 来源文档索引；省略/等于当前文档时按本图统计。 */
  source?: number;
  /** 来源图层 id（可选，取该图层统计而不是整份合成）。 */
  sourceLayer?: number;
  /** 来源文档里使用来源选区。 */
  useSelectionInSource?: boolean;
}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    luminance: clamp(values.luminance ?? 100, 1, 200),
    intensity: clamp(values.intensity ?? 100, 1, 200),
    fade: clamp(values.fade ?? 0, 0, 100),
    neutralize: values.neutralize ?? false
  };
  if (values.useSelectionInTarget !== undefined) params.useSelectionInTarget = values.useSelectionInTarget;
  if (values.source !== undefined) params.source = Math.max(0, Math.round(values.source));
  if (values.sourceLayer !== undefined) params.sourceLayer = Math.max(1, Math.round(values.sourceLayer));
  if (values.useSelectionInSource !== undefined) params.useSelectionInSource = values.useSelectionInSource;
  return params;
}

/** 无参数命令（自动校正、去色、均衡）只接受空对象。 */
export function buildEmptyCommand(): Record<string, unknown> {
  return {};
}

/** `#rrggbb` 规范化；非法返回 null（不静默替换成别的颜色）。 */
export function normalizeHexColor(value: string): string | null {
  const text = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(text) ? text : null;
}

/** 曲线的 256 级铅笔映射是否完整合法。 */
export function validCurveMap(map: readonly number[]): boolean {
  return map.length === 256 && map.every((value) => Number.isFinite(value) && value >= 0 && value <= 255);
}

/** 把点曲线画成铅笔映射（直线连接，端点外保持端点值），只用于界面初始绘制。 */
export function mapFromPoints(points: readonly CurvePoint[]): CurveMap {
  const sorted = buildCurvePoints(points);
  if (sorted.length < 2) return Array.from({ length: 256 }, (_, index) => index);
  return Array.from({ length: 256 }, (_, index) => {
    if (index <= sorted[0]![0]) return sorted[0]![1];
    const last = sorted[sorted.length - 1]!;
    if (index >= last[0]) return last[1];
    const right = sorted.findIndex((point) => point[0] >= index);
    const a = sorted[right - 1]!;
    const b = sorted[right]!;
    const t = b[0] === a[0] ? 0 : (index - a[0]) / (b[0] - a[0]);
    return Math.round(a[1] + (b[1] - a[1]) * t);
  });
}

/** 一次 Smooth 参数（与内核 `smooth` 同样的半径 3 均值）。 */
export function smoothCurveMap(map: readonly number[]): CurveMap {
  return map.map((_, index) => {
    const radius = Math.min(3, index, map.length - 1 - index);
    if (radius === 0) return map[index]!;
    let total = 0;
    for (let offset = -radius; offset <= radius; offset++) total += map[index + offset]!;
    return Math.round(total / (radius * 2 + 1));
  });
}

/**
 * 把铅笔映射折回控制点（切回点曲线时用）。
 *
 * 取 9 个等距输入（0、32、64…255）的映射值：输入严格递增、点数远小于内核上限 19，参数结构
 * 一定合法。像素级还原属于上游 `map_to_points` 的拟合，这里不复制那份算法，只保证「切回去
 * 的方向和曲线走向」不丢。
 */
export function pointsFromMap(map: readonly number[]): CurvePoint[] {
  const step = Math.round(255 / 8);
  return Array.from({ length: 9 }, (_, index) => {
    const input = Math.min(255, index * step);
    return [input, clamp(map[input] ?? input, 0, 255)] as CurvePoint;
  });
}

/** 从一个调整层的完整参数里取某通道曲线，缺省返回恒等曲线。 */
export function curveOf(params: Record<string, unknown> | null, channel: CurveChannel): CurvePoint[] {
  const raw = channel === "rgb" ? params?.points : params?.[channel];
  if (!Array.isArray(raw)) return identityCurve();
  const points: CurvePoint[] = [];
  for (const point of raw) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const [x, y] = point;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push([x, y]);
  }
  return points.length >= 2 ? points : identityCurve();
}

/**
 * 从参数里取某通道的铅笔映射，缺省返回恒等映射。
 *
 * 参数是 256 级数组时直接用；是控制点时按直线换算（与内核 `curve_map_outputs` 的端点/段内
 * 线性一致）。界面优先用内核 `curveGeometry` 的样条采样，只有拿不到端口时
 * （例如宿主未接）才用这里的直线近似，避免把近似值当成真实曲线。
 */
export function curveMapOf(params: Record<string, unknown> | null, channel: CurveChannel): CurveMap {
  const raw = channel === "rgb" ? params?.points : params?.[channel];
  if (Array.isArray(raw) && validCurveMap(raw as number[])) return (raw as number[]).map((value) => clamp(value, 0, 255));
  return mapFromPoints(curveOf(params, channel));
}

/** 从一个调整层的参数里取色阶（总通道或分通道），缺省返回中性端点。 */
export function levelsOf(params: Record<string, unknown> | null, channel: "rgb" | "red" | "green" | "blue"): LevelsChannel {
  const base = identityLevels();
  const source = channel === "rgb" ? params : params?.[channel];
  if (!source || typeof source !== "object") return base;
  const record = source as Record<string, unknown>;
  const pick = (key: keyof LevelsChannel) => (typeof record[key] === "number" && Number.isFinite(record[key]) ? (record[key] as number) : base[key]);
  return { inBlack: pick("inBlack"), gamma: pick("gamma"), inWhite: pick("inWhite"), outBlack: pick("outBlack"), outWhite: pick("outWhite") };
}

/** 可作为匹配颜色来源的会话文档（索引与名称来自内核会话，不依赖共享视图模型）。 */
export type DirectAdjustmentDocument = {
  index: number;
  name: string;
  width: number;
  height: number;
  active: boolean;
};

/** 拆解内核可开始的目标清单；结构不符返回 null（不显示半截入口）。 */
export function decodeDirectTargets(input: unknown): { kinds: AdjustmentKind[]; commands: AdjustmentCommand[]; allKinds: AdjustmentKind[]; allCommands: AdjustmentCommand[]; documents: DirectAdjustmentDocument[] } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const strings = (value: unknown): string[] | null => (Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null);
  const kinds = strings(record.kinds), commands = strings(record.commands);
  const allKinds = strings(record.allKinds), allCommands = strings(record.allCommands);
  if (!kinds || !commands || !allKinds || !allCommands) return null;
  const known = (list: string[]) => list.filter((id): id is AdjustmentKind => (ADJUSTMENT_KINDS as readonly string[]).includes(id));
  const knownCommands = (list: string[]) => list.filter((id): id is AdjustmentCommand => (ADJUSTMENT_COMMANDS as readonly string[]).includes(id));
  const raw = Array.isArray(record.documents) ? record.documents : [];
  const documents: DirectAdjustmentDocument[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    if (typeof entry.index !== "number" || !Number.isInteger(entry.index) || entry.index < 0) continue;
    if (typeof entry.name !== "string") continue;
    if (typeof entry.width !== "number" || typeof entry.height !== "number") continue;
    documents.push({ index: entry.index, name: entry.name, width: entry.width, height: entry.height, active: entry.active === true });
  }
  return { kinds: known(kinds), commands: knownCommands(commands), allKinds: known(allKinds), allCommands: knownCommands(allCommands), documents };
}
