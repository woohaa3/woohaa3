/** @vitest-environment jsdom */
import { expect, it } from "vitest";
import { applyCanvasCommands, createEmptyWoohaa3ServerCanvas, defaultSelfContained3DNodeData, type CanvasCommand } from "@woohaa3/contracts";
import { serverCanvasToYDoc, yDocToServerCanvas } from "@woohaa3/contracts/canvas-yjs";
import * as Y from "yjs";
import { startFrontendRuntime } from "../frontend/src/cordis/kernel.js";
import type { CanvasSession } from "../frontend/src/cordis/contracts.js";
import { createCanvasEditService } from "../frontend/src/cordis/services/canvas-state/store/canvas-edit-service.js";
import { woohaa3CanvasStore } from "../frontend/src/cordis/services/canvas-state/index.js";
import { InputScopeService } from "../frontend/src/cordis/services/input-scopes.js";
import { DialogService } from "../frontend/src/cordis/services/dialogs/service.js";
import { SlotRegistry } from "../frontend/src/cordis/slots.js";
import { buildCanvasCopyPayload } from "../frontend/src/cordis/plugins/canvas-shell/clipboard/payload.js";
import { pasteImportExtension } from "../frontend/src/cordis/plugins/paste-import/plugin.js";
import { createKeyboardShortcuts } from "../frontend/src/cordis/plugins/canvas-shell/interaction-keyboard.js";
import { nodeSelectionStore } from "../frontend/src/cordis/services/selection-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteCanvasRepository } from "../services/canvas-service/src/storage/sqlite/index.js";
import { CanvasApplicationService } from "../services/canvas-service/src/storage/core/index.js";

it.each(["duplicate", "paste"])("%s a world collection through the page journal and SQLite restarts", async (entry) => {
  const instance = { kind: "world-instance", version: "shared-world-v1", instanceId: "i", transform: { version: "shared-world-v1", position: { u: 1, v: 2, h: 3 }, rotation: [0, 0, 0, 1], scale: 2 } };
  const camera = { kind: "world-camera", version: "shared-world-v1", cameraId: "c", settingsVersion: "1", position: { u: 1, v: 2, h: 4 }, rotation: [0, 0, 0, 1], projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 }, captureMode: { kind: "static" }, aspect: { width: 16, height: 9 }, boundInstanceId: "i" };
  const created = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("world"), [
    { type: "node.add", node: { id: "m", type: "model3d", position: { x: 0, y: 0 } }, nodeData: { sharedWorldInstance: instance } },
    { type: "node.add", node: { id: "g", type: "workflow-group-2d", position: { x: 10, y: 0 } }, nodeData: { workflowGroup2d: { kind: "workflow-group-2d", version: "shared-world-v1", groupId: "g", scopeVersion: "1", memberNodeIds: ["m"] } } },
    { type: "node.add", node: { id: "a", type: "scene-area", position: { x: 20, y: 0 } }, nodeData: { sceneArea: { kind: "scene-area", version: "shared-world-v1", areaId: "a", scopeVersion: "1", bounds: { min: { u: 0, v: 0 }, max: { u: 2, v: 2 } } } } },
    { type: "node.add", node: { id: "c", type: "world-camera", position: { x: 30, y: 0 } }, nodeData: { worldCamera: camera } }
  ] as never);
  if (!created.ok) throw Error("invalid fixture");
  let canonical = created.canvas;
  const dir = mkdtempSync(path.join(tmpdir(), "world-copy-"));
  const db = path.join(dir, "canvas.sqlite");
  let repository = new SqliteCanvasRepository({ path: db });
  await repository.createCanvas(canonical);
  canonical = (await repository.getCanvas(canonical.id))!;
  const slots = new SlotRegistry();
  const session = { isWritable: () => true, commandLifecycle: () => null, submitCommands(commands: readonly CanvasCommand[], operationId: string) {
    const settled = (async () => {
      await new CanvasApplicationService({ repository }).commitCommands({ canvasId: canonical.id, expectedRevision: canonical.revision, operationId, actorId: "copy-test", commands });
      repository.close();
      repository = new SqliteCanvasRepository({ path: db });
      canonical = (await repository.getCanvas(canonical.id))!;
      woohaa3CanvasStore.getState().applyRemoteCanvas(canonical);
      return { state: "committed", error: null };
    })();
    return { ok: true, handle: { settled } };
  } } as unknown as CanvasSession;
  const edit = createCanvasEditService({ session, getCanvas: () => canonical });
  const runtime = await startFrontendRuntime({ installPlatform(ctx) {
    ctx.provide("slots", slots); ctx.provide("inputScopes", new InputScopeService()); ctx.provide("dialogs", new DialogService());
    ctx.provide("canvasSession", session); ctx.provide("canvasRemote", {} as never); ctx.provide("canvasEdit", edit as never);
    ctx.provide("selection", { getSnapshot: () => ({ nodeIds: [], primaryNodeId: null, editingFocus: false, keyboardActive: true }) } as never);
    ctx.provide("canvasRuntime", { lastPointerWorld: () => ({ x: 500, y: 500 }), controller: () => ({ viewport: () => ({ x: 0, y: 0, zoom: 1 }) }) } as never);
  }, plugins: [{ id: "paste-import", required: false, plugin: pasteImportExtension() }] });
  try {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canonical);
    nodeSelectionStore.setFromRuntime({ nodeIds: ["m", "g", "a", "c"], primaryNodeId: "m", editingFocus: false }, new Set(["m", "g", "a", "c"]));
    const keyboard = createKeyboardShortcuts({ options: { getSession: () => session }, target: window, writable: () => true,
      state: {}, model: { active: false }, schedule: () => {}, modalActive: () => false, attachActive: () => false } as never);
    if (entry === "duplicate") keyboard.onKeyDown(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true }));
    else {
      keyboard.onKeyDown(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true }));
      await expect.poll(() => (window as unknown as Record<string, unknown>).__canvasMemoryClipboard).toBeTruthy();
      const text = (window as unknown as Record<string, string>).__canvasMemoryClipboard;
      expect(slots.list("input.paste")[0]!.handle({ clipboardData: { files: [], items: [], types: [], getData: () => text } } as unknown as ClipboardEvent)).toBe(true);
    }
    await expect.poll(() => canonical.document.nodes.length).toBe(8);
    await expect.poll(() => edit.getSnapshot().canUndo).toBe(true);
    const copyIds = canonical.document.nodes.map(n => n.id).filter(id => !["m", "g", "a", "c"].includes(id));
    const copied = structuredClone(copyIds.map(id => canonical.nodeData[id]));
    const copiedCamera = copied.find(data => data.worldCamera)?.worldCamera as typeof camera;
    const copiedInstance = copied.find(data => data.sharedWorldInstance)?.sharedWorldInstance as typeof instance;
    expect(copiedCamera.boundInstanceId).toBe(copiedInstance.instanceId);
    expect(copiedInstance.instanceId).not.toBe(instance.instanceId);
    expect(copiedCamera.cameraId).not.toBe(camera.cameraId);
    expect(copiedCamera.settingsVersion).toBe(camera.settingsVersion);
    expect(copiedInstance.transform).toEqual(instance.transform);
    expect(copiedCamera.position).toEqual(camera.position);
    const copiedGroup = copied.find(data => data.workflowGroup2d)!.workflowGroup2d as { groupId: string; scopeVersion: string; memberNodeIds: string[] };
    const copiedArea = copied.find(data => data.sceneArea)!.sceneArea as { areaId: string; scopeVersion: string };
    expect(copiedGroup.memberNodeIds).toEqual([copyIds[copied.findIndex(data => data.sharedWorldInstance)]]);
    expect(copiedGroup.groupId).not.toBe("g"); expect(copiedGroup.scopeVersion).not.toBe("1");
    expect(copiedArea.areaId).not.toBe("a"); expect(copiedArea.scopeVersion).not.toBe("1");
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(serverCanvasToYDoc(canonical)));
    const roundtrip = yDocToServerCanvas(restored);
    expect(roundtrip.ok).toBe(true);
    if (roundtrip.ok) expect(copyIds.map(id => roundtrip.canvas.nodeData[id])).toEqual(copied);
    expect(canonical.nodeData.m.sharedWorldInstance).toEqual(instance);
    const beforeFailure = structuredClone(canonical);
    const invalid = JSON.stringify({ format: "infinspire-canvas-copy-v1", nodes: [{ id: "bad", type: "text", position: { x: 0, y: 0 }, width: -1 }], edges: [], incomingEdges: [], nodeData: {} });
    if (entry === "duplicate") window.dispatchEvent(new CustomEvent("woohaa3-canvas-duplicate", { detail: invalid }));
    else slots.list("input.paste")[0]!.handle({ clipboardData: { files: [], items: [], types: [], getData: () => invalid } } as unknown as ClipboardEvent);
    expect(canonical).toEqual(beforeFailure);
    expect(edit.getSnapshot().canUndo).toBe(true);
    expect(await edit.undo()).toEqual({ ok: true });
    expect(canonical.document.nodes).toHaveLength(4);
    const undone = yDocToServerCanvas(serverCanvasToYDoc(canonical));
    expect(undone.ok && undone.canvas.nodeData).toEqual(canonical.nodeData);
    expect(await edit.redo()).toEqual({ ok: true });
    expect(copyIds.map(id => canonical.nodeData[id])).toEqual(copied);
    const redone = yDocToServerCanvas(serverCanvasToYDoc(canonical));
    expect(redone.ok && redone.canvas.nodeData).toEqual(canonical.nodeData);
  } finally { delete (window as unknown as Record<string, unknown>).__canvasMemoryClipboard; nodeSelectionStore.reset(); await runtime.dispose(); woohaa3CanvasStore.getState().applyRemoteCanvas(null as never); repository.close(); rmSync(dir, { recursive: true, force: true }); }
});

it.each(["duplicate", "paste"])("%s preserves layout across unselected parent chains", async (entry) => {
  let canonical = createEmptyWoohaa3ServerCanvas("mixed-parents");
  canonical.document.nodes = [
    { id: "outer", type: "group", position: { x: 100, y: 200 }, width: 400, height: 300 },
    { id: "left", type: "group", parentId: "outer", position: { x: 10, y: 20 }, width: 400, height: 300 },
    { id: "right", type: "group", position: { x: 1000, y: 300 }, width: 400, height: 300 },
    { id: "a", type: "text", parentId: "left", position: { x: 20, y: 30 }, width: 200, height: 150 },
    { id: "b", type: "text", parentId: "right", position: { x: 20, y: 30 }, width: 200, height: 150 },
    { id: "c", type: "text", position: { x: 500, y: 600 }, width: 200, height: 150 }
  ];
  const original = structuredClone(canonical.document.nodes);
  const session = { isWritable: () => true, commandLifecycle: () => null, submitCommands(commands: readonly CanvasCommand[]) {
    const result = applyCanvasCommands(canonical, commands);
    if (!result.ok) throw Error(JSON.stringify(result));
    canonical = result.canvas;
    woohaa3CanvasStore.getState().applyRemoteCanvas(canonical);
    return { ok: true, handle: { settled: Promise.resolve({ state: "committed", error: null }) } };
  } } as unknown as CanvasSession;
  let submitted: readonly CanvasCommand[] | undefined;
  const mixedEdit = { async record(commands: readonly CanvasCommand[]) {
    submitted = commands;
    return { ok: true };
  } };
  const slots = new SlotRegistry();
  const runtime = await startFrontendRuntime({ installPlatform(ctx) {
    ctx.provide("slots", slots); ctx.provide("inputScopes", new InputScopeService()); ctx.provide("dialogs", new DialogService());
    ctx.provide("canvasSession", session); ctx.provide("canvasRemote", {} as never); ctx.provide("canvasEdit", mixedEdit as never);
    ctx.provide("selection", { getSnapshot: () => ({ nodeIds: [], primaryNodeId: null, editingFocus: false, keyboardActive: true }) } as never);
    ctx.provide("canvasRuntime", { lastPointerWorld: () => ({ x: 1500, y: 1500 }), controller: () => ({ viewport: () => ({ x: 0, y: 0, zoom: 1 }) }) } as never);
  }, plugins: [{ id: "paste-import", required: false, plugin: pasteImportExtension() }] });
  try {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canonical);
    nodeSelectionStore.setFromRuntime({ nodeIds: ["a", "b", "c"], primaryNodeId: "a", editingFocus: false }, new Set(["a", "b", "c"]));
    const keyboard = createKeyboardShortcuts({ options: { getSession: () => session }, target: window, writable: () => true,
      state: {}, model: { active: false }, schedule: () => {}, modalActive: () => false, attachActive: () => false } as never);
    keyboard.onKeyDown(new KeyboardEvent("keydown", { key: entry === "paste" ? "c" : "d", ctrlKey: true, bubbles: true, cancelable: true }));
    if (entry === "paste") {
      await expect.poll(() => (window as unknown as Record<string, unknown>).__canvasMemoryClipboard).toBeTruthy();
      const text = (window as unknown as Record<string, string>).__canvasMemoryClipboard;
      slots.list("input.paste")[0]!.handle({ clipboardData: { files: [], items: [], types: [], getData: () => text } } as unknown as ClipboardEvent);
    }
    await expect.poll(() => submitted).toBeDefined();
    const copies = submitted!.filter(command => command.type === "node.add").map(command => (command as Extract<CanvasCommand, { type: "node.add" }>).node);
    expect(copies).toHaveLength(3);
    expect(copies.every(node => !node.parentId)).toBe(true);
    expect(copies[1].position.x - copies[0].position.x).toBe(890);
    expect(copies[1].position.y - copies[0].position.y).toBe(80);
    expect(copies[2].position.x - copies[0].position.x).toBe(370);
    expect(copies[2].position.y - copies[0].position.y).toBe(350);
    expect(canonical.document.nodes).toEqual(original);
  } finally { delete (window as unknown as Record<string, unknown>).__canvasMemoryClipboard; nodeSelectionStore.reset(); await runtime.dispose(); woohaa3CanvasStore.getState().applyRemoteCanvas(null as never); }
});

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
