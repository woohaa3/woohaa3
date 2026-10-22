/**
 * task-monitor 列表与筛选栏展示组件
 * （自 `task-monitor.tsx` 拆出，change: 2026-10-13-add-enterprise-access-and-production-deployment，
 *  规模门禁 ≤500 行；任务 8.4/8.7 / design D11）。
 *
 * 全局状态计数、筛选工具栏（草稿输入不触发查询，应用/Enter 一次提交）与原生语义表格。
 */
import { useState } from "react";
import { isTerminalTaskState, type TaskExecutionState, type TaskInspectionSnapshot } from "@woohaa3/contracts";
import { Button } from "../../shared/ui/index.js";
import { CloseIcon } from "../../shared/ui/index.js";
import { TIME_SHORTCUTS, effectiveTotalMs, formatDuration, formatLocalTime, actorLabel, isoToLocalDateTime, localDateTimeToIso, localTimeZoneName, shortcutRange, sourceLabel, stateLabel, type TimeShortcut } from "./format.js";
import type { DraftState } from "./monitor-model.js";

/** 全局状态计数（来自全局聚合，不是当前页行数）。 */
export function StateCounts({
  counts,
  active,
  onSelect
}: {
  counts: Record<TaskExecutionState, number> | undefined;
  active: string;
  onSelect: (state: TaskExecutionState) => void;
}) {
  const entries: TaskExecutionState[] = ["queued", "pending", "running", "succeeded", "failed", "cancelled"];
  return (
    <div className="task-monitor__counts" aria-label="全局状态计数">
      {entries.map((state) => (
        <button
          key={state}
          type="button"
          className={`task-monitor__count is-${state}${active === state ? " is-active" : ""}`}
          aria-pressed={active === state}
          onClick={() => onSelect(state)}
        >
          <span className="task-monitor__count-value">{counts ? (counts[state] ?? 0) : "—"}</span>
          <span className="task-monitor__count-label">{stateLabel(state)}</span>
        </button>
      ))}
    </div>
  );
}

/** 筛选工具栏：草稿输入不触发查询；应用/Enter 一次提交并回到第一页。 */
export function Toolbar({
  draft,
  draftDirty,
  onDraft,
  onApply,
  onClearAll,
  appliedTags,
  onRemoveTag
}: {
  draft: DraftState;
  draftDirty: boolean;
  onDraft: (next: Partial<DraftState>) => void;
  onApply: () => void;
  onClearAll: () => void;
  appliedTags: Array<{ key: keyof DraftState; label: string }>;
  onRemoveTag: (key: keyof DraftState) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const applyShortcut = (shortcut: TimeShortcut) => {
    const range = shortcutRange(shortcut);
    onDraft({ from: range.from, to: range.to });
  };
  return (
    <div className="task-monitor__toolbar">
      <div className="task-monitor__toolbar-row">
        <label className="task-monitor__field">
          <span>使用人</span>
          <input
            type="search"
            value={draft.providerId}
            placeholder="Provider"
            aria-label="按 Provider 筛选"
            onChange={(event) => onDraft({ providerId: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) onApply();
            }}
          />
        </label>
        <label className="task-monitor__field">
          <span>状态</span>
          <select value={draft.state} aria-label="按状态筛选" onChange={(event) => onDraft({ state: event.target.value })}>
            <option value="">全部</option>
            {(["queued", "pending", "running", "succeeded", "failed", "cancelled"] as const).map((state) => (
              <option key={state} value={state}>
                {stateLabel(state)}
              </option>
            ))}
          </select>
        </label>
        <label className="task-monitor__field">
          <span>来源</span>
          <select value={draft.source} aria-label="按来源筛选" onChange={(event) => onDraft({ source: event.target.value })}>
            <option value="">全部</option>
            <option value="canvas">画布</option>
            <option value="extension">插件</option>
            <option value="unknown">未知来源</option>
          </select>
        </label>
        <div className="task-monitor__toolbar-spacer" />
        <Button tone="primary" onClick={onApply}>
          应用
        </Button>
        <Button tone="ghost" onClick={onClearAll} disabled={appliedTags.length === 0}>
          清除
        </Button>
        <Button tone="ghost" onClick={() => setAdvancedOpen((value) => !value)} aria-expanded={advancedOpen}>
          高级筛选
        </Button>
      </div>

      {advancedOpen ? (
        <div className="task-monitor__toolbar-row task-monitor__toolbar-row--advanced">
          <label className="task-monitor__field">
            <span>模型类型</span>
            <select value={draft.modelType} aria-label="按模型类型筛选" onChange={(event) => onDraft({ modelType: event.target.value })}>
              <option value="">全部</option>
              <option value="language">语言</option>
              <option value="image">图片</option>
              <option value="video">视频</option>
              <option value="audio">音频</option>
            </select>
          </label>
          <label className="task-monitor__field">
            <span>模型</span>
            <input type="text" value={draft.modelKey} aria-label="按模型筛选" onChange={(event) => onDraft({ modelKey: event.target.value })} />
          </label>
          <label className="task-monitor__field">
            <span>插件</span>
            <input type="text" value={draft.extensionId} aria-label="按插件筛选" onChange={(event) => onDraft({ extensionId: event.target.value })} />
          </label>
          <label className="task-monitor__field">
            <span>画布</span>
            <input type="text" value={draft.canvasId} aria-label="按画布筛选" onChange={(event) => onDraft({ canvasId: event.target.value })} />
          </label>
          <label className="task-monitor__field">
            <span>节点</span>
            <input type="text" value={draft.nodeId} aria-label="按节点筛选" onChange={(event) => onDraft({ nodeId: event.target.value })} />
          </label>
          <label className="task-monitor__field">
            <span>任务 key</span>
            <input type="text" value={draft.taskKey} aria-label="按 taskKey 筛选" onChange={(event) => onDraft({ taskKey: event.target.value })} />
          </label>
          <div className="task-monitor__time">
            <span>时间（{localTimeZoneName()}）</span>
            <div className="task-monitor__time-shortcuts">
              {TIME_SHORTCUTS.map((shortcut) => (
                <Button key={shortcut.id} size="sm" tone="ghost" onClick={() => applyShortcut(shortcut)}>
                  {shortcut.label}
                </Button>
              ))}
            </div>
            <label className="task-monitor__field">
              <span>起始</span>
              <input
                type="datetime-local"
                value={isoToLocalDateTime(draft.from)}
                aria-label="起始时间"
                onChange={(event) => onDraft({ from: localDateTimeToIso(event.target.value) ?? "" })}
              />
            </label>
            <label className="task-monitor__field">
              <span>结束</span>
              <input
                type="datetime-local"
                value={isoToLocalDateTime(draft.to)}
                aria-label="结束时间"
                onChange={(event) => onDraft({ to: localDateTimeToIso(event.target.value) ?? "" })}
              />
            </label>
          </div>
        </div>
      ) : null}

      {appliedTags.length > 0 ? (
        <ul className="task-monitor__tags" aria-label="已应用条件">
          {appliedTags.map((tag) => (
            <li key={tag.key}>
              <button type="button" onClick={() => onRemoveTag(tag.key)} aria-label={`移除条件 ${tag.label}`}>
                {tag.label}
                <CloseIcon aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {draftDirty ? (
        <p className="task-monitor__dirty" role="status">
          当前修改尚未应用
        </p>
      ) : null}
    </div>
  );
}

/**
 * 原生语义表格（不使用无键盘契约的 grid）；行提供可聚焦的「查看详情」主操作。
 *
 * 仅有 `canvasId` 的行额外提供「在画布中打开」——用户反馈「没有地方快速回到我们的画布」，
 * 行内入口不要求先打开详情；`nodeId` 存在时一并带给画布做定位（见 page scope 的节点目标）。
 */
export function TaskTable({
  items,
  selectedTaskKey,
  nowMs,
  onSelect,
  onOpenCanvas
}: {
  items: TaskInspectionSnapshot["items"];
  selectedTaskKey?: string;
  nowMs: number;
  onSelect: (taskKey: string) => void;
  onOpenCanvas?: (input: { canvasId: string; nodeId?: string }) => void;
}) {
  return (
    <div className="task-monitor__list" data-testid="task-monitor-list">
      <table className="task-monitor__table">
        <caption className="visually-hidden">任务列表</caption>
        <thead>
          <tr>
            <th scope="col">任务 / 模型</th>
            <th scope="col">状态</th>
            <th scope="col">使用人</th>
            <th scope="col">来源</th>
            <th scope="col">耗时</th>
            <th scope="col">创建时间</th>
            <th scope="col"><span className="visually-hidden">操作</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const selected = item.taskKey === selectedTaskKey;
            const totalMs = effectiveTotalMs(item.timing, item.state, nowMs);
            const canvasId = item.canvasId;
            return (
              <tr key={item.taskKey} className={selected ? "is-selected" : undefined} aria-selected={selected}>
                <td>
                  <span className="task-monitor__model">{item.modelTitle ?? item.modelKey ?? item.taskKey}</span>
                  <span className="task-monitor__secondary">
                    {item.providerName ?? item.providerId}
                    {item.attempt !== undefined && item.attempt > 1 ? ` · 第 ${item.attempt} 次` : ""}
                  </span>
                  {item.error && item.state === "failed" ? <span className="task-monitor__error-inline">{item.error.message}</span> : null}
                  {item.result && item.state === "succeeded" ? (
                    <span className="task-monitor__secondary">
                      结果：{item.result.mediaKind === "text" ? "文本" : item.result.mediaKind === "image" ? "图片" : item.result.mediaKind === "video" ? "视频" : "音频"}
                    </span>
                  ) : null}
                </td>
                <td>
                  <StateBadge state={item.state} progress={item.progress} />
                </td>
                <td>{actorLabel(item.actor)}</td>
                <td>{sourceLabel(item.source)}{item.extensionId ? ` · ${item.extensionId}` : ""}</td>
                <td>{formatDuration(totalMs)}</td>
                <td>{formatLocalTime(item.createdAt)}</td>
                <td className="task-monitor__cell-actions">
                  <Button size="sm" tone="ghost" onClick={() => onSelect(item.taskKey)} aria-label={`查看详情 ${item.taskKey}`}>
                    查看详情
                  </Button>
                  {canvasId && onOpenCanvas ? (
                    <>
                      {/* 两个 ghost 按钮相邻：保留一个文本空格作为行内间隔（不新增容器/样式）。 */}
                      {" "}
                      <Button
                        size="sm"
                        tone="ghost"
                        onClick={() => onOpenCanvas({ canvasId, ...(item.nodeId ? { nodeId: item.nodeId } : {}) })}
                        aria-label={`在画布中打开 ${item.taskKey}`}
                      >
                        在画布中打开
                      </Button>
                    </>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function StateBadge({ state, progress }: { state: TaskExecutionState; progress?: number }) {
  return (
    <span className={`task-monitor__state is-${state}`} data-state={state}>
      <span className="task-monitor__state-glyph" aria-hidden="true" />
      {stateLabel(state)}
      {!isTerminalTaskState(state) && progress !== undefined ? ` ${Math.round(progress * 100)}%` : ""}
    </span>
  );
}

export function neighbour(items: TaskInspectionSnapshot["items"], taskKey: string | undefined, delta: number): string | undefined {
  if (!taskKey) return undefined;
  const index = items.findIndex((item) => item.taskKey === taskKey);
  if (index < 0) return undefined;
  return items[index + delta]?.taskKey;
}
