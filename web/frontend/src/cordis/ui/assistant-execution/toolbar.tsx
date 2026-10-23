import type { ReactNode } from "react";
import { IconButton } from "../../../shared/ui/Button.js";
import { RefreshIcon, SettingsIcon } from "../../../shared/ui/icons.js";
import "./toolbar.css";

/** Every assistant entry keeps selection, parameters, refresh, management and submission in one row. */
export function AssistantToolbar({ assistant, parameters, submit, onRefresh, onManage, disabled, refreshing, notice }: {
  assistant?: ReactNode; parameters?: ReactNode; submit?: ReactNode; notice?: ReactNode;
  onRefresh?: () => void; onManage?: () => void; disabled?: boolean; refreshing?: boolean;
}) {
  return <div className="assistant-toolbar-group">
    <div className="assistant-toolbar">
      <div className="assistant-toolbar__selection">{assistant ?? <button type="button" className="assistant-toolbar__placeholder" disabled>选择助手</button>}</div>
      <div className="assistant-toolbar__parameters">{parameters ?? <button type="button" className="assistant-toolbar__placeholder" title="使用助手默认参数" disabled>默认参数</button>}</div>
      <IconButton label="刷新助手" title="刷新助手" size="sm" disabled={disabled || !onRefresh} loading={refreshing} onClick={onRefresh}><RefreshIcon size={16} /></IconButton>
      <IconButton label="管理助手" title="管理助手" size="sm" disabled={disabled || !onManage} onClick={onManage}><SettingsIcon size={16} /></IconButton>
      <div className="assistant-toolbar__submit">{submit}</div>
    </div>
    {notice}
  </div>;
}
