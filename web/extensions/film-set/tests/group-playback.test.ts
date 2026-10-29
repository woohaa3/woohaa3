import { expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createFilmSetGroupMarker, createModelSnapshot, createMotionSnapshot, resolveFilmSetClip, compileFilmSetClip } from "@woohaa3/contracts";
import { shotMediaSource, shotMediaRef } from "../src/authoring/browser/shot-media-provider.js";
import { observeFilmSetClips } from "../src/authoring/browser/shot-reference-observation.js";
import { readAnimation } from "../src/integration/browser/playback-plugin.js";

it("compiles group-owned object animation against live source geometry without persisting content", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("group-playback");
  canvas.document.nodes.push({ id: "film", type: "group", position: { x: 0, y: 0 } }, { id: "source", type: "model3d", parentId: "film", position: { x: 20, y: 20 } });
  const model = createModelSnapshot({ modelScript: "scene.box({id:'body'});", modelScriptVersion: "woohaa-model-js-v2" });
  const motion = createMotionSnapshot({ motionScript: "motion.model.rotate('body',{speed:1});", basedOnModelVersion: model.contentVersion });
  canvas.nodeData.source = { modelScript: model.modelScript, modelScriptLanguage: model.modelScriptLanguage, modelScriptVersion: model.modelScriptVersion, modelContentVersion: model.contentVersion };
  canvas.nodeData.film = { filmSetGroup: createFilmSetGroupMarker({ activeClip: "shot", clips: [{ id: "shot", duration: 2 }], sceneBindings: [{ bindingId: "actor", sourceNodeId: "source", kind: "model3d", transform: { x: 3, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true, contentKey: `model3d:${model.contentVersion.contentHash}`, animation: { motion, playback: { startTime: 0, duration: 2, timeScale: 1, loop: false } } }] }) };
  const before = JSON.stringify(canvas);
  const animation = readAnimation(canvas, "film");
  expect(animation).not.toBeNull();
  const view = resolveFilmSetClip(animation!, "shot");
  expect(view?.clip.bindings[0]?.itemId).toBe("actor");
  expect(view?.content.items[0]).toMatchObject({ id: "actor", kind: "model", localTransform: { offset: { x: 3, y: 0, z: 0 } } });
  const compiled = compileFilmSetClip("film", view!);
  expect(compiled.ok).toBe(true);
  if (compiled.ok) expect(compiled.diagnostics).toEqual([]);
  expect(JSON.stringify(canvas)).toBe(before);
  expect(canvas.nodeData.film.filmSetContent).toBeUndefined();
  const source = shotMediaSource(canvas, shotMediaRef("film", "shot"), "#ffffff");
  expect(observeFilmSetClips(canvas, "film")[0]?.contentIdentity).toBe(source.contentIdentity);
  const next = createModelSnapshot({ modelScript: "scene.box({id:'body',size:[3,2,1]});", modelScriptVersion: "woohaa-model-js-v2" });
  canvas.nodeData.source.modelScript = next.modelScript;
  canvas.nodeData.source.modelContentVersion = next.contentVersion;
  const changed = observeFilmSetClips(canvas, "film")[0]?.contentIdentity;
  expect(changed).not.toBe(source.contentIdentity);
  expect(changed).toBe(shotMediaSource(canvas, shotMediaRef("film", "shot"), "#ffffff").contentIdentity);

});

it("invalidates dynamic shot references when the bound media bytes change", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("group-media");
  canvas.document.nodes.push({ id: "film", type: "group", position: { x: 0, y: 0 } }, { id: "source", type: "image", parentId: "film", position: { x: 20, y: 20 } });
  canvas.nodeData.source = { outputAssetId: "image" };
  canvas.assets.push({ id: "image", mediaKind: "image", status: "ready", metadata: { checksum: "first", storageKey: "one", width: 100, height: 50 } } as never);
  canvas.nodeData.film = { filmSetGroup: createFilmSetGroupMarker({ clips: [{ id: "shot", duration: 2 }], sceneBindings: [{ bindingId: "image", sourceNodeId: "source", kind: "image", transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true, contentKey: "image:first" }] }) };
  const before = shotMediaSource(canvas, shotMediaRef("film", "shot"), "#ffffff").contentIdentity;
  expect(observeFilmSetClips(canvas, "film")[0]?.contentIdentity).toBe(before);
  canvas.assets[0]!.metadata!.checksum = "second";
  const after = shotMediaSource(canvas, shotMediaRef("film", "shot"), "#ffffff").contentIdentity;
  expect(after).not.toBe(before);
  expect(observeFilmSetClips(canvas, "film")[0]?.contentIdentity).toBe(after);
});
