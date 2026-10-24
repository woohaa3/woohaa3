import { useEffect, useState } from "react";
import { syncStatusView, type SyncStatusInput, type SyncStatusView } from "./sync-status.js";

/** Saves start immediately; only the automatic pending tooltip waits for sustained latency. */
export function useSyncStatusView(input: SyncStatusInput): SyncStatusView {
  const view = syncStatusView(input);
  const pending = input.pendingCount > 0 && input.mode === "remote" && input.phase === "synced"
    && !input.error && !input.readOnly && !input.reconnecting;
  const [revealPending, setRevealPending] = useState(false);
  useEffect(() => {
    setRevealPending(false);
    if (!pending) return;
    const timer = setTimeout(() => setRevealPending(true), 500);
    return () => clearTimeout(timer);
  }, [pending]);
  return pending && !revealPending ? { ...view, pinned: false } : view;
}
