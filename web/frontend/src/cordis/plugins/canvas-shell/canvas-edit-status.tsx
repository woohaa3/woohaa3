/**
 * 每条编辑记录的等待/冲突状态（change: 2026-11-06-nonblocking-canvas-edit-history，任务 4.2）。
 *
 * 取代原先「正在结算上一次操作，请稍候」的全局阻断：
 * - pending/unknown：显示还有多少条动作在等待保存/对账，不拦截后续操作；
 * - conflict：逐条显示失败原因，并提供显式「跳过」入口（不自动跳过）。
 */
import type { CanvasEditService } from "../../services/canvas-state/index.js";
import { useCanvasEditSnapshot } from "./canvas-undo-controls.js";

export function CanvasEditStatus({ edit }: { edit: CanvasEditService }) {
  const snapshot = useCanvasEditSnapshot(edit);
  const waiting = snapshot.pending.filter(entry => entry.state === "pending" || entry.state === "unknown");
  const conflicts = snapshot.pending.filter(entry => entry.state === "conflict");
  if (waiting.length === 0 && conflicts.length === 0) return null;
  const slow = waiting.some(entry => entry.slow);
  return (
    <div className="canvas-edit-status" data-testid="canvas-edit-status">
      {waiting.length > 0 ? (
        <span className="canvas-edit-status__waiting" data-testid="canvas-edit-status-waiting">
          {slow ? "等待确认" : `${waiting.length} 项等待保存`}
        </span>
      ) : null}
      {conflicts.map(entry => (
        <span className="canvas-edit-status__conflict" key={entry.id} data-testid="canvas-edit-status-conflict">
          <span title={entry.error ?? entry.label}>{entry.label}未保存</span>
          <button
            type="button"
            className="canvas-edit-status__skip"
            data-testid="canvas-edit-status-skip"
            title={entry.error ?? "跳过此记录"}
            onClick={() => edit.skipConflict(entry.id)}
          >
            跳过
          </button>
        </span>
      ))}
    </div>
  );
}
