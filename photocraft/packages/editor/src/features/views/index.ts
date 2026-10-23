import { Hand, ZoomIn } from "lucide-react";
import { canRunTool } from "../tool-contracts.js";
import { sections } from "./sections.js";
import { ViewWorkspacePanel } from "./panels.js";

export const feature = {
  id: "views",
  tools: [{ id: "hand", gesture: "move", targets: ["pixels", "mask"], canRun: canRunTool, label: "抓手", Icon: Hand, order: 30 }, { id: "zoom", gesture: "point", targets: ["pixels", "mask"], canRun: canRunTool, label: "缩放", Icon: ZoomIn, order: 31 }],
  sections,
  panels: { ViewWorkspacePanel }
} as const;
