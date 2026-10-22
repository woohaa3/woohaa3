/** Synchronous IPC inside one input handler. Durations overlap input segments. */
export type NativeInputTiming = { calls: number; wallMs: number; maxMs: number; slowestMethod: string };
const METHODS = new Set(["set_scene", "set_viewport", "set_observer", "set_positions", "query_point_hit", "query_model_pick", "canvas_work_diagnostics"]);
let active: NativeInputTiming | undefined;
export function beginNativeInputTiming() {
  if (!import.meta.env.DEV || import.meta.env.VITE_WOOHAA_PERFORMANCE === "0") return () => undefined;
  const previous = active;
  const timing: NativeInputTiming = { calls: 0, wallMs: 0, maxMs: 0, slowestMethod: "other" };
  active = timing;
  return () => { active = previous; return timing.calls ? timing : undefined; };
}
export function recordNativeInputCall(method: string, ms: number) {
  if (!active || !Number.isFinite(ms) || ms < 0) return;
  active.calls++; active.wallMs += ms;
  if (ms >= active.maxMs) {
    active.maxMs = ms;
    active.slowestMethod = METHODS.has(method) ? method : method.startsWith("query_") ? "query_other" : "other";
  }
}
