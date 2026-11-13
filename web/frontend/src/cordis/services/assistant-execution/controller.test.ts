import { describe, expect, it, vi } from "vitest";
import { assistantInputController, clearAssistantExpansionDrafts, createAssistantInputController, type AssistantSubmissionPort } from "./controller.js";

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
  it("resets the next expansion choice while retrying the original frozen choice", async () => {
    const page = {};
    const scope = { dataScopeId: 'owner', canvasId: 'canvas', purpose: 'world', nodeId: 'area-a' };
    const controller = assistantInputController<{ allowSceneAreaExpansion: boolean }, string>(page, scope);
    controller.edit({ allowSceneAreaExpansion: true });
    const submit = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({ kind: 'accepted', value: 'done' });
    const port = { submit, query: submit };
    await controller.submit({ allowSceneAreaExpansion: true }, port);
    expect(controller.getSnapshot().draft.allowSceneAreaExpansion).toBe(false);
    expect(assistantInputController(page, { ...scope, nodeId: 'area-b' }).getSnapshot().draft.allowSceneAreaExpansion).not.toBe(true);
    await controller.submit({ allowSceneAreaExpansion: false }, port);
    expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0]);
    expect(submit.mock.calls[1]![0]).toEqual({ allowSceneAreaExpansion: true });
  });
  it("clears the target's expansion drafts without changing other targets or pending input", async () => {
    const page = {};
    const scope = { dataScopeId: 'owner', canvasId: 'canvas', nodeId: 'area-a' };
    const generate = assistantInputController<{ allowSceneAreaExpansion: boolean }, string>(page, { ...scope, purpose: 'world:area-a' });
    const reply = assistantInputController(page, { ...scope, purpose: 'reply:conversation' });
    const other = assistantInputController(page, { ...scope, nodeId: 'area-b', purpose: 'world:area-b' });
    const port = { submit: vi.fn(async () => { throw new Error('lost'); }), query: vi.fn(async () => ({ kind: 'accepted' as const, value: 'ok' })) };
    await generate.submit({ allowSceneAreaExpansion: true }, port);
    generate.edit({ allowSceneAreaExpansion: true });
    reply.edit({ allowSceneAreaExpansion: true });
    other.edit({ allowSceneAreaExpansion: true });
    const pending = generate.getSnapshot().pending;
    clearAssistantExpansionDrafts(page, scope);
    expect(generate.getSnapshot().draft.allowSceneAreaExpansion).toBe(false);
    expect(reply.getSnapshot().draft.allowSceneAreaExpansion).toBe(false);
    expect(other.getSnapshot().draft.allowSceneAreaExpansion).toBe(true);
    expect(generate.getSnapshot().pending).toEqual(pending);
  });
});

it("text submits independent frozen requests before earlier responses, preserving unknown identities and later drafts", async () => {
  const controller = createAssistantInputController<{ prompt: string }, string>({ prompt: "first" });
  const resolve: Array<(result: { kind: "accepted"; value: string } | { kind: "unknown"; message: string }) => void> = [];
  const submit = vi.fn(() => new Promise<{ kind: "accepted"; value: string } | { kind: "unknown"; message: string }>(done => resolve.push(done)));
  const port = { submit, query: vi.fn(async () => ({ kind: "accepted" as const, value: "first" })) };
  const first = controller.submitIndependent({ prompt: "first" }, port);
  controller.edit({ prompt: "second" });
  const second = controller.submitIndependent({ prompt: "second" }, port);
  const original = controller.getSnapshot().submissions[0]!;
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit.mock.calls[0]).not.toEqual(submit.mock.calls[1]);
  controller.edit({ prompt: "third" });
  resolve[1]!({ kind: "accepted", value: "second" }); await second;
  resolve[0]!({ kind: "unknown", message: "lost" }); await first;
  expect(controller.getSnapshot().submissions).toHaveLength(1);
  await controller.querySubmission(original.requestId, port);
  expect(port.query).toHaveBeenCalledWith({ prompt: "first" }, original.requestId);
  expect(controller.getSnapshot().draft.prompt).toBe("third");
  expect(submit).toHaveBeenCalledTimes(2);
});

it("isolates text prompt drafts by connection and model", () => {
  const controller = createAssistantInputController({ prompt: "legacy authored prompt" });
  controller.selectPromptScope("connection-a:model-a");
  expect(controller.getSnapshot().draft.prompt).toBe("legacy authored prompt");
  controller.edit({ prompt: "a draft" }); controller.selectPromptScope("connection-b:model-b");
  expect(controller.getSnapshot().draft.prompt).toBe("");
  controller.edit({ prompt: "b draft" }); controller.selectPromptScope("connection-a:model-a");
  expect(controller.getSnapshot().draft.prompt).toBe("a draft");
});
