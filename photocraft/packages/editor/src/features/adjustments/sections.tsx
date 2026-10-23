import type { FeaturePanelContext } from "../panel-context.js";
import { HistogramPanel, AdvancedAdjustmentPanel } from "./panels.js";
import { DirectAdjustmentPanel } from "./direct-adjustment-panel.js";

export const sections = [
{ id: "histogram", order: 0, placement: "summary", menu: "窗口", label: "直方图…", menuOrder: 1, render: ({ controller, locked }: FeaturePanelContext) => (<div key="histogram" className="photo-editor__advanced-section" data-advanced-section="histogram"><HistogramPanel controller={controller} readonly={locked} /></div>) },
{
  id: "adjustments",
  order: 1,
  placement: "advanced",
  menu: "图像",
  label: "调整…",
  menuOrder: 0,
  render: ({ controller, locked, colors, refreshPreview, panelRequest }: FeaturePanelContext) => (
    <div key="adjustments" className="photo-editor__advanced-section" data-advanced-section="adjustments">
      <DirectAdjustmentPanel key={panelRequest?.panel === "adjustments" ? panelRequest.sequence : "default"} initialTarget={panelRequest?.panel === "adjustments" ? panelRequest.command : undefined} endpoint={controller} readonly={locked} foreground={colors.foreground} onApply={refreshPreview} />
      <AdvancedAdjustmentPanel endpoint={controller} readonly={locked} onApply={refreshPreview} />
    </div>
  )
}
] as const;
