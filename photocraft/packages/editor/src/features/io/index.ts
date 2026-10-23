import { sections } from "./sections.js";
import { InterchangePanel } from "./panels.js";
export const feature = {
  id: "io",
  tools: [],
  sections,
  panels: { InterchangePanel }
} as const;
