import { Button } from "@woohaa3/ui/primitives";
import { SelectInput } from "@woohaa3/ui/forms";
import { useEffect, useMemo, useState } from "react";
import { filmSetExportProfileLabel, type FilmSetExportProfile } from "@woohaa3/contracts";
import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";
import { createFilmSetVideoExportSession, videoExportTarget } from "./film-set-video-capture.js";
import { recordingThemeBackdrop } from "./recording-theme-backdrop.js";
import { EXPORT_PROFILE_OPTIONS, readExportProfilePreference, writeExportProfilePreference } from "./film-set-export-profile-preference.js";
import type { VideoExportProgress } from "./film-set-video-export.js";

export function FilmSetVideoExportControl({ ctx, disabled, onBusyChange }: { ctx: Context; disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const session = useMemo(() => createFilmSetVideoExportSession(ctx), [ctx]);
  const [progress, setProgress] = useState<VideoExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [profile, setProfile] = useState<FilmSetExportProfile>(() => readExportProfilePreference());
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) session.cancel(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { document.removeEventListener("visibilitychange", onVisibility); session.cancel(); };
  }, [session]);
  const run = async () => {
    if (disabled || session.busy) return;
    if (!ctx.filmSetPlayback.getSnapshot().preview) {
      ctx.canvasRuntime.controller()?.cancelTransientGesture();
      ctx.modelWorkspace.session.cancelPose();
      ctx.modelWorkspace.session.cancelFocus();
      ctx.filmSetPlayback.preview();
    }
    const target = videoExportTarget(ctx, profile);
    if (!target) { setError("请选择一个可播放的动画片段后再生成视频"); return; }
    ctx.filmSetPlayback.pause();
    setError(null); setMessage(`正在导出：${target.title}`); onBusyChange(true);
    // 本地生成操作：视频导出是 browser-local owner，经统一运行状态登记（不写 canonical）。
    const service = ctx.get("runState") as import("@woohaa3/frontend/extension-api").RunStateService | undefined;
    const local = service?.beginLocalOperation({ canvasId: target.canvasId, nodeId: target.nodeId, kind: "video-export" });
    setProgress({ phase: "rendering", completed: 0, total: Math.ceil(target.duration * 30) });
    try {
      const result = await session.run(target, setProgress);
      if (result.ok) { local?.finish(); setMessage(`${target.title} 视频已生成（${filmSetExportProfileLabel(profile)}），已放在片场右侧`); }
      else if (result.code === "canceled") { local?.finish({ error: "已取消" }); setMessage(result.message); }
      else { local?.finish({ error: result.message }); setError(result.message); }
    } catch (thrown) {
      local?.finish({ error: thrown instanceof Error ? thrown.message : "视频生成失败" });
      setError(thrown instanceof Error ? thrown.message : "视频导出失败");
    } finally { setProgress(null); onBusyChange(false); }
  };
  const percent = progress ? Math.floor(100 * progress.completed / Math.max(1, progress.total)) : 0;
  return <>
    <div className="film-set-export-profile">
      <span>规格</span>
      <SelectInput
        label="导出规格"
        disabled={!!progress}
        value={profile}
        options={EXPORT_PROFILE_OPTIONS}
        onValueChange={value => setProfile(writeExportProfilePreference(value as FilmSetExportProfile))}
      />
    </div>
    <Button size="sm" disabled={disabled || !!progress} onClick={() => void run()} title={`将当前片段从头到尾生成视频（${filmSetExportProfileLabel(profile)}；背景按该镜头设置：跟随主题时为 ${recordingThemeBackdrop(ctx)}，自定义时用镜头颜色），并添加到片场右侧`}>
      {progress ? progress.phase === "rendering" ? `生成视频 ${percent}%` : progress.phase === "uploading" ? "上传视频中…" : "保存视频中…" : "导出视频"}
    </Button>
    {progress ? <>
      <progress aria-label="视频生成进度" max={progress.total} value={progress.completed} />
      <Button size="sm" disabled={progress.phase === "saving"} onClick={() => session.cancel()}>取消生成</Button>
    </> : null}
    {error ? <p role="alert">{error}</p> : message ? <p role="status">{message}</p> : null}
  </>;
}
