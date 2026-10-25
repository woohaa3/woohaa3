import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, getWoohaa3CanvasNodeAbsolutePosition, type Woohaa3CanvasNode } from "./domain/index.js";
import { createCompositeChildNode, followCompositeChildOwner, placeCompositeChild, planCompositeChildLayout, planCompositeChildNode, removeCompositeChildNodes } from "./composite-children.js";

describe("public composite children", () => {
  const group: Woohaa3CanvasNode = { id: "group", type: "group", position: { x: 100, y: 200 }, data: {} };
  const owner: Woohaa3CanvasNode = { id: "owner", type: "composite-asset", parentId: "group", position: { x: 20, y: 30 }, data: {} };
  const child = () => createCompositeChildNode({ nodes: [group, owner], owner, id: "child", type: "image", bounds: { x: 500, y: 600, width: 280, height: 210 } });
  const absolute = (node: Woohaa3CanvasNode, nodes: Woohaa3CanvasNode[]) => getWoohaa3CanvasNodeAbsolutePosition(node, new Map(nodes.map(n => [n.id, n])));

  it("constructs a sibling in nested coordinates and follows owner reparenting once", () => {
    const before = [group, owner, child()], current = structuredClone(before);
    expect(current[2].position).toEqual({ x: 400, y: 400 });
    current[1].parentId = undefined;
    current[1].position = { x: 220, y: 330 };
    followCompositeChildOwner(current[2], current[1], before, current, false);
    expect(current[2].parentId).toBeUndefined();
    expect(absolute(current[2], current)).toEqual({ x: 600, y: 700 });
  });

  it("moving the group adds its delta once; explicit child placement wins", () => {
    const before = [group, owner, child()], current = structuredClone(before);
    current[0].position = { x: 200, y: 300 };
    followCompositeChildOwner(current[2], current[1], before, current, false);
    expect(absolute(current[2], current)).toEqual({ x: 600, y: 700 });
    current[2].position = { x: 800, y: 900 };
    followCompositeChildOwner(current[2], current[1], before, current, true);
    expect(absolute(current[2], current)).toEqual({ x: 1000, y: 1200 });
  });

  it("dense layouts still produce a free position above or below occupied space", () => {
    const preferred = { x: 0, y: 0, width: 100, height: 100 }, occupied = [{ ...preferred, y: -500, height: 10000 }];
    expect(placeCompositeChild({ preferred, occupied, maxAttempts: 2, step: 32, spacing: 40 }).y).toBe(9540);
    expect(placeCompositeChild({ preferred, occupied, direction: "up", spacing: 40 }).y).toBe(-640);
  });

  it("places a row above the owner from left to right, bypassing occupied positions horizontally", () => {
    const ownerBounds = { x: 100, y: 500, width: 320, height: 240 };
    const sizes = [{ width: 248, height: 232 }, { width: 248, height: 232 }];
    expect(planCompositeChildLayout({ layout: "row", ownerBounds, sizes, occupied: [] })).toEqual([
      { x: 100, y: 220, width: 248, height: 232 },
      { x: 372, y: 220, width: 248, height: 232 }
    ]);
    expect(planCompositeChildLayout({ layout: "row", ownerBounds, sizes, occupied: [{ x: 100, y: 220, width: 248, height: 232 }] })).toEqual([
      { x: 372, y: 220, width: 248, height: 232 },
      { x: 644, y: 220, width: 248, height: 232 }
    ]);
    expect(placeCompositeChild({ preferred: { x: 0, y: 0, width: 100, height: 100 }, occupied: [{ x: -500, y: 0, width: 10000, height: 100 }], direction: "right", spacing: 24, maxAttempts: 1 }).x).toBe(9524);
  });

  it("projection preserves saved positions and stable data; removal cleans edges and data", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("third-extension");
    canvas.document.nodes = [group, owner];
    const input = { canvas, ownerNodeId: "owner", id: "child", type: "image", bounds: { x: 500, y: 600, width: 280, height: 210 }, data: { title: "Output" } };
    const command = planCompositeChildNode(input)[0];
    expect(command).toMatchObject({ type: "node.add", node: { parentId: "group", position: { x: 400, y: 400 } } });
    canvas.document.nodes.push(child()); canvas.nodeData.child = { title: "Output" };
    expect(planCompositeChildNode({ ...input, bounds: { ...input.bounds, x: 999 } })).toEqual([]);
    const work = { nodes: [group, owner, child()], edges: [{ id: "edge", source: "child", target: "owner", data: {} }], nodeData: canvas.nodeData };
    removeCompositeChildNodes(work, new Set(["child"]));
    expect(work.nodes.map(node => node.id)).toEqual(["group", "owner"]);
    expect(work.edges).toEqual([]); expect(work.nodeData.child).toBeUndefined();
  });
});
