import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "../command-reducer.js";
import { createEmptyWoohaa3ServerCanvas } from "../domain/index.js";
import { normalizeGlbModelReference } from "../model-definition.js";

const now = "2026-11-01T00:00:00.000Z";
const instance = {
  kind: "world-instance", version: "shared-world-v1", instanceId: "instance-1",
  transform: { version: "shared-world-v1", position: { u: 1, v: 2, h: 3 }, rotation: [0, 0, 0, 1], scale: 2 }
};

describe("world instance command boundary", () => {
  it("validates GLB placement before normalization and rejects the whole batch", () => {
    const assetId = `asset-upload-${"c".repeat(64)}`;
    const reference = normalizeGlbModelReference({ assetId });
    if (!reference.ok) throw new Error("invalid fixture");
    const asset = {
      id: assetId, title: "model.glb", mediaKind: "file" as const, source: "uploaded" as const,
      status: "ready" as const, createdAt: now, url: `/api/media/sha256-${"c".repeat(64)}`,
      metadata: { storageKey: `sha256-${"c".repeat(64)}`, checksum: "c".repeat(64), contentType: "model/gltf-binary", size: 1024, modelFormat: "glb" }
    };
    const canvas = createEmptyWoohaa3ServerCanvas("canvas", now);
    const data = { sharedWorldInstance: instance, modelSourceKind: "glb" as const, modelAssetId: assetId,
      modelContentVersion: reference.value.contentVersion, modelPlacement: reference.value.placement };
    const add = (nodeData: typeof data) => applyCanvasCommands(canvas, [
      { type: "asset.upsert", asset },
      { type: "node.add", node: { id: "model", type: "model3d", position: { x: 0, y: 0 } }, nodeData }
    ], { now });
    expect(add(data).ok).toBe(true);
    for (const modelPlacement of [
      { ...data.modelPlacement, entityHandle: { id: 42 } },
      { ...data.modelPlacement, offset: { ...data.modelPlacement.offset, extra: 1 } }
    ]) {
      const result = add({ ...data, modelPlacement });
      expect(result.ok).toBe(false);
      expect(canvas.document.nodes).toEqual([]);
      expect(canvas.assets).toEqual([]);
    }
  });

  it("retains the world transform when the card moves", () => {
    const created = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("canvas", now), [{
      type: "node.add", node: { id: "model", type: "model3d", position: { x: 0, y: 0 } },
      nodeData: { sharedWorldInstance: instance }
    }], { now });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const moved = applyCanvasCommands(created.canvas, [{ type: "node.update", nodeId: "model", position: { x: 100, y: 200 } }], { now });
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(moved.canvas.nodeData.model.sharedWorldInstance).toEqual(instance);
    const invalid = applyCanvasCommands(created.canvas, [{
      type: "nodeData.patch", nodeId: "model",
      value: { sharedWorldInstance: { ...instance, transform: { ...instance.transform, scale: -1 } } }
    }], { now });
    expect(invalid.ok).toBe(false);
    expect(created.canvas.nodeData.model.sharedWorldInstance).toEqual(instance);
  });

  it("rejects malformed or misplaced payloads atomically", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("canvas", now);
    for (const payload of [
      { ...instance, version: "future" },
      { ...instance, transform: { ...instance.transform, scale: 0 } },
      { ...instance, transform: { ...instance.transform, position: { u: Infinity, v: 0, h: 0 } } },
      { ...instance, gpuHandle: 1 }
    ]) {
      const result = applyCanvasCommands(canvas, [
        { type: "node.add", node: { id: "first", type: "text", position: { x: 0, y: 0 } } },
        { type: "node.add", node: { id: "model", type: "model3d", position: { x: 0, y: 0 } }, nodeData: { sharedWorldInstance: payload } }
      ], { now });
      expect(result.ok).toBe(false);
      expect(canvas.document.nodes).toEqual([]);
    }
    expect(applyCanvasCommands(canvas, [{ type: "node.add", node: { id: "text", type: "text", position: { x: 0, y: 0 } }, nodeData: { sharedWorldInstance: instance } }], { now }).ok).toBe(false);
  });
});
