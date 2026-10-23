import { sections } from "./sections.js";
import { FilterPanel } from "./panels.js";
export const feature = {
  id: "filters",
  tools: [],
  sections,
  panels: { FilterPanel }
} as const;
