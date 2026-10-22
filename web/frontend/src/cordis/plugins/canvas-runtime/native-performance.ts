/** Bounded dev-only timings. XHR wall time includes IPC wait; rAF is WebView cadence, not GPU FPS. */
import { nativeProtocolUrl } from "../../../desktop/native-protocol.js";
export function createNativePerformance(target: typeof globalThis, token: string) {
  if (!import.meta.env.DEV || import.meta.env.VITE_WOOHAA_PERFORMANCE === "0") return { record: (_name: string, _ms: number) => {}, recordWork: (_value: unknown, _start: number, _end: number) => {}, dispose: () => {} };
  const groups = new Map<string, { count: number; sum: number; recent: number[]; cursor: number }>();
  let disposed = false, sending: XMLHttpRequest | null = null;
  let work: Record<string, number> | undefined;
  const recordWork = (value: unknown, started: number, ended: number) => {
    if (disposed || !value || typeof value !== "object") return;
    const input = value as { renderStages?: { work?: Record<string, unknown> }; snapshotBuilds?: number; pickCandidateBuilds?: number; meshBuilds?: number };
    work = { readStartedAtMonotonicMs: started, observedAtMonotonicMs: ended, readWallMs: Math.max(0, ended - started) };
    for (const key of ["renderMs", "renderFrames", "queueMs", "prepareMs", "prepareFrames"])
      if (typeof input.renderStages?.work?.[key] === "number") work[key] = input.renderStages.work[key] as number;
    for (const key of ["snapshotBuilds", "pickCandidateBuilds", "meshBuilds"] as const)
      if (typeof input[key] === "number") work[key] = input[key];
  };
  const record = (method: string, ms: number) => {
    const name = ["raf_interval", "set_scene", "set_viewport", "set_viewport_async", "set_observer", "set_positions", "query_point_hit", "query_model_pick", "texture", "layout", "canvas_work_diagnostics"].includes(method)
      ? method : method.startsWith("query_") ? "query_other" : ["runtime_health", "is_ready", "rendered_revision", "base_scene_generation", "viewport_capability", "observer_capability", "position_capability"].includes(method) ? "status" : "other";
    if (!Number.isFinite(ms) || ms < 0 || disposed) return;
    let data = groups.get(name);
    if (!data) { data = { count: 0, sum: 0, recent: [], cursor: 0 }; groups.set(name, data); }
    data.count++; data.sum += ms;
    data.recent[data.cursor] = ms; data.cursor = (data.cursor + 1) % 2048;
  };
  const snapshot = () => Object.fromEntries([...groups].map(([name, data]) => {
    const values = [...data.recent].sort((a, b) => a - b);
    const at = (q: number) => values[Math.max(0, Math.ceil(values.length * q) - 1)]!;
    return [name, { count: data.count, windowCount: values.length, meanMs: data.sum / data.count,
      p50Ms: at(.5), p95Ms: at(.95), maxMs: at(1) }];
  }));
  const timer = target.setInterval(() => {
    if (disposed || sending) return;
    const xhr = new target.XMLHttpRequest(); sending = xhr;
    xhr.open("POST", nativeProtocolUrl("rpc", target), true);
    xhr.setRequestHeader("X-Woohaa-Token", token);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.timeout = 5000;
    xhr.onloadend = () => { sending = null; };
    try { xhr.send(JSON.stringify({ method: "client_metrics", args: [snapshot(), work ?? null] })); }
    catch { sending = null; }
  }, 2000);
  let previous: number | null = null;
  const visibility = () => { previous = null; };
  target.document.addEventListener("visibilitychange", visibility);
  let raf = target.requestAnimationFrame(function frame(now) {
    if (disposed) return;
    if (target.document.visibilityState === "visible") {
      if (previous !== null) record("raf_interval", now - previous);
      previous = now;
    } else previous = null;
    raf = target.requestAnimationFrame(frame);
  });
  return { record, recordWork, dispose: () => { disposed = true; target.document.removeEventListener("visibilitychange", visibility); target.clearInterval(timer); target.cancelAnimationFrame(raf); sending?.abort(); } };
}
