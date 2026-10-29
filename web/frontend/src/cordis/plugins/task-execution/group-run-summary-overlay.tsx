/**
 * 分组批量执行结果摘要（change: 2026-10-16-add-group-selection-toolbar，任务 4.1 / design D6）。
 *
 * 非模态 DOM overlay，复用现有 `canvas-undo-toast` chrome。只表达**请求受理结果**
 * （已提交/跳过/失败），明确不是「生成完成」；跳过或失败非零时可展开查看成员与原因。
 *
 * 绑定起始 canvasId/groupId：同画布切换选择后保留，可手动关闭；新批替换旧摘要，切画布或页面
 * 释放由 store 清理。任务进度、取消与终态仍由成员活动与历史承载，本摘要不成为第二份任务状态源。
 */
import { useState, useSyncExternalStore } from "react";
import { CloseIcon } from "@woohaa3/ui/icons";
import type { GroupRunSummaryState, GroupRunSummaryStore } from "./group-run-actions.js";

export function GroupRunSummaryOverlay({ store }: { store: GroupRunSummaryStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [expanded, setExpanded] = useState(false);
  if (!state) return null;
  return (
    <GroupRunSummaryCard
      key={`${state.canvasId}:${state.summary.groupId}`}
      state={state}
      onDismiss={() => store.dismiss()}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    />
  );
}

function GroupRunSummaryCard(input: {
  state: GroupRunSummaryState;
  onDismiss: () => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { summary } = input.state;
  const accepted = summary.accepted.length;
  const skipped = summary.skipped.length;
  const failed = summary.failed.length;
  // 跳过/失败都可以说明原因；没有可展开项时不显示展开按钮。
  const hasDetails = skipped + failed > 0;
  return (
    <div className="canvas-undo-toast group-run-summary" role="status" data-testid="group-run-summary">
      <span className="canvas-undo-toast__text">
        已提交 {accepted} 项，跳过 {skipped} 项，失败 {failed} 项
      </span>
      {hasDetails ? (
        <button type="button" className="canvas-undo-toast__action" onClick={input.onToggle}>
          {input.expanded ? "收起原因" : "查看原因"}
        </button>
      ) : null}
      <button
        type="button"
        className="canvas-undo-toast__close"
        aria-label="关闭提交摘要"
        onClick={input.onDismiss}
      >
        <CloseIcon />
      </button>
      {input.expanded && hasDetails ? (
        <ul className="group-run-summary__details" data-testid="group-run-summary-details">
          {summary.failed.map((item) => (
            <li key={`failed:${item.nodeId}`} className="group-run-summary__detail">
              失败 · {item.nodeId}：{item.error}
            </li>
          ))}
          {skipped > 0 && accepted + failed === 0 ? (
            <li className="group-run-summary__detail group-run-summary__detail--headline">
              本批没有成员被受理。常见原因：成员均在运行中、缺少提示词或素材、模型不可用，或页面/权限已变化。
            </li>
          ) : null}
          {summary.skipped.map((item) => (
            <li key={`skipped:${item.nodeId}`} className="group-run-summary__detail">
              跳过 · {item.nodeId}：{item.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
