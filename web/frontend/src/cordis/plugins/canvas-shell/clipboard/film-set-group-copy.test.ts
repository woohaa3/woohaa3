import { expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createFilmSetGroupMarker, createModel3DNodeData, model3DNodeDataFields, prepareFilmSetGroup, readFilmSetAnimationProjection, shotPreviewNodeId, staticShotCameraMotion, type StoredAsset } from "@woohaa3/contracts";
import { applyCanvasCommands, filmSetTestLifecycles } from "../../../../../../test-support/managed-shot-commands.js";
import { buildCanvasCopyPayload, parseCanvasCopyPayload, serializeCanvasCopyPayload } from "./payload.js";
import { planCanvasPaste } from "./planner.js";

it("cross-canvas paste remaps the full film group closure and keeps following the copied live cards", () => {
  const source = createEmptyWoohaa3ServerCanvas("source-canvas");
  source.document.nodes = [{ id: "film", type: "group", position: { x: 0, y: 0 } }, ...["model3d", "image", "video"].map((type, index) => ({ id: type, type, parentId: "film", position: { x: index * 100, y: 30 } }))];
  source.nodeData.model3d = model3DNodeDataFields(createModel3DNodeData({ title: "Actor", model: { modelScript: "scene.box({id:'body'});", modelScriptVersion: "woohaa-model-js-v2" } })) as never;
  for (const kind of ["image", "video"] as const) {
    source.nodeData[kind] = { outputAssetId: `asset-${kind}`, resourceKind: kind, taskStatus: "successed", activeRunId: "running-must-not-copy" };
    source.assets.push({ id: `asset-${kind}`, title: kind, mediaKind: kind, source: "uploaded", status: "ready", createdAt: "2026-10-28T00:00:00Z", metadata: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), width: 320, height: 240 } } as StoredAsset);
  }
  source.nodeData.film = { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: ["model3d", "image", "video"].map(kind => ({ bindingId: `binding-${kind}`, sourceNodeId: kind, kind: kind as "model3d" | "image" | "video", visibility: true, contentKey: `old-${kind}`, transform: { x: 0, y: 0, z: 0, scale: 1, yaw: 0 } })), cameras: [{ id: "camera", azimuth: 0, elevation: .3, distance: 5, focusOffset: { x: 0, y: 0, z: 0 } }], clips: [{ id: "clip", cameraId: "camera", duration: 0, loop: false, cameraMotion: staticShotCameraMotion(), bindings: [] }], activeClip: "clip" }) };
  const materialized = applyCanvasCommands(source, []);
  if (!materialized.ok) throw Error(materialized.rejection.message);
  const baseline = structuredClone(materialized.canvas);
  const payload = parseCanvasCopyPayload(serializeCanvasCopyPayload(buildCanvasCopyPayload(materialized.canvas, ["film"])!))!;
  const target = createEmptyWoohaa3ServerCanvas("target-canvas");
  const plan = planCanvasPaste({ canvas: target, payload, lifecycle: filmSetTestLifecycles, anchor: null, viewport: { x: 0, y: 0, zoom: 1 }, createId: (prefix, index) => `copy-${prefix}-${index}` });
  expect(plan).not.toBeNull();
  const result = applyCanvasCommands(target, plan!.commands);
  if (!result.ok) throw Error(result.rejection.message);
  const canvas = result.canvas;
  const group = canvas.document.nodes.find(node => node.type === "group")!;
  const marker = canvas.nodeData[group.id].filmSetGroup!;
  expect(marker.sceneBindings).toHaveLength(3);
  for (const binding of marker.sceneBindings) {
    expect(binding.sourceNodeId).toMatch(/^copy-/);
    expect(binding.bindingId).toMatch(/^copy-/);
    expect(canvas.document.nodes.find(node => node.id === binding.sourceNodeId)?.parentId).toBe(group.id);
    expect(canvas.nodeData[binding.sourceNodeId].activeRunId).toBeUndefined();
  }
  expect(canvas.document.nodes.some(node => node.id === shotPreviewNodeId(group.id, marker.clips![0]!.id))).toBe(true);
  expect(prepareFilmSetGroup(canvas, group.id)!.diagnostics).toEqual([]);
  const model = marker.sceneBindings.find(binding => binding.kind === "model3d")!;
  canvas.nodeData[model.sourceNodeId].modelScript = "scene.sphere({id:'updated',radius:3});";
  const item = readFilmSetAnimationProjection(canvas, group.id)!.filmSetContent.items.find(item => item.id === model.bindingId)!;
  expect(item.kind === "model" && item.model.modelScript).toContain("updated");
  expect(materialized.canvas).toEqual(baseline);
});
