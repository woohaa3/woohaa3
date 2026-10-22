import { measureInteractionPhase } from "../../performance/interaction-phase-profiler.js";
/** One cancellable rAF owner. Independent steps and diagnostics cannot stop it. */
export function createInteractionFrameLoop(deps: {
  target: Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">;
  advance: () => void;
  render: () => void;
  report: (operation: string, error: unknown) => void;
  recovered: (operation: string) => void;
}) {
  let disposed = false;
  let frame: number | null = null;
  const step = <T>(operation: string, invoke: () => T, fallback: T): T => {
    try {
      const result = operation === "frame" ? invoke() : measureInteractionPhase(operation, invoke);
      try { deps.recovered(operation); } catch { /* Diagnostic isolation. */ }
      return result;
    } catch (error) {
      try { deps.report(operation, error); } catch { /* Diagnostic isolation. */ }
      return fallback;
    }
  };
  const tick = () => {
    frame = null;
    if (disposed) return;
    try {
      step("model-fly", deps.advance, undefined);
      step("frame", deps.render, undefined);
    } finally {
      if (!disposed) frame = deps.target.requestAnimationFrame(tick);
    }
  };
  return {
    step,
    start() { if (!disposed && frame === null && typeof deps.target.requestAnimationFrame === "function") frame = deps.target.requestAnimationFrame(tick); },
    dispose() { disposed = true; if (frame !== null) deps.target.cancelAnimationFrame?.(frame); frame = null; }
  };
}
