/**
 * 矢量蒙版编辑（U15，change: 2026-10-22-add-photocraft-vector-canvas-tools，design D4）。
 *
 * 现有入口已经能「从路径创建 / 启用 / 链接 / 删除」，本模块补齐**全显全隐、栅格化与直接编辑
 * 现有蒙版路径**，并守住两条语义：
 *
 * 1. 矢量蒙版是**几何**，改它不改像素：密度/羽化/反转只动蒙版参数，图层内容保持不变；
 * 2. 与像素蒙版共存：栅格化是把矢量蒙版乘进图层蒙版（上游 `layer.rasterize.vectorMask`），
 *    不是把图层压平，也不是删掉原图像。
 *
 * 所有数值在提交前按内核范围裁定，界面不依赖渲染期夹取。
 */

import type { PenPath } from "./pen-tools.js";

export type VectorMaskSummary = {
  layer: number;
  enabled: boolean;
  linked: boolean;
  density: number;
  feather: number;
  inverted?: boolean;
  path?: unknown;
};

/** 矢量蒙版动作（与上游命令 id 一一对应）。 */
export const MASK_ACTIONS = {
  revealAll: "layer.vectorMask.revealAll",
  hideAll: "layer.vectorMask.hideAll",
  edit: "layer.vectorMask.edit",
  enabled: "layer.vectorMask.enabled",
  linked: "layer.vectorMask.linked",
  delete: "layer.vectorMask.delete",
  fromPath: "layer.vectorMask.fromPath",
  currentPath: "layer.vectorMask.currentPath",
  rasterize: "layer.rasterize.vectorMask",
} as const;

export type MaskAction = (typeof MASK_ACTIONS)[keyof typeof MASK_ACTIONS];

/** 蒙版参数补丁：只带需要改的字段（其余由内核保留）。 */
export type MaskPatch = {
  density?: number;
  feather?: number;
  enabled?: boolean;
  linked?: boolean;
  invert?: boolean;
  path?: PenPath | unknown;
};

/** 参数裁定：密度 0–100、羽化 0–1000 px、布尔字段必须是布尔值。 */
export function maskEditParams(layer: number, patch: MaskPatch): Record<string, unknown> {
  const params: Record<string, unknown> = { layer };
  if (patch.density !== undefined) {
    if (!Number.isFinite(patch.density) || patch.density < 0 || patch.density > 100) throw new Error("矢量蒙版密度必须在 0–100 之间");
    params.density = patch.density;
  }
  if (patch.feather !== undefined) {
    if (!Number.isFinite(patch.feather) || patch.feather < 0 || patch.feather > 1000) throw new Error("矢量蒙版羽化必须在 0–1000 px 之间");
    params.feather = patch.feather;
  }
  for (const key of ["enabled", "linked", "invert"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new Error(`${key} 必须是布尔值`);
    // `invert` 在上游是「翻转一次」，界面只在需要翻转时提交 true。
    if (key === "invert" && value === false) continue;
    params[key] = value;
  }
  if (patch.path !== undefined) params.path = patch.path;
  return params;
}

/** 全显 / 全隐：不带路径时新建一个显隐全部区域的蒙版。 */
export function maskVisibilityParams(layer: number | null, reveal: boolean): Record<string, unknown> {
  return { ...(layer == null ? {} : { layer }), hide: !reveal };
}

/** 从当前路径/工作路径创建或替换蒙版。 */
export function maskFromPathParams(layer: number | null, name: string): Record<string, unknown> {
  const params: Record<string, unknown> = { name };
  if (layer != null) params.layer = layer;
  return params;
}

/** 栅格化：乘进图层蒙版，保留原图像；不支持批量以外的隐式聚合。 */
export function rasterizeMaskParams(layer: number | null): Record<string, unknown> {
  return layer == null ? {} : { layer };
}

/** 蒙版是否可编辑：没有蒙版的图层只能先创建。 */
export function maskState(mask: VectorMaskSummary | undefined): "none" | "editable" | "disabled" {
  if (!mask) return "none";
  return mask.enabled ? "editable" : "disabled";
}

/** 蒙版的显示摘要（属性面板回显；不重建第二套蒙版模型）。 */
export function maskSummaryText(mask: VectorMaskSummary): string {
  const parts = [mask.enabled ? "已启用" : "已停用", mask.linked ? "已链接" : "未链接"];
  if (Number.isFinite(mask.density) && mask.density !== 1) parts.push(`密度 ${Math.round(mask.density * 100)}%`);
  if (Number.isFinite(mask.feather) && mask.feather > 0) parts.push(`羽化 ${mask.feather} px`);
  if (mask.inverted) parts.push("已反转");
  return parts.join(" · ");
}

/**
 * 直接编辑蒙版路径时的命中目标：路径编辑命令用 `name: "layer"` 指向图层自身的形状或蒙版路径。
 * 传入的 `layer` 是有形状层/矢量蒙版的图层 id。
 */
export function maskPathTarget(layer: number): { name: "layer"; layer: number } {
  return { name: "layer", layer };
}
