import { sections } from "./sections.js";
import { BlendingPanel, FillLayerPanel, LayerCompPanel, LayerFilterPanel, MattingPanel, StylePresetPanel } from "./panels.js";
export const feature = {
  id: "layers",
  tools: [],
  sections,
  panels: { LayerFilterPanel, FillLayerPanel, BlendingPanel, MattingPanel, LayerCompPanel, StylePresetPanel }
} as const;
