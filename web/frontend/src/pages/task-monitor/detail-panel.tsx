import { useEffect, useRef, type ReactNode } from "react";
import { Button, IconButton } from "../../shared/ui/index.js";
import { CloseIcon } from "../../shared/ui/index.js";
import { TaskTraceBody } from "../../shared/task-trace/task-trace-body.js";
import type { MonitorItem } from "./monitor-model.js";

/**
 * 独立任务监控页的任务详情侧栏（薄壳）
 * （自 task-monitor.tsx 拆出，change: 2026-10-13-add-enterprise-access-and-production-deployment；
 *   change: 生成溯源改为画布内浮窗）。
 *
 * 只保留**对话框语义与导航**：role/aria、Esc 关闭、关闭按钮、上一条/下一条、返回画布。
 * 详情正文已抽到 `shared/task-trace/task-trace-body`，与画布内「生成溯源」浮窗共用同一组件，
 * 两处内容天然一致。
 *
 * 打开时焦点落到关闭按钮（键盘可达）；Esc 关闭。不提供取消/重试。
 */
export function DetailPanel({
  detail,
  error,
  loading,
  nowMs,
  resolveMediaUrl,
  onClose,
  onOpenCanvas,
  onNavigate,
  previousTaskKey,
  nextTaskKey
}: {
  detail: MonitorItem | null;
  error: string | null;
  loading: boolean;
  nowMs: number;
  /** 第二个参数是详情所属画布：正文明细把 `detail.canvasId` 透传给媒体地址。 */
  resolveMediaUrl?: (storageKey: string, canvasId?: string) => string;
  onClose: () => void;
  onOpenCanvas?: (input: { canvasId: string; nodeId?: string }) => void;
  onNavigate: (delta: number) => void;
  previousTaskKey?: string;
  nextTaskKey?: string;
}): ReactNode {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus?.();
  }, []);
  return (
    <aside
      className="task-monitor__detail"
      role="dialog"
      aria-label="任务详情"
      data-testid="task-monitor-detail"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="task-monitor__detail-top">
        <h2>{detail ? detail.modelTitle ?? detail.modelKey ?? detail.taskKey : "任务详情"}</h2>
        <div className="task-monitor__detail-actions">
          <IconButton ref={closeRef} label="关闭详情" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
      </div>

      <TaskTraceBody
        detail={detail}
        error={error}
        loading={loading}
        nowMs={nowMs}
        resolveMediaUrl={resolveMediaUrl}
        onOpenCanvas={onOpenCanvas}
      />

      <footer className="task-monitor__detail-nav">
        <Button size="sm" tone="ghost" disabled={!previousTaskKey} onClick={() => onNavigate(-1)}>
          上一条
        </Button>
        <Button size="sm" tone="ghost" disabled={!nextTaskKey} onClick={() => onNavigate(1)}>
          下一条
        </Button>
      </footer>
    </aside>
  );
}
