import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "../command-reducer.js";
import { createEmptyWoohaa3ServerCanvas } from "../domain/index.js";

const now = "2026-11-01T00:00:00.000Z";
const instance = {
  kind: "world-instance", version: "shared-world-v1", instanceId: "instance-1",
  transform: { version: "shared-world-v1", position: { u: 1, v: 2, h: 3 }, rotation: [0, 0, 0, 1], scale: 2 }
};

describe("world instance command boundary", () => {
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
