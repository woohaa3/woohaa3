import { expect, it } from "vitest";
import { applyCanvasCommands } from "./command-reducer.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { contentKeyForFilmSetGroupSource, createFilmSetGroupMarker } from "./film-set-group.js";
import { createModelSnapshot } from "./animation-snapshot.js";
import { groupAppearancePreparation } from "./builtin-node-capabilities.js";

it("prepares group ground and live source geometry without writing snapshots", async () => {
  const canvas = createEmptyWoohaa3ServerCanvas("group-geometry");
  const node = { id: "film", type: "group", position: { x: 0, y: 0 } };
  canvas.document.nodes.push(node, { id: "source", type: "model3d", parentId: "film", position: { x: 20, y: 20 } });
  const model = createModelSnapshot({ modelScript: "scene.box({id:'body',size:[1,2,3]});", modelScriptVersion: "woohaa-model-js-v2" });
  canvas.nodeData.source = { modelScript: model.modelScript, modelScriptLanguage: model.modelScriptLanguage, modelScriptVersion: model.modelScriptVersion, modelContentVersion: model.contentVersion };
  canvas.nodeData.film = { filmSetGroup: createFilmSetGroupMarker({ ground: { width: 10, depth: 12 }, sceneBindings: [{ bindingId: "actor", sourceNodeId: "source", kind: "model3d", visibility: true, contentKey: model.contentVersion.contentHash, transform: { x: 2, y: 0, z: 0, yaw: 0, scale: 1 } }] }) };
  const context = { canvas, node, data: canvas.nodeData.film };
  const before = JSON.stringify(canvas);
  const originalContentKey = contentKeyForFilmSetGroupSource(canvas, "source");
  const firstKey = groupAppearancePreparation.executionKey(context);
  const first = await groupAppearancePreparation.prepare(context);
  expect(first.status).toBe("ok");
  expect(first.resource?.ops.some(op => op.t === "box")).toBe(true);
  expect(JSON.stringify(canvas)).toBe(before);
  canvas.nodeData.film.filmSetGroup!.sceneBindings[0]!.transform.x = 5;
  canvas.nodeData.film.filmSetGroup!.sceneBindings[0]!.visibility = false;
  expect(groupAppearancePreparation.executionKey(context)).toBe(firstKey);
  const transformed = await groupAppearancePreparation.prepare(context);
  expect(transformed.resource?.signature).toBe(first.resource?.signature);
  canvas.nodeData.source.modelScript = "scene.sphere({id:'body',radius:2});";
  expect(contentKeyForFilmSetGroupSource(canvas, "source")).not.toBe(originalContentKey);
  expect(groupAppearancePreparation.executionKey(context)).not.toBe(firstKey);
  const next = await groupAppearancePreparation.prepare(context);
  expect(next.resource?.signature).not.toBe(first.resource?.signature);
  expect(next.resource?.ops.some(op => op.t === "sphere")).toBe(true);
  canvas.nodeData.source.modelScript = "throw new Error('bad resource');";
  const partial = await groupAppearancePreparation.prepare(context);
  expect(partial.status).toContain("ok:partial:");
  expect(partial.resource).toBeDefined();
  expect(canvas.nodeData.film.filmSetGroup?.sceneBindings).toHaveLength(1);
});

it("removes the object instead of showing a placeholder cube when its source card is deleted", async () => {
  const canvas = createEmptyWoohaa3ServerCanvas("group-missing-source");
  const node = { id: "film", type: "group", position: { x: 0, y: 0 } };
  canvas.document.nodes.push(node, { id: "source", type: "model3d", parentId: "film", position: { x: 20, y: 20 } });
  const model = createModelSnapshot({ modelScript: "scene.box({id:'body',size:[1,2,3]});", modelScriptVersion: "woohaa-model-js-v2" });
  canvas.nodeData.source = { modelScript: model.modelScript, modelScriptLanguage: model.modelScriptLanguage, modelScriptVersion: model.modelScriptVersion, modelContentVersion: model.contentVersion };
  canvas.nodeData.film = { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "actor", sourceNodeId: "source", kind: "model3d", visibility: true, contentKey: model.contentVersion.contentHash, transform: { x: 2, y: 0, z: 0, yaw: 0, scale: 1 } }] }) };

  const deleted = applyCanvasCommands(canvas, [{ type: "node.remove", nodeIds: ["source"] }]);
  expect(deleted.ok).toBe(true);
  if (!deleted.ok) return;
  const context = { canvas: deleted.canvas, node, data: deleted.canvas.nodeData.film };
  const prepared = await groupAppearancePreparation.prepare(context);
  expect(prepared.status).toContain("missing-source");
  expect(prepared.resource?.ops.some(op => op.t !== "material" && op.id.startsWith("actor"))).toBe(false);
  expect(prepared.resource?.ops.some(op => op.t === "box" && op.id.endsWith("resource-unavailable"))).toBe(false);
  expect(deleted.canvas.nodeData.film.filmSetGroup?.sceneBindings).toHaveLength(1);
});
