import type { FeaturePanelContext } from "../panel-context.js";
import { ActionsPanel, AutomationPanel, DataSetsPanel, HistoryPanel } from "./panels.js";

/**
 * 历史/动作/数据驱动域的入口
 * （change: 2026-10-22-add-photocraft-history-automation-workflows）。
 *
 * `placement: "advanced"`：四个面板都由共享高级区域渲染，和调色、滤镜、视图辅助一致，
 * 不需要改共享外壳。共享区域会同时挂载全部 section；点击菜单项时 `photo-editor-app.tsx`
 * 会滚动到对应 `data-advanced-section`，因此面板不必自己隐藏。
 *
 * `menu` 反映 Photoshop 的分组：历史记录/动作/变量在「窗口」，自动处理在「文件」。
 * 共享 `photo-editor-chrome.tsx` 的「窗口」下拉（显示开关之后、文档清单之前）与「文件」下拉
 * 都调用 `featureMenuSections`，因此这四个 section 同时出现在菜单与高级区域；点击菜单项时
 * `photo-editor-app.tsx` 会滚动到对应 `data-advanced-section`。
 *
 * `order` 用 13 起：12 留给动画域时间轴（同级 change），避免两个分支合入后顺序抖动。
 */
export const sections = [
  {
    id: "history",
    order: 13,
    placement: "advanced",
    menu: "窗口",
    label: "历史记录…",
    menuOrder: 0,
    render: ({ controller, locked, refreshPreview }: FeaturePanelContext) => (
      <div key="history" className="photo-editor__advanced-section" data-advanced-section="history">
        <HistoryPanel controller={controller} readonly={locked} onChanged={refreshPreview} />
      </div>
    )
  },
  {
    id: "actions",
    order: 14,
    placement: "advanced",
    menu: "窗口",
    label: "动作…",
    menuOrder: 1,
    render: ({ controller, locked, refreshPreview }: FeaturePanelContext) => (
      <div key="actions" className="photo-editor__advanced-section" data-advanced-section="actions">
        <ActionsPanel controller={controller} readonly={locked} onChanged={refreshPreview} />
      </div>
    )
  },
  {
    id: "dataSets",
    order: 15,
    placement: "advanced",
    menu: "窗口",
    label: "变量与数据集…",
    menuOrder: 2,
    render: ({ controller, locked, refreshPreview }: FeaturePanelContext) => (
      <div key="dataSets" className="photo-editor__advanced-section" data-advanced-section="dataSets">
        <DataSetsPanel controller={controller} readonly={locked} onChanged={refreshPreview} />
      </div>
    )
  },
  {
    id: "automation",
    order: 16,
    placement: "advanced",
    menu: "文件",
    label: "自动处理…",
    menuOrder: 0,
    render: ({ controller, locked }: FeaturePanelContext) => (
      <div key="automation" className="photo-editor__advanced-section" data-advanced-section="automation">
        <AutomationPanel controller={controller} readonly={locked} />
      </div>
    )
  }
] as const;
