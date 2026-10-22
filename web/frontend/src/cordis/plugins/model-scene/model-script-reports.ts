import type { ModelScriptReport } from "../../contracts.js";

/** Remote bookkeeping has its own serial queue; local previews never await it. */
export function createModelScriptReports(report: (value: ModelScriptReport) => Promise<void>) {
  const pending = new Map<string, { value: ModelScriptReport; current: () => boolean }>();
  let running = false;
  let stopped = false;
  let activeNodeId: string | null = null;

  const drain = async () => {
    running = true;
    try {
      while (!stopped && pending.size) {
        const [nodeId, entry] = pending.entries().next().value!;
        pending.delete(nodeId);
        if (!entry.current()) continue;
        activeNodeId = nodeId;
        try {
          await report(entry.value);
        } catch {
          // A reporting failure must not prevent the next report or local preview.
        } finally {
          activeNodeId = null;
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    hasPending(nodeId: string) {
      return activeNodeId === nodeId || pending.has(nodeId);
    },
    enqueue(value: ModelScriptReport, current: () => boolean) {
      if (stopped) return;
      // Keep only the latest queued outcome per node while an earlier request waits.
      pending.set(value.nodeId, { value, current });
      if (!running) void drain();
    },
    dispose() {
      stopped = true;
      pending.clear();
    },
  };
}
