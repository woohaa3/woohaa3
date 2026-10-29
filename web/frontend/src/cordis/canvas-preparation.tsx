/**
 * Canvas preparation chrome（旧 ID 在线迁移准备态）
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 5.4、5.8 / design D4）。
 *
 * 显式旧 ID 的首次打开：展示标准 loading、媒体计数、来源名、重试与退出；不创建 Canvas
 * Session/socket/Bevy。准备成功由 page-scope watcher 自动重解析到 Canvas scope；本组件不
 * 触达来源配置/哈希等内部细节（spec: 内部源配置不进入创作者流程）。
 *
 * 无障碍：状态用 `role="status"` + `aria-live="polite"`；进度用 `role="progressbar"`。
 */
import { useEffect, useState } from "react";
import { useRuntimeContext } from "./react.js";
import { Button } from "@woohaa3/ui/primitives";
import type { AppRuntime } from "./page-scope.js";
import { initialPreparationState } from "./services/canvas-preparation-store.js";
import type { CanvasPreparationState } from "./contract/canvas-preparation.js";

export function CanvasPreparationPage({
  view,
  app
}: {
  view: { canvasId: string; jobId: string | null };
  app: AppRuntime;
}) {
  const ctx = useRuntimeContext();
  const preparation = ctx.canvasPreparation;
  const [state, setState] = useState<CanvasPreparationState>(
    () => preparation?.getState() ?? initialPreparationState()
  );

  useEffect(() => {
    if (!preparation) return undefined;
    setState(preparation.getState());
    return preparation.subscribe(() => setState(preparation.getState()));
  }, [preparation]);

  // 准备态 scope 挂载时确保观察在跑（幂等；迟到结果由 store 隔离）。
  useEffect(() => {
    if (!preparation) return undefined;
    const controller = new AbortController();
    void preparation.observe({ canvasId: view.canvasId, signal: controller.signal });
    return () => controller.abort();
  }, [preparation, view.canvasId]);

  const retry = () => {
    const source = state.sources.find((entry) => entry.availability === "available")?.sourceId;
    setState({ ...state, status: "loading", error: null, code: null });
    void preparation?.prepare({ canvasId: view.canvasId, ...(source ? { sourceId: source } : {}) });
  };

  const exit = () => {
    app.router.navigate({ page: "task-history" });
  };

  const total = state.totalMedia;
  const completed = Math.min(state.completedMedia, total);

  return (
    <div className="canvas-preparation" data-testid="canvas-preparation">
      <div className="canvas-preparation__panel">
        <h2 className="canvas-preparation__title">正在准备作品</h2>
        <p className="canvas-preparation__message" role="status" aria-live="polite">
          {state.status === "loading" || state.status === "preparing"
            ? "正在从历史来源恢复此作品，请稍候…"
            : state.status === "failed"
              ? state.error ?? "准备失败"
              : "准备完成"}
        </p>
        {state.status === "preparing" || state.status === "loading" ? (
          <div
            className="canvas-preparation__progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total > 0 ? total : 1}
            aria-valuenow={completed}
            aria-label="迁移进度"
          >
            <div
              className="canvas-preparation__progress-bar"
              style={{ width: total > 0 ? `${Math.round((completed / total) * 100)}%` : "10%" }}
            />
          </div>
        ) : null}
        {total > 0 ? (
          <p className="canvas-preparation__count" aria-live="polite">
            已处理媒体 {completed} / {total}
          </p>
        ) : null}
        <div className="canvas-preparation__actions">
          {state.status === "failed" && state.retryable ? (
            <Button tone="primary" onClick={retry} data-testid="canvas-preparation-retry">
              重试
            </Button>
          ) : null}
          <Button tone="ghost" onClick={exit} data-testid="canvas-preparation-exit">
            退出
          </Button>
        </div>
        {state.status === "deleted" ? (
          <p className="canvas-preparation__error" role="alert">
            已删除的作品不会自动重建。
          </p>
        ) : null}
      </div>
    </div>
  );
}
