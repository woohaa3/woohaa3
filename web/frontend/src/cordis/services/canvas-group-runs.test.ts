import { afterEach, expect, it, vi } from "vitest";
import type { CanvasCreationView, ConversationTurn } from "@woohaa3/contracts";
import { createCanvasGroupRuns } from "./canvas-group-runs.js";

const creation = (id: string): CanvasCreationView => ({ requestId: id, canvasId: "c", rootGroupId: id, commandId: `cmd-${id}`, turnRequestId: `request-${id}`, scopeEpoch: 1, stage: "accepted", conversationId: `conversation-${id}`, turnId: `turn-${id}` });
const turn = (id: string, status = "running", action = "generate") => ({ requestId: `request-${id}`, status, action, target: { mode: "canvas-group", canvasId: "c", nodeId: id }, createdAt: "2026-10-20T00:00:00Z" }) as ConversationTurn;
const disposers: (() => void)[] = [];
function fixture() {
  let space = "one";
  let writable = true;
  const listeners = new Set<() => void>();
  const request = vi.fn().mockResolvedValue({ ok: true, data: { creations: [creation("g1"), creation("g2")] } });
  const readConversation = vi.fn().mockImplementation(async (id: string) => ({ ok: true, value: { turns: [turn(id.replace("conversation-", "")), turn(id.replace("conversation-", ""), "succeeded", "discuss")] } }));
  const cancelTurn = vi.fn().mockResolvedValue({ ok: true });
  const service = createCanvasGroupRuns({ canvasId: "c", transport: { request } as never, conversations: { readConversation, cancelTurn }, user: {
    getSnapshot: () => ({ dataScopeId: space }) as never,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }
  }, writable: () => writable });
  disposers.push(service.dispose);
  return { service, request, readConversation, cancelTurn, readonly: () => { writable = false; }, switchSpace: () => { space = "two"; listeners.forEach(fn => fn()); } };
}
afterEach(() => { disposers.splice(0).forEach(fn => fn()); vi.useRealTimers(); });

it("shares concurrent group executions and ignores later discussion turns", async () => {
  const { service, request } = fixture();
  const a = service.refresh();
  expect(service.refresh()).toBe(a);
  await a;
  expect(request).toHaveBeenCalledTimes(1);
  expect(service.getSnapshot().rows.map(row => [row.creation.rootGroupId, row.status])).toEqual([["g1", "running"], ["g2", "running"]]);
});

it("isolates a failed conversation read while updating other groups and retaining previous state", async () => {
  const { service, readConversation } = fixture();
  await service.refresh();
  readConversation.mockImplementation(async (id: string) => id.endsWith("g1") ? { ok: false, error: "暂时离线" } : { ok: true, value: { turns: [turn("g2", "partial")] } });
  await service.refresh();
  expect(service.getSnapshot().rows.map(row => row.status)).toEqual(["running", "partial"]);
  expect(service.getSnapshot().error).toBe("暂时离线");
  expect(service.getSnapshot().rows[1].active).toBe(false);
});

it("uses exact turn and creation request IDs for actions and enforces writable state", async () => {
  const { service, request, cancelTurn, readonly } = fixture();
  await service.refresh();
  await service.stop("request-g1");
  expect(cancelTurn).toHaveBeenCalledWith("request-g1");
  await service.retry("g2");
  expect(request).toHaveBeenCalledWith({ path: "/api/agent-conversations/canvas-creations/g2/retry", method: "POST", body: {} });
  readonly();
  await expect(service.stop("request-g2")).rejects.toThrow("不可写");
  expect(cancelTurn).toHaveBeenCalledTimes(1);
});

it("shows creation failures and unresolved results before a conversation exists", async () => {
  const { service, request, readConversation } = fixture();
  await service.refresh();
  request.mockResolvedValue({ ok: true, data: { creations: [
    { ...creation("failed"), conversationId: undefined, turnId: undefined, stage: "failed", error: { code: "upstream", message: "助手未能启动" } },
    { ...creation("unknown"), conversationId: undefined, turnId: undefined, stage: "unknown" }
  ] } });
  readConversation.mockClear();
  await service.refresh();
  expect(service.getSnapshot().rows.map(row => [row.label, row.active, row.error])).toEqual([
    ["创作失败", false, "助手未能启动"], ["结果待核对", true, undefined]
  ]);
  expect(readConversation).not.toHaveBeenCalled();
  request.mockRejectedValue(new Error("读取离线"));
  await service.refresh();
  expect(service.getSnapshot().rows).toHaveLength(2);
  expect(service.getSnapshot().error).toBe("读取离线");
});

it("drops late responses from the previous data space and stops polling after dispose", async () => {
  vi.useFakeTimers();
  const { service, request, switchSpace } = fixture();
  await service.refresh();
  let resolve!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const old = service.refresh();
  await Promise.resolve();
  switchSpace();
  await service.refresh();
  resolve({ ok: true, data: { creations: [creation("old")] } });
  await old;
  expect(service.getSnapshot().rows.map(row => row.creation.rootGroupId)).toEqual(["g1", "g2"]);
  service.dispose();
  const count = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(request).toHaveBeenCalledTimes(count);
});
