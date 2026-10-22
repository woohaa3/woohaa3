import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";
import { decodeFilmSetNodeData, filmSetAnimationsOf, compositeAssetNodeBoxSize, getWoohaa3CanvasNodeAbsolutePosition, readFilmSetExportProfile, type FilmSetExportProfile } from "@woohaa3/contracts";
import { FilmSetVideoExportSession, videoSize, type FilmSetVideoTarget } from "./film-set-video-export.js";
import { createFilmSetVideoEncoder } from "./film-set-video-encoder.js";
import { recordingThemeBackdrop } from "./recording-theme-backdrop.js";

function canvasNow(ctx: Context) { return ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas(); }
function layoutIdentity(ctx: Context, nodeId: string): string {
  const canvas = canvasNow(ctx), node = canvas?.document.nodes.find(node => node.id === nodeId);
  return JSON.stringify([node?.width, node?.height, canvas?.nodeData[nodeId]?.scenePlacement]);
}
export function videoExportTarget(ctx: Context, profile: FilmSetExportProfile = readFilmSetExportProfile(undefined)): FilmSetVideoTarget | null {
  const canvas = canvasNow(ctx), playback = ctx.canvasRuntime.animationPlaybackState();
  if (!canvas || !playback?.clipId || !playback.sourceIdentity || playback.viewMode !== "focus-preview") return null;
  const decoded = decodeFilmSetNodeData(canvas.nodeData[playback.nodeId]);
  if (!decoded.ok) return null;
  const clip = filmSetAnimationsOf(decoded.value).clips.find(clip => clip.id === playback.clipId);
  if (!clip) return null;
  return { canvasId: canvas.id, nodeId: playback.nodeId, clipId: clip.id, sourceIdentity: playback.sourceIdentity,
    generation: playback.generation ?? 0, title: `${decoded.value.title || "片场"} · ${clip.name}`,
    duration: clip.timeline.duration, aspect: clip.initialCamera.aspect, time: playback.time, playing: playback.playing,
    layoutIdentity: layoutIdentity(ctx, playback.nodeId), profile };
}

export function createFilmSetVideoExportSession(ctx: Context): FilmSetVideoExportSession {
  let captureGeneration = 1_000_000;
  const sameSource = (target: FilmSetVideoTarget) => {
    const p = ctx.canvasRuntime.animationPlaybackState();
    return canvasNow(ctx)?.id === target.canvasId && p?.nodeId === target.nodeId && p.clipId === target.clipId
      && p.sourceIdentity === target.sourceIdentity && p.generation === target.generation && p.viewMode === "focus-preview" && layoutIdentity(ctx, target.nodeId) === target.layoutIdentity;
  };
  return new FilmSetVideoExportSession({
    isCurrent: target => ctx.canvasSession.isWritable() && !document.hidden && ctx.canvasRuntime.modelFocusMode() !== "history" && sameSource(target),
    seek: time => ctx.filmSetPlayback.seek(time),
    restore: target => {
      // 导出结束（成功、失败或取消）后回到交互预览的纹理上限，避免常驻显存翻四倍（D5）。
      ctx.canvasRuntime.compositeAssetMediaSessions?.()?.setExportQuality?.(false);
      if (sameSource(target)) { ctx.filmSetPlayback.seek(target.time); if (target.playing && !document.hidden) ctx.filmSetPlayback.play(); }
    },
    createEncoder: createFilmSetVideoEncoder,
    acquire: () => ctx.modelWorkspace.acquireCapture(),
    async capture(target, time, signal) {
      // Flush the new playback time, then wait for embedded video textures at exactly that time.
      await nextPaint(signal);
      // 导出取帧时片场媒体平面使用更高纹理上限（D5）；交互预览仍是 1024。
      ctx.canvasRuntime.compositeAssetMediaSessions?.()?.setExportQuality?.(true);
      const ready = await (ctx.canvasRuntime.compositeAssetMediaSessions?.()?.waitForTime(target.nodeId, time, 5000, 0.001) ?? Promise.resolve(true));
      if (!ready) throw new Error(`第 ${time.toFixed(2)} 秒的片场媒体帧未就绪，请检查媒体后重试`);
      await nextPaint(signal);
      const runtime = ctx.canvasRuntime.runtime();
      if (!runtime?.isReady()) throw new Error("画布渲染器未就绪，请稍后重试");
      if (!sameSource(target) || ctx.canvasRuntime.animationPlaybackState()?.time !== time) throw new Error("镜头播放时刻已变化，视频生成已停止");
      const frame = await runtime.requestCapture({ nodeId: target.nodeId, generation: captureGeneration++, ...videoSize(target.aspect, target.profile) });
      if (!frame) throw new Error(`第 ${time.toFixed(2)} 秒的镜头捕捉失败或超时，请重试`);
      return frame;
    },
    // 画布内上传：带画布身份，同步到远端的画布把字节写进托管存储。
    upload: (file, signal) => ctx.mediaRemote.upload({ file, signal, canvasId: ctx.canvasScope.canvasId() }),
    sourcePosition: nodeId => {
      const canvas = canvasNow(ctx), node = canvas?.document.nodes.find(node => node.id === nodeId);
      if (!canvas || !node) return null;
      const nodes = canvas.document.nodes.map(node => ({ ...node, data: {} }));
      return { ...getWoohaa3CanvasNodeAbsolutePosition({ ...node, data: {} }, new Map(nodes.map(node => [node.id, node]))), width: compositeAssetNodeBoxSize(node).width };
    },
    async submit(commands, commandId) {
      const result = ctx.canvasSession.submitCommands(commands, commandId);
      if (!result.ok) return { ok: false, error: result.reason };
      const settled = await result.handle.settled;
      return settled.state === "rejected" ? { ok: false, error: settled.error ?? "画布未能保存，请重试" } : { ok: true };
    }
  });
}

/** 浏览器导出提交时携带的主题镜头背景色（D6）；前端是唯一持有当前主题的一方。 */
export function videoExportThemeBackdrop(ctx: Context): string {
  return recordingThemeBackdrop(ctx);
}

function nextPaint(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("视频生成已取消")); return; }
    const abort = () => { cancelAnimationFrame(frame); reject(new Error("视频生成已取消")); };
    const frame = requestAnimationFrame(() => { signal.removeEventListener("abort", abort); resolve(); });
    signal.addEventListener("abort", abort, { once: true });
  });
}
