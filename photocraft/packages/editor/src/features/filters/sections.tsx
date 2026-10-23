import type { FeaturePanelContext } from "../panel-context.js";
import { FilterPanel } from "./panels.js";

export const sections = [
{ id: "filter", order: 5, placement: "advanced", menu: "滤镜", label: "滤镜库…", menuOrder: 0, render: ({ controller, locked, refreshPreview, panelRequest }: FeaturePanelContext) => (<div key="filter" className="photo-editor__advanced-section" data-advanced-section="filter"><FilterPanel key={panelRequest?.panel === "filter" ? panelRequest.sequence : "default"} initialFilter={panelRequest?.panel === "filter" ? panelRequest.command : undefined} controller={controller} readonly={locked} onChanged={refreshPreview} /></div>) }
] as const;
