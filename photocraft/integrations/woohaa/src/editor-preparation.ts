type State = { nodeId: string | null; phase: "loading" | "failed"; message: string };
type Input = { nodeId: string; kind: string; owner: "direct" | "history"; preserveOverviewReturn?: boolean };

/** Owns only a user's pending entry, never the document or the installation itself. */
export function createEditorPreparation(options: {
  prepare(): Promise<void>;
  enter(input: Input, signal: AbortSignal): Promise<{ ok: boolean; reason?: string }>;
  stillCurrent(nodeId: string): boolean;
}) {
  let state: State = { nodeId: null, phase: "loading", message: "" };
  let generation = 0, disposed = false;
  let entering: { nodeId: string; generation: number } | null = null;
  let abort: AbortController | null = null;
  let lastInput: Input | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: State) => { state = next; for (const listener of listeners) listener(); };
  const cancel = () => { abort?.abort(); generation++; publish({ nodeId: null, phase: "loading", message: "" }); };
  const start = (input: Input) => {
    const { nodeId } = input;
    if (disposed || (state.nodeId === nodeId && state.phase === "loading")) return;
    abort?.abort();
    const attempt = new AbortController(); abort = attempt; lastInput = input;
    const current = ++generation;
    publish({ nodeId, phase: "loading", message: "正在准备图片编辑器…" });
    void (async () => {
      try {
        await options.prepare();
        if (disposed || current !== generation) return;
        if (!options.stillCurrent(nodeId)) { cancel(); return; }
        entering = { nodeId, generation: current };
        const result = await options.enter(input, attempt.signal);
        if (disposed || current !== generation) return;
        if (!result.ok) throw new Error(result.reason ?? "暂时无法进入编辑器，请重试");
        cancel();
      } catch (error) {
        if (!disposed && current === generation) publish({ nodeId, phase: "failed", message: error instanceof Error ? error.message : "编辑器准备失败，请重试" });
      } finally { if (entering?.generation === current) entering = null; }
    })();
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    guard: (input: Input): string | null => {
      const { nodeId, kind, owner } = input;
      if (kind !== "image" || owner !== "direct" || (entering?.nodeId === nodeId && entering.generation === generation && !abort?.signal.aborted)) return null;
      start(input);
      return "正在准备图片编辑器…";
    },
    retry: () => { if (state.nodeId && lastInput) start(lastInput); },
    cancel,
    dispose: () => { disposed = true; cancel(); listeners.clear(); }
  };
}
