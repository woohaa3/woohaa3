import { expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createFilmSetGroupMarker, createModelSnapshot, type CanvasCommand } from "@woohaa3/contracts";
import { applyCanvasCommands, planCanvasEdit } from "../../../test-support/managed-shot-commands.js";
import { submitProtectedItemOp } from "../src/integration/browser/film-set-object-feature.js";
import { readFilmSetContentForSession } from "../src/state/browser/object-state.js";
import { FilmSetObjectSession } from "../src/authoring/browser/object-session.js";
import { createFilmSetObjectGesture } from "../src/authoring/browser/film-set-object-gesture.js";
import type { FilmSetContext } from "../src/integration/browser/context.js";

it.each(["model3d", "image", "video", "ground"])("%s drag commits once through the group journal and supports undo/redo and repeated drags", async kind => {
  let canvas = createEmptyWoohaa3ServerCanvas("gesture");
  canvas.document.nodes.push({ id: "film", type: "group", position: { x: 120, y: 80 } });
  const itemId = kind === "ground" ? "film-set-ground" : "binding";
  const transform = { x: 0, y: 0, z: 0, yaw: 0, scale: 1 };
  canvas.nodeData.film = { filmSetGroup: createFilmSetGroupMarker({ sceneTransform: { x: 3, y: 4, z: 5, yaw: Math.PI / 2, scale: 4 },
    ...(kind === "ground" ? { ground: { width: 20, depth: 20, transform } } : { sceneBindings: [{ bindingId: itemId, sourceNodeId: "source", kind: kind as "model3d" | "image" | "video", transform, visibility: true, contentKey: "v1" }] }) }) };
  if (kind !== "ground") {
    canvas.document.nodes.push({ id: "source", type: kind as "model3d" | "image" | "video", parentId: "film", position: { x: 20, y: 30 } });
    const model = createModelSnapshot({ modelScript: "scene.box({id:'body'});", modelScriptVersion: "woohaa-model-js-v2" });
    canvas.nodeData.source = kind === "model3d" ? { modelScript: model.modelScript, modelScriptLanguage: model.modelScriptLanguage, modelScriptVersion: model.modelScriptVersion, modelContentVersion: model.contentVersion } : { outputAssetId: "asset" };
    if (kind !== "model3d") canvas.assets.push({ id: "asset", mediaKind: kind, status: "ready", url: "/media/asset" } as never);
  }
  const sourceBefore = structuredClone(canvas.nodeData.source ?? null);
  const journal: Array<Extract<CanvasCommand, { type: "edit.apply" }>[]> = [];
  let inverse: CanvasCommand[] = [];
  let forward: CanvasCommand[] = [];
  const ctx = { canvasState: { getCanvas: () => canvas, getWorkingCanvas: () => canvas }, canvasSession: { isWritable: () => true },
    canvasEdit: { record: async (commands: CanvasCommand[]) => {
      const plan = planCanvasEdit(canvas, commands);
      if (!plan.ok) return { ok: false, reason: plan.reason };
      forward = [{ type: "edit.apply", ...plan.forward }]; inverse = [{ type: "edit.apply", ...plan.inverse }];
      const result = applyCanvasCommands(canvas, forward);
      if (!result.ok) return { ok: false, reason: result.rejection.message };
      canvas = result.canvas; journal.push(forward as never); return { ok: true };
    } } } as unknown as FilmSetContext;
  const session = new FilmSetObjectSession({ readContent: () => readFilmSetContentForSession(canvas, "film"), isWritable: () => true,
    submitItemOp: ({ nodeId, itemId, op, label }) => submitProtectedItemOp(ctx, nodeId, itemId, op, label) });
  session.enter("film"); session.select(itemId);
  const camera = { target: [0, 0, 0] as [number, number, number], yaw: 0, pitch: 0, distance: 20, flySpeed: 6 };
  const { handler } = createFilmSetObjectGesture({ session, projection: () => camera, surface: () => ({ width: 1024, height: 768 }),
    compositionBasis: () => ({ unit: 4, yaw: Math.PI / 2, center: [0, 0, 0] }), pick: () => itemId,
    hitObjectGizmo: () => ({ handle: "x", direction: [1, 0], worldPerPixel: 2 }), nodeId: () => "film", blocked: () => false });
  for (let n = 0; n < 2; n++) {
    expect(handler.begin({ x: 400, y: 300 }, false)).toBe(true);
    handler.move({ x: 410, y: 300 }); handler.end(); handler.end();
    await Promise.resolve(); await Promise.resolve();
    expect(journal).toHaveLength(n + 1);
    expect(session.selectedItem()!.localTransform.offset.z).toBeCloseTo((n + 1) * 5);
  }
  expect(canvas.nodeData.source ?? null).toEqual(sourceBefore);
  const undo = applyCanvasCommands(canvas, inverse); if (!undo.ok) throw Error(undo.rejection.message);
  expect(readFilmSetContentForSession(undo.canvas, "film").items.find(item => item.id === itemId)?.localTransform.offset.z).toBeCloseTo(5);
  const redo = applyCanvasCommands(undo.canvas, forward); if (!redo.ok) throw Error(redo.rejection.message);
  canvas = redo.canvas;
  expect(session.selectedItem()!.localTransform.offset.z).toBeCloseTo(10);
  handler.begin({ x: 400, y: 300 }, false); handler.move({ x: 420, y: 300 }); handler.cancel(); handler.end();
  expect(journal).toHaveLength(2); expect(session.getState().preview).toBeNull();
});
