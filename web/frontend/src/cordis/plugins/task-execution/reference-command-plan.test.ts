import { describe, expect, it } from "vitest";
import { applyCanvasCommands, createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { planReferenceChange } from "./reference-command-plan.js";

function fixture() {
  const canvas = createEmptyWoohaa3ServerCanvas("refs");
  canvas.document.nodes = ["a", "b", "c", "target"].map(id => ({ id, type: "image", position: { x: 0, y: 0 } }));
  canvas.document.edges = ["a", "b"].map(id => ({ id: `edge-${id}`, source: id, target: "target", data: {} }));
  canvas.nodeData.target = { prompt: "保留提示词", inputMapping: [
    { sourceNodeId: "a", role: "reference_image", slotId: "slot-a", sortKey: "0" },
    { sourceNodeId: "b", role: "reference_image", slotId: "slot-b", sortKey: "1" }
  ] };
  return canvas;
}

describe("guarded reference set changes", () => {
  it("replaces one source atomically, keeps other slots and retires the replaced mention identity", () => {
    const canvas = fixture();
    const commands = planReferenceChange(canvas, "target", { remove: [{ sourceNodeId: "a", slotId: "slot-a" }], replacement: "c" })!;
    const result = applyCanvasCommands(canvas, commands);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.document.edges.map(e => e.source).sort()).toEqual(["b", "c"]);
    expect(result.canvas.nodeData.target!.inputMapping).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceNodeId: "b", slotId: "slot-b" }),
      expect.objectContaining({ sourceNodeId: "c" })
    ]));
    expect(result.canvas.nodeData.target!.inputMapping!.some(m => m.slotId === "slot-a")).toBe(false);
    expect(canvas.document.edges.map(e => e.source)).toEqual(["a", "b"]);
  });

  it("clears topology and mapping together while preserving the prompt", () => {
    const canvas = fixture();
    const result = applyCanvasCommands(canvas, planReferenceChange(canvas, "target", {
      remove: [{ sourceNodeId: "a", slotId: "slot-a" }, { sourceNodeId: "b", slotId: "slot-b" }]
    })!);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.document.edges).toEqual([]);
    expect(result.canvas.nodeData.target).toMatchObject({ inputMapping: [], prompt: "保留提示词" });
  });

  it("rejects concurrent mappings as a whole and does not disconnect the old source", () => {
    const canvas = fixture();
    const commands = planReferenceChange(canvas, "target", { remove: [{ sourceNodeId: "a", slotId: "slot-a" }], replacement: "c" })!;
    canvas.nodeData.target!.inputMapping![0]!.label = "changed elsewhere";
    expect(applyCanvasCommands(canvas, commands)).toMatchObject({ ok: false, rejection: { code: "invalid-connection" } });
    expect(canvas.document.edges).toHaveLength(2);
    expect(planReferenceChange(canvas, "target", { remove: [{ sourceNodeId: "c", slotId: "slot-a" }], replacement: "a" })).toBeNull();
  });
});
