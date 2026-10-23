import type { FeaturePanelContext } from "../panel-context.js";
import { ViewWorkspacePanel } from "./panels.js";

/**
 * 本域的高级面板入口（菜单「视图 → 视图导航、参考线与分析…」）。
 *
 * 子面板（辅助/参考线/布局/导航/Info/计数/注释）由面板内部页签分组，避免为每个 U 组新增
 * section id——section id 需要同步共享 CSS 的 `data-feature` 门，那是跨域文件。
 */
export const sections = [
  {
    id: "viewAids",
    order: 7,
    placement: "advanced",
    menu: "视图",
    label: "视图导航、参考线与分析…",
    menuOrder: 0,
    render: ({ controller, locked, updateAids, documentView }: FeaturePanelContext) => (
      <div key="viewAids" className="photo-editor__advanced-section" data-advanced-section="viewAids">
        <ViewWorkspacePanel
          controller={controller}
          readonly={locked}
          revision={documentView?.revision ?? 0}
          onChanged={updateAids}
        />
      </div>
    )
  }
] as const;

/** 菜单项标签（与 section id 同源；宿主按 id 打开对应面板）。 */
export const viewMenuEntries = sections.map((section) => ({ id: section.id, label: section.label, menuOrder: section.menuOrder }));
