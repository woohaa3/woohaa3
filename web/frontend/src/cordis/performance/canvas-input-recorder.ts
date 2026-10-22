import { appPublicUrl } from "../services/app-base-path.js";

/** Independent of consumed-gesture timing, so rejected clicks reach disk too. */
export function createCanvasInputRecorder<T>(target: Window) {
  if (!import.meta.env.DEV || import.meta.env.VITE_WOOHAA_PERFORMANCE === "0"
    || typeof target.fetch !== "function" || typeof target.setInterval !== "function") return undefined;
  const recorderId = target.crypto?.randomUUID?.() ?? `input-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pending: T[] = [];
  let dropped = 0, sequence = 0, disposed = false, leaving = false, warned = false;
  let flight: Promise<void> | null = null;
  let batch: { category: "canvas-input"; recorderId: string; sequence: number; dropped: number;
    pageLoadId: string; runtime: "native" | "wasm"; samples: T[] } | null = null;
  const flush = (): Promise<void> => {
    if (flight) return flight;
    if (!batch && !pending.length && !dropped) return Promise.resolve();
    if (!batch) {
      batch = { category: "canvas-input", recorderId, sequence: sequence++, dropped,
        pageLoadId: String(target.performance.timeOrigin),
        runtime: "__WOOHAA_NATIVE__" in target ? "native" : "wasm", samples: pending.splice(0, 16) };
      dropped = 0;
    }
    const payload = batch;
    flight = Promise.resolve().then(async () => {
      let succeeded = false;
      try {
        const response = await target.fetch(appPublicUrl("/__dev/performance/interactions"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(payload), keepalive: true
        });
        if (!response.ok) throw new Error(String(response.status));
        batch = null;
        succeeded = true;
        warned = false;
      } catch {
        // Retain the same batch/sequence for the next timer tick.
        if (!warned) console.warn("[canvas-input] 诊断写盘失败，正在等待重试");
        warned = true;
      } finally {
        flight = null;
      }
      if (succeeded && (leaving || pending.length >= 16) && (pending.length || dropped)) await flush();
    });
    return flight;
  };
  const pagehide = () => { leaving = true; void flush(); };
  const visibility = () => { if (target.document.hidden) void flush(); };
  const timer = target.setInterval(() => { void flush(); }, 500);
  target.addEventListener("pagehide", pagehide);
  target.document.addEventListener("visibilitychange", visibility);
  return {
    record(sample: T) {
      if (disposed) return;
      if (pending.length >= 256) { pending.shift(); dropped++; }
      pending.push(sample);
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      target.clearInterval(timer);
      target.removeEventListener("pagehide", pagehide);
      target.document.removeEventListener("visibilitychange", visibility);
      pagehide();
    }
  };
}
