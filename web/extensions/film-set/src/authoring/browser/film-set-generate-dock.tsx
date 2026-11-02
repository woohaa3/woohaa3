import type { ReactNode } from "react";

/** 收起只隐藏内容，保留宿主生成面板的草稿、连接、模型选择与运行状态。 */
export function FilmSetGenerateDock({ hidden, collapsed, children }: {
  hidden: boolean;
  collapsed: boolean;
  children: ReactNode;
}) {
  return <section className="film-set-generate-dock" hidden={hidden || collapsed}
    onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <div className="film-set-generate-dock__expanded" hidden={collapsed}>{children}</div>
  </section>;
}
