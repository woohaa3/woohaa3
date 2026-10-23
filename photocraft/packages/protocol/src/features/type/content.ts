import { isNonEmptyShortString, isFiniteNumberValue, round } from "../shared/content.js";

/** 文字层内容（可重编）。 */
export type ImageProjectTextContent = {
  /** 段落框的文字空间范围；省略或 null 表示点文字。 */
  box?: [number, number, number, number] | null;
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  align: "left" | "center" | "right";
  /** 行距（pt）；省略等同自动行距，保持旧指纹兼容。 */
  leading?: number | null;
  /** 字距（1/1000 em）。 */
  tracking?: number;
  /** 基线偏移（pt）。 */
  baselineShift?: number;
  /** 字偶距策略（`metrics` / `optical` / `off`）。 */
  kerning?: string;
  /** 手工字偶距（1/1000 em）；作用于相邻字符对，与 `kerning` 策略可叠加。 */
  kern?: number;
  /** 首行缩进（pt）。 */
  firstLineIndent?: number;
  /** 左缩进（pt）；负值表示悬挂。 */
  startIndent?: number;
  /** 右缩进（pt）。 */
  endIndent?: number;
  /** 段前距（pt）。 */
  spaceBefore?: number;
  /** 段后距（pt）。 */
  spaceAfter?: number;
  /** 自动行距倍数（相对字号）；必须为正。 */
  autoLeading?: number;
  /** 段落对齐（大写枚举名，与内核 `TextAlign` 一致）。 */
  paragraphAlign?: "Left" | "Center" | "Right" | "JustifyLeft" | "JustifyCenter" | "JustifyRight" | "JustifyAll";
  /** 文本方向。 */
  direction?: "Auto" | "Ltr" | "Rtl";
  /** 连字符。 */
  hyphenate?: boolean;
  /** 应用的段落样式表 id（0/省略 = Basic Paragraph）。 */
  styleSheet?: number;
  /**
   * 应用的**字符**样式表 id（省略 = 「None」）。
   *
   * 应用字符样式会把样式的解析值写进 run（例如下划线），但 run 自己的字号/颜色可能不变；
   * 只摘要段落样式引用会「换了字符样式却不判脏」。
   */
  charStyleSheet?: number;
  /** CSS 字重（100–900）。 */
  weight?: number;
  /** 斜体（由字面或 `italic` 开关写入）。 */
  italic?: boolean;
  /** 水平缩放（百分比，1 = 100%）。 */
  horizontalScale?: number;
  /** 垂直缩放（百分比）。 */
  verticalScale?: number;
  underline?: boolean;
  strikethrough?: boolean;
  fauxBold?: boolean;
  fauxItalic?: boolean;
  /** 大小写替换（大写枚举名，与内核 `Caps` 一致）。 */
  caps?: "Normal" | "SmallCaps" | "AllCaps";
  /** 标准连字（`liga`/`clig`）；默认启用。 */
  ligatures?: boolean;
  /** 自由连字（`dlig`）。 */
  discretionaryLigatures?: boolean;
  /** BCP-47 语言标签；影响整形与断行。`null` = 未指定。 */
  language?: string | null;
  /** 可变字体轴设置，形状为 `axis=value`。 */
  fontVariations?: string[];
  /** 抗锯齿方式（大写枚举名，与内核 `AntiAlias` 一致）。 */
  antialias?: "None" | "Sharp" | "Crisp" | "Strong" | "Smooth" | "Windows" | "WindowsLcd";
  /** 启用的 OpenType 特性，形状为 `tag=value`（tag 为四字符标记）。 */
  features?: string[];
  /** Warp 变形；省略表示不变形。 */
  warp?: {
    style: string;
    value: number;
    horizontalDistortion: number;
    verticalDistortion: number;
    horizontal: boolean;
  };
  /**
   * 逐字符 run 的排版摘要：`6;5=tracking:300`（每 run 的字节长度 + 非默认字段）。
   *
   * 只在**一层有多个 run 且至少一个 run 不是默认排版**时出现，由内核
   * `features/type/content.rs` 生成；宿主不重建第二套草稿，原样携带并校验结构。
   * 它的存在是为了让 `type.setStyle` 的 `range` 写入（只改中间几个字符）也进指纹。
   */
  charRuns?: string;
  /** 逐段落 run 的排版摘要，形状与 `charRuns` 相同。 */
  paragraphRuns?: string;
};

export function canonicalizeText(text: ImageProjectTextContent | null): string | null {
  if (!text || typeof text !== "object") return null;
  if (typeof text.text !== "string" || text.text.length > 100_000) return null;
  if (!isNonEmptyShortString(text.fontFamily, 200)) return null;
  if (!isFiniteNumberValue(text.fontSize) || text.fontSize <= 0) return null;
  if (!/^#[0-9a-f]{6}$/.test(text.color)) return null;
  if (typeof text.bold !== "boolean") return null;
  if (text.align !== "left" && text.align !== "center" && text.align !== "right") return null;
  const box=text.box;
  if (box != null && (!Array.isArray(box) || box.length!==4 || !box.every((n)=>isFiniteNumberValue(n) && Math.abs(n)<=8192) || box[2]<=0 || box[3]<=0)) return null;
  // 排版参数（P7）：省略或默认值时保持旧指纹文本形状。
  const typography: string[] = [];
  if (text.leading != null) {
    if (!isFiniteNumberValue(text.leading) || text.leading < 0 || text.leading > 5000) return null;
    typography.push(`leading:${round(text.leading)}`);
  }
  if (text.tracking !== undefined) {
    if (!isFiniteNumberValue(text.tracking) || text.tracking < -1000 || text.tracking > 10000) return null;
    if (text.tracking !== 0) typography.push(`tracking:${round(text.tracking)}`);
  }
  if (text.baselineShift !== undefined) {
    if (!isFiniteNumberValue(text.baselineShift) || Math.abs(text.baselineShift) > 5000) return null;
    if (text.baselineShift !== 0) typography.push(`baseline:${round(text.baselineShift)}`);
  }
  if (text.kerning !== undefined) {
    if (!["metrics", "optical", "off"].includes(text.kerning)) return null;
    if (text.kerning !== "metrics") typography.push(`kerning:${text.kerning}`);
  }
  // 本 change 新增的排版内容（change: 2026-10-22-add-photocraft-typography-workflows，任务 3.2）。
  // 与内核 `identity.rs::canonicalize_text` 及 `features/type/content.rs` 逐字段一致：
  // 缺省/默认值不写，旧工程指纹因此保持兼容。
  if (text.kern !== undefined) {
    if (!isFiniteNumberValue(text.kern) || Math.abs(text.kern) > 1000) return null;
    if (text.kern !== 0) typography.push(`kern:${round(text.kern)}`);
  }
  // 每项都带自己的默认值：与默认值相等时不写，这样「显式写成默认」与「不写」
  // 得到同一个指纹（内核 `features/type/content.rs` 也会折叠掉默认值）。
  for (const [key, label, fallback] of [
    ["firstLineIndent", "indent1", 0],
    ["startIndent", "indentStart", 0],
    ["endIndent", "indentEnd", 0],
    ["spaceBefore", "spaceBefore", 0],
    ["spaceAfter", "spaceAfter", 0],
    ["autoLeading", "autoLeading", 1.2]
  ] as const) {
    const value = text[key];
    if (value === undefined || value === null) continue;
    if (!isFiniteNumberValue(value) || Math.abs(value) > 5000) return null;
    // 段落缩进/段距可以为负（悬挂缩进），自动行距必须为正数。
    if (key === "autoLeading" && value <= 0) return null;
    if (round(value) !== round(fallback)) typography.push(`${label}:${round(value)}`);
  }
  for (const [key, label, allowed] of [
    ["paragraphAlign", "paraAlign", ["Left", "Center", "Right", "JustifyLeft", "JustifyCenter", "JustifyRight", "JustifyAll"]],
    ["direction", "direction", ["Auto", "Ltr", "Rtl"]],
    ["antialias", "antialias", ["None", "Sharp", "Crisp", "Strong", "Smooth", "Windows", "WindowsLcd"]]
  ] as const) {
    const value = text[key];
    if (value === undefined || value === null) continue;
    if (!allowed.includes(value as never)) return null;
    typography.push(`${label}:${value}`);
  }
  if (text.hyphenate !== undefined && text.hyphenate !== null) {
    if (typeof text.hyphenate !== "boolean") return null;
    if (text.hyphenate) typography.push("hyphenate:1");
  }
  if (text.styleSheet !== undefined && text.styleSheet !== null) {
    if (!Number.isInteger(text.styleSheet) || text.styleSheet <= 0) return null;
    typography.push(`styleSheet:${text.styleSheet}`);
  }
  // 应用的字符样式引用（与内核 `charStyleSheet` 对应）。
  if (text.charStyleSheet !== undefined && text.charStyleSheet !== null) {
    if (!Number.isInteger(text.charStyleSheet) || text.charStyleSheet <= 0) return null;
    typography.push(`charStyleSheet:${text.charStyleSheet}`);
  }
  // 整层字符属性（与内核 `attach_flat_char` 对应）：默认值不写，枚举名与内核一致。
  for (const [key, label, fallback] of [
    ["weight", "weight", 400],
    ["horizontalScale", "hScale", 1],
    ["verticalScale", "vScale", 1]
  ] as const) {
    const value = text[key];
    if (value === undefined || value === null) continue;
    if (!isFiniteNumberValue(value) || Math.abs(value) > 10_000) return null;
    if (round(value) !== round(fallback)) typography.push(`${label}:${round(value)}`);
  }
  for (const [key, label, fallback] of [
    ["underline", "underline", false],
    ["strikethrough", "strikethrough", false],
    ["italic", "italic", false],
    ["fauxBold", "fauxBold", false],
    ["fauxItalic", "fauxItalic", false],
    ["ligatures", "ligatures", true],
    ["discretionaryLigatures", "dligatures", false]
  ] as const) {
    const value = text[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "boolean") return null;
    if (value !== fallback) typography.push(`${label}:${value ? 1 : 0}`);
  }
  if (text.caps !== undefined && text.caps !== null) {
    if (!["Normal", "SmallCaps", "AllCaps"].includes(text.caps)) return null;
    if (text.caps !== "Normal") typography.push(`caps:${text.caps}`);
  }
  if (text.language !== undefined && text.language !== null) {
    if (typeof text.language !== "string" || text.language.length === 0 || text.language.length > 64) return null;
    if (!/^[\x21-\x7e]+$/.test(text.language)) return null;
    typography.push(`language:${text.language}`);
  }
  if (text.fontVariations !== undefined && text.fontVariations !== null) {
    if (!Array.isArray(text.fontVariations) || text.fontVariations.length > 32) return null;
    const axes: string[] = [];
    for (const axis of text.fontVariations) {
      if (typeof axis !== "string") return null;
      const at = axis.indexOf("=");
      if (at < 0) return null;
      const name = axis.slice(0, at);
      const raw = axis.slice(at + 1);
      const amount = Number(raw);
      if (!/^[A-Za-z0-9]{1,4}$/.test(name) || raw.trim() === "" || !Number.isFinite(amount)) return null;
      axes.push(`${name}=${amount}`);
    }
    axes.sort();
    typography.push(`variations:${axes.join("+")}`);
  }
  if (text.features !== undefined && text.features !== null) {
    if (!Array.isArray(text.features) || text.features.length > 64) return null;
    const tags: string[] = [];
    for (const feature of text.features) {
      if (typeof feature !== "string") return null;
      const at = feature.indexOf("=");
      if (at < 0) return null;
      const tag = feature.slice(0, at);
      const raw = feature.slice(at + 1);
      // 形状是 `tag=value`；tag 是 OpenType 的四字符标记。
      if (!/^[A-Za-z0-9]{4}$/.test(tag)) return null;
      if (!/^\d+$/.test(raw)) return null;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 65535) return null;
      tags.push(`${tag}=${value}`);
    }
    tags.sort();
    typography.push(`features:${tags.join(",")}`);
  }
  if (text.warp !== undefined && text.warp !== null) {
    const warp = text.warp;
    if (typeof warp !== "object") return null;
    if (typeof warp.style !== "string" || !warp.style.startsWith("warp") || warp.style.length > 32) return null;
    const numbers = [warp.value, warp.horizontalDistortion, warp.verticalDistortion];
    if (!numbers.every((n) => isFiniteNumberValue(n) && Math.abs(n) <= 1000)) return null;
    if (typeof warp.horizontal !== "boolean") return null;
    typography.push(
      `warp:${warp.style}:${round(warp.value)}:${round(warp.horizontalDistortion)}:${round(warp.verticalDistortion)}:${warp.horizontal ? 1 : 0}`
    );
  }
  // 逐 run 摘要：只有一层有多个 run 时内核才写它，宿主原样携带并校验结构。
  // 有了它，`type.setStyle` 的 `range` 写入（只改中间几个字符）也会改变身份。
  for (const [key, paragraph] of [["charRuns", false], ["paragraphRuns", true]] as const) {
    const value = text[key];
    if (value === undefined || value === null) continue;
    const runs = canonicalizeRuns(value, paragraph);
    if (runs === null) return null;
    typography.push(`${key}=${runs}`);
  }
  return [
    box == null ? "text" : `text-box:${box.map((n)=>String(round(n))).join(",")}`,
    String(round(text.fontSize)),
    text.color,
    text.bold ? "1" : "0",
    text.align,
    text.fontFamily,
    text.text
  ].join(":") + (typography.length ? `:${typography.join(":")}` : "");
}/** 逐 run 摘要里允许出现的字段名（与内核 `features/type/content.rs` 一致）。 */
const CHAR_RUN_KEYS = [
  "baseline", "caps", "charStyle", "color", "dligatures", "family", "fauxBold", "fauxItalic",
  "features", "hScale", "italic", "kern", "kerning", "language", "leading", "ligatures", "size",
  "strikethrough", "tracking", "underline", "variations", "vScale", "weight"
];
const PARAGRAPH_RUN_KEYS = [
  "align",
  "autoLeading",
  "direction",
  "hyphenate",
  "indent1",
  "indentEnd",
  "indentStart",
  "spaceAfter",
  "spaceBefore",
  "styleSheet"
];
/** 每层 run 数预算：碎片化的 run 不该无限膨胀指纹。 */
const MAX_RUNS = 4096;

/**
 * 校验并规范化逐 run 摘要：`6;5=tracking:300`。
 *
 * 与内核 `identity.rs::canonicalize_runs` 逐条对应：拆开、按字段名排序、再拼回。
 * 数值不重新取整——文本由内核按 `js_rounded` 的精度写好，二次取整反而会让两侧不一致。
 */
export function canonicalizeRuns(value: unknown, paragraph: boolean): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 65536) return null;
  const keys = paragraph ? PARAGRAPH_RUN_KEYS : CHAR_RUN_KEYS;
  const runs = value.split(";");
  if (runs.length > MAX_RUNS) return null;
  const normalized: string[] = [];
  for (const run of runs) {
    const at = run.indexOf("=");
    const length = at < 0 ? run : run.slice(0, at);
    if (!/^\d+$/.test(length) || Number(length) > 100_000) return null;
    if (at < 0) {
      normalized.push(String(Number(length)));
      continue;
    }
    const pairs: [string, string][] = [];
    for (const pair of run.slice(at + 1).split(",")) {
      const split = pair.indexOf(":");
      if (split < 0) return null;
      const key = pair.slice(0, split);
      const field = pair.slice(split + 1);
      if (!keys.includes(key) || field === "") return null;
      if (!isValidRunValue(key, field)) return null;
      pairs.push([key, field]);
    }
    // 同一 run 内按字段名排序：写入顺序不同不该换指纹。
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    normalized.push(`${Number(length)}=${pairs.map(([key, field]) => `${key}:${field}`).join(",")}`);
  }
  return normalized.join(";");
}

function isValidRunValue(key: string, value: string): boolean {
  switch (key) {
    case "kerning":
      return ["metrics", "optical", "off"].includes(value);
    case "align":
      return ["Left", "Center", "Right", "JustifyLeft", "JustifyCenter", "JustifyRight", "JustifyAll"].includes(value);
    case "direction":
      return ["Auto", "Ltr", "Rtl"].includes(value);
    case "hyphenate":
    case "underline":
    case "strikethrough":
    case "italic":
    case "ligatures":
    case "dligatures":
    case "fauxBold":
    case "fauxItalic":
      return value === "0" || value === "1";
    case "caps":
      return ["Normal", "SmallCaps", "AllCaps"].includes(value);
    case "family":
      return value.length > 0 && value.length <= 200 && !value.includes("\0");
    case "language":
      return value.length <= 64 && /^[\x21-\x7e]*$/.test(value);
    case "color":
      return /^#[0-9a-f]{6}$/.test(value);
    case "variations":
      return value.split("+").every((axis) => {
        const at = axis.indexOf("=");
        if (at < 0) return false;
        const name = axis.slice(0, at);
        const amount = axis.slice(at + 1);
        // 字体轴名是四个 ASCII 字符（`wght`/`wdth`/`opsz`…）。
        return /^[A-Za-z0-9]{1,4}$/.test(name) && amount.trim() !== "" && Number.isFinite(Number(amount));
      });
    case "features":
      return value.split("+").every((feature) => {
        const at = feature.indexOf("=");
        if (at < 0) return false;
        const tag = feature.slice(0, at);
        const raw = feature.slice(at + 1);
        return /^[A-Za-z0-9]{4}$/.test(tag) && /^\d+$/.test(raw) && Number(raw) <= 65535;
      });
    default: {
      const number = Number(value);
      return value.trim() !== "" && Number.isFinite(number);
    }
  }
}
