/**
 * 本域的高级面板入口（U57、U60、U61、U62、U64）。
 *
 * 菜单顺序全部追加在「图层」菜单尾部（`menuOrder` 2–6），不改动已有的
 * `vector`（0）、`smartObject`（1）两项。`order` 12–16 排在其它域之后，
 * 保证 `FEATURE_SECTIONS` 的既有排序前缀不变。
 */
import type { FeaturePanelContext } from "../panel-context.js";
import { BlendingPanel, FillLayerPanel, LayerCompPanel, MattingPanel, StylePresetPanel } from "./panels.js";

export const sections = [
{ id: "fillLayer", order: 12, placement: "advanced", menu: "图层", label: "填充层…", menuOrder: 2, render: ({ controller, locked, activeLayerId }: FeaturePanelContext) => (<div key="fillLayer" className="photo-editor__advanced-section" data-advanced-section="fillLayer"><FillLayerPanel controller={controller} readonly={locked} activeLayerId={activeLayerId} /></div>) },
{ id: "blending", order: 13, placement: "advanced", menu: "图层", label: "混合选项…", menuOrder: 3, render: ({ controller, locked, activeLayerId }: FeaturePanelContext) => (<div key="blending" className="photo-editor__advanced-section" data-advanced-section="blending"><BlendingPanel controller={controller} readonly={locked} activeLayerId={activeLayerId} /></div>) },
{ id: "matting", order: 14, placement: "advanced", menu: "图层", label: "去边与净化…", menuOrder: 4, render: ({ controller, locked, activeLayerId }: FeaturePanelContext) => (<div key="matting" className="photo-editor__advanced-section" data-advanced-section="matting"><MattingPanel controller={controller} readonly={locked} activeLayerId={activeLayerId} /></div>) },
{ id: "layerComps", order: 15, placement: "advanced", menu: "窗口", label: "图层复合…", menuOrder: 5, render: ({ controller, locked, documentView }: FeaturePanelContext) => (<div key="layerComps" className="photo-editor__advanced-section" data-advanced-section="layerComps"><LayerCompPanel controller={controller} readonly={locked} revision={documentView?.revision ?? 0} /></div>) },
{ id: "stylePresets", order: 16, placement: "advanced", menu: "窗口", label: "样式预设…", menuOrder: 6, render: ({ controller, locked, activeLayerId }: FeaturePanelContext) => (<div key="stylePresets" className="photo-editor__advanced-section" data-advanced-section="stylePresets"><StylePresetPanel controller={controller} readonly={locked} activeLayerId={activeLayerId} /></div>) }
] as const;
