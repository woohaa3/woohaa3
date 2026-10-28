import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type CanvasGroupAction } from "@woohaa3/contracts";
import type { CanvasService } from "@woohaa3/canvas-service";
import { createGroupEffects } from "./group-effects.js";
import { createToolGrantRegistry } from "./authoring-adapters.js";

function setup() {
  const canvas = createEmptyWoohaa3ServerCanvas("c", "now");
  canvas.nodeData.n = { activeRunId: "run", taskStatus: "processing" };
  canvas.jobs = [{ id: "job", nodeId: "n", taskId: "task", runId: "run", status: "running", updatedAt: "now" }];
  const cancel = vi.fn(async () => ({ ok: true }));
  const service = { sync: { registry: { resolve: async () => ({ exportCanvas: () => ({ ok: true, canvas }) }) } }, runService: { cancel } } as unknown as CanvasService;
  const actions: CanvasGroupAction[] = [{ canvasId: "c", commandId: "cmd" }, { canvasId: "c", nodeId: "n", runId: "run", jobId: "job" }];
  return { canvas, cancel, service, actions, grants: createToolGrantRegistry() };
}
describe("group effect evidence", () => {
  it("keeps a stop before the first action cancelled instead of unknown", async () => {
    const s = setup();
    const controller = new AbortController(); controller.abort();
    expect((await createGroupEffects(s.service, s.grants).settle({ owner: "owner", requestId: "r", actions: [], outcome: { status: "succeeded" }, signal: controller.signal })).status).toBe("cancelled");
  });
  it("settles a missing receipt as failed instead of leaving an unknown result", async () => {
    const s = setup();
    expect((await createGroupEffects(s.service, s.grants).settle({
      owner: "owner", requestId: "r", actions: [],
      outcome: { status: "succeeded" }, signal: new AbortController().signal
    }))).toMatchObject({ status: "failed", error: { code: "write-unconfirmed" } });
  });
  it("revokes the matched run and still settles failed when run evidence is unreadable", async () => {
    const s = setup();
    (s.service as unknown as { sync: { registry: { resolve: () => Promise<{ exportCanvas: () => { ok: false; message: string } }> } } })
      .sync.registry.resolve = async () => ({ exportCanvas: () => ({ ok: false, message: "unavailable" }) });
    expect((await createGroupEffects(s.service, s.grants).settle({
      owner: "owner", requestId: "r", actions: s.actions,
      outcome: { status: "succeeded" }, signal: new AbortController().signal, recovery: true
    })).status).toBe("failed");
    expect(s.cancel).toHaveBeenCalledWith({ canvasId: "c", nodeId: "n", runId: "run" });
  });
  it("settles failed even when revoking the matched run rejects", async () => {
    const s = setup();
    s.cancel.mockRejectedValueOnce(new Error("cancel down"));
    expect((await createGroupEffects(s.service, s.grants).settle({
      owner: "owner", requestId: "r", actions: s.actions,
      outcome: { status: "succeeded" }, signal: new AbortController().signal, recovery: true
    })).status).toBe("failed");
    // 撤销失败被吞掉、不阻塞结算（避免未处理的 rejection）。
    await Promise.resolve();
  });
  it("waits for the linked media result after the assistant finishes", async () => {
    const s = setup();
    const wait = vi.fn(async () => { s.canvas.jobs[0]!.status = "success"; s.canvas.nodeData.n.taskStatus = "successed"; s.canvas.nodeData.n.result = { kind: "text", text: "actual result" }; });
    const outcome = await createGroupEffects(s.service, s.grants, { wait }).settle({ owner: "owner", requestId: "r", actions: s.actions, outcome: { status: "succeeded" }, signal: new AbortController().signal });
    expect(wait).toHaveBeenCalledOnce();
    expect(outcome.status).toBe("succeeded");
  });
  it("keeps failed, missing-output and interrupted inference evidence distinct", async () => {
    const s = setup();
    const effects = createGroupEffects(s.service, s.grants);
    const input = { owner: "owner", requestId: "r", actions: s.actions, outcome: { status: "succeeded" as const }, signal: new AbortController().signal, recovery: true };
    // 子 run 仍活动：撤销匹配 run 后按失败结算。
    expect((await effects.settle(input)).status).toBe("failed");
    expect(s.cancel).toHaveBeenCalledWith({ canvasId: "c", nodeId: "n", runId: "run" });
    s.canvas.jobs[0]!.status = "failed";
    expect((await effects.settle(input)).status).toBe("partial");
    s.canvas.jobs[0]!.status = "success";
    const cancelAfter = s.cancel.mock.calls.length;
    // 成功但无产物：同样先撤销再失败。
    expect((await effects.settle(input)).status).toBe("failed");
    expect(s.cancel.mock.calls.length).toBeGreaterThan(cancelAfter);
    s.canvas.assets.push({ id: "output", nodeId: "n", title: "output", mediaKind: "image", source: "generated", status: "ready", createdAt: "now", provenance: { runId: "run" } });
    s.canvas.nodeData.n.activeRunId = "newer-run";
    expect((await effects.settle(input)).status).toBe("succeeded");
    // 显式失败输入不覆盖已确认的领域成功事实。
    expect((await effects.settle({ ...input, outcome: { status: "failed" } })).status).toBe("succeeded");
  });
  it("revokes the owner first and only cancels exact linked runs", () => {
    const s = setup();
    const revoke = vi.spyOn(s.grants, "revoke");
    createGroupEffects(s.service, s.grants).cancel({ owner: "owner", requestId: "r", actions: s.actions });
    expect(revoke).toHaveBeenCalledWith("r", "owner");
    expect(s.cancel).toHaveBeenCalledTimes(1);
    expect(s.cancel).toHaveBeenCalledWith({ canvasId: "c", nodeId: "n", runId: "run" });
    expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(s.cancel.mock.invocationCallOrder[0]!);
  });
});
