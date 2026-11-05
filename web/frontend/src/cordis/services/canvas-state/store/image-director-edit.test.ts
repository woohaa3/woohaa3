import { describe, expect, it } from "vitest";
import { applyCanvasCommands, createEmptyWoohaa3ServerCanvas, planCanvasEdit } from "@woohaa3/contracts";
import type { CanvasSession } from "../../../contracts.js";
import { createCanvasEditService } from "./canvas-edit-service.js";

describe("image director history adoption", () => {
  it("adopts an already applied plan once without submitting it again", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("canvas");
    const plan = planCanvasEdit(canvas, [{ type: "node.add", node: { id: "model", type: "model3d", position: { x: 0, y: 0 } }, nodeData: { title: "Model" } }]);
    if (!plan.ok) throw new Error(plan.reason);
    const applied = applyCanvasCommands(canvas, [{ type: "edit.apply", ...plan.forward }]);
    if (!applied.ok) throw new Error(applied.rejection.message);
    const current = { ...applied.canvas, revision: 1 };
    const session = { isWritable: () => true } as CanvasSession;
    const service = createCanvasEditService({ session, getCanvas: () => current });
    const receipt = { operationId: "op", source: { sourceNodeId: "image", assetId: "asset", contentVersion: "v", checksum: "a".repeat(64), mimeType: "image/png", width: 1, height: 1 }, modelNodeIds: ["model"], areaNodeId: "area", cameraNodeId: "camera", forward: plan.forward, inverse: plan.inverse };
    expect((await service.adoptImageDirector({ canvasId: "canvas", receipt, revision: 1, allowNew: true })).ok).toBe(true);
    expect((await service.adoptImageDirector({ canvasId: "canvas", receipt, revision: 1, allowNew: true })).ok).toBe(true);
    expect(service.getSnapshot().size).toBe(1);
    expect(current.document.nodes).toHaveLength(1);
  });
});
