import type { FeaturePanelContext } from "../panel-context.js";
import { OpenTypePanel, StyleLibraryPanel, TextEffectsPanel, TextToolsPanel, TypographyPanel } from "./panels.js";

/** 单一「字符与段落」入口：五个面板共用同一文字图层选择，保持高级区段落数不变。 */
export const sections = [
{ id: "typography", order: 10, placement: "advanced", menu: "文字", label: "字符与段落…", menuOrder: 0, render: ({ controller, locked, activeLayer, activeLayerId }: FeaturePanelContext) => (<div key="typography" className="photo-editor__advanced-section" data-advanced-section="typography">{activeLayer?.kind === "text" ? <>{activeLayer.effectiveLocks?.all ? <p className="photo-editor__brush-note" data-type-locked="true">该文字图层已全部锁定：排版、OpenType、变形与转换入口已禁用，解锁后可继续。</p> : null}<TypographyPanel controller={controller} readonly={locked} layer={activeLayerId} locked={activeLayer.effectiveLocks?.all ?? false} /><StyleLibraryPanel controller={controller} readonly={locked} layer={activeLayerId} /><OpenTypePanel controller={controller} readonly={locked} layer={activeLayerId} locked={activeLayer.effectiveLocks?.all ?? false} /><TextEffectsPanel controller={controller} readonly={locked} layer={activeLayerId} locked={activeLayer.effectiveLocks?.all ?? false} /><TextToolsPanel controller={controller} readonly={locked} layer={activeLayerId} locked={activeLayer.effectiveLocks?.all ?? false} /></> : <p>选择文字图层，或在画布上单击创建文字。</p>}</div>) }
] as const;
