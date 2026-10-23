/**
 * 绘画与笔刷的内核枚举取值
 * （change: 2026-10-22-add-photocraft-painting-color-workflows，U30）。
 *
 * 这里集中「界面能选 = 内核认识」的枚举：绘画混合模式、纹理掩膜模式、程序化纹理样式。
 * 单独成文件是为了让 `tool-parameters.ts`（笔迹编译）、`tool-modes.ts`（工具参数）与
 * `brush-library-state.ts`（笔刷动态）共用同一份清单而不产生循环依赖。
 *
 * 混合模式的**清单来自协议包**（`PAINT_BLEND_MODE_IDS`）：它同时被宿主的工程校验消费，因此
 * 「能绘制的模式」只有一份，不会出现编辑器多一个、协议少一个的漂移。
 */
import { PAINT_BLEND_MODE_IDS, type PaintBlendModeId } from "@woohaa3/photocraft-protocol";

/**
 * 绘画混合模式：协议与内核共用的可绘制模式集合。
 *
 * `passThrough` 只对组有意义，`clear` 已由 `erase` 表达，两者都不在列表里。
 */
export type PaintBlendMode = PaintBlendModeId;

export const PAINT_BLEND_MODES: readonly PaintBlendMode[] = PAINT_BLEND_MODE_IDS;

export function isPaintBlendMode(value: string): value is PaintBlendMode {
  return (PAINT_BLEND_MODES as readonly string[]).includes(value);
}

/**
 * 把内核返回的混合模式写法（`"Normal"`、`"Color Dodge"`、`"ColorDodge"`）折回界面 id。
 *
 * 只做归一化，遇到未知值返回 `null`（不猜一个模式去改用户像素）。
 */
export function normalizePaintBlendMode(value: unknown): PaintBlendMode | null {
  if (typeof value !== "string") return null;
  const want = value.toLowerCase().replace(/[\s_\-()]/g, "");
  return PAINT_BLEND_MODES.find((mode) => mode.toLowerCase() === want) ?? null;
}

/** 纹理/双重笔刷掩膜的组合方式（内核 `MaskMode`，camelCase 序列化）。 */
export type MaskMode =
  | "multiply"
  | "subtract"
  | "darken"
  | "overlay"
  | "colorDodge"
  | "colorBurn"
  | "linearBurn"
  | "hardMix"
  | "linearHeight"
  | "height";

export const MASK_MODES: readonly MaskMode[] = [
  "multiply",
  "subtract",
  "darken",
  "overlay",
  "colorDodge",
  "colorBurn",
  "linearBurn",
  "hardMix",
  "linearHeight",
  "height"
];

export function isMaskMode(value: string): value is MaskMode {
  return (MASK_MODES as readonly string[]).includes(value);
}

/** 程序化纹理样式（内核 `PatternStyle`；都不依赖外部图案文件）。 */
export type TextureStyle = "noise" | "canvas" | "paper" | "dots";

export const TEXTURE_STYLES: readonly TextureStyle[] = ["noise", "canvas", "paper", "dots"];

export function isTextureStyle(value: string): value is TextureStyle {
  return (TEXTURE_STYLES as readonly string[]).includes(value);
}
