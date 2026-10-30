import { Button, IconButton } from "@woohaa3/ui/primitives";
import { PlayIcon, PauseIcon, BackIcon } from "@woohaa3/ui/icons";
import { useState, useSyncExternalStore } from "react";
import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";
import type { ModelCaptureSession } from "@woohaa3/frontend/extension-api";

export function FilmSetAnimationPlayer({ ctx, captureSession, writable, duration, onPreview }: { ctx: Context; captureSession: ModelCaptureSession; writable: boolean; duration?: number; onPreview?: () => void }) {
  const playback = useSyncExternalStore(ctx.filmSetPlayback.subscribe, ctx.filmSetPlayback.getSnapshot, ctx.filmSetPlayback.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enterPreview = () => { if (!playback.preview) { onPreview?.(); ctx.filmSetPlayback.preview(); } };
  const total = playback.preview ? playback.duration : duration ?? playback.duration;
  const capture = async () => {
    enterPreview();
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
    <IconButton label={playback.playing ? "暂停" : "播放"} title={playback.playing ? "暂停" : "播放"} size="sm" disabled={!total || !!playback.error?.startsWith("片段无法播放")} onClick={() => { enterPreview(); playback.playing ? ctx.filmSetPlayback.pause() : ctx.filmSetPlayback.play(); }}>{playback.playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}</IconButton>
    <IconButton label="回到开头" title="回到开头" size="sm" onClick={() => { enterPreview(); ctx.filmSetPlayback.stop(); }}><BackIcon size={16} /></IconButton>
    <output>{playback.time.toFixed(2)} / {total.toFixed(2)} 秒</output>
    </div>
    <input aria-label="动画进度" type="range" min={0} max={total} step={0.01} value={Math.min(playback.time, total)} disabled={!total} onChange={event => { enterPreview(); ctx.filmSetPlayback.pause(); ctx.filmSetPlayback.seek(Number(event.target.value)); }} />
    <div className="film-set-animation-player__actions">
    <Button size="sm" disabled={!writable || busy || !!playback.error?.startsWith("片段无法播放")} onClick={() => void capture()}>{busy ? "截图中…" : "保存当前帧"}</Button>
    {playback.preview ? <Button size="sm" onClick={() => ctx.filmSetPlayback.edit()}>返回编辑</Button> : null}
    </div>
    {error || playback.error ? <p role="alert">{error ?? playback.error}</p> : null}
  </div>;
}
