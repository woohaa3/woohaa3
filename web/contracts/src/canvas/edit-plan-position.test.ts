import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { applyCanvasCommands } from "./command-reducer.js";
import { diffPlan, planCanvasEdit } from "./edit-plan.js";
import { planPositionEdit } from "./edit-plan-position.js";
import type { CanvasCommand } from "./commands.js";

function fixture() {
  const result = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("c"), [
    { type: "node.add", node: { id: "g", type: "group", position: { x: 10, y: 10 }, width: 400, height: 300 } },
    { type: "node.add", node: { id: "a", type: "image", position: { x: 2, y: 3 }, parentId: "g" } },
    { type: "node.add", node: { id: "b", type: "text", position: { x: 500, y: 0 } } },
    { type: "nodeData.patch", nodeId: "a", value: { title: "retain me" } }
  ]);
  if (!result.ok) throw new Error(result.rejection.message);
  return result.canvas;
}

describe("position history fast path", () => {
  it("matches full reducer/diff for duplicates, ordering, relative positions and snapped no-ops", () => {
    const before = fixture();
    for (const commands of [
      [{ type: "node.update", nodeId: "a", position: { x: 2.1, y: 3.1 } }],
      [{ type: "node.update", nodeId: "b", position: { x: 20.13, y: -1.12 } }, { type: "node.update", nodeId: "a", position: { x: 4.5, y: 5.25 } }],
      [{ type: "node.update", nodeId: "a", position: { x: 9, y: 10 } }, { type: "node.update", nodeId: "a", position: { x: 2, y: 3 } }]
    ] as CanvasCommand[][]) {
      const after = applyCanvasCommands(before, commands);
      if (!after.ok) throw new Error(after.rejection.message);
      expect(planPositionEdit(before, commands)).toEqual(diffPlan(before, after.canvas));
    }
  });
  it("undo/redo protects conflicts and preserves unrelated node data", () => {
    const before = fixture();
    const plan = planCanvasEdit(before, [{ type: "node.update", nodeId: "a", position: { x: 9, y: 10 } }]);
    if (!plan.ok) throw new Error(plan.reason);
    const command = (part: typeof plan.forward): CanvasCommand => ({ type: "edit.apply", ...part });
    const moved = applyCanvasCommands(before, [command(plan.forward)]);
    if (!moved.ok) throw new Error(moved.rejection.message);
    const undone = applyCanvasCommands(moved.canvas, [command(plan.inverse)]);
    if (!undone.ok) throw new Error(undone.rejection.message);
    expect(undone.canvas.document.nodes).toEqual(before.document.nodes);
    expect(undone.canvas.nodeData).toEqual(before.nodeData);
    expect(applyCanvasCommands(undone.canvas, [command(plan.forward)]).ok).toBe(true);
    expect(applyCanvasCommands(moved.canvas, [command(plan.forward)]).ok).toBe(false);
  });
  it("falls back for mixed changes and rejects missing or invalid positions without mutation", () => {
    const before = fixture(), original = JSON.stringify(before);
    expect(planPositionEdit(before, [{ type: "node.update", nodeId: "a", width: 200, position: { x: 4, y: 5 } }])).toBeNull();
    expect(planPositionEdit(before, [{ type: "node.update", nodeId: "missing", position: { x: 4, y: 5 } }])?.ok).toBe(false);
    expect(planPositionEdit(before, [{ type: "node.update", nodeId: "a", position: { x: NaN, y: 5 } }])?.ok).toBe(false);
    expect(JSON.stringify(before)).toBe(original);
  });
});
