import type { FeaturePanelContext } from "../panel-context.js";
import { ApplyImagePanel, CalculationsPanel, ChannelPanel } from "./panels.js";

/**
 * 通道入口挂在「图像」菜单，顺序排在调整（0）、画布构图（2）之后。
 *
 * 面板复用既有「高级工具」区块：菜单打开对应 section，`data-advanced-section` 与
 * `photo-editor.css` 的可见性规则一一对应（本 change 已补三行 channel/applyImage/calculations）。
 */
export const sections = [
  {
    id: "channels",
    order: 12,
    placement: "advanced",
    menu: "窗口",
    label: "通道…",
    menuOrder: 3,
    render: ({ controller, locked, documentView, refreshPreview }: FeaturePanelContext) => (
      <div key="channels" className="photo-editor__advanced-section" data-advanced-section="channels">
        <ChannelPanel controller={controller} readonly={locked} revision={documentView?.revision ?? 0} hasSelection={documentView?.hasSelection ?? false} onChanged={refreshPreview} />
      </div>
    )
  },
  {
    id: "applyImage",
    order: 13,
    placement: "advanced",
    menu: "图像",
    label: "应用图像…",
    menuOrder: 4,
    render: ({ controller, locked, documentView, refreshPreview }: FeaturePanelContext) => (
      <div key="applyImage" className="photo-editor__advanced-section" data-advanced-section="applyImage">
        <ApplyImagePanel controller={controller} readonly={locked} revision={documentView?.revision ?? 0} onChanged={refreshPreview} />
      </div>
    )
  },
  {
    id: "calculations",
    order: 14,
    placement: "advanced",
    menu: "图像",
    label: "计算…",
    menuOrder: 5,
    render: ({ controller, locked, documentView, refreshPreview }: FeaturePanelContext) => (
      <div key="calculations" className="photo-editor__advanced-section" data-advanced-section="calculations">
        <CalculationsPanel controller={controller} readonly={locked} revision={documentView?.revision ?? 0} onChanged={refreshPreview} />
      </div>
    )
  }
] as const;
