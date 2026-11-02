// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { ScopeContext } from "./plugin.js";

it("discards late prepare failures on selection change and unmount", async () => {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const data = (id: string) => ({ kind: "scene-area", version: "shared-world-v1", areaId: id, scopeVersion: "v1", bounds: { min: { u: 0, v: 0 }, max: { u: 1, v: 1 } } });
  woohaa3CanvasStore.getState().applyRemoteCanvas({ ...base, revision: 1, document: { ...base.document,
    nodes: ["a", "b"].map(id => ({ id, type: "group", position: { x: 0, y: 0 } })) },
    nodeData: { a: { sceneArea: data("a") }, b: { sceneArea: data("b") } } } as ServerCanvas);
  const pending: Array<{ signal: AbortSignal; resolve: (value: unknown) => void }> = [];
  const ctx = { canvasRemote: { prepareSceneArea: vi.fn((_input, signal: AbortSignal) => new Promise(resolve => pending.push({ signal, resolve }))) } };
  const host = document.createElement("div");
  const root = createRoot(host);
  const select = (id: string) => nodeSelectionStore.setFromRuntime({ nodeIds: [id], primaryNodeId: id, editingFocus: false }, new Set(["a", "b"]));
  await act(async () => { select("a"); root.render(<ScopeContext ctx={ctx as never} canvasId="c1" />); });
  await act(async () => { select("b"); });
  expect(pending[0]!.signal.aborted).toBe(true);
  await act(async () => { pending[0]!.resolve({ ok: false, code: "lease-conflict", message: "old conflict" }); });
  expect(host.textContent).not.toContain("old conflict");
  await act(async () => { pending[1]!.resolve({ ok: false, code: "not-ready", message: "current error" }); });
  expect(host.textContent).toContain("current error");
  await act(async () => { select("a"); });
  await act(async () => { root.unmount(); });
  expect(pending[2]!.signal.aborted).toBe(true);
  await act(async () => { pending[2]!.resolve({ ok: false, code: "not-ready", message: "late" }); });
  expect(host.textContent).toBe("");
  nodeSelectionStore.reset();
});
