import { describe, expect, it, vi } from "vitest";
import { assistantInputController, createAssistantInputController, type AssistantSubmissionPort } from "./controller.js";

describe("assistant input controller", () => {
  it("isolates scopes and restores the same target across layouts", () => {
    const page = {};
    const scope = { dataScopeId: "owner", canvasId: "c", purpose: "model3d", nodeId: "n" };
    const a = assistantInputController(page, scope);
    a.edit({ prompt: "draft" });
    expect(assistantInputController(page, scope)).toBe(a);
    for (const patch of [{ dataScopeId: "other" }, { canvasId: "other" }, { nodeId: "other" }, { purpose: "discuss" }]) {
      expect(assistantInputController(page, { ...scope, ...patch }).getSnapshot().draft.prompt).toBe("");
    }
  });
  it("deduplicates double submission and preserves later edits on late acceptance", async () => {
    const controller = createAssistantInputController<{ prompt: string }, string>({ prompt: "first" });
    let resolve!: (value: { kind: "accepted"; value: string }) => void;
    const submit = vi.fn(() => new Promise<{ kind: "accepted"; value: string }>(done => { resolve = done; }));
    const port = { submit, query: submit };
    const first = controller.submit({ prompt: "first" }, port);
    await controller.submit({ prompt: "second" }, port);
    controller.edit({ prompt: "later edit" });
    resolve({ kind: "accepted", value: "task-a" });
    await first;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ draft: { prompt: "later edit" }, accepted: "task-a", pending: null });
  });
  it("keeps frozen identity after response loss and never dispatches during query", async () => {
    const controller = createAssistantInputController<{ prompt: string }, string>({ prompt: "first" });
    const port: AssistantSubmissionPort<{ prompt: string }, string> = {
      submit: vi.fn(async () => { throw new Error("transport lost"); }),
      query: vi.fn(async () => ({ kind: "accepted" as const, value: "original" })),
    };
    const input = { prompt: "first" };
    await controller.submit(input, port);
    const id = controller.getSnapshot().pending!.requestId;
    input.prompt = "mutated";
    controller.edit({ prompt: "next" });
    await controller.query(port);
    expect(port.query).toHaveBeenCalledWith({ prompt: "first" }, id);
    expect(port.submit).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().draft.prompt).toBe("next");
  });
});
