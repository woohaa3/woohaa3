import type { FeaturePanelContext } from "../panel-context.js";
import { PaintingWorkflowPanel } from "./panels.js";

export const sections = [
{ id: "painting", order: 12, placement: "advanced", menu: "窗口", label: "绘画工具与颜色…", menuOrder: 2, render: (context: FeaturePanelContext) => (<div key="painting" className="photo-editor__advanced-section" data-advanced-section="painting"><PaintingWorkflowPanel context={context} /></div>) }
] as const;
