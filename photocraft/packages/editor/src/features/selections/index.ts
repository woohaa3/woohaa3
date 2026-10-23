import { canRunPixelTool } from "../tool-contracts.js";
import { sections } from "./sections.js";
import { WandSparkles, Scan, Magnet, Pentagon } from "lucide-react";
import { MarqueeIcon, LassoIcon } from "../../ui/icons.js";
import { SelectionModifyPanel, ColorRangePanel, RefineEdgePanel } from "./panels.js";
import {
  ColorGrowPanel,
  ColorRangeSamplesPanel,
  LayerMaskPanel,
  LineSelectionPanel,
  MagneticLassoPanel,
  NamedSelectionPanel,
  QuickMaskPanel,
  RefineEdgeWorkspace,
  SmartSelectPanel
} from "./workflow-panels.js";
export const feature = {
  id: "selections",
  tools: [{ id: "polygon-lasso", gesture: "selection", targets: ["pixels"], canRun: canRunPixelTool, label: "多边形套索", Icon: Pentagon, order: 2.1 }, { id: "magnetic-lasso", gesture: "selection", targets: ["pixels"], canRun: canRunPixelTool, label: "磁性套索", Icon: Magnet, order: 2.2 }, { id: "marquee", gesture: "selection", targets: ["pixels"], canRun: canRunPixelTool, label: "矩形 / 椭圆选框", Icon: MarqueeIcon, order: 1 }, { id: "lasso", gesture: "selection", targets: ["pixels"], canRun: canRunPixelTool, label: "套索", Icon: LassoIcon, order: 2 }, { id: "wand", gesture: "sample", targets: ["pixels"], canRun: canRunPixelTool, label: "魔棒", Icon: WandSparkles, order: 3 }, { id: "quick", gesture: "sample", targets: ["pixels"], canRun: canRunPixelTool, label: "快速选择", Icon: Scan, order: 4 }],
  sections,
  panels: {
    SelectionModifyPanel,
    ColorRangePanel,
    RefineEdgePanel,
    // U17–U24：面板随既有分区装配，不经共享外壳新增 id。
    LineSelectionPanel,
    MagneticLassoPanel,
    NamedSelectionPanel,
    ColorGrowPanel,
    QuickMaskPanel,
    SmartSelectPanel,
    ColorRangeSamplesPanel,
    RefineEdgeWorkspace,
    LayerMaskPanel
  }
} as const;
