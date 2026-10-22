import type { BevyModule } from "./bevy-runtime-types.js";
import { mergeRustWorkDiagnostics } from "./scene-diagnostics.js";
import { readResourceDiagnostics, type ResourceDiagnostics } from "./resource-diagnostics.js";

/** Native diagnostics are sampled asynchronously, never refreshed from input/submit. */
export function createWorkDiagnosticsCollector(target: typeof globalThis, current: () => BevyModule) {
  let disposed = false, pending = false;
  let resources: ResourceDiagnostics | undefined;
  const merge = (json: string, owner: BevyModule) => {
    if (disposed || owner !== current()) return;
    const parsed = JSON.parse(json) as Parameters<typeof mergeRustWorkDiagnostics>[0];
    mergeRustWorkDiagnostics(parsed, owner);
    resources = readResourceDiagnostics(parsed, target.performance?.now() ?? performance.now());
  };
  const refresh = () => {
    const owner = current();
    if (disposed || owner.async_canvas_work_diagnostics || !owner.canvas_work_diagnostics) return;
    try { merge(owner.canvas_work_diagnostics(), owner); } catch { /* Diagnostics cannot interrupt editing. */ }
  };
  const poll = async () => {
    if (disposed || pending || target.document?.visibilityState === "hidden") return;
    const owner = current();
    if (!owner.async_canvas_work_diagnostics) return;
    pending = true;
    try { merge(await owner.async_canvas_work_diagnostics(), owner); }
    catch { /* Next poll retries; no synchronous fallback. */ }
    finally { pending = false; }
  };
  const timer = import.meta.env.DEV && import.meta.env.VITE_WOOHAA_PERFORMANCE !== "0"
    && current().async_canvas_work_diagnostics ? target.setInterval(() => { void poll(); }, 1000) : null;
  return { refresh, resources: () => disposed ? undefined : resources,
    dispose() { disposed = true; if (timer !== null) target.clearInterval(timer); } };
}
