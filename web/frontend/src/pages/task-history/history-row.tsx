/**
 * 历史列表行与结果摘要（change: improve-task-history-experience，任务 4.2/4.3）。
 *
 * 列表以任务为中心：类型/模型名 + 次级 Provider、执行时来源、状态文字+图形、成功类型化
 * 摘要/失败安全错误、突出耗时与创建时间、明确主操作与独立定位动作。行操作不冒泡误触。
 */
import type { ComponentType } from "react";
import { isTerminalTaskState, type TaskModelType } from "@woohaa3/contracts";
import { Button } from "../../shared/ui/Button.js";
import { FileImageIcon, FileTextIcon, FilmIcon, ImageIcon, MusicIcon } from "../../shared/ui/icons.js";
import { CopyField, TaskStateBadge } from "./history-detail.js";
import { formatDuration, formatLocalTime, formatRelative, sourceLabel } from "./history-format.js";
import type { HistoryRow } from "./history-state.js";

const MODEL_TYPE_ICON: Record<TaskModelType, ComponentType<{ className?: string }>> = {
  language: FileTextIcon,
  image: ImageIcon,
  video: FilmIcon,
  audio: MusicIcon
};

export function HistoryRowView({
  row,
  selected,
  onOpen,
  onOpenCanvas,
  onCopy,
  resolveMediaUrl
}: {
  row: HistoryRow;
  selected: boolean;
  onOpen: () => void;
  onOpenCanvas?: (input: { canvasId: string; nodeId: string }) => void;
  onCopy: (value: string) => Promise<boolean | void>;
  resolveMediaUrl: (storageKey: string, canvasId?: string) => string;
}) {
  const TypeIcon = row.modelType ? MODEL_TYPE_ICON[row.modelType] : FileImageIcon;
  const canOpenCanvas = Boolean(onOpenCanvas && row.canvasId && row.nodeId);
  return (
    <tr data-task-key={row.taskKey} data-state={row.state} data-selected={selected || undefined} data-unmatched={row.unmatched || undefined}>
      <td className="task-history__cell-task">
        <TypeIcon className="task-history__type-icon" />
        <button type="button" className="task-history__task-open" onClick={onOpen}>
          <span className="task-history__model-title">{row.modelTitle ?? row.modelKey ?? "未命名模型"}</span>
          <span className="task-history__model-meta">
            {row.providerName ?? row.providerId}
            {row.attempt !== undefined && row.attempt > 1 ? ` · 尝试 ${row.attempt} 次` : ""}
          </span>
        </button>
        <CopyField value={row.taskKey} label="任务 ID" copyText={onCopy} className="task-history__id" />
      </td>
      <td className="task-history__cell-source is-wrap">
        {row.source === "extension" ? (
          <>
            <span>插件</span>
            {row.extensionId ? <span className="task-history__sub">{row.extensionId}</span> : null}
          </>
        ) : row.canvasId ? (
          <>
            <span>{row.canvasTitle ?? row.canvasId}</span>
            {row.nodeId ? <span className="task-history__sub">{row.nodeTitle ?? row.nodeId}</span> : null}
          </>
        ) : row.source === "canvas" ? (
          <span>{row.canvasTitle ?? "画布任务"}</span>
        ) : (
          <span className="task-history__muted">{sourceLabel(row.source)}</span>
        )}
        {row.unmatched ? <span className="task-history__badge">已不匹配当前查询</span> : null}
      </td>
      <td>
        <TaskStateBadge state={row.state} />
        {row.state === "running" ? (
          row.progress !== undefined && Number.isFinite(row.progress) ? (
            <progress className="task-history__progress" max={1} value={Math.max(0, Math.min(1, row.progress))} aria-label="执行进度" />
          ) : (
            <span className="task-history__muted">阶段未知</span>
          )
        ) : null}
      </td>
      <td className="task-history__cell-result">
        <ResultSummaryCell row={row} resolveMediaUrl={resolveMediaUrl} />
      </td>
      <td className="task-history__cell-time">
        <time dateTime={row.createdAt} title={formatLocalTime(row.createdAt)}>
          {formatRelative(row.createdAt)}
        </time>
        <span className="task-history__sub">耗时 {formatDuration(row.durationMs)}</span>
      </td>
      <td className="task-history__cell-actions">
        <Button size="sm" onClick={onOpen} aria-label={`查看任务 ${row.taskKey} 详情`}>
          详情
        </Button>
        <Button
          size="sm"
          tone="ghost"
          disabled={!canOpenCanvas}
          onClick={() => row.canvasId && row.nodeId && onOpenCanvas?.({ canvasId: row.canvasId, nodeId: row.nodeId })}
        >
          打开画布
        </Button>
        {!canOpenCanvas ? (
          <span className="task-history__jump-reason" data-jump-reason={row.canvasId ? "missing-node" : "missing-canvas"}>
            不可跳转：{row.canvasId ? "缺少节点" : "缺少画布"}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

/** 结果/异常摘要：成功显示类型化摘要，失败显示一行安全错误，运行中显示进度，取消不伪造产物。 */
function ResultSummaryCell({ row, resolveMediaUrl }: { row: HistoryRow; resolveMediaUrl: (key: string, canvasId?: string) => string }) {
  if (row.state === "failed" && row.error) {
    return (
      <span className="task-history__error-summary" title={row.error.message}>
        {row.error.name ? `${row.error.name}: ` : ""}
        {row.error.message}
      </span>
    );
  }
  if (row.state === "cancelled") return <span className="task-history__muted">已取消</span>;
  if (!isTerminalTaskState(row.state)) {
    return <span className="task-history__muted">{row.progress !== undefined ? `${Math.round(row.progress * 100)}%` : "进行中"}</span>;
  }
  if (!row.result) return <span className="task-history__muted">无结果</span>;
  if (row.result.mediaKind === "image" && row.result.storageKey) {
    return (
      <span className="task-history__thumb">
        <img src={resolveMediaUrl(row.result.storageKey, row.canvasId)} alt="结果缩略图" loading="lazy" />
      </span>
    );
  }
  if (row.result.mediaKind === "video") {
    return (
      <span className="task-history__muted">
        <FilmIcon className="task-history__result-icon" /> 视频
        {row.result.durationSeconds !== undefined ? ` · ${row.result.durationSeconds}s` : ""}
      </span>
    );
  }
  if (row.result.mediaKind === "audio") {
    return (
      <span className="task-history__muted">
        <MusicIcon className="task-history__result-icon" /> 音频
        {row.result.durationSeconds !== undefined ? ` · ${row.result.durationSeconds}s` : ""}
      </span>
    );
  }
  return (
    <span className="task-history__muted task-history__result-text" title={row.result.text}>
      {row.result.text ?? "文本结果"}
      {row.result.textTruncated ? "（已截断）" : ""}
    </span>
  );
}
