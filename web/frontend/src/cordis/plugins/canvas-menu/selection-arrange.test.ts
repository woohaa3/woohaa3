import { expect, it } from "vitest";
import { applyCanvasCommands, createDefaultWorldCameraData, createEmptyWoohaa3ServerCanvas, planCanvasEdit, type CanvasNodeData } from "@woohaa3/contracts";
import { planSelectionArrange, selectionArrangeItems } from "./selection-arrange.js";

it("arranges only selected cards in one reversible edit and rejects stale or world selections", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("arrange");
  canvas.document.nodes = [
    { id: "a", type: "world-camera", position: { x: 0, y: 0 }, width: 248, height: 156 },
    { id: "b", type: "image", position: { x: 350, y: 100 }, width: 260, height: 195 },
    { id: "other", type: "image", position: { x: 800, y: 400 } }
  ];
  canvas.nodeData.a = { title: "Camera", worldCamera: createDefaultWorldCameraData("camera", "v1", { u: 0, v: 0 }) } as unknown as CanvasNodeData;
  const plan = planSelectionArrange(canvas, ["a", "b"], "top");
  if (!plan.ok) throw Error(plan.reason);
  const edit = planCanvasEdit(canvas, plan.commands);
  if (!edit.ok) throw Error(edit.reason);
  const moved = applyCanvasCommands(canvas, [{ type: "edit.apply", ...edit.forward }]);
  if (!moved.ok) throw Error(moved.rejection.message);
  expect(moved.canvas.document.nodes.find(n => n.id === "b")!.position).toEqual({ x: 350, y: 0 });
  expect(moved.canvas.document.nodes.find(n => n.id === "other")).toEqual(canvas.document.nodes[2]);
  expect(moved.canvas.nodeData).toEqual(canvas.nodeData);
  const undone = applyCanvasCommands(moved.canvas, [{ type: "edit.apply", ...edit.inverse }]);
  expect(undone.ok && undone.canvas.document.nodes).toEqual(canvas.document.nodes);
  expect(planSelectionArrange(canvas, ["a", "deleted"], "left").ok).toBe(false);
  expect(selectionArrangeItems(canvas, ["a", "b"], false).every(item => item.disabled)).toBe(true);
  canvas.document.nodes.push({ id: "world", type: "scene-area", position: { x: 0, y: 0 } });
  expect(planSelectionArrange(canvas, ["a", "world"], "left").ok).toBe(false);
});
