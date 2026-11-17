import { createEmptyWoohaa3ServerCanvas, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import type { RasterCanvas } from "../media-raster.js";
import type { BevyRuntime } from "../bevy-runtime.js";
import type { VideoElementLike } from "../video-frame-session.js";

export const STORAGE = `sha256-${"a".repeat(64)}`;

export function videoCanvas(
  nodes: Array<{ id: string; outputAssetId?: string }>,
  options: { posterUrl?: string; status?: StoredAsset["status"]; mediaKind?: StoredAsset["mediaKind"] } = {}
): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: nodes.map((node) => ({ id: node.id, type: "video", position: { x: 0, y: 0 } })) },
    nodeData: Object.fromEntries(nodes.map((node) => [node.id, node.outputAssetId ? { outputAssetId: node.outputAssetId } : {}])) as ServerCanvas["nodeData"],
    assets: nodes.filter((node) => node.outputAssetId).map((node) => ({
      id: node.outputAssetId!, title: "v", mediaKind: options.mediaKind ?? "video", source: "generated",
      status: options.status ?? "ready", url: `/api/media/${STORAGE}`,
      ...(options.posterUrl ? { posterUrl: options.posterUrl } : {}),
      createdAt: "2026-09-26T00:00:00.000Z",
      metadata: { storageKey: STORAGE, checksum: "a".repeat(64), contentType: "video/mp4", size: 4 }
    }))
  };
}

export type FakeVideo = VideoElementLike & {
  emit(type: string): void;
  emitLoaded(): void;
  emitFrame(): void;
  playCalls: number;
  pauseCalls: number;
};

export function fakeVideo(options: { width?: number; height?: number; duration?: number; rvfc?: boolean; rejectPlay?: boolean } = {}): FakeVideo {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  let rvfcHandle = 0;
  const pendingCallbacks = new Map<number, (now: number) => void>();
  const video: FakeVideo = {
    src: "", muted: false, loop: false, playsInline: false, preload: "", crossOrigin: null,
    currentTime: 0, duration: options.duration ?? 2, videoWidth: options.width ?? 160, videoHeight: options.height ?? 90,
    playCalls: 0, pauseCalls: 0,
    play() { video.playCalls += 1; return options.rejectPlay ? Promise.reject(new Error("autoplay blocked")) : Promise.resolve(); },
    pause() { video.pauseCalls += 1; }, removeAttribute() { video.src = ""; },
    addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(handler); },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    emit(type) { for (const handler of listeners.get(type) ?? []) handler({}); },
    emitLoaded() { for (const handler of listeners.get("loadeddata") ?? []) handler({}); },
    emitFrame() {
      if (options.rvfc === false) return;
      const callbacks = [...pendingCallbacks.entries()]; pendingCallbacks.clear();
      for (const [, callback] of callbacks) callback(0);
    }
  };
  if (options.rvfc !== false) {
    video.requestVideoFrameCallback = (callback) => { const handle = ++rvfcHandle; pendingCallbacks.set(handle, callback); return handle; };
    video.cancelVideoFrameCallback = (handle) => { pendingCallbacks.delete(handle); };
  }
  return video;
}

export function fakeCanvas(): RasterCanvas {
  return { width: 0, height: 0, getContext: () => ({ drawImage: () => undefined, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }) };
}

export function runtimeRecorder(): { runtime: BevyRuntime; uploads: Array<{ id: string; width: number; height: number }> } {
  const uploads: Array<{ id: string; width: number; height: number }> = [];
  const runtime = { setTexture: (id: string, width: number, height: number) => uploads.push({ id, width, height }) } as unknown as BevyRuntime;
  return { runtime, uploads };
}
