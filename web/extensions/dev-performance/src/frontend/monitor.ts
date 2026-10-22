export type FrameMetrics = { fps: number; updatesPerSecond: number; averageMs: number | null; drawCalls3d: number | null };
export type FrameSnapshot = { instance: object; generation: number; renders: number; updates: number; drawCalls3d?: number };

const validDraws = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0;

type FrameSource = Pick<Window, "setInterval" | "clearInterval"> & {
  performance: Pick<Performance, "now">;
  document: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
};

/** 每秒读一次 Bevy 累计计数；不另建逐帧循环，不把浏览器回调频率当成画布 FPS。 */
export function startFrameMonitor(
  source: FrameSource,
  read: () => FrameSnapshot | null,
  publish: (metrics: FrameMetrics | null) => void
): () => void {
  let timer: number | undefined;
  let previous: (FrameSnapshot & { at: number }) | undefined;
  let disposed = false;
  const sample = () => {
    if (disposed || source.document.hidden) return;
    let counters: FrameSnapshot | null;
    try { counters = read(); } catch { counters = null; }
    const at = source.performance.now();
    if (!counters || ![counters.renders, counters.updates].every(value => Number.isFinite(value) && value >= 0)) {
      previous = undefined;
      publish(null);
      return;
    }
    const elapsed = previous ? at - previous.at : 0;
    if (previous && elapsed > 0 && counters.instance === previous.instance && counters.generation === previous.generation
      && counters.renders >= previous.renders && counters.updates >= previous.updates) {
      const renders = counters.renders - previous.renders;
      publish({
        fps: renders * 1000 / elapsed,
        updatesPerSecond: (counters.updates - previous.updates) * 1000 / elapsed,
        averageMs: renders > 0 ? elapsed / renders : null,
        drawCalls3d: renders > 0 && validDraws(counters.drawCalls3d) && validDraws(previous.drawCalls3d)
          && counters.drawCalls3d >= previous.drawCalls3d
          ? (counters.drawCalls3d - previous.drawCalls3d) / renders : null
      });
    } else publish(null);
    previous = { ...counters, at };
  };
  const visibility = () => {
    if (timer !== undefined) source.clearInterval(timer);
    timer = undefined;
    previous = undefined;
    publish(null);
    if (!disposed && !source.document.hidden) {
      sample();
      timer = source.setInterval(sample, 1000);
    }
  };
  source.document.addEventListener("visibilitychange", visibility);
  visibility();
  return () => {
    disposed = true;
    if (timer !== undefined) source.clearInterval(timer);
    source.document.removeEventListener("visibilitychange", visibility);
  };
}
