import type { FeaturePanelContext } from "../panel-context.js";
import { SmartObjectPanel } from "./smart-object-panel.js";

export const sections = [
{ id: "smartObject", order: 9, placement: "advanced", menu: "图层", label: "智能对象…", menuOrder: 1, render: ({ controller, locked, documentView, activeLayerId, refreshPreview }: FeaturePanelContext) => (<div key="smartObject" className="photo-editor__advanced-section" data-advanced-section="smartObject"><SmartObjectPanel controller={controller} readonly={locked} layer={activeLayerId} revision={documentView?.revision ?? 0} onChanged={refreshPreview} /></div>) }
] as const;
