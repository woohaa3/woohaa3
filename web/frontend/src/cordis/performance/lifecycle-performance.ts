/// <reference types="vite/client" />
import { appPublicUrl } from "../services/app-base-path";

/** Lifecycle wall-clock spans are independent of synchronous interaction timing. */
export const LIFECYCLE_STAGES = [
  "app-start", "app-services", "page-services", "page-plugins", "page-resolve",
  "react-commit", "navigation-response", "navigation-dom", "navigation-load",
  "canvas-first-sync", "renderer-load", "wasm-module", "wasm-init", "renderer-ready",
  "renderer-first-render", "image-prepare", "video-first-frame", "model-prepare",
  "image-load-decode", "image-raster", "image-submit", "focus-bitmap-decode"
] as const;
export type LifecycleStage = typeof LIFECYCLE_STAGES[number];
export type LifecycleOutcome = "ok" | "error" | "cancelled";
export type LifecycleSample = {
  stage: LifecycleStage;
  startedAt: number;
  durationMs: number;
  outcome: LifecycleOutcome;
  hidden: boolean;
  spanId: number;
};

export function createLifecycleRecorder(target: Window, enabled: boolean) {
  if (!enabled || !target.performance || typeof target.fetch !== "function") return undefined;
  const recorderId = target.crypto?.randomUUID?.() ?? `lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const samples: LifecycleSample[] = [];
  let sequence = 0, dropped = 0, spanId = 0, sending = false, disposed = false, leavingRequested = false;
  const active = new Map<number, (outcome?: LifecycleOutcome) => void>();
  const now = () => target.performance.now();
  const record = (stage: LifecycleStage, startedAt: number, durationMs: number, outcome: LifecycleOutcome, id: number, hidden: boolean) => {
    if (disposed || !Number.isFinite(durationMs) || durationMs < 0) return;
    if (samples.length >= 2048) { dropped++; return; }
    samples.push({ stage, startedAt, durationMs, outcome, hidden, spanId: id });
  };
  const begin = (stage: LifecycleStage) => {
    if (disposed) return (_outcome?: LifecycleOutcome) => {};
    if (active.size >= 2048) { dropped++; return (_outcome?: LifecycleOutcome) => {}; }
    const startedAt = now(), id = ++spanId;
    let hidden = target.document.hidden, ended = false;
    const end = (outcome: LifecycleOutcome = "ok") => {
      if (ended) return;
      ended = true;
      active.delete(id);
      record(stage, startedAt, now() - startedAt, outcome, id, hidden || target.document.hidden);
    };
    // A span crossing a background interval is flagged even if it ends in foreground.
    const markHidden = () => { hidden = true; };
    Object.assign(end, { markHidden });
    active.set(id, end);
    return end;
  };
  const metadata = () => {
    const identity = (target as Window & { __woohaaBuildIdentity?: Record<string, string> }).__woohaaBuildIdentity;
    return { userAgent: target.navigator.userAgent, timeOrigin: target.performance.timeOrigin,
      loadId: String(target.performance.timeOrigin), width: target.innerWidth, height: target.innerHeight,
      pixelRatio: target.devicePixelRatio, timingSchema: 2,
      identity: { js: identity?.js ?? import.meta.env.VITE_WOOHAA_JS_IDENTITY ?? "unknown",
        wasm: identity?.wasm ?? import.meta.env.VITE_WOOHAA_WASM_IDENTITY ?? "unknown", mode: import.meta.env.MODE } };
  };
  const flush = async (leaving = false) => {
    leavingRequested ||= leaving;
    if (sending || (!samples.length && !dropped)) return;
    const count = Math.min(samples.length, 256);
    const batch = { category: "lifecycle", recorderId, sequence: sequence++, dropped,
      metadata: metadata(), samples: samples.splice(0, count) };
    dropped = 0;
    sending = true;
    try {
      const response = await target.fetch(appPublicUrl("/__dev/performance/interactions"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(batch), keepalive: leavingRequested
      });
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      dropped += count + batch.dropped;
      console.warn("[performance] 启动/素材性能批次上传失败，已计入丢失数量");
    } finally { sending = false; }
    if (leavingRequested && samples.length) void flush(true);
  };
  const visibility = () => {
    if (!target.document.hidden) return;
    for (const end of active.values()) (end as typeof end & { markHidden(): void }).markHidden();
    void flush(true);
  };
  const pagehide = () => {
    for (const end of [...active.values()]) end("cancelled");
    void flush(true);
  };
  const navigation = () => {
    const entry = target.performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (!entry || entry.loadEventEnd <= 0) return;
    for (const [stage, end] of [["navigation-response", entry.responseEnd], ["navigation-dom", entry.domContentLoadedEventEnd],
      ["navigation-load", entry.loadEventEnd]] as const) {
      record(stage, 0, end, "ok", ++spanId, target.document.hidden);
    }
  };
  const loaded = () => { target.setTimeout(navigation, 0); };
  if (target.document.readyState === "complete") loaded();
  else target.addEventListener("load", loaded, { once: true });
  const timer = target.setInterval(() => { void flush(); }, 5000);
  target.document.addEventListener("visibilitychange", visibility);
  target.addEventListener("pagehide", pagehide);
  return { begin, flush, dispose() {
    pagehide();
    disposed = true;
    target.clearInterval(timer);
    target.document.removeEventListener("visibilitychange", visibility);
    target.removeEventListener("pagehide", pagehide);
    target.removeEventListener("load", loaded);
  } };
}

let recorder: ReturnType<typeof createLifecycleRecorder>;
function getRecorder() {
  if (!import.meta.env.DEV || import.meta.env.VITE_WOOHAA_PERFORMANCE === "0" || typeof window === "undefined") return;
  return recorder ??= createLifecycleRecorder(window, true);
}
const noop = (_outcome?: LifecycleOutcome) => {};
export function beginLifecycleSpan(stage: LifecycleStage): (outcome?: LifecycleOutcome) => void {
  return getRecorder()?.begin(stage) ?? noop;
}
export async function measureLifecycle<T>(stage: LifecycleStage, action: () => T | Promise<T>): Promise<T> {
  const end = beginLifecycleSpan(stage);
  try { const result = await action(); end(); return result; }
  catch (error) { end("error"); throw error; }
}
import.meta.hot?.dispose(() => { recorder?.dispose(); recorder = undefined; });
