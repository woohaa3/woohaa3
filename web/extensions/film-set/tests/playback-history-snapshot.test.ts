import { afterEach, expect, it } from "vitest";
import { createFilmSetGroupMarker, createEmptyWoohaa3ServerCanvas, createModel3DNodeData, model3DNodeDataFields, readFilmSetAnimationProjection, type NodeGenerationHistoryDetail } from "@woohaa3/contracts";
import { HistoryFilmSetSnapshots } from "../src/preview/browser/history-preview.js";
const history = new HistoryFilmSetSnapshots();
afterEach(() => history.clear("film"));
it("history restores orchestration while resolving the current resource card", () => {
  const marker = createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "actor", sourceNodeId: "source", kind: "model3d", contentKey: "historic-key", visibility: true, transform: { x: 3, y: 0, z: 0, yaw: 0, scale: 1 } }] });
  const detail: NodeGenerationHistoryDetail = { entryId: "old", kind: "model", modelScript: "", language: "javascript", version: "woohaa-model-js-v2", sourceHash: "hist", animation: { schemaVersion: 4, filmSetGroup: marker } };
  const canvas = createEmptyWoohaa3ServerCanvas("c", "now");
  canvas.document.nodes.push({ id: "film", type: "group", position: { x: 0, y: 0 } }, { id: "source", type: "model3d", parentId: "film", position: { x: 0, y: 0 } });
  canvas.nodeData.film = { filmSetGroup: createFilmSetGroupMarker() };
  canvas.nodeData.source = model3DNodeDataFields(createModel3DNodeData({ title: "current", model: { modelScript: "scene.box({id:'current'});", modelScriptVersion: "woohaa-model-js-v2" } })) as never;
  const before = JSON.stringify(canvas);
  expect(history.set("film", detail)).toBe(true);
  const projection = readFilmSetAnimationProjection(history.project(canvas), "film")!;
  const actor = projection.filmSetContent.items.find(item => item.id === "actor");
  expect(actor?.kind === "model" && actor.model.modelScript).toContain("current");
  expect(actor?.localTransform.offset.x).toBe(3);
  expect(history.get("film")?.sceneBindings[0].contentKey).toBe("historic-key");
  expect(JSON.stringify(canvas)).toBe(before);
  history.clear("film");
  expect(history.project(canvas)).toBe(canvas);
});
it("schema 4 with an illegal marker does not override history", () => {
  expect(history.set("film", { kind: "model", animation: { schemaVersion: 4, filmSetGroup: { schemaVersion: 1, sceneBindings: "nope" } } } as unknown as NodeGenerationHistoryDetail)).toBe(false);
  expect(history.get("film")).toBeUndefined();
});
it("legacy snapshots and unknown versions cannot become online history overrides", () => {
  for (const schemaVersion of [3, 99]) {
    expect(history.set("film", { kind: "model", animation: { schemaVersion } } as unknown as NodeGenerationHistoryDetail)).toBe(false);
    expect(history.get("film")).toBeUndefined();
  }
});
