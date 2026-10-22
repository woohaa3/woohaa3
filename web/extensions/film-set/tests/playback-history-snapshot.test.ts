import { afterEach, expect, it } from "vitest";
import { canonicalFilmSetFields, createFilmSetSnapshot, createEmptyWoohaa3ServerCanvas, decodeFilmSetNodeData, filmSetAnimationsOf, type NodeGenerationHistoryDetail } from "@woohaa3/contracts";
import { HistoryFilmSetSnapshots } from "../src/frontend/history-preview.js";
const historyFilmSetSnapshots = new HistoryFilmSetSnapshots();
afterEach(() => historyFilmSetSnapshots.clear("film"));
it("history preview isolates the complete scene and clip collection, then restores the live view", () => {
  const historical = createFilmSetSnapshot({ title: "old", model: { modelScript: "scene.box({id:'historic'});", modelScriptVersion: "woohaa-model-js-v2" }, modelItemId: "old-actor", motionScript: "motion.model.rotate('historic', { speed: 1 });", timeline: { duration: 7, loop: false } });
  const collection = filmSetAnimationsOf(historical);
  const detail: NodeGenerationHistoryDetail = {
    entryId: "old", kind: "model", modelScript: "", language: "javascript", version: "woohaa-model-js-v2", sourceHash: "hist",
    animation: { schemaVersion: 3, scenePlacement: historical.scenePlacement, sceneCamera: historical.sceneCamera, filmSetContent: historical.filmSetContent, filmSetAnimations: collection }
  };
  const canvas = createEmptyWoohaa3ServerCanvas("c", "now");
  canvas.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
  canvas.nodeData.film = canonicalFilmSetFields(historical) as never;
  const before = JSON.stringify(canvas);
  expect(historyFilmSetSnapshots.set("film", detail)).toBe(true);
  const decoded = decodeFilmSetNodeData(historyFilmSetSnapshots.project(canvas)!.nodeData.film);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  const historicItem = decoded.value.filmSetContent.items.find(item => item.id === "old-actor");
  expect(historicItem && historicItem.kind === "model" ? historicItem.model.modelScript : "").toContain("historic");
  expect(filmSetAnimationsOf(decoded.value)).toEqual(collection);
  expect(JSON.stringify(canvas)).toBe(before);
  const composition = historyFilmSetSnapshots.get("film")!.composition;
  expect(historyFilmSetSnapshots.get("film")!.composition).toBe(composition);
  historyFilmSetSnapshots.clear("film");
  expect(historyFilmSetSnapshots.project(canvas)).toBe(canvas);
});
it("invalid historical animation clears preview instead of mixing in current motion", () => {
  const invalid = { entryId: "bad", kind: "model", modelScript: "", language: "javascript", version: "woohaa-model-js-v2", sourceHash: "bad", animation: { schemaVersion: 99 } };
  expect(historyFilmSetSnapshots.set("film", invalid as unknown as NodeGenerationHistoryDetail)).toBe(false);
  expect(historyFilmSetSnapshots.get("film")).toBeUndefined();
});
