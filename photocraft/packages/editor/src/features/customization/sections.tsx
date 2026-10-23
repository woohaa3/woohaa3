import type { FeaturePanelContext } from "../panel-context.js";
import { WorkspaceCustomizationPanel } from "./panels.js";

/**
 * 高级面板里的工作区定制入口（U78）。
 *
 * 入口挂在「窗口」菜单（设计 D1 的操作与布局要求：窗口 → 工作区 / 工具栏 / 快捷键与命令搜索）。
 * 外壳的窗口菜单会渲染 `featureMenuSections("窗口")`，因此这里改菜单归属即可，不需要再改外壳。
 */
export const sections = [
  {
    id: "customization",
    order: 12,
    placement: "advanced",
    menu: "窗口",
    label: "工作区、快捷键与命令搜索…",
    menuOrder: 10,
    render: ({ controller, locked, applyPanelLayout }: FeaturePanelContext) => (
      <div key="customization" className="photo-editor__advanced-section" data-advanced-section="customization">
        {/* 共享样式表不为本域加一行隐藏规则；自带的这一条只在本面板渲染时生效。 */}
        <style>{
          '.photo-editor__advanced[data-feature]:not([data-feature="customization"]) > [data-advanced-section="customization"]{display:none}'
        }</style>
        {/* 外壳提供实时重排端口时，应用工作区立即生效；缺省退回写布局键并如实提示需重开。 */}
        <WorkspaceCustomizationPanel controller={controller} locked={locked} {...(applyPanelLayout ? { applyPanelLayout } : {})} />
      </div>
    )
  }
] as const;
