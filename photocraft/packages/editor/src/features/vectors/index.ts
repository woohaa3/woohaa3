import {
  Circle,
  Minus,
  MousePointer2,
  PenTool,
  Pentagon,
  Shapes,
  Spline,
  Square,
  SquareRoundCorner,
  Star,
  Triangle,
  Waypoints,
} from "lucide-react";
import { canRunPixelTool } from "../tool-contracts.js";
import { PenIcon } from "../../ui/icons.js";
import { sections } from "./sections.js";
import { VECTOR_TOOLS } from "./vector-tools.js";

/**
 * 矢量工具组（U08–U16，change: 2026-10-22-add-photocraft-vector-canvas-tools）。
 *
 * 手势种类只有三种新值：`shape`（拖绘）、`pen`（落锚/拖柄）、`path`（锚点编辑）。
 * 画布据此把指针事件交给 `vector-tools.ts` 的归约器，不再落到平移或笔迹分支——
 * 这是「未登记工具会被当成平移/笔迹而误画像素」的正面解法。
 */
const ICONS: Record<string, typeof Square> = {
  "shape-rect": Square,
  "shape-rounded-rect": SquareRoundCorner,
  "shape-ellipse": Circle,
  "shape-triangle": Triangle,
  "shape-polygon": Pentagon,
  "shape-star": Star,
  "shape-line": Minus,
  "pen-freeform": PenTool,
  "pen-curvature": Spline,
  "path-select": MousePointer2,
  "direct-select": Waypoints,
  "custom-shape": Shapes,
};

/** 归约器的手势组 → 画布分派用的手势名（画布只做路由，语义在归约器里）。 */
const CANVAS_GESTURE = { "shape-draw": "shape", pen: "pen", "path-edit": "path" } as const;

export const feature = {
  id: "vectors",
  tools: [
    { id: "pen", gesture: "point", targets: ["pixels"], canRun: canRunPixelTool, label: "钢笔", Icon: PenIcon, order: 11 },
    ...VECTOR_TOOLS.map(tool => ({
      id: tool.id,
      gesture: CANVAS_GESTURE[tool.gesture],
      targets: ["pixels"] as const,
      canRun: canRunPixelTool,
      label: tool.label,
      Icon: ICONS[tool.id] ?? Square,
      order: tool.order,
      shortcut: tool.shortcut,
    })),
  ],
  sections,
  panels: {  }
} as const;

/** 工具是否属于矢量组（画布据此路由指针事件，快捷键与上下文栏据此显示参数）。 */
export type VectorFeatureToolId = (typeof VECTOR_TOOLS)[number]["id"];
export const VECTOR_TOOL_IDS: readonly string[] = VECTOR_TOOLS.map(tool => tool.id);
export function isVectorTool(id: string): id is VectorFeatureToolId {
  return VECTOR_TOOL_IDS.includes(id);
}
