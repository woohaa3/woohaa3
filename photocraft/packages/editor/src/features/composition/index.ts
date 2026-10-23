import { Crop } from "lucide-react";
import { canRunPixelTool } from "../tool-contracts.js";
import { sections } from "./sections.js";
import { MoveIcon } from "../../ui/icons.js";
import { ComposePanel, CompositionWorkflowPanel } from "./panels.js";

export const feature = {
  id: "composition",
  tools: [{ id: "crop", gesture: "selection", targets: ["pixels"], canRun: canRunPixelTool, label: "裁剪", Icon: Crop, order: 4.5 }, { id: "move", gesture: "move", targets: ["pixels"], canRun: canRunPixelTool, label: "移动", Icon: MoveIcon, order: 0 }],
  sections,
  panels: { ComposePanel, CompositionWorkflowPanel }
} as const;

/**
 * 画布叠加层（裁剪框、整图旋转预览、变形网格）由集成负责人在共享 `renderOverlay` 槽位
 * 挂载，见 `overlays.tsx` 的文件注释；这里只把组件与槽位名导出给装配侧。
 */
export { CompositionOverlay, MountedCompositionOverlay, COMPOSITION_OVERLAY_SLOTS } from "./overlays.js";
export type { CompositionOverlayProps, CompositionOverlayState, CompositionOverlaySlot } from "./overlays.js";
export {
  compositionOverlayState,
  publishCompositionOverlay,
  subscribeCompositionOverlay,
  resetCompositionOverlay
} from "./overlay-store.js";
