/**
 * 并排双视图的画布容器（U72）。
 *
 * 只负责布局与**输入归属**：把每个视图渲染成一块真实画布，并标出谁是活动视图。谁接收像素/
 * 工具输入由调用方传给 `renderPane` 的 `active` 决定——非活动窗格在按下时只做一次「激活」，
 * 并且**吞掉这次按下**，因此不会出现「一次点击既切视图又画一笔」。
 *
 * 取景、内容、历史都不在这里：内容与历史来自同一个控制器，取景由调用方按视图给出。
 */

import type { ReactNode } from "react";
import type { CanvasPane } from "./panes.js";

export function ViewPanes({
  panes,
  renderPane,
  onActivate,
}: {
  panes: readonly CanvasPane[];
  /** 渲染一块画布；`active` 为真表示它是当前接收输入的那个视图。 */
  renderPane: (pane: CanvasPane, active: boolean) => ReactNode;
  /** 点击非活动窗格：切换输入归属（不改文档、不落笔）。 */
  onActivate: (viewId: string) => void;
}) {
  return (
    <div className="photo-editor__panes" data-view-panes="true">
      {panes.map((pane) => (
        <div
          key={pane.id}
          className="photo-editor__pane"
          data-view-pane={pane.id}
          data-view-pane-active={pane.active ? "true" : undefined}
          // 只在非活动时接管这次按下：活动窗格必须原样把指针交给画布，否则第一笔会被吞。
          onPointerDownCapture={pane.active ? undefined : (event) => {
            event.preventDefault();
            event.stopPropagation();
            onActivate(pane.id);
          }}
        >
          <header className="photo-editor__pane-label">
            {pane.label}
            {pane.active ? " · 活动" : " · 点击激活"}
          </header>
          <div className="photo-editor__pane-canvas">{renderPane(pane, pane.active)}</div>
        </div>
      ))}
    </div>
  );
}
