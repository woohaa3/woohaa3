import type { ModelScriptReport } from "../../contracts.js";

/**
 * Identity of the canvas visit (and renderer scope inside it) that produced a report.
 *
 * `visit` increases on every canvas switch and on every renderer scope change, so A→B→A and a
 * same-canvas renderer recreation always produce a fresh value even when canvas id and node key
 * are unchanged. Reports from an earlier visit must never suppress or displace a later one.
 */
export type ModelScriptReportVisit = number;

/**
 * Remote bookkeeping has its own serial queue; local previews never await it.
 *
 * Every entry carries the `current` predicate of the visit that produced it, captured at
 * enqueue time and re-checked immediately before the request is sent. A report queued during
 * canvas visit A (or an earlier renderer scope of the same canvas) is therefore dropped once
 * that visit is gone, and a visit that comes back with the same canvas id / node key is never
 * suppressed by — nor confused with — the stale one.
 *
 * `hasPending` is visit-scoped: it only answers for the visit the caller is asking about, so a
 * stale entry from visit A can never hide visit B's outcome for the same node.
 */
export function createModelScriptReports(report: (value: ModelScriptReport) => Promise<void>) {
  type Entry = { value: ModelScriptReport; visit: ModelScriptReportVisit; current: () => boolean };
  // Keyed by `visit:nodeId`: two visits never compete for one slot.
  const pending = new Map<string, Entry>();
  let running = false;
  let stopped = false;
  let active: Entry | null = null;

  const key = (visit: ModelScriptReportVisit, nodeId: string) => `${visit}:${nodeId}`;

  const drain = async () => {
    running = true;
    try {
      while (!stopped && pending.size) {
        const [entryKey, entry] = pending.entries().next().value!;
        pending.delete(entryKey);
        if (!entry.current()) continue;
        active = entry;
        try {
          await report(entry.value);
        } catch {
          // A reporting failure must not prevent the next report or local preview.
        } finally {
          active = null;
        }
      }
    } finally {
      running = false;
      // Entries queued while the drain was finishing still need a runner. The loop itself
      // stops on `stopped`, so a disposed queue never restarts here.
      if (!stopped && pending.size) void drain();
    }
  };

  return {
    /** Does `visit` still have a report for `nodeId` that would actually be sent? */
    hasPending(visit: ModelScriptReportVisit, nodeId: string) {
      if (active?.value.nodeId === nodeId && active.visit === visit) return true;
      const entry = pending.get(key(visit, nodeId));
      return !!entry && entry.visit === visit && entry.current();
    },
    /**
     * Queue the newest outcome for `(visit, nodeId)`. A different visit keeps its own slot, so
     * an older visit can neither replace nor mask this one.
     */
    enqueue(value: ModelScriptReport, visit: ModelScriptReportVisit, current: () => boolean) {
      if (stopped) return;
      pending.set(key(visit, value.nodeId), { value, visit, current });
      if (!running) void drain();
    },
    /** Drop every entry that no longer belongs to a live visit. */
    retain(keep: (visit: ModelScriptReportVisit) => boolean) {
      for (const [entryKey, entry] of pending) {
        if (!keep(entry.visit)) pending.delete(entryKey);
      }
    },
    dispose() {
      stopped = true;
      pending.clear();
    },
  };
}
