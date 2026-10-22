/** @vitest-environment jsdom */
import { expect, it } from "vitest";
import { applyCanvasCommands, createEmptyWoohaa3ServerCanvas, defaultSelfContained3DNodeData, type CanvasCommand } from "@woohaa3/contracts";
import { startFrontendRuntime } from "../../kernel.js";
import type { CanvasSession } from "../../contracts.js";
import { createCanvasEditService } from "../../services/canvas-state/store/canvas-edit-service.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { InputScopeService } from "../../services/input-scopes.js";
import { DialogService } from "../../services/dialogs/service.js";
import { SlotRegistry } from "../../slots.js";
import { buildCanvasCopyPayload } from "../canvas-shell/clipboard/payload.js";
import { pasteImportExtension } from "./plugin.js";

it("real paste contribution/journal undo removes only the copy and redo preserves original project references", async () => {
  const created = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("c", "2026-10-11T00:00:00Z"), [{
    type: "node.add", node: { id: "original", type: "extension3d", position: { x: 1, y: 2 } },
    nodeData: { ...JSON.parse(JSON.stringify(defaultSelfContained3DNodeData("model3d"))), extensionId: "game-furnace", projectStorageKey: "sha256-saved-project", inputHash: "confirmed", title: "炉" }
  }]);
  if (!created.ok) throw Error("invalid fixture");
  let canonical = created.canvas;
  const original = structuredClone(canonical.nodeData.original);
  const session = {
    isWritable: () => true, commandLifecycle: () => null,
    submitCommands(commands: readonly CanvasCommand[]) {
      const result = applyCanvasCommands(canonical, commands);
      if (!result.ok) throw Error(JSON.stringify(result));
      canonical = result.canvas;
      woohaa3CanvasStore.getState().applyRemoteCanvas(canonical);
      return { ok: true, handle: { settled: Promise.resolve({ state: "committed", error: null }) } };
    }
  } as unknown as CanvasSession;
  const edit = createCanvasEditService({ session, getCanvas: () => canonical });
  let recordResult: unknown;
  const recordedEdit = { ...edit, async record(commands: readonly CanvasCommand[], label: string) {
    recordResult = await edit.record(commands, label);
    return recordResult;
  } };
  const slots = new SlotRegistry();
  const runtime = await startFrontendRuntime({ installPlatform(ctx) {
    ctx.provide("slots", slots);
    ctx.provide("inputScopes", new InputScopeService());
    ctx.provide("dialogs", new DialogService());
    ctx.provide("canvasSession", session);
    ctx.provide("canvasRemote", {} as never);
    ctx.provide("canvasEdit", recordedEdit as never);
    ctx.provide("selection", { getSnapshot: () => ({ nodeIds: ["original"], primaryNodeId: "original", editingFocus: false, keyboardActive: true }) } as never);
    ctx.provide("canvasRuntime", { lastPointerWorld: () => ({ x: 500, y: 500 }), controller: () => ({ viewport: () => ({ x: 0, y: 0, zoom: 1 }) }) } as never);
  }, plugins: [{ id: "paste-import", required: false, plugin: pasteImportExtension() }] });
  try {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canonical);
    const payload = buildCanvasCopyPayload(canonical, ["original"])!;
    const event = { clipboardData: { files: [], items: [], types: [], getData: () => JSON.stringify(payload) }, preventDefault() {} } as unknown as ClipboardEvent;
    expect(slots.list("input.paste")[0]!.handle(event)).toBe(true);
    await expect.poll(() => recordResult).toBeDefined();
    expect(recordResult, JSON.stringify(recordResult)).toMatchObject({ ok: true });
    expect(edit.getSnapshot().canUndo).toBe(true);
    expect(canonical.document.nodes).toHaveLength(2);
    const copyId = canonical.document.nodes.find(node => node.id !== "original")!.id;
    expect(canonical.nodeData[copyId]).toEqual(original);
    expect(await edit.undo()).toEqual({ ok: true });
    expect(canonical.document.nodes.map(node => node.id)).toEqual(["original"]);
    expect(canonical.nodeData.original).toEqual(original);
    expect(await edit.redo()).toEqual({ ok: true });
    expect(canonical.document.nodes).toHaveLength(2);
    expect(canonical.nodeData.original).toEqual(original);
    expect(canonical.nodeData[copyId]).toEqual(original);
  } finally { await runtime.dispose(); woohaa3CanvasStore.getState().applyRemoteCanvas(null as never); }
});
