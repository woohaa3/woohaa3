import { sections } from "./sections.js";
import { WorkspaceCustomizationPanel } from "./panels.js";
export const feature = {
  id: "customization",
  tools: [],
  sections,
  panels: { WorkspaceCustomizationPanel }
} as const;
