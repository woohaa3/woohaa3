/** Presentation only: selection and all writes remain owned by the existing sessions. */
import { useSyncExternalStore } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { FilmIcon } from "@woohaa3/ui/icons";
import { type FilmSetAnimations, type ServerCanvas, type FilmSetAnimationClip, readShotReferenceAssetLink } from "@woohaa3/contracts";
import type { FilmSetHostContext } from "../../state/browser/host-ports.js";
import type { FilmSetObjectSession } from "./object-session.js";
import type { FilmSetObjectAction } from "./object-action.js";
import type { ShotImageReferences } from "./shot-image-reference.js";
import { FilmSetObjectToolbar } from "./film-set-object-toolbar.js";
import { shotMediaSource, shotMediaRef } from "./shot-media-provider.js";
import { SHOT_REFERENCE_PROFILE_KEY } from "./shot-reference-recording-runtime.js";
import type { ShotReferenceRecordingController } from "./shot-reference-recording-controller.js";
import { FilmSetAnimationControls } from "./film-set-animation-controls.js";

export function FilmSetStillOutput({ images, nodeId, clipId, writable }: { images?: ShotImageReferences; nodeId: string; clipId: string; writable: boolean }) {
  useSyncExternalStore(images?.subscribe ?? (() => () => {}), images?.revision ?? (() => 0), () => 0);
  const state = images?.state(nodeId, clipId);
  return <div className="film-set-image-reference">
    <p>{state?.status === "ready" ? "图片参考已更新" : state?.status === "failed" ? `图片参考更新失败：${state.error}` : "图片参考准备中 · 退出片场后自动更新"}</p>
    {state?.status === "ready" && state.error ? <p className="film-set-object-hint">{state.error}</p> : null}
    {state?.status === "failed" ? <Button size="sm" disabled={!writable} onClick={() => images?.retry(nodeId, clipId)}>重试图片参考</Button> : null}
    <Button size="sm" disabled={state?.status !== "ready"} onClick={() => void images?.download(nodeId, clipId)}>下载图片参考</Button>
  </div>;
}

export function FilmSetNavigation(props: {
  ctx: FilmSetHostContext; nodeId: string; objectSession: FilmSetObjectSession; objectAction?: FilmSetObjectAction;
  recording?: ShotReferenceRecordingController;
  collection: FilmSetAnimations | null; activeClipId?: string; inspectingShot: boolean; images?: ShotImageReferences;
  writable: boolean; readOnly: boolean; collapsed: boolean; onCollapsedChange(value: boolean): void;
  onSelectObject(id: string | null): void; onSelectShot(id: string): void;
}) {
  const { ctx, nodeId, objectSession, collection, images } = props;
  useSyncExternalStore(images?.subscribe ?? (() => () => {}), images?.revision ?? (() => 0), () => 0);
  const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
  return <aside className="film-set-navigation" data-canvas-scrollable="true" data-collapsed={props.collapsed} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <div className="film-set-navigation__heading"><Button size="sm" tone="ghost" onClick={() => props.onCollapsedChange(!props.collapsed)}>{props.collapsed ? "展开" : "收起导航"}</Button></div>
    <div className="film-set-navigation__body" hidden={props.collapsed}>
      <div className="film-set-navigation__objects">
        <FilmSetObjectToolbar section="list" session={objectSession} nodeId={nodeId} writable={props.writable} readOnly={props.readOnly} action={props.objectAction}
          onDelete={() => objectSession.deleteSelected()} onSelect={props.onSelectObject} objectSelectionActive={!props.inspectingShot} />
      </div>
      <section className="film-set-navigation__shots">
        <div className="film-set-section-heading"><h3>拍摄镜头 <span className="film-set-count">{collection?.clips.length ?? 0}</span></h3><FilmSetAnimationControls presentation="create" ctx={ctx} nodeId={nodeId} writable={props.writable} onSelectShot={props.onSelectShot} /></div>
        <div className="film-set-shot-cards">
          {!collection?.clips.length ? <p className="film-set-object-hint">尚无镜头。新建静态构图或动态镜头开始拍摄。</p> : null}
          {collection?.clips.map(clip => <ShotCard key={clip.id} clip={clip} nodeId={nodeId} canvas={canvas}
            selected={props.activeClipId === clip.id && props.inspectingShot} defaultShot={clip.id === collection.defaultClipId}
            images={images} recording={props.recording} writable={props.writable} onSelect={() => props.onSelectShot(clip.id)} />)}
        </div>
      </section>
    </div>
  </aside>;
}

function ShotCard({ clip, nodeId, canvas, selected, defaultShot, images, recording, writable, onSelect }: {
  clip: FilmSetAnimationClip; nodeId: string; canvas: ServerCanvas | null; selected: boolean; defaultShot: boolean;
  images?: ShotImageReferences; recording?: ShotReferenceRecordingController; writable: boolean; onSelect(): void;
}) {
  let source: ReturnType<typeof shotMediaSource> | null = null;
  try { if (canvas && clip.kind === "dynamic") source = shotMediaSource(canvas, shotMediaRef(nodeId, clip.id), "theme"); } catch { /* unavailable resource stays visible as a diagnostic */ }
  const ref = source && canvas ? { canvasId: canvas.id, filmSetNodeId: nodeId, clipId: clip.id, contentIdentity: source.contentIdentity, profileKey: SHOT_REFERENCE_PROFILE_KEY } : null;
  const status = useSyncExternalStore(listener => ref && recording ? recording.cache.subscribe(ref, listener) : () => {},
    () => ref && recording ? recording.cache.status(ref) : null, () => null);
  const still = clip.kind === "static" ? images?.state(nodeId, clip.id) : undefined;
  const video = source ? canvas?.assets.find(asset => {
    const link = readShotReferenceAssetLink(asset.metadata);
    return asset.mediaKind === "video" && asset.status === "ready" && link?.filmSetNodeId === nodeId && link.clipId === clip.id
      && link.contentIdentity === source!.contentIdentity && link.profileKey === SHOT_REFERENCE_PROFILE_KEY;
  }) : null;
  const label = clip.kind === "static" ? still?.status === "ready" ? "已更新" : still?.status === "failed" ? "更新失败" : still?.status === "preparing" ? "准备中" : "待更新"
    : video ? "已更新" : status === "failed" ? "更新失败" : status === "recording" || status === "queued" ? "准备中" : "待更新";
  return <div className="film-set-shot-card-entry">
    <button type="button" className="film-set-shot-card" aria-label={`镜头 · ${clip.name}`} aria-selected={selected} onClick={onSelect}>
      <span className="film-set-shot-card__image">{still?.asset?.url && still.status === "ready" ? <img src={still.asset.url} alt="" /> : video?.url ? <video key={video.id} src={video.url} muted preload="metadata" /> : <FilmIcon />}</span>
      <span className="film-set-shot-card__name" title={clip.name}>{clip.name}{defaultShot ? " · 默认" : ""}</span>
      <span className="film-set-shot-card__state">{clip.kind === "static" ? "静态" : `${clip.timeline.duration} 秒`} · {label}</span>
    </button>
    {label === "更新失败" ? <Button size="sm" disabled={!writable} onClick={() => clip.kind === "static" ? images?.retry(nodeId, clip.id) : recording?.requestRecord(nodeId, clip.id)}>重试参考</Button> : null}
  </div>;
}
