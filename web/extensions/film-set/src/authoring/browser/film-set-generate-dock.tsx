import type { ReactNode } from "react";
import { Button, IconButton } from "@woohaa3/ui/primitives";
import { ChevronDownIcon } from "@woohaa3/ui/icons";

/** 收起只隐藏内容，保留宿主生成面板的草稿、连接、模型选择与运行状态。 */
export function FilmSetGenerateDock({ hidden, collapsed, onCollapsedChange, shotName, selectedItem, targetItemId, onTargetChange, children }: {
  hidden: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  shotName: string;
  selectedItem: { id: string; name: string } | null;
  targetItemId: string | null;
  onTargetChange: (itemId: string | null) => void;
  children: ReactNode;
}) {
  return <div className="film-set-generate-dock" hidden={hidden}
    onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    {collapsed ? <Button className="film-set-generate-restore" onClick={() => onCollapsedChange(false)}>AI 修改</Button> : null}
    <div className="film-set-generate-dock__expanded" hidden={collapsed}>
      <div className="film-set-generate-dock__heading">
        <span className="film-set-generate-dock__title">AI 修改</span>
        <span className="film-set-generate-dock__shot" title={shotName}>{shotName}</span>
        {selectedItem ? <select className="film-set-generate-dock__target" aria-label="AI 修改目标"
          value={targetItemId ?? ""} onChange={event => onTargetChange(event.target.value || null)}>
          <option value="">整个镜头</option>
          <option value={selectedItem.id}>{selectedItem.name}</option>
        </select> : <span className="film-set-generate-dock__scope">整个镜头</span>}
        <IconButton label="收起 AI 修改" size="sm" tone="ghost" onClick={() => onCollapsedChange(true)}><ChevronDownIcon size={16} /></IconButton>
      </div>
      {children}
    </div>
  </div>;
}
