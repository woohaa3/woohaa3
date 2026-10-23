import { sections } from "./sections.js";
import { ApplyImagePanel, CalculationsPanel, ChannelPanel } from "./panels.js";

/**
 * P7 通道与通道计算（U25/U26）。
 *
 * 本域不新增画布工具：通道的目标/显隐、拆分合并与计算都从面板发起，
 * 面板使用共享控制器既有的 `dispatch`（选区命令）与 `features.channels`（本域端口）。
 */
export const feature = {
  id: "channels",
  tools: [],
  sections,
  panels: { ChannelPanel, ApplyImagePanel, CalculationsPanel }
} as const;
