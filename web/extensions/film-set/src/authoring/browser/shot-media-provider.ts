/** Film-set owns payload semantics and full clip production; the host sees only open content refs. */
import {
  decodeFilmSetNodeData, filmSetAnimationsOf, isFilmSetNode, readShotReferenceAssetLink,
  shotReferenceContentIdentity, shotImageReferenceIdentity,
  type MediaContentRef, type ServerCanvas, type StoredAsset,
} from "@woohaa3/contracts";
import type { MediaContentContext, MediaContentProvider } from "@woohaa3/frontend/extension-api";
import type { FilmSetHostContext } from "../../state/browser/host-ports.js";
import type { ShotImageReferences } from "./shot-image-reference.js";
import type { ShotReferenceRecordingController } from "./shot-reference-recording-controller.js";
import { SHOT_REFERENCE_PROFILE_KEY } from "./shot-reference-recording-runtime.js";
import { recordingThemeBackdrop } from "./recording-theme-backdrop.js";
export const SHOT_MEDIA_PROVIDER_ID = "film-set.shot";
export function shotMediaRef(filmSetNodeId: string, clipId: string): MediaContentRef {
  return { providerId: SHOT_MEDIA_PROVIDER_ID, schemaVersion: 1, payload: { filmSetNodeId, clipId } };
}
export function shotMediaSource(canvas: ServerCanvas, ref: MediaContentRef, background: string) {
  const { filmSetNodeId, clipId } = ref.payload;
  if (typeof filmSetNodeId !== "string" || typeof clipId !== "string" || Object.keys(ref.payload).some(k => k !== "filmSetNodeId" && k !== "clipId")) throw Error("film-set.shot: 来源引用无效");
  const node = canvas.document.nodes.find(n => n.id === filmSetNodeId);
  if (!node || !isFilmSetNode(node.type, canvas.nodeData[node.id])) throw Error("film-set.shot: 源片场已删除");
  const animation = decodeFilmSetNodeData(canvas.nodeData[filmSetNodeId]);
  if (!animation.ok) throw Error(animation.reason);
  const clip = filmSetAnimationsOf(animation.value).clips.find(c => c.id === clipId);
  if (!clip) throw Error("film-set.shot: 源镜头已删除");
  const still = clip.kind === "static" ? shotImageReferenceIdentity({ animation: animation.value, clipId,
    background: clip.backdrop && clip.backdrop !== "theme" ? clip.backdrop : background, assets: canvas.assets }) : null;
  const contentIdentity = still?.contentIdentity ?? shotReferenceContentIdentity({ animation: animation.value, clipId });
  if (!contentIdentity) throw Error("film-set.shot: 镜头内容不可用");
  return { mediaKind: clip.kind === "static" ? "image" as const : "video" as const,
    sourceIdentity: `${clip.kind}:${contentIdentity}:${still?.profileKey ?? SHOT_REFERENCE_PROFILE_KEY}`,
    dependencyNodeIds: [filmSetNodeId], filmSetNodeId, clipId, contentIdentity, name: clip.name };
}
export function createShotMediaProvider(ctx: FilmSetHostContext, images: ShotImageReferences, recording: ShotReferenceRecordingController): MediaContentProvider {
  const source = (canvas: ServerCanvas, ref: MediaContentRef) => shotMediaSource(canvas, ref, recordingThemeBackdrop(ctx));
  const ready = (canvas: ServerCanvas, ref: MediaContentRef): StoredAsset | null => {
    const target = source(canvas, ref);
    if (target.mediaKind === "image") return images.state(target.filmSetNodeId, target.clipId).asset ?? null;
    return canvas.assets.find(asset => {
      const link = readShotReferenceAssetLink(asset.metadata);
      return asset.mediaKind === "video" && asset.status === "ready" && link?.filmSetNodeId === target.filmSetNodeId && link.clipId === target.clipId && link.contentIdentity === target.contentIdentity && link.profileKey === SHOT_REFERENCE_PROFILE_KEY;
    }) ?? null;
  };
  const materialize = async (context: MediaContentContext): Promise<StoredAsset> => {
    const target = source(context.canvas, context.ref);
    const existing = ready(context.canvas, context.ref);
    if (existing) return existing;
    if (!ctx.canvasSession.isWritable()) throw Error("当前画布不可写，无法物化镜头内容");
    if (target.mediaKind === "image") images.retry(target.filmSetNodeId, target.clipId);
    else recording.requestRecord(target.filmSetNodeId, target.clipId);
    return new Promise((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clean = () => { clearTimeout(timer); context.signal.removeEventListener("abort", abort); };
      const fail = (message: string) => { if (finished) return; finished = true; clean(); reject(Error(message)); };
      const abort = () => fail("provider-request-aborted");
      const check = () => {
        if (finished) return;
        try {
          if (context.signal.aborted) return abort();
          const canvas = ctx.canvasState.getCanvas();
          if (!canvas || canvas.id !== context.canvas.id || source(canvas, context.ref).sourceIdentity !== context.source.sourceIdentity) return fail("provider-source-stale");
          const asset = ready(canvas, context.ref);
          if (asset) { finished = true; clean(); resolve(asset); return; }
          if (target.mediaKind === "image") {
            const state = images.state(target.filmSetNodeId, target.clipId);
            if (state.status === "failed") return fail(state.error ?? "静态镜头物化失败");
          } else if (recording.cache.status({ canvasId: canvas.id, filmSetNodeId: target.filmSetNodeId, clipId: target.clipId, contentIdentity: target.contentIdentity, profileKey: SHOT_REFERENCE_PROFILE_KEY }) === "failed") return fail("完整镜头视频物化失败，请重新录制");
          timer = setTimeout(check, 250);
        } catch (error) { fail(String(error)); }
      };
      context.signal.addEventListener("abort", abort, { once: true }); check();
    });
  };
  return { providerId: SHOT_MEDIA_PROVIDER_ID, owner: "film-set", schemaVersions: [1], mediaKinds: ["image", "video"],
    describe: source, resolvePreview: async context => ready(context.canvas, context.ref), materialize, snapshot: materialize };
}
