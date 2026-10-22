import { Button } from "@woohaa3/frontend/extension-api";
import { useEffect, useMemo, useState } from "react";
import type { FilmSetContext as Context } from "./context.js";
import { createFilmSetVideoExportSession, videoExportTarget } from "./film-set-video-capture.js";
import type { VideoExportProgress } from "./film-set-video-export.js";

export function FilmSetVideoExportControl({ ctx, disabled, onBusyChange }: { ctx: Context; disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const session = useMemo(() => createFilmSetVideoExportSession(ctx), [ctx]);
  const [progress, setProgress] = useState<VideoExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) session.cancel(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { document.removeEventListener("visibilitychange", onVisibility); session.cancel(); };
  }, [session]);
  const run = async () => {
    if (disabled || session.busy) return;
    const target = videoExportTarget(ctx);
    if (!target) { setError("请选择一个可播放的动画片段后再生成视频"); return; }
    setError(null); setMessage(null); onBusyChange(true);
    // 本地生成操作：视频导出是 browser-local owner，经统一运行状态登记（不写 canonical）。
    const service = ctx.get("runState") as import("@woohaa3/frontend/extension-api").RunStateService | undefined;
    const local = service?.beginLocalOperation({ canvasId: target.canvasId, nodeId: target.nodeId, kind: "video-export" });
    setProgress({ phase: "rendering", completed: 0, total: Math.ceil(target.duration * 30) });
    try {
      const result = await session.run(target, setProgress);
      if (result.ok) { local?.finish(); setMessage("视频已生成，已放在片场右侧"); }
      else if (result.code === "canceled") { local?.finish({ error: "已取消" }); setMessage(result.message); }
      else { local?.finish({ error: result.message }); setError(result.message); }
    } catch (thrown) {
      local?.finish({ error: thrown instanceof Error ? thrown.message : "视频生成失败" });
      throw thrown;
    } finally { setProgress(null); onBusyChange(false); }
  };
  const percent = progress ? Math.floor(100 * progress.completed / Math.max(1, progress.total)) : 0;
  return <>
    <Button size="sm" disabled={disabled || !!progress} onClick={() => void run()} title="将当前片段从头到尾生成视频，并添加到片场右侧">
      {progress ? progress.phase === "rendering" ? `生成视频 ${percent}%` : progress.phase === "uploading" ? "上传视频中…" : "保存视频中…" : "生成视频"}
    </Button>
    {progress ? <>
      <progress aria-label="视频生成进度" max={progress.total} value={progress.completed} />
      <Button size="sm" disabled={progress.phase === "saving"} onClick={() => session.cancel()}>取消生成</Button>
    </> : null}
    {error ? <p role="alert">{error}</p> : message ? <p role="status">{message}</p> : null}
  </>;
}
