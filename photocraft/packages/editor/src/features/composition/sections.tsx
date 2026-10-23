import type { FeaturePanelContext } from "../panel-context.js";
import { ComposePanel, CompositionWorkflowPanel } from "./panels.js";

/**
 * 构图域只占一个装配槽位（`compose`）。
 *
 * 共享装配（`features/index.ts` 与 `features/boundaries.test.ts` 的槽位数）由集成负责人维护，
 * 所以裁剪/尺寸/裁边与变换/填充/照片合并/画板切片共用这一节：入口在面板内按分组切换，
 * 菜单里仍是一个「画布构图…」。
 */
export const sections = [
{ id: "compose", order: 6, placement: "advanced", menu: "图像", label: "画布构图…", menuOrder: 2, render: ({ controller, locked, documentView, panelRequest }: FeaturePanelContext) => (<div key="compose" className="photo-editor__advanced-section" data-advanced-section="compose"><ComposePanel key={panelRequest?.panel === "compose" ? panelRequest.sequence : "default"} initialCommand={panelRequest?.panel === "compose" ? panelRequest.command : undefined} controller={controller} readonly={locked} width={documentView?.width ?? 0} height={documentView?.height ?? 0} /><CompositionWorkflowPanel controller={controller} readonly={locked} groups={["transform", "fill", "photo", "structure"]} /></div>) }
] as const;
