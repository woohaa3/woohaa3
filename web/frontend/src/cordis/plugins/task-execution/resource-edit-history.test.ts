import { expect, it, vi } from "vitest";
import { watchResourceEditHistory } from "./resource-edit-history.js";
import { EditJournal } from "../../services/canvas-state/store/edit-journal.js";

vi.mock("../../services/canvas-state/index.js", () => ({ woohaa3CanvasStore: { getState: () => ({ canvas: { id: "canvas", revision: 99 } }), subscribe: () => () => undefined } }));

it("registers only live director edits and replays their durable history", async () => {
  let listener = () => {};
  let status = "running";
  const service = { subscribe: (fn: () => void) => { listener = fn; return () => {}; }, getSnapshot: () => ({ turnsByRequest: { request: { turn: { status, target: { canvasId: "canvas", mode: "world", worldScope: { kind: "scene-area", areaId: "area" } } } } } }) };
  const entries: Array<{ undo(): Promise<{ ok: boolean }>; redo(): Promise<{ ok: boolean }> }> = [];
  const replay = vi.fn(async (input: { direction: string }) => ({ ok: true as const, commandId: `history-${input.direction}`, revision: 3, duplicate: false }));
  const ctx = { canvasRemote: { listResourceEdits: vi.fn(async () => ({ ok: true as const, commands: [{ commandId: "source", revision: 2 }] })), replayResourceEdit: replay }, canvasSession: { isWritable: () => true }, canvasEdit: { recordExternal: (entry: typeof entries[number]) => { entries.push(entry); return { ok: true }; } } };
  const dispose = watchResourceEditHistory(ctx as never, "canvas", service as never);
  status = "succeeded";
  listener();
  await vi.waitFor(() => expect(entries).toHaveLength(1));
  expect(await entries[0]!.undo()).toMatchObject({ ok: true });
  expect(await entries[0]!.redo()).toMatchObject({ ok: true });
  expect(replay.mock.calls[0]![0]).toMatchObject({ sourceCommandId: "source", previousCommandId: "source", direction: "undo" });
  expect(replay.mock.calls[1]![0]).toMatchObject({ sourceCommandId: "source", previousCommandId: "history-undo", direction: "redo" });
  dispose();
});

it("retries a failed history fetch and reuses the undo identity after a lost response", async () => {
  let listener = () => {};
  let status = "running";
  const service = { subscribe: (fn: () => void) => { listener = fn; return () => {}; }, getSnapshot: () => ({ turnsByRequest: { request: { turn: { status, target: { canvasId: "canvas", mode: "world", worldScope: { kind: "scene-area", areaId: "area" } } } } } }) };
  const entries: Array<{ undo(): Promise<{ ok: boolean }>; redo(): Promise<{ ok: boolean }> }> = [];
  const list = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true, commands: [{ commandId: "source", revision: 2 }] });
  const replay = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValue({ ok: true, commandId: "history-undo", revision: 3, duplicate: true });
  const ctx = { canvasRemote: { listResourceEdits: list, replayResourceEdit: replay }, canvasSession: { isWritable: () => true }, canvasEdit: { recordExternal: (entry: typeof entries[number]) => { entries.push(entry); return { ok: true }; } } };
  const dispose = watchResourceEditHistory(ctx as never, "canvas", service as never);
  status = "succeeded";
  listener();
  await vi.waitFor(() => expect(entries).toHaveLength(1), { timeout: 4000 });
  expect(list).toHaveBeenCalledTimes(2);
  expect(await entries[0]!.undo()).toMatchObject({ ok: false });
  expect(await entries[0]!.undo()).toMatchObject({ ok: true });
  expect(replay.mock.calls[1]![0].operationId).toBe(replay.mock.calls[0]![0].operationId);
  expect(replay.mock.calls[1]![0].previousCommandId).toBe('source');
  dispose();
});

it("places concurrent runs around an intervening local edit by commit revision", async () => {
  let listener = () => {};
  const statuses = { first: 'running', second: 'running' };
  const service = { subscribe: (fn: () => void) => { listener = fn; return () => {}; }, getSnapshot: () => ({ turnsByRequest: Object.fromEntries(Object.entries(statuses).map(([requestId, status]) => [requestId, { turn: { status, target: { canvasId: 'canvas', mode: 'world', worldScope: { kind: 'scene-area', areaId: requestId } } } }])) }) };
  const journal = new EditJournal({ isWritable: () => true, hasNetChange: () => true, submitGuarded: () => ({ ok: true, settled: Promise.resolve({ ok: true, committed: true, revision: 20 }) }) });
  const list = vi.fn(async ({ runId }: { runId: string }) => ({ ok: true as const, commands: [{ commandId: runId, revision: runId === 'first' ? 10 : 30 }] }));
  const ctx = { canvasRemote: { listResourceEdits: list, replayResourceEdit: vi.fn(async () => ({ ok: true as const, commandId: 'undo', revision: 99 })) }, canvasSession: { isWritable: () => true }, canvasEdit: { recordExternal: journal.recordExternal.bind(journal) } };
  const dispose = watchResourceEditHistory(ctx as never, 'canvas', service as never);
  statuses.second = 'succeeded'; listener();
  await vi.waitFor(() => expect(journal.size).toBe(1));
  await journal.recordAndSubmit({ label: 'local', forward: { preconditions: [], operations: [] }, inverse: { preconditions: [], operations: [] } });
  await vi.waitFor(() => expect(journal.size).toBe(2));
  statuses.first = 'succeeded'; listener();
  await vi.waitFor(() => expect(journal.size).toBe(3));
  expect(journal.snapshot().entries.map(entry => entry.id)).toEqual(['resource-edit:first', expect.any(String), 'resource-edit:second']);
  expect(journal.snapshot().undoLabel).toBe('助手编辑导演区');
  dispose();
});
