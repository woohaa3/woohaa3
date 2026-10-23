/**
 * 颜色/色板、渐变预设与工具预设的界面状态
 * （change: 2026-10-22-add-photocraft-painting-color-workflows，U35/U36）。
 *
 * 三层分工：
 *
 * - **内核**持有色板库、渐变库与工具预设库（`swatches.*`、`gradient.presets.*`、`tool.presets.*`）；
 * - **本模块**只做有界解码与视图状态，不复制库内容，也不另造第二份默认值；
 * - **面板**只消费解码结果，并把用户动作编成命令参数。
 *
 * 关键约束：
 * - 这些库是**偏好/工具状态**：改它们不推进文档修订、历史或内容指纹；
 * - 解码必须拒绝越界结构（未知模型、超长名称、非有限数值），不接受「尽量修好」；
 * - 应用色板/渐变/工具预设只改工具状态或产生**一次**可撤销的像素操作，两者不混淆。
 */

/** 色板颜色模型（与内核 `SwatchColor::model()` 一致）。 */
export type SwatchModel = "rgb" | "hsb" | "cmyk" | "lab" | "gray";
export const SWATCH_MODELS: readonly SwatchModel[] = ["rgb", "hsb", "cmyk", "lab", "gray"];

export type SwatchKind = "process" | "global" | "spot";

/** 一条色板。`values` 的单位由 `model` 决定（与内核 `swatches.list` 一致）。 */
export type SwatchEntry = {
  name: string;
  model: SwatchModel;
  values: number[];
  /** 在 RGB 工作空间里的颜色。 */
  hex: string;
  kind: SwatchKind;
};

export type SwatchGroup = { name: string; swatches: SwatchEntry[] };
export type SwatchLibrary = { groups: SwatchGroup[]; count: number };

/** 每条色板的取值范围（按模型）；用于拒绝内核不会产生的结构。 */
const SWATCH_RANGES: Record<SwatchModel, { length: number; min: number; max: number }> = {
  rgb: { length: 3, min: 0, max: 255 },
  hsb: { length: 3, min: 0, max: 360 },
  cmyk: { length: 4, min: 0, max: 100 },
  lab: { length: 3, min: -128, max: 128 },
  gray: { length: 1, min: 0, max: 100 }
};

const HEX = /^#[0-9a-f]{6}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 255 && !value.includes("\0");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 解码 `swatches.list` 的有界结果；非法结构返回 `null`。 */
export function decodeSwatchLibrary(input: unknown): SwatchLibrary | null {
  if (!isRecord(input) || !Array.isArray(input.groups)) return null;
  const groups: SwatchGroup[] = [];
  let count = 0;
  for (const rawGroup of input.groups) {
    if (!isRecord(rawGroup) || typeof rawGroup.name !== "string" || rawGroup.name.length > 255) return null;
    if (!Array.isArray(rawGroup.swatches)) return null;
    const swatches: SwatchEntry[] = [];
    for (const raw of rawGroup.swatches) {
      if (!isRecord(raw) || !isName(raw.name)) return null;
      const model = raw.model;
      if (typeof model !== "string" || !(SWATCH_MODELS as readonly string[]).includes(model)) return null;
      const range = SWATCH_RANGES[model as SwatchModel];
      if (!Array.isArray(raw.values) || raw.values.length !== range.length) return null;
      if (!raw.values.every((value) => isFiniteNumber(value) && value >= range.min && value <= range.max)) return null;
      if (typeof raw.hex !== "string" || !HEX.test(raw.hex)) return null;
      const kind = raw.kind;
      if (kind !== undefined && kind !== "process" && kind !== "global" && kind !== "spot") return null;
      swatches.push({
        name: raw.name,
        model: model as SwatchModel,
        values: raw.values as number[],
        hex: raw.hex,
        kind: (kind as SwatchKind | undefined) ?? "process"
      });
      count += 1;
      if (count > 4096) return null;
    }
    groups.push({ name: rawGroup.name, swatches });
  }
  return { groups, count };
}

/** 色板库按组折叠，供面板渲染（不改变内核顺序）。 */
export function swatchGroups(library: SwatchLibrary | null): SwatchGroup[] {
  return library ? library.groups.filter((group) => group.swatches.length > 0 || group.name.length > 0) : [];
}

// ---------------------------------------------------------------- 渐变预设（U35）

/** 一个渐变色标：位置 0–1，颜色为 `#rrggbb`／`foreground`／`background`。 */
export type GradientPresetStop = { location: number; color: string };
/** 一个渐变透明度色标：位置 0–1，不透明度 0–100。 */
export type GradientPresetOpacity = { location: number; opacity: number };

export type GradientPreset = {
  name: string;
  stops: GradientPresetStop[];
  transparency: GradientPresetOpacity[];
};

export type GradientPresetGroup = { name: string; presets: GradientPreset[] };
export type GradientLibrary = { groups: GradientPresetGroup[]; current: GradientPreset | null };

const STOP_COLOR = /^(#[0-9a-f]{6}|foreground|background)$/;

function decodeStops(value: unknown): GradientPresetStop[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 64) return null;
  const stops: GradientPresetStop[] = [];
  let previous = -1;
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length !== 2) return null;
    const [location, color] = raw;
    if (!isFiniteNumber(location) || location < 0 || location > 1 || location < previous) return null;
    if (typeof color !== "string" || !STOP_COLOR.test(color)) return null;
    previous = location;
    stops.push({ location, color });
  }
  return stops;
}

function decodeOpacityStops(value: unknown): GradientPresetOpacity[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64) return null;
  const stops: GradientPresetOpacity[] = [];
  let previous = -1;
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length !== 2) return null;
    const [location, opacity] = raw;
    if (!isFiniteNumber(location) || location < 0 || location > 1 || location < previous) return null;
    if (!isFiniteNumber(opacity) || opacity < 0 || opacity > 100) return null;
    previous = location;
    stops.push({ location, opacity });
  }
  return stops;
}

function decodeGradientPreset(value: unknown): GradientPreset | null {
  if (!isRecord(value) || !isName(value.name)) return null;
  const stops = decodeStops(value.stops);
  const transparency = decodeOpacityStops(value.transparency);
  if (!stops || !transparency) return null;
  return { name: value.name, stops, transparency };
}

/** 解码 `gradient.presets.list` 的有界结果；非法结构返回 `null`。 */
export function decodeGradientLibrary(input: unknown): GradientLibrary | null {
  if (!isRecord(input) || !Array.isArray(input.groups)) return null;
  const groups: GradientPresetGroup[] = [];
  let total = 0;
  for (const rawGroup of input.groups) {
    if (!isRecord(rawGroup) || typeof rawGroup.name !== "string" || rawGroup.name.length > 255) return null;
    if (!Array.isArray(rawGroup.presets)) return null;
    const presets: GradientPreset[] = [];
    for (const raw of rawGroup.presets) {
      const preset = decodeGradientPreset(raw);
      if (!preset) return null;
      presets.push(preset);
      total += 1;
      if (total > 512) return null;
    }
    groups.push({ name: rawGroup.name, presets });
  }
  const current = input.current === undefined || input.current === null ? null : decodeGradientPreset(input.current);
  if (input.current !== undefined && input.current !== null && !current) return null;
  return { groups, current };
}

/**
 * 渐变预设 → `paint.gradient` 的 `stops`/`transparency`。
 *
 * 预设只提供色标；端点、样式与不透明度仍由工具参数决定（否则「选预设」会悄悄改方向）。
 */
export function gradientPresetStops(preset: GradientPreset): { stops: [number, string][]; transparency: [number, number][] } {
  return {
    stops: preset.stops.map((stop) => [stop.location, stop.color] as [number, string]),
    transparency: preset.transparency.map((stop) => [stop.location, stop.opacity] as [number, number])
  };
}

// ---------------------------------------------------------------- 工具预设（U36）

export type ToolPreset = {
  name: string;
  tool: string;
  /** 不透明参数（含 `brush` 与 `foreground`）；界面只读关键字段。 */
  options: Record<string, unknown>;
  /** 保存时勾选「包含颜色」才有的前景色 `#rrggbb`。 */
  foreground: string | null;
};

export type ToolPresetList = { presets: ToolPreset[] };

function foregroundOf(options: Record<string, unknown>): string | null {
  const raw = options.foreground;
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const channels = raw.slice(0, 3);
  if (!channels.every((value) => isFiniteNumber(value) && value >= 0 && value <= 1)) return null;
  const hex = (value: number) => Math.round(value * 255).toString(16).padStart(2, "0");
  return `#${hex(channels[0] as number)}${hex(channels[1] as number)}${hex(channels[2] as number)}`;
}

/** 解码 `toolPresetsJson()` 的有界结果；非法结构返回 `null`。 */
export function decodeToolPresets(input: unknown): ToolPresetList | null {
  if (!isRecord(input) || !Array.isArray(input.presets)) return null;
  const presets: ToolPreset[] = [];
  const seen = new Set<string>();
  for (const raw of input.presets) {
    if (!isRecord(raw) || !isName(raw.name) || seen.has(raw.name.toLowerCase())) return null;
    if (typeof raw.tool !== "string" || !raw.tool.trim() || raw.tool.length > 64) return null;
    // 内核始终返回对象；非对象说明结构不对，整份拒绝而不是替换成空对象。
    if (raw.options !== undefined && (!isRecord(raw.options))) return null;
    const options = isRecord(raw.options) ? raw.options : {};
    seen.add(raw.name.toLowerCase());
    presets.push({ name: raw.name, tool: raw.tool, options, foreground: foregroundOf(options) });
    if (presets.length > 512) return null;
  }
  return { presets };
}

/** 工具预设按工具过滤（忽略大小写与 `Tool` 后缀，与内核一致）。 */
export function filterToolPresets(list: ToolPresetList | null, tool: string): ToolPreset[] {
  if (!list) return [];
  const normalize = (value: string) => value.toLowerCase().replace(/[\s_-]/g, "").replace(/tool$/, "");
  const wanted = normalize(tool);
  return wanted ? list.presets.filter((preset) => normalize(preset.tool) === wanted) : list.presets;
}

/** 把当前工具参数编成 `toolPresetsJson` 的新建参数。 */
export function buildToolPreset(params: {
  name: string;
  tool: string;
  options?: Record<string, unknown>;
  includeColor?: boolean;
}): Record<string, unknown> | null {
  const name = params.name.trim();
  if (!name || name.length > 255 || name.includes("\0")) return null;
  const tool = params.tool.trim();
  if (!tool || tool.length > 64 || tool.includes("\0")) return null;
  return {
    name,
    tool,
    ...(params.options && Object.keys(params.options).length ? { options: params.options } : {}),
    includeColor: params.includeColor === true
  };
}

/** 编辑工具预设的参数（`rename` 需要新名称，`delete` 只用原名称）。 */
export function buildToolPresetEdit(action: "rename" | "delete", preset: string, newName?: string): Record<string, unknown> | null {
  if (!isName(preset)) return null;
  if (action === "delete") return { action, preset };
  const name = (newName ?? "").trim();
  if (!name || name.length > 255 || name.includes("\0")) return null;
  return { action, preset, name };
}
