import { isFiniteNumberValue } from "../shared/content.js";

/**
 * 图像模式与调色板的内容身份
 * （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.2 / design D1b）。
 *
 * 与 Rust `rust/crates/editor-core/src/features/modes/content.rs::canonicalize_mode` 逐字节一致，
 * 两端共读同目录的 `content-fixtures.json`。文本用整数表示数值（8 位色 `0..=255`、油墨与曲线
 * `0..=10000`），因此不需要浮点格式化协商。
 *
 * **缺省不产生行**：RGB/8 位/无颜色表/无油墨返回 `""`，旧工程与本次未改模式的工程指纹不变。
 * 非法结构返回 `null`，调用方必须当作「不可判定」，绝不当作「无变化」。
 */

export const IMAGE_MODE_LIMITS = { maxTableColors: 256, maxInks: 4, maxInkCurvePoints: 64, maxInkNameLength: 64 } as const;

const MODE_IDS = ["rgb", "grayscale", "bitmap", "indexed", "duotone"] as const;
const INK_SCALE = 10_000;
const HASH_COLOR = /^#[0-9a-f]{6}$/;

export type ImageProjectModeData = {
  mode: (typeof MODE_IDS)[number];
  /** 非 8 位时写入；缺省 8。 */
  depthBits?: 8 | 16 | 32;
  /** 仅索引色：1–256 条 sRGB 条目与可选透明索引。 */
  colorTable?: { colors: string[]; transparent?: number | null } | null;
  /** 仅双色调：1–4 种油墨；`curve` 为 `[输入, 输出]` 的 0..1 数组。 */
  duotone?: { inks: ImageProjectModeInk[] } | null;
};

export type ImageProjectModeInk = { name: string; color: string; curve: [number, number][] };

const isModeData = (value: unknown): value is ImageProjectModeData =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 0..1 → 0..10000 的整数；非有限或越界返回 null。 */
function inkCoordinate(value: unknown): number | null {
  if (!isFiniteNumberValue(value) || value < 0 || value > 1) return null;
  return Math.round(value * INK_SCALE);
}

/** 规范化模式数据为确定性文本；缺省返回 `""`，非法返回 `null`。 */
export function canonicalizeMode(mode: ImageProjectModeData | null | undefined): string | null {
  if (mode === null || mode === undefined) return "";
  if (!isModeData(mode)) return null;
  const data = mode as Record<string, unknown>;
  if (Object.keys(data).some((key) => !["mode", "depthBits", "colorTable", "duotone"].includes(key))) return null;
  if (typeof data.mode !== "string" || !(MODE_IDS as readonly string[]).includes(data.mode)) return null;

  const depthBits = data.depthBits === undefined ? 8 : data.depthBits;
  if (depthBits !== 8 && depthBits !== 16 && depthBits !== 32) return null;
  // 显式写出的缺省值（RGB/8 位/无表/无油墨）与省略等价：旧工程身份不因序列化差异而变。
  if (
    data.mode === "rgb" && depthBits === 8
    && (data.colorTable === undefined || data.colorTable === null)
    && (data.duotone === undefined || data.duotone === null)
  ) return "";
  let text = depthBits === 8 ? `mode:${data.mode}` : `mode:${data.mode}:${depthBits}`;

  const table = data.colorTable;
  if (table === null || table === undefined) {
    if (data.mode === "indexed") return null;
  } else {
    if (data.mode !== "indexed" || typeof table !== "object" || Array.isArray(table)) return null;
    const entry = table as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !["colors", "transparent"].includes(key))) return null;
    const colors = entry.colors;
    if (!Array.isArray(colors) || colors.length < 1 || colors.length > IMAGE_MODE_LIMITS.maxTableColors) return null;
    const normalized: string[] = [];
    for (const color of colors) {
      if (typeof color !== "string" || !HASH_COLOR.test(color.toLowerCase())) return null;
      normalized.push(color.toLowerCase());
    }
    text += `|table:${normalized.length}:${normalized.join(",")}`;
    const transparent = entry.transparent;
    if (transparent !== null && transparent !== undefined) {
      if (!Number.isInteger(transparent) || (transparent as number) < 0 || (transparent as number) >= normalized.length) return null;
      text += `|transparent:${transparent}`;
    }
  }

  const duotone = data.duotone;
  if (duotone === null || duotone === undefined) {
    if (data.mode === "duotone") return null;
  } else {
    if (data.mode !== "duotone" || typeof duotone !== "object" || Array.isArray(duotone)) return null;
    const entry = duotone as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !["inks"].includes(key))) return null;
    const inks = entry.inks;
    if (!Array.isArray(inks) || inks.length < 1 || inks.length > IMAGE_MODE_LIMITS.maxInks) return null;
    const encoded: string[] = [];
    for (const ink of inks) {
      if (!ink || typeof ink !== "object" || Array.isArray(ink)) return null;
      const fields = ink as Record<string, unknown>;
      if (Object.keys(fields).some((key) => !["name", "color", "curve"].includes(key))) return null;
      const name = fields.name;
      if (typeof name !== "string" || name.length === 0) return null;
      // 与 Rust 一致：长度按 UTF-16 码元计，控制字符覆盖 C0/DEL/C1。
      if (name.length > IMAGE_MODE_LIMITS.maxInkNameLength || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return null;
      const color = fields.color;
      if (typeof color !== "string" || !HASH_COLOR.test(color.toLowerCase())) return null;
      const curve = fields.curve;
      if (!Array.isArray(curve) || curve.length > IMAGE_MODE_LIMITS.maxInkCurvePoints) return null;
      const points: string[] = [];
      for (const point of curve) {
        if (!Array.isArray(point) || point.length !== 2) return null;
        const input = inkCoordinate(point[0]);
        const output = inkCoordinate(point[1]);
        if (input === null || output === null) return null;
        points.push(`${input},${output}`);
      }
      // 名字可变长且可能含分隔符：与 Rust 一致，带 UTF-16 长度前缀。
      encoded.push(`${name.length}:${name}${color.toLowerCase()}#${points.length}:${points.join(";")}`);
    }
    text += `|inks:${encoded.length}:${encoded.join(",")}`;
  }
  return text;
}

/** 模式数据是否缺省（`mode` 字段可省略）。 */
export function isDefaultMode(mode: ImageProjectModeData | null | undefined): boolean {
  if (mode === null || mode === undefined) return true;
  return mode.mode === "rgb" && (mode.depthBits ?? 8) === 8
    && (mode.colorTable === undefined || mode.colorTable === null)
    && (mode.duotone === undefined || mode.duotone === null);
}
