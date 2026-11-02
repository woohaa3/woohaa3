/**
 * 执行面板的「收成一条底边栏 / 展开」状态。
 *
 * 状态由**表面**持有（`execution-panel-surface.tsx` 的 `DockedBar`）：只有它知道面板此刻
 * 占多高、该怎么摆；面板内容（`ExecutionPanel` / `AuthoringGenerateLayout`）只消费它。
 *
 * 没有 provider 时是「不可折叠、已展开」——面板在单测、storybook、全屏面里单独渲染时保持原样，
 * 也不会冒出一颗点了没反应的收起按钮。
 */
import { createContext, useContext, type ReactNode } from "react";

export type PanelCollapse = {
  /** 当前表面支持折叠（由底边栏提供）。为 `false` 时面板不渲染收起按钮。 */
  collapsible: boolean;
  /** 当前收成一条底边栏。 */
  collapsed: boolean;
  /** 展开成完整面板。 */
  expand: () => void;
  /** 收成一条底边栏。 */
  collapse: () => void;
};

const EXPANDED: PanelCollapse = {
  collapsible: false,
  collapsed: false,
  expand: () => undefined,
  collapse: () => undefined,
};

const PanelCollapseContext = createContext<PanelCollapse>(EXPANDED);

export function PanelCollapseProvider({ value, children }: { value: PanelCollapse; children: ReactNode }) {
  return <PanelCollapseContext.Provider value={value}>{children}</PanelCollapseContext.Provider>;
}

export function usePanelCollapse(): PanelCollapse {
  return useContext(PanelCollapseContext);
}
