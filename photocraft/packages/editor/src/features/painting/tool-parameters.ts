import { strokePoints } from "./stroke-points.js";
export { strokePoints } from "./stroke-points.js";
import { IMAGE_PROJECT_LIMITS } from "@woohaa3/photocraft-protocol";
import { clamp, type DocumentPoint } from "../shared/tool-parameters.js";

import { isPaintBlendMode, type PaintBlendMode } from "./blend-modes.js";

/** 笔刷设置（首期范围见 notes/scope.md）。 */
export type BrushSettings = {
  /** 笔头尺寸（源像素），1–512。 */
  size: number;
  /** 硬度 0–1。 */
  hardness: number;
  /** 不透明度 0–1。 */
  opacity: number;
  /** Flow 0–1。 */
  flow: number;
  /** 基础平滑 0–1。 */
  smoothing: number;
  /** 前景色 `#rrggbb`。 */
  color: string;
  /** 作用目标：像素层或蒙版。 */
  target: "pixels" | "mask";
  /**
   * 绘画混合模式（U30）。省略时按 `normal` 发送，保持首期参数形状；
   * 值必须在内核可识别的清单里，否则 `buildStroke` 拒绝。
   */
  mode?: PaintBlendMode;
  /**
   * 笔尖与动态补丁（camelCase `BrushSettings` 字段；change: 2026-10-22，任务 2.1/3.3）。
   *
   * 只保存用户在本会话里显式改过的动态参数，`paint.stroke` 的 `brush` 参数直接透传；未设置
   * 时内核用自己的默认值，不在前端补造第二份默认。
   */
  dynamics?: Record<string, unknown>;
};

/** 默认笔刷：小尺寸、硬边、满不透明度，作用于像素层。 */
export const DEFAULT_BRUSH: BrushSettings = {
  size: 24,
  hardness: 0.8,
  opacity: 1,
  flow: 1,
  smoothing: 0.2,
  color: "#000000",
  target: "pixels"
};

/** 笔头尺寸钳制到首期公开范围。 */
export function clampBrushSize(size: number): number {
  return clamp(size, IMAGE_PROJECT_LIMITS.minBrushSizeSourcePixels, IMAGE_PROJECT_LIMITS.maxBrushSizeSourcePixels);
}



/**
 * `paint.stroke` 参数：整笔保持同一组设置。
 *
 * `channel` 是通道面板的当前通道目标（`{channel:i}` 形式的 Alpha/专色索引）：
 * - 给出时明确落到该通道，`target` 由它决定（上游 `inject_target` 只在调用方**没有**
 *   给 `target` 时才注入，因此这里必须整块替换而不是与 `brush.target` 并存）；
 * - 未给出时保持原有 `pixels`/`mask` 行为，RGB 分量目标由内核按当前 `channel_view` 限制
 *   （`color_restriction`），前端不重复实现该限制。
 */
export function buildStroke(
  points: readonly (DocumentPoint & {
    tiltX?: number;
    tiltY?: number;
    rotation?: number;
    time?: number;
    wheel?: number;
  })[],
  brush: BrushSettings,
  options: { erase?: boolean; zoom?: number; channel?: number } = {}
): Record<string, unknown> | null {
  if (points.length === 0) return null;
  const mode = brush.mode ?? "normal";
  // 未知模式不悄悄退回 normal：那会让「界面显示叠加、实际正常」这种假结果通过验收。
  if (!isPaintBlendMode(mode)) return null;
  return {
    points: strokePoints(points),
    size: clampBrushSize(brush.size),
    hardness: clamp(brush.hardness, 0, 1),
    opacity: clamp(brush.opacity, 0, 1),
    flow: clamp(brush.flow, 0, 1),
    spacing: 0.25,
    smoothing: clamp(brush.smoothing, 0, 1),
    color: brush.color,
    mode,
    erase: options.erase ?? false,
    zoom: options.zoom && options.zoom > 0 ? options.zoom : 1,
    target: options.channel === undefined ? brush.target : { channel: options.channel },
    ...(brush.dynamics && Object.keys(brush.dynamics).length ? { brush: brush.dynamics } : {})
  };
}

/** 把 RGB 三元组（0–1）转成内核要求的 `#rrggbb`。 */
export function toHexColor(rgb: readonly [number, number, number]): string {
  const channel = (value: number) =>
    Math.round(clamp(value, 0, 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

/** `#rrggbb` 是否合法（供参数面板校验）。 */
export function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/.test(value);
}
