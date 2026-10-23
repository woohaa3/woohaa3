import { sections } from "./sections.js";
import { AdvancedAdjustmentPanel, HistogramPanel } from "./panels.js";
import { DirectAdjustmentPanel } from "./direct-adjustment-panel.js";
export const feature = {
  id: "adjustments",
  tools: [],
  sections,
  panels: { AdvancedAdjustmentPanel, DirectAdjustmentPanel, HistogramPanel }
} as const;
