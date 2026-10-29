/**
 * 历史页筛选工具栏与标题栏（change: improve-task-history-experience，任务 3.1/3.2/4.1/5.1）。
 *
 * 三层：紧凑标题/连接状态/刷新 → 状态 SegmentedControl → 常用筛选 + 高级筛选 + 已应用标签。
 * 草稿改变显示「尚未应用」；条件变化只改草稿，应用/Enter 一次提交。
 */
import type { TaskHistoryCandidateModel, TaskHistoryCandidateProvider, TaskHistoryCandidates, TaskModelType } from "@woohaa3/contracts";
import type { TaskHistoryConnectionStatus } from "../../shared/task-history/client.js";
import { SegmentedControl } from "@woohaa3/ui/primitives";
import { IconButton } from "@woohaa3/ui/primitives";
import { Tooltip } from "@woohaa3/ui/primitives";
import { CloseIcon, RefreshIcon } from "@woohaa3/ui/icons";
import { CONNECTION_LABELS, formatLocalTime } from "./history-format.js";
import { HISTORY_TIME_SHORTCUTS } from "./history-time.js";
import type { HistoryFilters, HistoryTab } from "./history-state.js";

const TABS: Array<{ id: HistoryTab; label: string }> = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "succeeded", label: "成功" },
  { id: "failed", label: "失败" },
  { id: "cancelled", label: "取消" }
];

export type HistoryToolbarProps = {
  draft: HistoryFilters;
  tab: HistoryTab;
  zone: string;
  connection: TaskHistoryConnectionStatus;
  candidates: TaskHistoryCandidates;
  appliedTags: Array<{ id: keyof HistoryFilters; label: string }>;
  draftDirty: boolean;
  rangeError: string | null;
  newTaskCount: number;
  refreshing: boolean;
  onTabChange: (tab: HistoryTab) => void;
  onDraftChange: (patch: Partial<HistoryFilters>) => void;
  onApplyDraft: () => void;
  onShortcut: (shortcut: (typeof HISTORY_TIME_SHORTCUTS)[number]) => void;
  onRemoveTag: (id: keyof HistoryFilters) => void;
  onClearAll: () => void;
  onRefresh: () => void;
  onGoLatest: () => void;
};

export function HistoryToolbar(props: HistoryToolbarProps) {
  const { draft } = props;
  return (
    <header className="task-history__header">
      <div className="task-history__titlebar">
        <h1>任务记录</h1>
        <div className="task-history__connection" data-connection={props.connection.state} role="status" aria-live="polite">
          <span className={`task-history__connection-dot is-${props.connection.state}`} aria-hidden="true" />
          <span>{CONNECTION_LABELS[props.connection.state]}</span>
          {props.connection.lastSyncedAt ? (
            <span className="task-history__connection-time">· 最近同步 {formatLocalTime(props.connection.lastSyncedAt)}</span>
          ) : null}
          {props.connection.error ? <span className="task-history__connection-error">{props.connection.error}</span> : null}
        </div>
        <Tooltip content="刷新当前页">
          <IconButton label="刷新" size="sm" onClick={props.onRefresh} loading={props.refreshing}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </div>

      <SegmentedControl
        className="task-history__tabs"
        optionClassName="task-history__tab"
        label="任务状态"
        value={props.tab}
        onValueChange={(next) => props.onTabChange(next as HistoryTab)}
        options={TABS.map((entry) => ({ value: entry.id, label: entry.label, ariaLabel: entry.label }))}
      />

      <div className="task-history__toolbar" role="group" aria-label="常用筛选">
        <input
          aria-label="Provider 筛选"
          list="task-history-providers"
          placeholder="Provider"
          value={draft.providerId}
          onChange={(event) => props.onDraftChange({ providerId: event.target.value })}
          onKeyDown={(event) => event.key === "Enter" && props.onApplyDraft()}
        />
        <datalist id="task-history-providers">
          {props.candidates.providers.map((provider: TaskHistoryCandidateProvider) => (
            <option key={provider.providerId} value={provider.providerId}>
              {provider.providerName ?? provider.providerId}
            </option>
          ))}
        </datalist>
        <input
          aria-label="模型筛选"
          list="task-history-models"
          placeholder="模型（modelKey）"
          value={draft.modelKey}
          onChange={(event) => props.onDraftChange({ modelKey: event.target.value })}
          onKeyDown={(event) => event.key === "Enter" && props.onApplyDraft()}
        />
        <datalist id="task-history-models">
          {props.candidates.models.map((model: TaskHistoryCandidateModel) => (
            <option key={`${model.providerId}/${model.modelKey}`} value={model.modelKey}>
              {model.modelTitle ?? model.modelKey}
            </option>
          ))}
        </datalist>
        <select
          aria-label="模型类型筛选"
          value={draft.modelType}
          onChange={(event) => props.onDraftChange({ modelType: event.target.value as "" | TaskModelType })}
        >
          <option value="">全部类型</option>
          <option value="language">文本</option>
          <option value="image">图片</option>
          <option value="video">视频</option>
          <option value="audio">音频</option>
        </select>
        <select
          aria-label="来源筛选"
          value={draft.source}
          onChange={(event) => props.onDraftChange({ source: event.target.value as "" | "canvas" | "extension" | "unknown" })}
        >
          <option value="">全部来源</option>
          <option value="canvas">画布</option>
          <option value="extension">插件</option>
          <option value="unknown">未知来源</option>
        </select>
        <input
          aria-label="插件筛选"
          list="task-history-plugins"
          placeholder="extensionId"
          value={draft.extensionId}
          onChange={(event) => props.onDraftChange({ extensionId: event.target.value })}
          onKeyDown={(event) => event.key === "Enter" && props.onApplyDraft()}
        />
        <datalist id="task-history-plugins">
          {props.candidates.plugins.map((plugin) => (
            <option key={plugin.extensionId} value={plugin.extensionId} />
          ))}
        </datalist>
        <div className="task-history__shortcuts" role="group" aria-label="时间快捷项">
          {HISTORY_TIME_SHORTCUTS.map((shortcut) => (
            <button key={shortcut.id} type="button" onClick={() => props.onShortcut(shortcut)}>
              {shortcut.label}
            </button>
          ))}
        </div>
        <button type="button" disabled={!props.draftDirty} onClick={props.onApplyDraft}>
          应用筛选
        </button>
      </div>

      <details className="task-history__advanced">
        <summary>高级筛选</summary>
        <div className="task-history__advanced-fields">
          <input aria-label="画布筛选" placeholder="canvasId" value={draft.canvasId} onChange={(event) => props.onDraftChange({ canvasId: event.target.value })} />
          <input aria-label="节点筛选" placeholder="nodeId" value={draft.nodeId} onChange={(event) => props.onDraftChange({ nodeId: event.target.value })} />
          <input aria-label="任务 Key 查找" placeholder="taskKey" value={draft.taskKey} onChange={(event) => props.onDraftChange({ taskKey: event.target.value })} />
          <label className="task-history__time">
            <span>起始（{props.zone}）</span>
            <input aria-label="起始时间" type="datetime-local" value={draft.from} onChange={(event) => props.onDraftChange({ from: event.target.value })} />
          </label>
          <label className="task-history__time">
            <span>结束（{props.zone}）</span>
            <input aria-label="结束时间" type="datetime-local" value={draft.to} onChange={(event) => props.onDraftChange({ to: event.target.value })} />
          </label>
        </div>
      </details>

      {props.appliedTags.length > 0 ? (
        <div className="task-history__chips" role="group" aria-label="已应用条件">
          {props.appliedTags.map((tag) => (
            <span key={tag.id} className="task-history__chip">
              <span>{tag.label}</span>
              <button type="button" aria-label={`删除条件：${tag.label}`} onClick={() => props.onRemoveTag(tag.id)}>
                <CloseIcon />
              </button>
            </span>
          ))}
          <button type="button" className="task-history__chip-clear" onClick={props.onClearAll}>
            清除全部
          </button>
        </div>
      ) : null}
      {props.draftDirty ? (
        <p className="task-history__dirty" role="status">
          当前修改尚未应用
        </p>
      ) : null}
      {props.rangeError ? (
        <p className="task-history__error" role="alert">
          {props.rangeError}
        </p>
      ) : null}
      {props.newTaskCount > 0 ? (
        <button type="button" className="task-history__new-tasks" onClick={props.onGoLatest}>
          有 {props.newTaskCount} 条新任务 · 回到最新
        </button>
      ) : null}
    </header>
  );
}
