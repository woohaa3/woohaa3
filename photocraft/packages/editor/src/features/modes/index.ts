import { sections } from "./sections.js";
import { ModesPanel } from "./panels.js";

/**
 * 图像模式与调色板域装配
 * （change: 2026-10-22-add-photocraft-image-mode-workflows）。
 *
 * 没有工具：模式转换不是画笔/选区手势，入口在「图像 › 模式与颜色表…」，工具矩阵由
 * `mode-data.ts` 判定其他域的现存工具是否可用。
 */
export const feature = {
  id: "modes",
  tools: [],
  sections,
  panels: { ModesPanel }
} as const;
