import { describe, expect, it } from "vitest";
import type { ServerCanvas } from "@woohaa3/contracts";
import { planSelectionTidy, tidyableNodeIds } from "./selection-tidy.js";

const node = (id: string, x: number, y: number, width: number, height: number, type = "image") => ({ id, type, position: { x, y }, width, height });
const canvasOf = (nodes: ReturnType<typeof node>[]) => ({ document: { nodes }, nodeData: {} }) as unknown as ServerCanvas;

describe("planSelectionTidy", () => {
  it("unifies every card to the largest width and height and lays them on a grid", () => {
    const canvas = canvasOf([node("a", 500, 300, 200, 100), node("b", 0, 0, 400, 150), node("c", 100, 20, 300, 300)]);
    const plan = planSelectionTidy(canvas, ["a", "b", "c"]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const byId = Object.fromEntries(plan.commands.map(command => [(command as { nodeId: string }).nodeId, command as unknown as { position: { x: number; y: number }; width: number; height: number }]));
    expect(Object.values(byId).every(command => command.width === 400 && command.height === 300)).toBe(true);
    // 阅读顺序 b, c, a；2 列，原点取包围盒左上角 (0,0)。
    expect(byId.b!.position).toEqual({ x: 0, y: 0 });
    expect(byId.c!.position).toEqual({ x: 424, y: 0 });
    expect(byId.a!.position).toEqual({ x: 0, y: 324 });
  });

  it("keeps cards on the same visual row together even when y differs slightly", () => {
    const canvas = canvasOf([node("right", 300, 10, 100, 100), node("left", 0, 0, 100, 100)]);
    const plan = planSelectionTidy(canvas, ["right", "left"]);
    expect(plan.ok && plan.commands.map(command => (command as { nodeId: string }).nodeId)).toEqual(["left", "right"]);
  });

  it("ignores groups and needs two cards", () => {
    const canvas = canvasOf([node("g", 0, 0, 500, 500, "workflow-group-2d"), node("a", 0, 0, 100, 100)]);
    expect(tidyableNodeIds(canvas, ["g", "a"])).toEqual(["a"]);
    expect(planSelectionTidy(canvas, ["g", "a"]).ok).toBe(false);
  });
});
