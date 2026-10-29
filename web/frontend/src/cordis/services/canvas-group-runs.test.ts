import { afterEach, expect, it, vi } from "vitest";
import type { CanvasCreationView, ConversationTurn } from "@woohaa3/contracts";
import { createCanvasGroupRuns } from "./canvas-group-runs.js";
const creation = (id: string): CanvasCreationView => ({ requestId: id, canvasId: "c", rootGroupId: id, commandId: `cmd-${id}`, turnRequestId: `request-${id}`, scopeEpoch: 1, stage: "accepted", conversationId: `conversation-${id}`, turnId: `turn-${id}` });
const turn = (id: string, status = "running", requestId = `request-${id}`) => ({ requestId, conversationId: `conversation-${id}`, turnId: requestId, status, action: "generate", target: { mode: "canvas-group", canvasId: "c", nodeId: id }, createdAt: "2026-10-20T00:00:00Z" }) as ConversationTurn;
const disposers: (() => void)[] = [];
function fixture() {
  let space = "one", writable = true;
  const listeners = new Set<() => void>();
  const request = vi.fn().mockImplementation(async ({ path }) => ({ ok: true, data: path.includes("group-executions") ? { turns: [turn("g1"), turn("g2")] } : { creations: [creation("g1"), creation("g2")] } }));
  const cancelTurn = vi.fn().mockResolvedValue({ ok: true });
  const service = createCanvasGroupRuns({ canvasId: "c", transport: { request } as never, conversations: { readConversation: vi.fn(), cancelTurn }, user: {
    getSnapshot: () => ({ dataScopeId: space }) as never, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }
  }, writable: () => writable });
  disposers.push(service.dispose);
  return { service, request, cancelTurn, readonly: () => { writable = false; }, switchSpace: () => { space = "two"; listeners.forEach(fn => fn()); } };
}
afterEach(() => { disposers.splice(0).forEach(fn => fn()); vi.useRealTimers(); });
it("discovers hand-made groups and every execution page, merging creation by exact request without hiding active turns", async () => {
  const { service, request } = fixture();
  await service.refresh();
  request.mockImplementation(async ({ path }) => ({ ok: true, data: !path.includes("group-executions") ? { creations: [creation("g1")] }
    : path.includes("cursor=") ? { turns: [turn("manual"), turn("g1", "running", "earlier-active")] }
    : { turns: [turn("g1", "succeeded")], nextCursor: "page2" } }));
  const pending = service.refresh(); expect(service.refresh()).toBe(pending); await pending;
  expect(service.getSnapshot().rows).toHaveLength(3);
  expect(service.getSnapshot().rows.find(r => r.requestId === "request-g1")?.creation?.requestId).toBe("g1");
  expect(service.getSnapshot().rows.find(r => r.rootGroupId === "manual")?.creation).toBeUndefined();
  expect(service.getSnapshot().rows[0].active).toBe(true);
  expect(service.getSnapshot().rows.some(r => r.requestId === "earlier-active" && r.active)).toBe(true);
});
it("retains the confirmed projection on a failed later page and keeps exact action identities", async () => {
  const { service, request, cancelTurn, readonly } = fixture(); await service.refresh();
  request.mockImplementation(async ({ path }) => path.includes("group-executions") ? { ok: false, error: "暂时离线" } : { ok: true, data: { creations: [] } });
  await service.refresh(); expect(service.getSnapshot().rows).toHaveLength(2); expect(service.getSnapshot().error).toBe("暂时离线");
  await service.stop("request-g1"); expect(cancelTurn).toHaveBeenCalledWith("request-g1");
  readonly(); await expect(service.stop("request-g2")).rejects.toThrow("不可写"); expect(cancelTurn).toHaveBeenCalledTimes(1);
});
it("keeps pre-acceptance recovery records without manufacturing conversations", async () => {
  const { service, request } = fixture(); await service.refresh();
  request.mockImplementation(async ({ path }) => ({ ok: true, data: path.includes("group-executions") ? { turns: [] } : { creations: [{ ...creation("unknown"), conversationId: undefined, turnId: undefined, stage: "failed" }] } }));
  await service.refresh(); expect(service.getSnapshot().rows).toMatchObject([{ rootGroupId: "unknown", label: "创作失败", active: false }]);
  await service.retry("unknown"); expect(request).toHaveBeenCalledWith({ path: "/api/agent-conversations/canvas-creations/unknown/retry", method: "POST", body: {} });
});
it("drops late pages across private data spaces and disposes polling", async () => {
  vi.useFakeTimers(); const { service, request, switchSpace } = fixture(); await service.refresh();
  let resolve!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const old = service.refresh(); await Promise.resolve(); switchSpace(); await service.refresh();
  resolve({ ok: true, data: { creations: [creation("old")] } }); await old;
  expect(service.getSnapshot().rows.map(row => row.rootGroupId).sort()).toEqual(["g1", "g2"]);
  service.dispose(); const count = request.mock.calls.length; await vi.advanceTimersByTimeAsync(10000); expect(request).toHaveBeenCalledTimes(count);
});
