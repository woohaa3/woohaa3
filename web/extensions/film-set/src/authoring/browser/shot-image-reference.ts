import { pinFilmSetCapture } from "../../state/browser/capture-snapshot.js";
import {
  filmSetAnimationsOf, shotPreviewNodeId,
  shotImageReferenceIdentity, shotImageReferenceAssetId, readyShotImageAsset,
  SHOT_IMAGE_REFERENCE_ROLE, SHOT_IMAGE_REFERENCE_METADATA_KEY,
  type StoredAsset, type ShotReferenceAssetLink
} from "@woohaa3/contracts";
import type { FilmSetHostContext } from "../../state/browser/host-ports.js";
import { readAnimation } from "../../state/browser/animation-projection.js";
import { recordingThemeBackdrop } from "./recording-theme-backdrop.js";

export type ShotImageState = { status: "dirty" | "preparing" | "ready" | "failed"; error?: string; asset?: StoredAsset };
type Target = ShotReferenceAssetLink & { canvasId: string; width: number; height: number; background: string; title: string };
export type ShotImageReferences = ReturnType<typeof installShotImageReferences>;

/** One extension-owned, bounded still producer. Assets become ready only after authoritative acknowledgement. */
export function installShotImageReferences(ctx: FilmSetHostContext, playback: { beginStillCapture(): () => void }) {
  const states = new Map<string, ShotImageState>();
  const uploaded = new Map<string, StoredAsset>();
  const listeners = new Set<() => void>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const attempts = new Map<string, number>();
  const pendingMappings = new Map<string, string>();
  let revision = 0, generation = 4_000_000;
  let active: { key: string; controller: AbortController } | null = null;
  let disposed = false;
  const notify = () => { revision++; for (const listener of listeners) listener(); };
  const targets = (): Target[] => {
    const canvas = ctx.canvasState.getCanvas();
    if (!canvas) return [];
    return canvas.document.nodes.flatMap(node => {
      const animation = readAnimation(canvas, node.id);
      if (!animation) return [];
      return filmSetAnimationsOf(animation).clips.flatMap(clip => {
        const background = clip.backdrop && clip.backdrop !== "theme" ? clip.backdrop : recordingThemeBackdrop(ctx);
        const identity = shotImageReferenceIdentity({ animation, clipId: clip.id, background, assets: canvas.assets });
        return identity ? [{ ...identity, filmSetNodeId: node.id, clipId: clip.id, canvasId: canvas.id, background, title: clip.name }] : [];
      });
    });
  };
  const keyOf = (target: Target) => `${target.canvasId}:${shotImageReferenceAssetId(target)}`;
  const current = (target: Target) => targets().some(candidate => keyOf(candidate) === keyOf(target));
  const check = (target: Target, signal: AbortSignal) => {
    if (disposed || signal.aborted || !current(target)) throw new Error("shot-image-version-stale: 镜头版本已变化，请重新执行");
    if (!ctx.canvasSession.isWritable()) throw new Error("shot-image-permission-denied: 当前画布不可写");
  };
  const freeze = () => {
    if (!ctx.canvasSession.isWritable()) return;
    const canvas = ctx.canvasState.getCanvas();
    if (!canvas) return;
    const available = targets();
    for (const node of canvas.document.nodes) {
      const mappings = canvas.nodeData[node.id]?.inputMapping ?? [];
      let changed = false;
      const next = mappings.map(mapping => {
        if (mapping.role !== SHOT_IMAGE_REFERENCE_ROLE) return mapping;
        const target = available.find(target => shotPreviewNodeId(target.filmSetNodeId, target.clipId) === mapping.sourceNodeId);
        const asset = target ? readyShotImageAsset(canvas.assets, target) : null;
        if (asset && mapping.sourceAssetIds?.length === 1 && mapping.sourceAssetIds[0] === asset.id) return mapping;
        if (!asset && !mapping.sourceAssetIds?.length) return mapping;
        changed = true;
        return { ...mapping, sourceAssetIds: asset ? [asset.id] : [] };
      });
      const pendingKey = `${canvas.id}:${node.id}`, fingerprint = JSON.stringify([mappings, next]);
      if (changed && pendingMappings.get(pendingKey) !== fingerprint) {
        pendingMappings.set(pendingKey, fingerprint);
        const submitted = ctx.canvasSession.submitCommands([{ type: "nodeData.patch", nodeId: node.id,
          value: { inputMapping: next }, expectedInputMapping: mappings }], `shot-image-freeze-${crypto.randomUUID()}`);
        if (submitted.ok) void submitted.handle.settled.finally(() => pendingMappings.delete(pendingKey));
        else pendingMappings.delete(pendingKey);
      }
    }
  };
  const prepare = async (target: Target, signal: AbortSignal) => {
    const key = keyOf(target);
    states.set(key, { status: "preparing" }); notify();
    let release: (() => void) | undefined, restore: (() => void) | undefined, unpin: (() => void) | undefined;
    try {
      check(target, signal);
      let asset = uploaded.get(key);
      if (!asset) {
        release = await ctx.modelWorkspace.acquireCapture(); check(target, signal);
        unpin = pinFilmSetCapture(ctx, target.filmSetNodeId, ctx.canvasState.getCanvas());
        restore = playback.beginStillCapture();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); check(target, signal);
        // First readback establishes offscreen demand/pins. Media is then explicitly held at zero.
        const runtime = ctx.canvasRuntime.runtime();
        if (!runtime?.isReady()) throw new Error("画布渲染器未就绪");
        const nodeId = shotPreviewNodeId(target.filmSetNodeId, target.clipId);
        await runtime.requestCapture({ nodeId, generation: generation++, width: target.width, height: target.height }); check(target, signal);
        const ready = await (ctx.canvasRuntime.compositeAssetMediaSessions?.()?.waitForTime(target.filmSetNodeId, 0, 5000, .001) ?? Promise.resolve(true));
        if (!ready) throw new Error("镜头媒体零点帧未就绪");
        const frame = await runtime.requestCapture({ nodeId, generation: generation++, width: target.width, height: target.height }); check(target, signal);
        if (!frame || frame.width !== target.width || frame.height !== target.height) throw new Error("镜头图片捕获失败或尺寸不符");
        const canvas = new OffscreenCanvas(frame.width, frame.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("PNG 编码器不可用");
        context.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/png" }); check(target, signal);
        restore(); restore = undefined; unpin(); unpin = undefined; release(); release = undefined;
        const result = await ctx.mediaRemote.upload({ file: new File([blob], "shot-reference.png", { type: "image/png" }), canvasId: target.canvasId, signal });
        check(target, signal);
        if (!result.ok) throw new Error(result.error);
        asset = { id: shotImageReferenceAssetId(target), title: `${target.title} · 图片参考`, url: result.media.url, mediaKind: "image", source: "generated", status: "ready", createdAt: new Date().toISOString(),
          metadata: { storageKey: result.media.storageKey, checksum: result.media.checksum, contentType: "image/png", size: result.media.size,
            width: target.width, height: target.height, background: target.background,
            [SHOT_IMAGE_REFERENCE_METADATA_KEY]: { filmSetNodeId: target.filmSetNodeId, clipId: target.clipId, contentIdentity: target.contentIdentity, profileKey: target.profileKey } } };
        uploaded.set(key, asset);
      }
      check(target, signal);
      const submitted = ctx.canvasSession.submitCommands([{ type: "asset.upsert", asset }], `shot-image-save-${crypto.randomUUID()}`);
      if (!submitted.ok) throw new Error(submitted.reason);
      const settled = await submitted.handle.settled; check(target, signal);
      if (settled.state === "rejected") throw new Error(settled.error ?? "图片参考登记失败");
      states.set(key, { status: "ready", asset }); uploaded.delete(key); attempts.delete(key); notify(); freeze();
    } catch (cause) {
      if (!signal.aborted && !disposed) {
        const error = cause instanceof Error ? cause.message : String(cause);
        states.set(key, { status: "failed", error }); notify();
        const attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
        if (attempt <= 5 && !/permission|version-stale/.test(error)) retryTimers.set(key, setTimeout(() => {
          retryTimers.delete(key); states.delete(key); reconcile();
        }, Math.min(2000 * 2 ** (attempt - 1), 30000)));
      }
    } finally { restore?.(); unpin?.(); release?.(); if (signal.aborted && states.get(key)?.status !== "ready") states.delete(key); }
  };
  const reconcile = () => {
    if (disposed) return;
    const all = targets(), keys = new Set(all.map(keyOf));
    if (active && !keys.has(active.key)) active.controller.abort();
    if (active && (!ctx.canvasSession.isWritable() || document.hidden)) active.controller.abort();
    for (const [key, timer] of retryTimers) if (!keys.has(key)) { clearTimeout(timer); retryTimers.delete(key); }
    for (const key of states.keys()) if (!keys.has(key) && active?.key !== key) { states.delete(key); uploaded.delete(key); attempts.delete(key); }
    for (const key of uploaded.keys()) if (!keys.has(key)) uploaded.delete(key);
    for (const key of attempts.keys()) if (!keys.has(key)) attempts.delete(key);
    const canvas = ctx.canvasState.getCanvas();
    for (const target of all) {
      const asset = readyShotImageAsset(canvas?.assets ?? [], target), key = keyOf(target);
      if (asset && states.get(key)?.status !== "ready") { states.set(key, { status: "ready", asset }); notify(); }
    }
    freeze();
    const mode = ctx.canvasNavigation.getSnapshot().mode;
    if (active && mode.type === "node-focus" && all.some(target => keyOf(target) === active?.key && target.filmSetNodeId === mode.nodeId)) active.controller.abort();
    if (active || !ctx.canvasSession.isWritable() || document.hidden) return;
    const target = all.find(target => !(mode.type === "node-focus" && mode.nodeId === target.filmSetNodeId) && !states.has(keyOf(target)));
    if (!target) return;
    const controller = new AbortController(); active = { key: keyOf(target), controller };
    void prepare(target, controller.signal).finally(() => { active = null; reconcile(); });
  };
  const subscriptions = [ctx.canvasState.subscribe(reconcile), ctx.canvasNavigation.subscribe(reconcile)];
  const theme = (ctx as { get?: (name: string) => unknown }).get?.("theme") as { subscribe?: (fn: () => void) => () => void } | undefined;
  if (theme?.subscribe) subscriptions.push(theme.subscribe(reconcile));
  document.addEventListener("visibilitychange", reconcile);
  reconcile();
  return {
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    revision: () => revision,
    isStatic: (filmSetNodeId: string, clipId: string) => targets().some(target => target.filmSetNodeId === filmSetNodeId && target.clipId === clipId),
    state(filmSetNodeId: string, clipId: string): ShotImageState {
      const target = targets().find(target => target.filmSetNodeId === filmSetNodeId && target.clipId === clipId);
      return target ? states.get(keyOf(target)) ?? { status: "dirty" } : { status: "failed", error: "镜头不存在或不是静态镜头" };
    },
    retry(filmSetNodeId: string, clipId: string) {
      const target = targets().find(target => target.filmSetNodeId === filmSetNodeId && target.clipId === clipId);
      if (!target) return;
      const key = keyOf(target); clearTimeout(retryTimers.get(key)); retryTimers.delete(key); attempts.delete(key); states.delete(key); reconcile();
    },
    async download(filmSetNodeId: string, clipId: string) {
      const target = targets().find(target => target.filmSetNodeId === filmSetNodeId && target.clipId === clipId);
      const asset = target && readyShotImageAsset(ctx.canvasState.getCanvas()?.assets ?? [], target);
      if (!target || !asset) return;
      try {
        const response = await fetch(ctx.mediaRemote.urlFor(String(asset.metadata!.storageKey), target.canvasId));
        if (!response.ok) throw new Error(`图片下载失败 (${response.status})`);
        const url = URL.createObjectURL(await response.blob());
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${target.title}.png`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (cause) { states.set(keyOf(target), { status: "ready", asset, error: String(cause) }); notify(); }
    },
    dispose() { disposed = true; active?.controller.abort(); subscriptions.forEach(unsubscribe => unsubscribe()); retryTimers.forEach(clearTimeout); uploaded.clear(); attempts.clear(); pendingMappings.clear(); listeners.clear(); document.removeEventListener("visibilitychange", reconcile); }
  };
}
