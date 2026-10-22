/**
 * 删除后的撤销提示（change: 2026-10-09-improve-canvas-workflow，任务 1.7）。
 *
 * 确认删除后显示「已删除 N 个作品 · 撤销」；提示按钮绑定具体动作身份（entryId），
 * 仅当该动作仍是可撤销栈顶时才启用——避免点击旧提示撤销了后来动作。
 * 提示可暂时关闭，但记录仍在 journal 中，用户仍可通过主画布撤销入口操作。
 */
import { useEffect, useState } from "react";
import { useSyncExternalStore } from "react";
import type { CanvasEditService, CanvasEditSnapshot } from "../../services/canvas-state/index.js";
import { CloseIcon } from "../../../shared/ui/icons.js";

export function CanvasUndoToast({ edit }: { edit: CanvasEditService }) {
  const snapshot = useSyncExternalStore(
    (listener) => edit.subscribe(() => listener()),
    () => edit.getSnapshot(),
    () => edit.getSnapshot()
  );
  const [dismissedEntryId, setDismissedEntryId] = useState<string | null>(null);

  const last = snapshot.lastAction;
  const visible = last?.kind === "delete" && snapshot.canUndo && last.entryId !== dismissedEntryId;

  // 新删除动作到达时重新显示（旧提示关闭不影响）。
  useEffect(() => {
    if (last?.kind === "delete" && last.entryId !== dismissedEntryId) {
      // 新动作：清除旧的关闭标记。
      if (dismissedEntryId !== null && last.entryId !== dismissedEntryId) setDismissedEntryId(null);
    }
  }, [last?.entryId, last?.kind, dismissedEntryId]);

  if (!visible || !last) return null;

  return (
    <div className="canvas-undo-toast" role="status" data-testid="canvas-undo-toast">
      <span className="canvas-undo-toast__text">已{last.label}，可撤销</span>
      <button
        type="button"
        className="canvas-undo-toast__action"
        data-testid="canvas-undo-toast-action"
        onClick={() => void edit.undo()}
      >
        撤销
      </button>
      <button
        type="button"
        className="canvas-undo-toast__close"
        aria-label="关闭撤销提示"
        onClick={() => setDismissedEntryId(last.entryId)}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

export type { CanvasEditSnapshot };
