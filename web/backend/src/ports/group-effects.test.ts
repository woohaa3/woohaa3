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
    expect((await effects.settle(input)).status).toBe("unknown");
    s.canvas.jobs[0]!.status = "failed";
    expect((await effects.settle(input)).status).toBe("partial");
    s.canvas.jobs[0]!.status = "success";
    expect((await effects.settle(input)).status).toBe("unknown");
    s.canvas.assets.push({ id: "output", nodeId: "n", title: "output", mediaKind: "image", source: "generated", status: "ready", createdAt: "now", provenance: { runId: "run" } });
    s.canvas.nodeData.n.activeRunId = "newer-run";
    expect((await effects.settle(input)).status).toBe("succeeded");
    expect((await effects.settle({ ...input, outcome: { status: "unknown" } })).status).toBe("unknown");
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
