import { migrateFilmSetFixture } from "../../../test-support/film-set-groups.js";
import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildCanvasRenderScene, canonicalFilmSetFields, ContentContributionRegistry,
  createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, createMotionSnapshot, shotPreviewNodeId,
  shotImageReferenceAssetId,
  type ServerCanvas, type StoredAsset} from "@woohaa3/contracts";
import { CompositeAssetRegistry } from "@woohaa3/frontend/extension-api";
import { createFilmSetModelAdapter } from "../src/preview/browser/model-adapter.js";
import { filmSetPresentation } from "../src/state/shared/content/presentation.js";
import { createShotMediaProvider, shotMediaRef, shotMediaSource } from "../src/authoring/browser/shot-media-provider.js";
import type { FilmSetHostContext } from "../src/state/browser/host-ports.js";
import type { ShotImageReferences } from "../src/authoring/browser/shot-image-reference.js";
import type { ShotReferenceRecordingController } from "../src/authoring/browser/shot-reference-recording-controller.js";
import { ownsShotMedia } from "../src/state/shared/managed-shot-media.js";
import { resolveFilmSetConversionAvailability } from "../src/authoring/browser/film-set-conversion/view.js";

function fixture(kind: "static" | "dynamic"): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("managed-media-render");
  const animation = createFilmSetSnapshot({
    title: "Film", model: { modelScript: 'scene.box({id:"body"});', modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: 'motion.model.rotate("body", {speed:1});', timeline: { duration: 4, loop: false },
  });
  if (kind === "static") {
    animation.filmSetAnimations!.clips[0] = {
      ...animation.filmSetAnimations!.clips[0]!, kind,
      timeline: { duration: 0, loop: false }, bindings: [],
      cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }),
    };
  }
  canvas.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
  canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
  const result = applyCanvasCommands(migrateFilmSetFixture(canvas, "film"), [{ type: "canvas.setTitle", title: "Film" }]);
  if (!result.ok) throw Error(result.rejection.message);
  return result.canvas;
}

describe("managed shot media render pipeline", () => {
  it.each(["static", "dynamic"] as const)("excludes its own %s media from conversion while preserving ordinary sources", kind => {
    const canvas = fixture(kind), id = shotPreviewNodeId("film", "clip-1"), type = kind === "static" ? "image" : "video";
    expect(ownsShotMedia(canvas, id)).toBe(true);
    expect(resolveFilmSetConversionAvailability({ canvas, nodeId: id, nodeType: type, writable: true })).toEqual({ available: false, reason: "片场镜头媒体不能再次创建片场" });
    canvas.document.nodes.push({ id: "independent", type, position: { x: 0, y: 0 } });
    canvas.nodeData.independent = { mediaContent: canvas.nodeData[id].mediaContent! };
    expect(ownsShotMedia(canvas, "independent")).toBe(false);
    canvas.nodeData.independent.managedBy = { ...canvas.nodeData[id].managedBy!, extensionId: "another-extension" };
    expect(ownsShotMedia(canvas, "independent")).toBe(false);
  });
  it("resolves a committed current PNG after reload and rejects stale local producer assets", async () => {
    const canvas = fixture("static"), ref = shotMediaRef("film", "clip-1");
    const source = shotMediaSource(canvas, ref, "#f6f8f6");
    const dimensions = /^image-v1-(\d+)x(\d+)/.exec(source.profileKey)!;
    const asset: StoredAsset = {
      id: shotImageReferenceAssetId(source), title: "Shot", mediaKind: "image", status: "ready", source: "generated", createdAt: "2026-10-26",
      metadata: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: "image/png", width: Number(dimensions[1]), height: Number(dimensions[2]), shotImageReference: { filmSetNodeId: "film", clipId: "clip-1", contentIdentity: source.contentIdentity, profileKey: source.profileKey } },
    };
    canvas.assets.push(asset);
    const retry = vi.fn(), requestRecord = vi.fn();
    let local: StoredAsset | undefined;
    const provider = createShotMediaProvider({ get: () => ({ getSnapshot: () => ({ tokens: { webSubtle: "#f6f8f6" } }) }) } as unknown as FilmSetHostContext,
      { state: () => ({ status: "dirty", asset: local }), retry, subscribe: () => () => {} } as unknown as ShotImageReferences,
      { requestRecord } as unknown as ShotReferenceRecordingController);
    const context = { canvas, nodeId: shotPreviewNodeId("film", "clip-1"), ref, source, signal: new AbortController().signal, requestId: "reload" };
    expect(await provider.resolvePreview(context)).toEqual(asset);
    expect(await provider.materialize(context)).toEqual(asset);
    expect(retry).not.toHaveBeenCalled(); expect(requestRecord).not.toHaveBeenCalled();
    local = structuredClone(asset);
    local.metadata!.shotImageReference = { ...source, contentIdentity: "outdated" };
    canvas.assets = [];
    expect(await provider.resolvePreview(context)).toBeNull();
  });
  it.each(["static", "dynamic"] as const)("accepts atomic %s asset binding without allowing ownership changes", kind => {
    const canvas = fixture(kind);
    const id = shotPreviewNodeId("film", "clip-1");
    const data = canvas.nodeData[id];
    const asset: StoredAsset = { id: "rendered-shot", mediaKind: kind === "static" ? "image" : "video", status: "ready", source: "generated", title: "Shot", createdAt: "2026-10-26", metadata: { storageKey: `sha256-${"a".repeat(64)}` } };
    const result = applyCanvasCommands(canvas, [
      { type: "nodeData.patch", nodeId: id, expectedNodeData: { [id]: data, film: canvas.nodeData.film }, value: { outputAssetId: asset.id, status: "ready" } },
      { type: "asset.upsert", asset },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.rejection.message);
    expect(result.canvas.nodeData[id]).toEqual({ ...data, outputAssetId: asset.id, status: "ready" });
    expect(result.canvas.assets).toContainEqual(asset);
    for (const value of [null, { managedBy: null } as never, { managedBy: { ...data.managedBy!, entityId: "forged" } }]) {
      const rejected = applyCanvasCommands(result.canvas, [{ type: "nodeData.patch", nodeId: id, value }]);
      expect(rejected.ok).toBe(false);
      expect(result.canvas.nodeData[id].managedBy).toEqual(data.managedBy);
    }
    expect(applyCanvasCommands(result.canvas, [{ type: "node.remove", nodeIds: [id] }]).ok).toBe(false);
  });
  it.each(["static", "dynamic"] as const)("keeps the %s shot camera route after canonical media migration", kind => {
    const canvas = fixture(kind);
    const id = shotPreviewNodeId("film", "clip-1");
    const canonical = structuredClone(canvas);
    const registry = new CompositeAssetRegistry();
    registry.register(createFilmSetModelAdapter());
    const projected = registry.projectCanvas(canvas)!;
    const content = new ContentContributionRegistry();
    content.register({ extensionId: "film-set", presentation: filmSetPresentation });
    const scene = buildCanvasRenderScene({ canvas: projected, content });
    const node = scene.nodes.find(node => node.id === id)!;
    expect(node.type).toBe(kind === "static" ? "image" : "video");
    // Both live preview and requestCapture route through this descriptor. They
    // must work before PNG/video materialization has written outputAssetId.
    expect(canvas.nodeData[id].outputAssetId).toBeUndefined();
    expect(scene.previewCards?.find(card => card.nodeId === id)).toMatchObject({
      ownerNodeId: "film", entityId: "clip-1", animated: kind === "dynamic"
    });
    expect(registry.children(projected).get(id)).toMatchObject({ ownerNodeId: "film", role: "preview" });
    expect(canvas).toEqual(canonical);
    expect(canvas.nodeData[id].shotPreview).toBeUndefined();
  });
  it("projects a group clip's backdrop and dynamic playback into its preview", () => {
    const canvas = fixture("dynamic"), id = shotPreviewNodeId("film", "clip-1");
    canvas.nodeData.film.filmSetGroup!.clips![0]!.backdrop = "#112233";
    const registry = new CompositeAssetRegistry();
    registry.register(createFilmSetModelAdapter());
    const content = new ContentContributionRegistry();
    content.register({ extensionId: "film-set", presentation: filmSetPresentation });
    const scene = buildCanvasRenderScene({ canvas: registry.projectCanvas(canvas)!, content, previewLocalStates: new Map([[id, { state: "ready", progress: 0.6, playing: true }]]) });
    expect(scene.previewCards?.find(card => card.nodeId === id)).toMatchObject({ backdrop: "#112233", progress: 0.6, playing: true });
  });
});
