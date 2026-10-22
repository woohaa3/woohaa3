import { expect, it, vi } from "vitest";
import { createEditorPreparation } from "../src/editor-preparation.js";
it("starts only on direct image entry, merges repeated requests and enters when ready", async () => {
  let finish!: () => void;
  const prepare = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const enter = vi.fn(async () => ({ ok: true as const }));
  const gate = createEditorPreparation({ prepare, enter, stillCurrent: () => true });
  expect(prepare).not.toHaveBeenCalled();
  expect(gate.guard({ nodeId: "n", kind: "image", owner: "history" })).toBeNull();
  gate.guard({ nodeId: "n", kind: "image", owner: "direct" });
  gate.guard({ nodeId: "n", kind: "image", owner: "direct" });
  expect(prepare).toHaveBeenCalledOnce(); expect(enter).not.toHaveBeenCalled();
  finish(); await vi.waitFor(() => expect(enter).toHaveBeenCalledOnce());
  expect(gate.getSnapshot().nodeId).toBeNull();
});
it.each(["cancel", "dispose", "change"])("late preparation cannot open after %s", async action => {
  let finish!: () => void;
  const enter = vi.fn(async () => ({ ok: true as const }));
  const gate = createEditorPreparation({ prepare: () => new Promise<void>(resolve => { finish = resolve; }), enter, stillCurrent: () => action !== "change" });
  gate.guard({ nodeId: "n", kind: "image", owner: "direct" });
  if (action === "cancel") gate.cancel();
  if (action === "dispose") gate.dispose();
  finish(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(enter).not.toHaveBeenCalled(); expect(gate.getSnapshot().nodeId).toBeNull();
});
it("failure stays local and explicit retry can recover", async () => {
  const prepare = vi.fn().mockRejectedValueOnce(new Error("下载失败")).mockResolvedValueOnce(undefined);
  const enter = vi.fn(async () => ({ ok: true as const }));
  const gate = createEditorPreparation({ prepare, enter, stillCurrent: () => true });
  gate.guard({ nodeId: "n", kind: "image", owner: "direct" });
  await vi.waitFor(() => expect(gate.getSnapshot().phase).toBe("failed"));
  expect(gate.getSnapshot().message).toBe("下载失败"); expect(enter).not.toHaveBeenCalled();
  gate.retry(); await vi.waitFor(() => expect(enter).toHaveBeenCalledOnce());
});
it("preserves return context and aborts navigation already awaiting settlement", async () => {
  let signal: AbortSignal | undefined;
  const enter = vi.fn(async (_input, currentSignal: AbortSignal) => { signal = currentSignal; return new Promise<{ ok: boolean }>(() => {}); });
  const gate = createEditorPreparation({ prepare: async () => {}, enter, stillCurrent: () => true });
  gate.guard({ nodeId: "n", kind: "image", owner: "direct", preserveOverviewReturn: true });
  await vi.waitFor(() => expect(enter).toHaveBeenCalledOnce());
  expect(enter.mock.calls[0]?.[0]).toMatchObject({ preserveOverviewReturn: true });
  gate.cancel(); expect(signal?.aborted).toBe(true);
});
it("a cancelled entry cannot bypass preparation for a new request to the same node", async () => {
  let finishEnter!: (value: { ok: boolean }) => void;
  const prepare = vi.fn(async () => {});
  const gate = createEditorPreparation({ prepare, enter: () => new Promise(resolve => { finishEnter = resolve; }), stillCurrent: () => true });
  gate.guard({ nodeId: "n", kind: "image", owner: "direct" });
  await vi.waitFor(() => expect(finishEnter).toBeTypeOf("function"));
  gate.cancel();
  expect(gate.guard({ nodeId: "n", kind: "image", owner: "direct" })).not.toBeNull();
  expect(prepare).toHaveBeenCalledTimes(2);
  gate.dispose();
});
