import { Button } from "@woohaa3/frontend/extension-api";
import { useState, useSyncExternalStore } from "react";
import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";
import type { ModelCaptureSession } from "@woohaa3/frontend/extension-api";

export function FilmSetAnimationPlayer({ ctx, captureSession, writable }: { ctx: Context; captureSession: ModelCaptureSession; writable: boolean }) {
  const playback = useSyncExternalStore(ctx.filmSetPlayback.subscribe, ctx.filmSetPlayback.getSnapshot, ctx.filmSetPlayback.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    <Button size="sm" disabled={!playback.duration || !!playback.error?.startsWith("片段无法播放")} onClick={() => playback.playing ? ctx.filmSetPlayback.pause() : ctx.filmSetPlayback.play()}>{playback.playing ? "暂停" : "播放"}</Button>
    <Button size="sm" onClick={() => ctx.filmSetPlayback.stop()}>回到开头</Button>
    <output>{playback.time.toFixed(2)} / {playback.duration.toFixed(2)} 秒</output>
    </div>
    <input aria-label="动画进度" type="range" min={0} max={playback.duration} step={0.01} value={Math.min(playback.time, playback.duration)} disabled={!playback.duration} onChange={event => ctx.filmSetPlayback.seek(Number(event.target.value))} />
    <div className="film-set-animation-player__actions">
    <Button size="sm" disabled={!writable || busy || !!playback.error?.startsWith("片段无法播放")} onClick={() => void capture()}>{busy ? "截图中…" : "保存当前帧"}</Button>
    <Button size="sm" onClick={() => ctx.filmSetPlayback.edit()}>返回编辑</Button>
    </div>
    {error || playback.error ? <p role="alert">{error ?? playback.error}</p> : null}
  </div>;
}
