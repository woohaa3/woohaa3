/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useSyncStatusView } from "./use-sync-status.js";
import type { SyncStatusInput, SyncStatusView } from "./sync-status.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function harness() {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), root = createRoot(host);
  let view: SyncStatusView;
  const base: SyncStatusInput = { mode: "remote", phase: "synced", pendingCount: 0, error: null, revision: 1 };
  function Status({ input }: { input: SyncStatusInput }) { view = useSyncStatusView(input); return null; }
  cleanups.push(() => act(() => root.unmount()));
  return { render: (input: Partial<SyncStatusInput>) => { act(() => root.render(<Status input={{ ...base, ...input }} />)); return view!; },
    advance: (ms: number) => { act(() => vi.advanceTimersByTime(ms)); return view!; } };
}
it("short saves retain their real pending label without opening the tooltip; sustained queues appear", () => {
  const h = harness();
  expect(h.render({ pendingCount: 1 })).toMatchObject({ tone: "warning", pinned: false, label: expect.stringContaining("待保存") });
  h.advance(200); expect(h.render({})).toMatchObject({ tone: "ok", pinned: false });
  expect(h.advance(1000).pinned).toBe(false);
  h.render({ pendingCount: 1 }); h.advance(300);
  h.render({ pendingCount: 2 });
  expect(h.advance(200)).toMatchObject({ pinned: true, label: expect.stringContaining("2 项") });
  h.render({}); expect(h.render({ pendingCount: 1 }).pinned).toBe(false);
});
it("errors, disconnects, permission changes and reconnects are visible immediately", () => {
  const h = harness();
  h.render({ pendingCount: 1 });
  for (const input of [{ error: "保存失败" }, { phase: "offline" as const }, { readOnly: true }, { reconnecting: true }]) {
    expect(h.render({ pendingCount: 1, ...input }).pinned).toBe(true);
  }
});
