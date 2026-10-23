import { type ImageProjectLevelsChannel, isFiniteNumberValue, round } from "../shared/content.js";

/**
 * 内容身份支持的调整层类型（与 Rust `clean_content`/`canonicalize_adjustment` 的匹配臂一致）。
 *
 * 只列**参数会随工程保存并重开**的类型：直接作用于像素的自动校正与匹配/替换颜色没有可重编
 * 的图层，因此不进入内容身份。范围外的 LUT 与无法求值的 PSD 块也不在这里——它们的投影是
 * `color-lookup` / `unsupported` 标记，`canonicalizeAdjustment` 返回 null（无法判定）。
 */
export const IMAGE_PROJECT_ADJUSTMENT_KINDS = [
  "brightness-contrast",
  "hue-saturation",
  "curves",
  "levels",
  "vibrance",
  "black-white",
  "exposure",
  "color-balance",
  "photo-filter",
  "channel-mixer",
  "invert",
  "posterize",
  "threshold",
  "gradient-map",
  "selective-color"
] as const;

export type ImageProjectAdjustmentKind = (typeof IMAGE_PROJECT_ADJUSTMENT_KINDS)[number];

/** 色相/饱和度的一个色域（六个色域按 reds…magentas 固定顺序）。 */
export type ImageProjectHueRange = {
  hue: number;
  saturation: number;
  lightness: number;
  /** 四个范围滑杆（0–360 度，可跨 0 环绕）。 */
  range?: [number, number, number, number];
};

/** 调整层参数。 */
export type ImageProjectAdjustmentContent = {
  kind: ImageProjectAdjustmentKind;
  /** 参数：与内核 `to_params` 同一套键与单位。 */
  parameters: ImageProjectAdjustmentParameters;
};

export type ImageProjectAdjustmentParameters =
  | { kind: "brightness-contrast"; brightness: number; contrast: number }
  | ({
      kind: "hue-saturation";
      hue: number;
      saturation: number;
      lightness: number;
      colorize?: boolean;
    } & Partial<Record<"reds" | "yellows" | "greens" | "cyans" | "blues" | "magentas", ImageProjectHueRange>>)
  | { kind: "curves"; rgb: Array<{ x: number; y: number }>; pencil?: boolean }
  | {
      kind: "levels";
      master: ImageProjectLevelsChannel;
      red: ImageProjectLevelsChannel;
      green: ImageProjectLevelsChannel;
      blue: ImageProjectLevelsChannel;
    }
  | { kind: "vibrance"; vibrance: number; saturation: number }
  | {
      kind: "black-white";
      reds: number;
      yellows: number;
      greens: number;
      cyans: number;
      blues: number;
      magentas: number;
      tint?: string | null;
    }
  | { kind: "exposure"; exposure: number; offset: number; gamma: number }
  | {
      kind: "color-balance";
      shadows: number[];
      midtones: number[];
      highlights: number[];
      preserveLuminosity?: boolean;
    }
  | { kind: "photo-filter"; color: string | number[]; density: number; preserveLuminosity?: boolean }
  | {
      kind: "channel-mixer";
      red: number[];
      green: number[];
      blue: number[];
      monochrome?: boolean;
    }
  | { kind: "invert" }
  | { kind: "posterize"; levels: number }
  | { kind: "threshold"; level: number }
  | { kind: "gradient-map"; stops: Array<[number, string] | number[]>; reverse?: boolean; dither?: boolean }
  | ({
      kind: "selective-color";
      method: "relative" | "absolute";
    } & Record<"reds" | "yellows" | "greens" | "cyans" | "blues" | "magentas" | "whites" | "neutrals" | "blacks", number[]>);

/** 六色域与可选颜色九范围的固定顺序（规范串的循环顺序，不能依赖对象键序）。 */
const HUE_RANGE_KEYS = ["reds", "yellows", "greens", "cyans", "blues", "magentas"] as const;
const SELECTIVE_KEYS = ["reds", "yellows", "greens", "cyans", "blues", "magentas", "whites", "neutrals", "blacks"] as const;
const HEX_COLOR = /^#[0-9a-f]{6}$/;

/**
 * 颜色参数归一成小写 `#rrggbb`：已是该形式的字符串原样接受，`[r, g, b]`（0–1）四舍五入。
 *
 * 与 Rust `identity::hex_color_parameter` 逐字节一致。
 */
function colorOf(value: unknown): string | null {
  if (typeof value === "string") return HEX_COLOR.test(value) ? value : null;
  if (!Array.isArray(value) || value.length !== 3) return null;
  const channels: string[] = [];
  for (const channel of value) {
    if (!isFiniteNumberValue(channel) || channel < 0 || channel > 1) return null;
    channels.push((Math.round(channel * 255) & 0xff).toString(16).padStart(2, "0"));
  }
  return `#${channels.join("")}`;
}

/** 百分比数值（通道混合器等按 0.1% 网格保存）：只要求有限。 */
function percentOf(value: unknown): number | null {
  return isFiniteNumberValue(value) && Math.abs(value) <= 1e6 ? value : null;
}

/** 可选布尔：缺省 / null 视为 false（与 Rust 的匹配臂一致）。 */
function flagOf(value: unknown): boolean | null {
  if (value === undefined || value === null) return false;
  return typeof value === "boolean" ? value : null;
}

/**
 * 调整层的规范串；新字段一律**追加**在既有前缀之后，并且只在非默认值时出现。
 *
 * 这条规则保证旧工程（没有输出端点、色域、Tint、铅笔映射）继续得到逐字节相同的规范串与
 * `documentContentHash`，与 Rust `identity::canonicalize_adjustment` 完全一致。
 */
export function canonicalizeAdjustment(adjustment: ImageProjectAdjustmentContent | null): string | null {
  if (!adjustment || typeof adjustment !== "object") return null;
  const parameters = adjustment.parameters;
  if (!parameters || typeof parameters !== "object") return null;
  if (adjustment.kind !== parameters.kind) return null;
  if (parameters.kind === "brightness-contrast") {
    if (!isFiniteNumberValue(parameters.brightness) || !isFiniteNumberValue(parameters.contrast)) return null;
    return `adjust:brightness-contrast:${round(parameters.brightness)}:${round(parameters.contrast)}`;
  }
  if (parameters.kind === "hue-saturation") {
    if (!isFiniteNumberValue(parameters.hue) || !isFiniteNumberValue(parameters.saturation)) return null;
    if (!isFiniteNumberValue(parameters.lightness)) return null;
    // U42：Colorize 与六个色域追加在后，缺省时完全不出现（旧指纹不变）。
    let tail = "";
    const colorize = flagOf(parameters.colorize);
    if (colorize === null) return null;
    if (colorize) tail += ":colorize";
    for (const [index, key] of HUE_RANGE_KEYS.entries()) {
      const range = parameters[key];
      if (range === undefined || range === null) continue;
      if (typeof range !== "object") return null;
      const { hue, saturation, lightness, range: bounds } = range as ImageProjectHueRange;
      if (!isFiniteNumberValue(hue) || !isFiniteNumberValue(saturation) || !isFiniteNumberValue(lightness)) return null;
      let renderedBounds: number[] | null = null;
      if (bounds !== undefined && bounds !== null) {
        if (!Array.isArray(bounds) || bounds.length !== 4) return null;
        if (!bounds.every((value) => isFiniteNumberValue(value))) return null;
        renderedBounds = bounds;
      }
      // 中性色域（无位移且范围就是该色域的默认四滑杆）等同于「没有这一项」：内核投影总是带出
      // 六个色域，若把中性项也写进规范串，旧工程的指纹会在重开时漂移。
      const center = 60 * index;
      const defaults = [center - 45, center - 15, center + 15, center + 45];
      const neutral = hue === 0 && saturation === 0 && lightness === 0
        && (renderedBounds === null || renderedBounds.every((value, at) => Math.abs(value - defaults[at]!) < 1e-6));
      if (neutral) continue;
      tail += `:${key}/${round(hue)}/${round(saturation)}/${round(lightness)}`;
      if (renderedBounds !== null) tail += `/${renderedBounds.map((value) => round(value)).join(",")}`;
    }
    return `adjust:hue-saturation:${round(parameters.hue)}:${round(parameters.saturation)}:${round(parameters.lightness)}${tail}`;
  }
  if (parameters.kind === "levels") {
    // U41：输出黑/白场只在非默认值时追加，旧工程的规范串保持逐字节不变。
    const channel = (value: unknown): string | null => {
      if (!value || typeof value !== "object") return null;
      const entry = value as Record<string, unknown>;
      const black = entry.inBlack, gamma = entry.gamma, white = entry.inWhite;
      if (!isFiniteNumberValue(black) || black < 0 || black > 253) return null;
      if (!isFiniteNumberValue(gamma) || gamma < 0.01 || gamma > 9.99) return null;
      if (!isFiniteNumberValue(white) || white < 2 || white > 255) return null;
      let rendered = `${round(black)},${round(gamma)},${round(white)}`;
      const outBlack = isFiniteNumberValue(entry.outBlack) ? entry.outBlack : 0;
      const outWhite = isFiniteNumberValue(entry.outWhite) ? entry.outWhite : 255;
      if (outBlack !== 0 || outWhite !== 255) rendered += `/${round(outBlack)},${round(outWhite)}`;
      return rendered;
    };
    const channels = ["master", "red", "green", "blue"].map((key) => channel((parameters as unknown as Record<string, unknown>)[key]));
    if (channels.some((value) => value === null)) return null;
    return `adjust:levels:${channels.join(";")}`;
  }
  if (parameters.kind === "vibrance") {
    if (!isFiniteNumberValue(parameters.vibrance) || !isFiniteNumberValue(parameters.saturation)) return null;
    if (parameters.vibrance < -100 || parameters.vibrance > 100 || parameters.saturation < -100 || parameters.saturation > 100) return null;
    return `adjust:vibrance:${round(parameters.vibrance)}:${round(parameters.saturation)}`;
  }
  if (parameters.kind === "black-white") {
    const keys = ["reds", "yellows", "greens", "cyans", "blues", "magentas"] as const;
    const weights: string[] = [];
    for (const key of keys) {
      const value = parameters[key];
      if (!isFiniteNumberValue(value) || value < -200 || value > 300) return null;
      weights.push(String(round(value)));
    }
    const tint = parameters.tint == null ? "-" : parameters.tint;
    if (tint !== "-" && (typeof tint !== "string" || !HEX_COLOR.test(tint))) return null;
    return `adjust:black-white:${weights.join(",")}:${tint}`;
  }
  if (parameters.kind === "curves") {
    if (!Array.isArray(parameters.rgb) || parameters.rgb.length === 0) return null;
    const points: string[] = [];
    for (const point of parameters.rgb) {
      if (!point || typeof point !== "object") return null;
      if (!isFiniteNumberValue(point.x) || !isFiniteNumberValue(point.y)) return null;
      if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
      points.push(`${round(point.x)},${round(point.y)}`);
    }
    // U41：铅笔模式是持久参数；默认的点模式不追加后缀。
    const pencil = flagOf(parameters.pencil);
    if (pencil === null) return null;
    return `adjust:curves:${points.join(";")}${pencil ? ":pencil" : ""}`;
  }
  if (parameters.kind === "exposure") {
    if (!isFiniteNumberValue(parameters.exposure) || !isFiniteNumberValue(parameters.offset)) return null;
    if (!isFiniteNumberValue(parameters.gamma)) return null;
    return `adjust:exposure:${round(parameters.exposure)}:${round(parameters.offset)}:${round(parameters.gamma)}`;
  }
  if (parameters.kind === "color-balance") {
    const tone = (value: unknown): string | null => {
      if (!Array.isArray(value) || value.length !== 3) return null;
      if (!value.every((entry) => isFiniteNumberValue(entry))) return null;
      return value.map((entry) => String(round(entry as number))).join(",");
    };
    const preserve = flagOf(parameters.preserveLuminosity);
    if (preserve === null) return null;
    const shadows = tone(parameters.shadows), midtones = tone(parameters.midtones), highlights = tone(parameters.highlights);
    if (shadows === null || midtones === null || highlights === null) return null;
    return `adjust:color-balance:${shadows}:${midtones}:${highlights}:${preserve ? 1 : 0}`;
  }
  if (parameters.kind === "photo-filter") {
    const color = colorOf(parameters.color);
    const density = percentOf(parameters.density);
    if (color === null || density === null) return null;
    const preserve = flagOf(parameters.preserveLuminosity);
    if (preserve === null) return null;
    return `adjust:photo-filter:${color}:${round(density)}:${preserve ? 1 : 0}`;
  }
  if (parameters.kind === "channel-mixer") {
    const row = (value: unknown): string | null => {
      if (!Array.isArray(value) || value.length !== 4) return null;
      const rendered: string[] = [];
      for (const entry of value) {
        const percent = percentOf(entry);
        if (percent === null) return null;
        rendered.push(String(round(percent)));
      }
      return rendered.join(",");
    };
    const monochrome = flagOf(parameters.monochrome);
    if (monochrome === null) return null;
    const red = row(parameters.red), green = row(parameters.green), blue = row(parameters.blue);
    if (red === null || green === null || blue === null) return null;
    return `adjust:channel-mixer:${red}:${green}:${blue}:${monochrome ? 1 : 0}`;
  }
  if (parameters.kind === "invert") return "adjust:invert";
  if (parameters.kind === "posterize") {
    if (!isFiniteNumberValue(parameters.levels)) return null;
    return `adjust:posterize:${round(parameters.levels)}`;
  }
  if (parameters.kind === "threshold") {
    if (!isFiniteNumberValue(parameters.level)) return null;
    return `adjust:threshold:${round(parameters.level)}`;
  }
  if (parameters.kind === "gradient-map") {
    if (!Array.isArray(parameters.stops) || parameters.stops.length < 2 || parameters.stops.length > 64) return null;
    const stops: string[] = [];
    let previous = -Infinity;
    for (const stop of parameters.stops) {
      if (!Array.isArray(stop) || stop.length !== 2) return null;
      const position = stop[0], color = colorOf(stop[1]);
      if (!isFiniteNumberValue(position) || position < 0 || position > 1) return null;
      if (position <= previous || color === null) return null;
      previous = position;
      stops.push(`${round(position)},${color}`);
    }
    const reverse = flagOf(parameters.reverse), dither = flagOf(parameters.dither);
    if (reverse === null || dither === null) return null;
    return `adjust:gradient-map:${stops.join(";")}:${reverse ? 1 : 0}:${dither ? 1 : 0}`;
  }
  if (parameters.kind === "selective-color") {
    const method = parameters.method;
    if (method !== "relative" && method !== "absolute") return null;
    const ranges: string[] = [];
    for (const key of SELECTIVE_KEYS) {
      const row = (parameters as unknown as Record<string, unknown>)[key];
      if (!Array.isArray(row) || row.length !== 4) return null;
      const rendered: string[] = [];
      for (const entry of row) {
        if (!isFiniteNumberValue(entry)) return null;
        rendered.push(String(round(entry)));
      }
      ranges.push(rendered.join(","));
    }
    return `adjust:selective-color:${method}:${ranges.join(";")}`;
  }
  return null;
}

export function isImageProjectAdjustmentKind(value: unknown): value is ImageProjectAdjustmentKind {
  return typeof value === "string" && (IMAGE_PROJECT_ADJUSTMENT_KINDS as readonly string[]).includes(value);
}
