/**
 * 画布撤销/重做工具按钮（change: 2026-10-09-improve-canvas-workflow，任务 1.7）。
 *
 * 主画布工具区提供撤销/重做图标动作，与快捷键 Ctrl/⌘+Z、Ctrl/⌘+Shift+Z（Windows/Linux 另支持
 * Ctrl+Y）行为一致。无记录时禁用并给出可读原因（pending/只读/冲突）。
 *
 * 作为 `canvas.toolbar` contribution 渲染（订阅 edit 快照，因此禁用态随记录变化实时更新）。
 */
import { useSyncExternalStore } from "react";
import type { CanvasEditService, CanvasEditSnapshot } from "../../services/canvas-state/index.js";
import { RedoIcon, UndoIcon } from "@woohaa3/ui/icons";

export function useCanvasEditSnapshot(edit: CanvasEditService): CanvasEditSnapshot {
  return useSyncExternalStore(
    (listener) => edit.subscribe(() => listener()),
    () => edit.getSnapshot(),
    () => edit.getSnapshot()
  );
}

export function CanvasUndoControls({ edit }: { edit: CanvasEditService }) {
  const snapshot = useCanvasEditSnapshot(edit);
  const undoLabel = snapshot.canUndo
    ? `撤销${snapshot.undoLabel ? `：${snapshot.undoLabel}` : ""}`
    : "没有可撤销的操作";
  const redoLabel = snapshot.canRedo
    ? `重做${snapshot.redoLabel ? `：${snapshot.redoLabel}` : ""}`
    : "没有可重做的操作";
  return (
    <div className="canvas-undo-controls" role="group" aria-label="撤销与重做">
      <button
        type="button"
        className="canvas-undo-controls__button"
        aria-label={undoLabel}
        title={undoLabel}
        disabled={!snapshot.canUndo}
        onClick={() => void edit.undo()}
      >
        <UndoIcon className="canvas-undo-controls__icon" />
      </button>
      <button
        type="button"
        className="canvas-undo-controls__button"
        aria-label={redoLabel}
        title={redoLabel}
        disabled={!snapshot.canRedo}
        onClick={() => void edit.redo()}
      >
        <RedoIcon className="canvas-undo-controls__icon" />
      </button>
    </div>
  );
}
