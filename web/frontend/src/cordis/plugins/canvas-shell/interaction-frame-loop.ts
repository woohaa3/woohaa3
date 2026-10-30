/** One cancellable rAF owner. Independent steps and diagnostics cannot stop it. */
export function createInteractionFrameLoop(deps: {
  target: Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">;
  advance: () => void;
  render: () => void;
  report: (operation: string, error: unknown) => void;
  recovered: (operation: string) => void;
  /** 可选的步骤耗时观察者（遥测归因：只读时钟并累加数字）。 */
  measure?: (operation: string, ms: number) => void;
}) {
  let disposed = false;
  let frame: number | null = null;
  const clock = (): number | undefined => {
    const value = globalThis.performance?.now?.();
    return typeof value === "number" ? value : undefined;
  };
  const step = <T>(operation: string, invoke: () => T, fallback: T): T => {
    const started = deps.measure ? clock() : undefined;
    try {
      const result = invoke();
      try { deps.recovered(operation); } catch { /* Diagnostic isolation. */ }
      return result;
    } catch (error) {
      try { deps.report(operation, error); } catch { /* Diagnostic isolation. */ }
      return fallback;
    } finally {
      if (started !== undefined) {
        const now = clock();
        if (now !== undefined) {
          try { deps.measure?.(operation, now - started); } catch { /* Diagnostic isolation. */ }
        }
      }
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
