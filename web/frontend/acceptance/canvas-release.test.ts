import { afterEach, expect, it, vi } from "vitest";
import { installInteractionController } from "../src/cordis/plugins/canvas-shell/interaction-controller.js";
import { woohaa3CanvasStore } from "../src/cordis/services/canvas-state/index.js";
import { nodeSelectionStore } from "../src/cordis/services/selection-store.js";
import { nodeDrop } from "../src/cordis/services/node-drop/index.js";
import { WorkingProjectionStore } from "../src/cordis/services/canvas-state/store/working-projection.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing, setSession, submitted } from "../src/cordis/plugins/canvas-shell/test-support/controller-harness.js";

installSharedSession();
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); nodeSelectionStore.reset(); });
function setup(options: Record<string, unknown> = {}) {
  const canonical = canvasWith([{ id: "source", x: 0, y: 0 }, { id: "target", x: 230, y: 0 }]);
  woohaa3CanvasStore.getState().applyRemoteCanvas(canonical);
  const dom = harness(), captured = runtimeCapturing();
  const controller = installInteractionController({ canvas: dom.canvas, target: dom.target as never,
    getRuntime: () => captured.runtime, getSession: () => getSession() as never, ...options });
  cleanups.push(() => controller.dispose()); controller.flush();
  const position = () => {
    // Query the accepted runtime mirror, including incremental positions, rather than only full-scene history.
    const generation = captured.runtime.interactionGeneration!();
    const hit = captured.runtime.queryPoint!({ generation, x: 10, y: 80, zoom: 1 });
    return hit;
  };
  const drag = () => {
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 150, clientY: 120 }); controller.flush();
  };
  const release = () => { dom.fire("pointerup", { clientX: 150, clientY: 120 }); controller.flush(); };
  return { dom, controller, canonical, captured, drag, release, position };
}

it.each(["session-rejected", "edit-rejected", "edit-promise-rejected"])("%s restores canonical position and permits the next gesture", async reason => {
  const submit = vi.fn(() => ({ ok: false }));
  if (reason === "session-rejected") setSession({ isWritable: () => true, submitCommands: submit });
  const edit = vi.fn(() => reason === "edit-promise-rejected" ? Promise.reject(new Error("refused")) : { ok: false });
  const s = setup(reason === "session-rejected" ? {} : { onEditCommands: edit });
  s.drag(); s.release();
  await Promise.resolve(); await Promise.resolve(); s.controller.flush();
  expect(woohaa3CanvasStore.getState().canvas).toEqual(s.canonical);
  expect(woohaa3CanvasStore.getState().working).toEqual(s.canonical);
  expect(s.position()).toMatchObject({ ok: true, value: { kind: "node", nodeId: "source" } });
  // A duplicate late pointerup cannot resubmit the rejected batch.
  s.release(); expect(reason === "session-rejected" ? submit : edit).toHaveBeenCalledTimes(1);
  s.drag(); s.release(); expect(reason === "session-rejected" ? submit : edit).toHaveBeenCalledTimes(2);
});

it("writability revoked during a drag prevents submission and clears its preview", () => {
  let writable = true;
  const s = setup({ isWritable: () => writable }); s.drag(); writable = false; s.release();
  expect(submitted).toHaveLength(0);
  expect(woohaa3CanvasStore.getState().working).toEqual(s.canonical);
  expect(s.position()).toMatchObject({ ok: true, value: { kind: "node", nodeId: "source" } });
  writable = true; s.drag(); s.release();
  expect(submitted.filter(c => c.type === "node.update")).toHaveLength(1);
});

it("extension consumption restores the source and discards attach edges and late pointerup", () => {
  const preview = vi.fn(), drop = vi.fn(() => true);
  cleanups.push(nodeDrop.bind({ preview, drop }));
  const s = setup(); s.drag();
  s.dom.fireKey("keydown", { key: "e", code: "KeyE" }); s.controller.flush();
  s.release();
  expect(drop).toHaveBeenCalledTimes(1);
  expect(submitted).toHaveLength(0);
  expect(woohaa3CanvasStore.getState().working).toEqual(s.canonical);
  expect(preview.mock.calls.at(-1)?.[0]).toBeNull();
  expect(s.position()).toMatchObject({ ok: true, value: { kind: "node", nodeId: "source" } });
  s.release(); expect(drop).toHaveBeenCalledTimes(1);
});

it("remote deletion of an attached target keeps the source move but drops the invalid edge", () => {
  const s = setup(); s.drag();
  s.dom.fireKey("keydown", { key: "e", code: "KeyE" }); s.controller.flush();
  const remote = { ...s.canonical, revision: 2, document: { ...s.canonical.document,
    nodes: s.canonical.document.nodes.filter(n => n.id !== "target") } };
  woohaa3CanvasStore.getState().applyRemoteCanvas(remote); s.controller.flush(); s.release();
  expect(submitted.filter(c => c.type === "node.update")).toHaveLength(1);
  expect(submitted.filter(c => c.type === "edge.add")).toHaveLength(0);
  expect(woohaa3CanvasStore.getState().working!.document.nodes.find(n => n.id === "source")!.position).toEqual({ x: 50, y: 20 });
});

it("selected ancestor and descendant commit one root move without changing nested local coordinates", () => {
  const canonical = canvasWith([]);
  canonical.document.nodes = [
    { id: "g", type: "group", position: { x: 20, y: 20 }, width: 300, height: 240 },
    { id: "inner", type: "group", position: { x: 30, y: 40 }, parentId: "g", width: 180, height: 160 },
    { id: "leaf", type: "image", position: { x: 10, y: 20 }, parentId: "inner", width: 100, height: 80 }
  ];
  woohaa3CanvasStore.getState().applyRemoteCanvas(canonical);
  const dom = harness(), captured = runtimeCapturing();
  const controller = installInteractionController({ canvas: dom.canvas, target: dom.target as never,
    getRuntime: () => captured.runtime, getSession: () => getSession() as never });
  cleanups.push(() => controller.dispose()); controller.flush();
  (dom.target.__canvasSetSelection as (ids: string[]) => void)(["g", "leaf"]); controller.flush();
  dom.fire("pointerdown", { clientX: 50, clientY: 35 });
  dom.fire("pointermove", { clientX: 80, clientY: 75 }); controller.flush();
  dom.fire("pointerup", { clientX: 80, clientY: 75 }); controller.flush();
  expect(submitted).toEqual([{ type: "node.update", nodeId: "g", position: { x: 50, y: 60 } }]);
  const working = woohaa3CanvasStore.getState().working!;
  expect(working.document.nodes.find(n => n.id === "inner")).toEqual(canonical.document.nodes[1]);
  expect(working.document.nodes.find(n => n.id === "leaf")).toEqual(canonical.document.nodes[2]);
  expect(woohaa3CanvasStore.getState().canvas).toEqual(canonical);
});

it.each(["server-rejected", "send-failed"])("%s rolls back an admitted pending move without reverting remote data", async reason => {
  const s = setup(), projection = new WorkingProjectionStore();
  projection.applyCanonical(s.canonical);
  cleanups.push(projection.subscribe(() => woohaa3CanvasStore.getState().applyWorkingCanvas(projection.workingCanvas)));
  const settlements = new Map<string, (value: { state: "rejected" }) => void>();
  setSession({ isWritable: () => true, submitCommands: (commands, commandId) => {
    const result = projection.appendBatch({ commands, commandId, baseRevision: projection.canonicalCanvas!.revision,
      submittedAt: "2026-10-13T00:00:00.000Z" });
    if (!result.ok) return { ok: false };
    return { ok: true, handle: { settled: new Promise<{ state: "rejected" }>(done => settlements.set(commandId, done)) } };
  } });
  s.drag(); s.release();
  expect(projection.pendingBatches).toHaveLength(1);
  expect(projection.workingCanvas!.document.nodes[0].position).toEqual({ x: 50, y: 20 });
  expect(woohaa3CanvasStore.getState().canvas).toEqual(s.canonical);
  const commandId = projection.pendingBatches[0].commandId;
  // Real projection rebase with a newer remote node/data update; pending remains visible.
  const remote = { ...s.canonical, revision: 2, nodeData: { target: { prompt: "remote-kept" } },
    document: { ...s.canonical.document, nodes: s.canonical.document.nodes.map(n =>
      n.id === "target" ? { ...n, position: { x: 600, y: 0 } } : n) } };
  woohaa3CanvasStore.getState().applyRemoteCanvas(remote); projection.applyCanonical(remote); s.controller.flush();
  expect(projection.workingCanvas!.document.nodes[0].position).toEqual({ x: 50, y: 20 });
  if (reason === "server-rejected") projection.applyResult({ commandId, status: "rejected", code: "conflict", error: "refused" });
  else projection.rejectBatch(commandId, "offline");
  settlements.get(commandId)!({ state: "rejected" }); await Promise.resolve(); s.controller.flush();
  expect(projection.pendingBatches).toHaveLength(0);
  expect(woohaa3CanvasStore.getState().working).toEqual(remote);
  expect(woohaa3CanvasStore.getState().canvas).toEqual(remote);
  expect(s.position()).toMatchObject({ ok: true, value: { kind: "node", nodeId: "source" } });
  // A new drag plans against the rolled-back working baseline and can be admitted.
  s.drag(); s.release(); expect(projection.pendingBatches).toHaveLength(1);
  expect(projection.workingCanvas!.document.nodes[0].position).toEqual({ x: 50, y: 20 });
  expect(projection.workingCanvas!.nodeData.target).toEqual({ prompt: "remote-kept" });
});

it("multiple selected independent roots move once each and do not attach", () => {
  const s = setup();
  (s.dom.target.__canvasSetSelection as (ids: string[]) => void)(["source", "target"]); s.controller.flush();
  s.drag(); s.dom.fireKey("keydown", { key: "e", code: "KeyE" }); s.controller.flush(); s.release();
  expect(submitted).toEqual([
    { type: "node.update", nodeId: "source", position: { x: 50, y: 20 } },
    { type: "node.update", nodeId: "target", position: { x: 280, y: 20 } }
  ]);
  expect(woohaa3CanvasStore.getState().canvas).toEqual(s.canonical);
  expect(woohaa3CanvasStore.getState().working!.document.nodes.map(n => n.position)).toEqual([{ x: 50, y: 20 }, { x: 280, y: 20 }]);
});
