import { beginBrowserTaskProfile } from "./browser-task-profile.js";
import { beginPhotocraftProfile, endPhotocraftProfile } from "./photocraft-performance.js";
/** Opt-in development recorder. No per-frame renderer calls or console logging. */
import { resetSceneDiagnostics, sceneDiagnosticsSnapshot } from "../plugins/canvas-runtime/scene-diagnostics.js";
import { beginInteractionProfile, endInteractionProfile } from "./interaction-phase-profiler.js";

type Renderer = { getWorkDiagnostics?(): Record<string, unknown>; generation?(): number; isReady?(): boolean };
export function numericDelta(end: Record<string, unknown>, start: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(end).flatMap<[string, unknown]>(([key, value]) => {
    const before = start[key];
    if (typeof value === "number" && typeof before === "number") return [[key, value - before]];
    if (value && before && typeof value === "object" && typeof before === "object" && !Array.isArray(value)) {
      return [[key, numericDelta(value as Record<string, unknown>, before as Record<string, unknown>)]];
    }
    return [];
  }));
}
export function intervalSummary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] : null;
  return { samples: sorted.length, meanMs: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    p95Ms: at(0.95), p99Ms: at(0.99), maxMs: at(1) };
}
export function installPerformanceRecorder(target: Window = window): () => void {
  if (!import.meta.env.DEV || import.meta.env.VITE_WOOHAA_PERFORMANCE === "0"
    || new URLSearchParams(target.location.search).get("recordPerformance") !== "1") return () => {};
  const doc = target.document;
  const panel = doc.createElement("div");
  panel.style.cssText = "position:fixed;right:16px;top:48px;z-index:2147483647;background:#173440;color:#fff;padding:10px;border-radius:8px;font:12px sans-serif;max-width:520px";
  const record = doc.createElement("button"); record.textContent = "Record · 10s";
  const download = doc.createElement("button"); download.textContent = "下载 JSON"; download.hidden = true;
  const close = doc.createElement("button"); close.textContent = "收起结果"; close.hidden = true;
  const status = doc.createElement("span"); status.style.marginLeft = "8px";
  const output = doc.createElement("pre"); output.hidden = true;
  output.style.cssText = "max-height:45vh;overflow:auto;white-space:pre-wrap;user-select:text";
  panel.append(record, download, close, status, output); doc.body.append(panel);
  let frame: number | null = null, timer: number | null = null, result = "", disposed = false;
  let browserTasks: ReturnType<typeof beginBrowserTaskProfile> | null = null;
  const renderer = () => (target as Window & { __bevyRuntime?: Renderer }).__bevyRuntime;
  const stop = () => {
    if (frame !== null) target.cancelAnimationFrame(frame);
    if (timer !== null) target.clearTimeout(timer);
    frame = timer = null; record.disabled = false;
    const browserTaskProfile = browserTasks?.stop(); browserTasks = null;
    return { browserTaskProfile, interactionProfile: endInteractionProfile(), photocraftProfile: endPhotocraftProfile() };
  };
  const cancel = () => { if (timer !== null && doc.visibilityState === "hidden") { stop(); status.textContent = "采集已取消：页面切到后台"; } };
  record.onclick = () => {
    if (disposed || record.disabled) return;
    const owner = renderer();
    if (!owner?.getWorkDiagnostics || owner.isReady?.() === false || doc.visibilityState === "hidden") { status.textContent = "请等待渲染器就绪并保持页面可见"; return; }
    let workStart: Record<string, unknown>;
    try { workStart = owner.getWorkDiagnostics(); } catch { status.textContent = "渲染统计不可用"; return; }
    resetSceneDiagnostics();
    beginInteractionProfile();
    beginPhotocraftProfile();
    output.hidden = download.hidden = close.hidden = true;
    result = ""; record.disabled = true; status.textContent = "采集中，请操作模型…";
    const instance = owner.generation?.();
    const size = [target.innerWidth, target.innerHeight, target.devicePixelRatio];
    const started = target.performance.now();
    browserTasks = beginBrowserTaskProfile(target, started);
    let previous: number | null = null;
    const intervals: number[] = [];
    const rafGaps: Array<{ atMs: number; durationMs: number }> = [];
    const tick = (time: number) => {
      if (previous !== null) {
        const durationMs = time - previous;
        intervals.push(durationMs);
        if (durationMs >= 25 && rafGaps.length < 128) rafGaps.push({ atMs: previous - started, durationMs });
      }
      previous = time; frame = target.requestAnimationFrame(tick);
    };
    frame = target.requestAnimationFrame(tick);
    timer = target.setTimeout(() => {
      const elapsedMs = target.performance.now() - started;
      const { interactionProfile, photocraftProfile, browserTaskProfile } = stop();
      if (disposed) return;
      if (renderer() !== owner || owner.generation?.() !== instance) { status.textContent = "渲染器已更换，请重新采集"; return; }
      if (size[0] !== target.innerWidth || size[1] !== target.innerHeight || size[2] !== target.devicePixelRatio) { status.textContent = "窗口尺寸已变化，请重新采集"; return; }
      try {
        const workEnd = owner.getWorkDiagnostics!();
        result = JSON.stringify({ schema: "woohaa-performance-record-v1", capturedAt: new Date().toISOString(),
          elapsedMs, viewport: { width: target.innerWidth, height: target.innerHeight, pixelRatio: target.devicePixelRatio },
          // Browser callback intervals are not CPU frame execution time or GPU timings.
          rafIntervals: intervalSummary(intervals), rafGaps, browserTaskProfile, scene: sceneDiagnosticsSnapshot(), interactionProfile, photocraftProfile,
          rendererWorkDelta: numericDelta(workEnd, workStart) }, null, 2);
        output.textContent = result; output.hidden = download.hidden = close.hidden = false;
        status.textContent = `完成 · ${(elapsedMs / 1000).toFixed(2)}s`;
      } catch { status.textContent = "读取渲染统计失败，请重试"; }
    }, 10000);
  };
  close.onclick = () => { output.hidden = !output.hidden; close.textContent = output.hidden ? "展开结果" : "收起结果"; };
  download.onclick = () => {
    const url = URL.createObjectURL(new Blob([result], { type: "application/json" }));
    const anchor = doc.createElement("a"); anchor.href = url; anchor.download = "woohaa-performance.json"; anchor.click();
    URL.revokeObjectURL(url);
  };
  doc.addEventListener("visibilitychange", cancel);
  return () => { disposed = true; stop(); doc.removeEventListener("visibilitychange", cancel); panel.remove(); };
}
