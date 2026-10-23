import { canRunPixelTool } from "../tool-contracts.js";
import { sections } from "./sections.js";
import { TypeIcon } from "../../ui/icons.js";
import { TypographyPanel } from "./panels.js";
export const feature = {
  id: "type",
  tools: [{ id: "text", gesture: "text", targets: ["pixels"], canRun: canRunPixelTool, label: "文字", Icon: TypeIcon, order: 7 }],
  sections,
  panels: { TypographyPanel }
} as const;
