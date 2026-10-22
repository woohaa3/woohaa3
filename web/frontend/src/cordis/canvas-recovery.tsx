/**
 * Canvas recovery chrome
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 3.5 / design D1）。
 *
 * 显式不存在的 canvasId 或目录解析失败时渲染：不静默跳到其它画布。提供「打开已有画布」
 * 与「新建画布」的恢复动作；不创建 Canvas Session/socket/Bevy。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useRuntimeContext } from "./react.js";
import { Button } from "../shared/ui/Button.js";
import type { AppPageLocation } from "./navigation/app-router.js";
import type { CanvasRecoveryService } from "./contract/canvas-catalog.js";

export function CanvasRecoveryPage({
  recovery,
  navigate
}: {
  recovery: CanvasRecoveryService;
  navigate: (location: AppPageLocation) => void;
}) {
  const ctx = useRuntimeContext();
  const catalog = ctx.canvasCatalog;
  const directory = useSyncExternalStore(catalog.subscribe, catalog.getState, catalog.getState);
  const loading = directory.status === "idle" || directory.status === "loading";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void catalog.load(true);
  }, [catalog]);

  const open = (canvasId: string) => {
    ctx.canvasSelection.setRecentCanvasId(canvasId);
    navigate({ page: "canvas", canvasId });
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    const result = await catalog.create({});
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    open(result.canvasId);
  };

  return (
    <main className="canvas-recovery" aria-labelledby="canvas-recovery-title" data-testid="canvas-recovery">
      <div className="canvas-recovery__panel">
        <h1 id="canvas-recovery-title" className="canvas-recovery__title">
          {recovery.code === "CANVAS_NOT_FOUND" ? "找不到这个画布" : "暂时无法打开画布"}
        </h1>
        <p className="canvas-recovery__message">请选择其他画布继续工作，或新建画布。</p>
        <section className="canvas-recovery__directory" aria-labelledby="canvas-recovery-directory" aria-busy={loading || directory.loadingMore}>
          <h2 id="canvas-recovery-directory" className="canvas-recovery__subtitle">切换画布</h2>
          {loading ? <p className="canvas-recovery__hint" role="status">正在加载画布列表…</p> : null}
          {!loading && directory.error ? (
            <div className="canvas-recovery__directory-error">
              <p className="canvas-recovery__error" role="alert">无法加载画布列表：{directory.error}</p>
              <Button onClick={() => void (directory.status === "error" ? catalog.load(true) : catalog.loadMore())} loading={directory.loadingMore}>重试</Button>
            </div>
          ) : null}
          {directory.status === "ready" && directory.entries.length === 0 ? (
            <p className="canvas-recovery__hint">还没有画布，可以新建一个开始创作。</p>
          ) : null}
          {!loading && directory.entries.length > 0 ? (
            <ul className="canvas-recovery__list" aria-label="已有画布">
              {directory.entries.map((entry) => (
                <li key={entry.id}>
                  <button type="button" className="canvas-recovery__item" onClick={() => open(entry.id)}>
                    {entry.title || "未命名画布"}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {directory.status === "ready" && directory.entries.length + directory.offset < directory.total && !directory.error ? (
            <Button onClick={() => void catalog.loadMore()} loading={directory.loadingMore}>加载更多</Button>
          ) : null}
        </section>
        <div className="canvas-recovery__actions">
          <Button tone={directory.status === "ready" && directory.entries.length === 0 ? "primary" : "neutral"} onClick={() => void create()} loading={busy}>
            新建画布
          </Button>
        </div>
        {error ? <p className="canvas-recovery__error" role="status">{error}</p> : null}
        <details className="canvas-recovery__details">
          <summary>错误详情</summary>
          <p>{recovery.error}</p>
          {recovery.canvasId ? <p>请求的画布 ID：{recovery.canvasId}</p> : null}
        </details>
      </div>
    </main>
  );
}
