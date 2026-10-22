import { Button } from "@woohaa3/frontend/extension-api";
import { useState, useSyncExternalStore } from "react";
import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";
import type { ModelCaptureSession } from "@woohaa3/frontend/extension-api";
import { FilmSetVideoExportControl } from "./film-set-video-export-control.js";
import { NativeVideoExportControl } from "./native-video-export-control.js";
import { nativeRecordingAvailable } from "./native-recording-availability.js";
import { readExportProfilePreference } from "./film-set-export-profile-preference.js";

export function FilmSetAnimationPlayer({ ctx, captureSession, writable }: { ctx: Context; captureSession: ModelCaptureSession; writable: boolean }) {
  const playback = useSyncExternalStore(ctx.filmSetPlayback.subscribe, ctx.filmSetPlayback.getSnapshot, ctx.filmSetPlayback.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false);
  // profile 偏好只读一次渲染即可：原生与浏览器两条路径共用同一份本地偏好（D7）。
  const [profile] = useState(() => readExportProfilePreference());
  const capture = async () => {
    ctx.filmSetPlayback.pause();
    const projection = ctx.canvasRuntime.animationPlaybackState();
    if (!projection?.clipId || !writable || busy) return;
    setBusy(true); setError(null);
    const { nodeId, clipId, sourceIdentity, generation, time } = projection;
    const isCurrent = () => {
      const current = ctx.canvasRuntime.animationPlaybackState();
      return current?.nodeId === nodeId && current.clipId === clipId && current.sourceIdentity === sourceIdentity && current.generation === generation && current.time === time && ctx.canvasRuntime.modelFocusMode() !== "history";
    };
    try {
      const result = await captureSession.capture({ nodeId, cameraId: `clip:${clipId}`, captureId: `frame-${crypto.randomUUID()}`, isCurrent,
        origin: { nodeData: { filmSetShotOrigin: { filmSetNodeId: nodeId, cameraId: `clip:${clipId}`, clipId, timeSeconds: time, sourceIdentity, aspect: projection.initialCamera.aspect, capturedAt: new Date().toISOString() } } as never } });
      if (!result.ok) setError(result.message);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "当前帧截图失败"); }
    finally { setBusy(false); }
  };
  return <div className="film-set-animation-player" role="region" aria-label="动画播放控制">
    <div className="film-set-animation-player__transport">
    <Button size="sm" disabled={videoBusy || !playback.duration || !!playback.error?.startsWith("片段无法播放")} onClick={() => playback.playing ? ctx.filmSetPlayback.pause() : ctx.filmSetPlayback.play()}>{playback.playing ? "暂停" : "播放"}</Button>
    <Button size="sm" disabled={videoBusy} onClick={() => ctx.filmSetPlayback.stop()}>回到开头</Button>
    <output>{playback.time.toFixed(2)} / {playback.duration.toFixed(2)} 秒</output>
    </div>
    <input aria-label="动画进度" type="range" min={0} max={playback.duration} step={0.01} value={Math.min(playback.time, playback.duration)} disabled={videoBusy || !playback.duration} onChange={event => ctx.filmSetPlayback.seek(Number(event.target.value))} />
    <div className="film-set-animation-player__actions">
    <Button size="sm" disabled={!writable || busy || videoBusy || !!playback.error?.startsWith("片段无法播放")} onClick={() => void capture()}>{busy ? "截图中…" : "保存当前帧"}</Button>
    {nativeRecordingAvailable()
      ? <NativeVideoExportControl
          ctx={ctx}
          disabled={!writable || busy || !playback.duration || !!playback.error}
          profile={profile}
          target={{
            nodeId: playback.nodeId ?? "",
            clipId: playback.clipId ?? "",
            title: "片场动画",
            ...(playback.sourceIdentity ? { displayVersion: playback.sourceIdentity } : {})
          }}
          onBusyChange={setVideoBusy}
        />
      : <FilmSetVideoExportControl ctx={ctx} disabled={!writable || busy || !playback.duration || !!playback.error} onBusyChange={setVideoBusy} />}
    <Button size="sm" onClick={() => ctx.filmSetPlayback.edit()}>返回编辑</Button>
    </div>
    {error || playback.error ? <p role="alert">{error ?? playback.error}</p> : null}
  </div>;
}
