import type { FeaturePanelContext } from "../panel-context.js";
import { VectorToolsPanel } from "./vector-tools-panel.js";

export const sections = [
{
  id: "vector",
  order: 8,
  placement: "advanced",
  menu: "窗口",
  label: "路径与形状…",
  menuOrder: 0,
  render: ({ controller, locked, documentView, activeLayerId, colors }: FeaturePanelContext) => {
    // 布尔运算按「选中的形状层」整层合并：这里只统计已选中的形状层数，不复制图层模型。
    const layers = documentView?.layers ?? [];
    const shapeLayers = layers.filter(layer => layer.kind === "shape" && layer.selected).length;
    return <div key="vector" className="photo-editor__advanced-section" data-advanced-section="vector">
      <VectorToolsPanel
        controller={controller}
        readonly={locked}
        layer={activeLayerId}
        color={colors.foreground}
        hasSelection={documentView?.hasSelection ?? false}
        revision={documentView?.revision ?? 0}
        shapeLayers={shapeLayers}
      />
    </div>;
  }
}
] as const;
