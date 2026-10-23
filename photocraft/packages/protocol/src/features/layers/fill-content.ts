import { HASH16, isFiniteNumberValue, isFiniteUnit, isNonEmptyShortString, round } from "../shared/content.js";

/** 渐变几何的规范名（与 Rust `gradient_style_name` 同值）。 */
export const IMAGE_PROJECT_GRADIENT_STYLES = ["linear", "radial", "angle", "reflected", "diamond"] as const;
export type ImageProjectGradientStyle = (typeof IMAGE_PROJECT_GRADIENT_STYLES)[number];

/** 渐变颜色端点：位置 0–1、`#rrggbb` 与独立 alpha。 */
export type ImageProjectGradientStop = { at: number; color: string; alpha: number };
/** 渐变透明度端点：位置 0–1 与 0–1 的 alpha。 */
export type ImageProjectGradientOpacityStop = { at: number; alpha: number };

/**
 * 填充层的规范内容（U57）：纯色 / 渐变 / 图案。
 *
 * 填充层是**可重编内容**——像素是参数算出来的缓存，改颜色必须让宿主看到净变化，所以这里
 * 描述参数而不是渲染结果。由 `document_content.rs` 写在图层的 `fillLayer` 字段
 * （不复用 `fill`：后者是填充**不透明度**）。
 *
 * 三个实现必须逐字节一致，否则宿主与内核会对「是否净变化」给出不同答案：
 * Rust `features/layers/content.rs::fill_content`、Rust
 * `identity.rs::canonicalize_fill`、以及本文件的 [`canonicalizeFillContent`]。
 */
export type ImageProjectFillContent =
  | { kind: "solid"; parameters: { kind: "solid"; color: string; alpha: number } }
  | {
      kind: "gradient";
      parameters: {
        kind: "gradient";
        stops: ImageProjectGradientStop[];
        angle: number;
        scale: number;
        style: ImageProjectGradientStyle;
        reverse: boolean;
        opacityStops: ImageProjectGradientOpacityStop[];
        midpoints: number[];
        offset: [number, number];
        dither: boolean;
        align: boolean;
      };
    }
  | {
      kind: "pattern";
      parameters: {
        kind: "pattern";
        /** 图案库键：换图案改变内容，改库项本身不改变已应用快照。 */
        pattern: string;
        name: string;
        scale: number;
        angle: number;
        link: boolean;
        phase: [number, number];
      };
    };

/** 渐变端点数上限（与 Rust `MAX_GRADIENT_STOPS` 一致）。 */
const MAX_GRADIENT_STOPS = 1024;
const HEX_COLOR = /^#[0-9a-f]{6}$/;

/**
 * 填充内容的规范文本；非法结构返回 `null`（调用方必须当作「无法判定」，绝不是「无变化」）。
 *
 * 行格式与 Rust `identity.rs::canonicalize_fill` 逐字节一致：
 *
 * ```text
 * fill:solid:<#rrggbb>:<alpha>
 * fill:gradient:<style>:<angle>:<scale>:<reverse>:<dither>:<align>:<x>,<y>:[<at>:<#rrggbb>:<alpha>…]:[<at>:<alpha>…]:[<mid>…]
 * fill:pattern:<名称长度>:<名称>:<id 长度>:<id>:<scale>:<angle>:<link>:<x>,<y>
 * ```
 *
 * 颜色只取 `#rrggbb` 加独立 alpha：非 RGB 文档的通道数组长度不同，直接比较会让同一语义
 * 颜色在不同模式下得到不同指纹。
 */
export function canonicalizeFillContent(value: ImageProjectFillContent | null | undefined): string | null {
  if (!value || typeof value !== "object") return null;
  const parameters = value.parameters;
  if (!parameters || typeof parameters !== "object") return null;
  if (value.kind !== parameters.kind) return null;
  if (parameters.kind === "solid") {
    const color = parameters.color;
    if (typeof color !== "string" || !HEX_COLOR.test(color)) return null;
    if (!isFiniteUnit(parameters.alpha)) return null;
    return `fill:solid:${color}:${round(parameters.alpha)}`;
  }
  if (parameters.kind === "gradient") {
    const style = parameters.style;
    if (typeof style !== "string" || !(IMAGE_PROJECT_GRADIENT_STYLES as readonly string[]).includes(style)) return null;
    const stops = parameters.stops;
    if (!Array.isArray(stops) || stops.length < 2 || stops.length > MAX_GRADIENT_STOPS) return null;
    const rendered: string[] = [];
    let previous = Number.NEGATIVE_INFINITY;
    for (const stop of stops) {
      if (!stop || typeof stop !== "object") return null;
      const at = stop.at;
      if (!isFiniteUnit(at) || at < previous) return null;
      previous = at;
      if (typeof stop.color !== "string" || !HEX_COLOR.test(stop.color)) return null;
      if (!isFiniteUnit(stop.alpha)) return null;
      rendered.push(`${round(at)}:${stop.color}:${round(stop.alpha)}`);
    }
    const opacity = parameters.opacityStops;
    if (!Array.isArray(opacity) || opacity.length > MAX_GRADIENT_STOPS) return null;
    const opacities = opacity.map((stop) => {
      if (!stop || typeof stop !== "object" || !isFiniteUnit(stop.at) || !isFiniteUnit(stop.alpha)) return null;
      return `${round(stop.at)}:${round(stop.alpha)}`;
    });
    if (opacities.some((entry) => entry === null)) return null;
    const midpoints = parameters.midpoints;
    if (!Array.isArray(midpoints) || midpoints.length >= Math.max(stops.length, 1)) return null;
    if (!midpoints.every(isFiniteUnit)) return null;
    const offset = parameters.offset;
    if (!Array.isArray(offset) || offset.length !== 2) return null;
    const [dx, dy] = offset;
    if (!isFiniteNumberValue(dx) || Math.abs(dx) > 1e5 || !isFiniteNumberValue(dy) || Math.abs(dy) > 1e5) return null;
    const scale = parameters.scale;
    // 与核验器同一区间：越界内容无法判为「可保存」。
    if (!isFiniteNumberValue(scale) || scale < 0.1 || scale > 1.5) return null;
    const angle = parameters.angle;
    if (!isFiniteNumberValue(angle)) return null;
    if (typeof parameters.reverse !== "boolean" || typeof parameters.dither !== "boolean" || typeof parameters.align !== "boolean") return null;
    return `fill:gradient:${style}:${round(angle)}:${round(scale)}:${parameters.reverse ? 1 : 0}:${parameters.dither ? 1 : 0}:${parameters.align ? 1 : 0}:${round(dx)},${round(dy)}:[${rendered.join(";")}]:[${(opacities as string[]).join(";")}]:[${midpoints.map((mid) => round(mid as number)).join(";")}]`;
  }
  const name = parameters.name;
  const id = parameters.pattern;
  if (!isNonEmptyShortString(name, 200) || !isNonEmptyShortString(id, 200)) return null;
  const scale = parameters.scale;
  if (!isFiniteNumberValue(scale) || scale <= 0 || scale > 10) return null;
  const angle = parameters.angle;
  if (!isFiniteNumberValue(angle) || angle < -360 || angle > 360) return null;
  if (typeof parameters.link !== "boolean") return null;
  const phase = parameters.phase;
  if (!Array.isArray(phase) || phase.length !== 2) return null;
  const [px, py] = phase;
  if (!isFiniteNumberValue(px) || Math.abs(px) > 1e7 || !isFiniteNumberValue(py) || Math.abs(py) > 1e7) return null;
  return `fill:pattern:${name.length}:${name}:${id.length}:${id}:${round(scale)}:${round(angle)}:${parameters.link ? 1 : 0}:${round(px)},${round(py)}`;
}

/**
 * 填充内容里引用的图案 id（核验器用：图案必须随工程保存）。
 *
 * 只对图案填充返回一项目；其它填充返回空数组。
 */
export function fillPatternReference(value: ImageProjectFillContent | null | undefined): string | null {
  if (!value || typeof value !== "object" || value.kind !== "pattern") return null;
  const id = value.parameters?.pattern;
  return typeof id === "string" && id.length > 0 && id.length <= 200 ? id : null;
}

/** 内容摘要是否具备 `HASH16` 形状（供核验与调试共用）。 */
export function isContentHash16(value: unknown): value is string {
  return typeof value === "string" && HASH16.test(value);
}
