/** Opt-in production playback evidence; no query credentials or full pixel buffers. */
import type { VideoElementLike } from "./video-frame-session.js";
type Fields = Record<string, string | number | boolean | null | undefined>;
type Entry = Fields & { at: string; session: string; nodeId: string; stage: string; count: number };
type Trace = { enabled: boolean; log: (stage: string, fields?: Fields, immediate?: boolean) => void };
const frames = new WeakMap<object, { trace: Trace; sequence: number; mediaTime: number }>();
let nextSession = 0;

export function createVideoPlaybackTrace(nodeId: string, scope = "focus"): Trace {
  const session = `video-${Date.now().toString(36)}-${++nextSession}`;
  const stages = new Map<string, { at: number; count: number; signature?: string }>();
  const enabled = videoPlaybackDiagnosticsEnabled();
  const trace: Trace = { enabled, log(stage, fields = {}, immediate = false) {
    if (!enabled) return;
    // Diagnostics must not change playback, even when console observers fail.
    try {
      const now = Date.now();
      const previous = stages.get(stage) ?? { at: -Infinity, count: 0 };
      previous.count += 1;
      stages.set(stage, previous);
      const signature = (stage === "texture-receipt" || stage === "heartbeat") ? JSON.stringify(fields) : undefined;
      if (signature !== undefined && signature === previous.signature) return;
      if (!immediate && now - previous.at < 1000) return;
      previous.signature = signature;
      previous.at = now;
      const entry: Entry = { ...fields, at: new Date(now).toISOString(), session, nodeId, scope, stage, count: previous.count };
      const host = globalThis as typeof globalThis & { __woohaaVideoPlaybackLog?: Entry[] };
      const log = host.__woohaaVideoPlaybackLog ??= [];
      log.push(entry);
      if (log.length > 200) log.splice(0, log.length - 200);
      console.info('[DEBUG-video-playback]', JSON.stringify(entry));
    } catch { /* Diagnostic failures cannot interrupt rendering. */ }
  } };
  trace.log("environment", { scope, userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
    secureContext: globalThis.isSecureContext }, true);
  return trace;
}

export function traceVideoPixels(pixels: Uint8Array, trace: Trace, sequence: number, mediaTime: number): void {
  if (!trace.enabled) return;
  frames.set(pixels, { trace, sequence, mediaTime });
  // Fixed-size sample distinguishes changing frames without copying/hash-scanning RGBA.
  let sample = 0;
  for (let i = 0; i < 32; i += 1) sample = (Math.imul(sample, 31) + (pixels[Math.floor(i * pixels.length / 32)] ?? 0)) >>> 0;
  trace.log('raster', { sequence, mediaTime, sample });
}

export function traceVideoTexture(pixels: object, stage: string, fields: Fields): void {
  const frame = frames.get(pixels);
  if (frame) frame.trace.log(stage, { ...fields, sequence: frame.sequence, mediaTime: frame.mediaTime });
}


/** Query opt-in survives in-page navigation, but stays within this tab. */
export function videoPlaybackDiagnosticsEnabled(): boolean {
  try {
    const flag = new URLSearchParams(globalThis.location?.search ?? "").get("woohaaVideoDebug");
    if (flag !== null) {
      try { globalThis.sessionStorage?.setItem("woohaaVideoDebug", flag === "1" ? "1" : "0"); } catch { /* storage may be blocked */ }
      return flag === "1";
    }
    return import.meta.env.DEV || globalThis.sessionStorage?.getItem("woohaaVideoDebug") === "1";
  } catch { return Boolean(import.meta.env.DEV); }
}

export function videoDiagnosticSource(source: string): string {
  try {
    const url = new URL(source, globalThis.location?.href ?? "http://local.invalid/");
    if (url.protocol === "blob:") return "blob:";
    if (url.protocol !== "http:" && url.protocol !== "https:") return url.protocol;
    return `${url.origin}${url.pathname}`;
  } catch { return "invalid-source"; }
}

type DiagnosticVideo = VideoElementLike & {
  currentSrc?: string; networkState?: number; ended?: boolean;
  error?: { code: number } | null;
  buffered?: { length: number; start(index: number): number; end(index: number): number };
  getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number };
};

/** A timer observes stalled decoders too; it never seeks, plays, or requests frames. */
export function observeVideoPlayback(trace: Trace, element: VideoElementLike): () => void {
  if (!videoPlaybackDiagnosticsEnabled()) return () => {};
  const video = element as DiagnosticVideo;
  const state = (): Fields => {
    const buffered: number[][] = [];
    try {
      for (let i = 0; i < Math.min(video.buffered?.length ?? 0, 4); i += 1) buffered.push([video.buffered!.start(i), video.buffered!.end(i)]);
    } catch { /* time ranges may change during observation */ }
    const quality = video.getVideoPlaybackQuality?.();
    return { currentTime: Number(video.currentTime), duration: Number.isFinite(video.duration) ? video.duration : null,
      readyState: video.readyState, networkState: video.networkState, paused: video.paused, seeking: video.seeking,
      ended: video.ended, width: video.videoWidth, height: video.videoHeight, errorCode: video.error?.code,
      buffered: JSON.stringify(buffered), decodedFrames: quality?.totalVideoFrames, droppedFrames: quality?.droppedVideoFrames,
      source: videoDiagnosticSource(video.currentSrc || video.src) };
  };
  const report = (stage: string, immediate = false) => {
    try { trace.log(stage, state(), immediate); } catch { /* observations cannot affect playback */ }
  };
  const handlers = ["loadstart", "loadedmetadata", "loadeddata", "canplay", "playing", "play", "pause", "ended", "waiting", "stalled", "suspend", "abort", "emptied", "seeking", "seeked", "error", "timeupdate"]
    .map(event => {
      const handler = () => report(event, event !== "timeupdate");
      video.addEventListener(event, handler);
      return { event, handler };
    });
  report("source", true);
  const timer = typeof document === "undefined" ? null : globalThis.setInterval(() => { if (!video.paused || (video.readyState ?? 0) < 2) report("heartbeat"); }, 2000);
  return () => {
    if (timer !== null) globalThis.clearInterval(timer);
    for (const { event, handler } of handlers) video.removeEventListener(event, handler);
  };
}

/** Separate one-byte same-origin probe, never a claim about the media element's own request. */
export function probeVideoSource(trace: Trace, source: string): () => void {
  if (!videoPlaybackDiagnosticsEnabled() || typeof location === "undefined") return () => {};
  let url: URL;
  try { url = new URL(source, location.href); } catch { return () => {}; }
  if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) {
    trace.log("range-probe-skipped", { reason: "non-same-origin", source: videoDiagnosticSource(source) }, true);
    return () => {};
  }
  let cancelled = false;
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), 5000);
  void fetch(url.href, { headers: { Range: "bytes=0-0" }, credentials: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal })
    .then(async response => {
      if (cancelled) { await response.body?.cancel(); return; }
      trace.log("range-probe", { status: response.status, contentType: response.headers.get("content-type"),
        contentLength: response.headers.get("content-length"), contentRange: response.headers.get("content-range"),
        acceptRanges: response.headers.get("accept-ranges"), contentEncoding: response.headers.get("content-encoding") }, true);
      await response.body?.cancel();
    }).catch(error => {
      if (cancelled) return;
      trace.log("range-probe-error", { error: error instanceof Error ? error.name : "unknown" }, true);
    }).finally(() => globalThis.clearTimeout(timer));
  return () => { cancelled = true; controller.abort(); globalThis.clearTimeout(timer); };
}
