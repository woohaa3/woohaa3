import { describe, expect, it } from "vitest";
import type { Woohaa3CanvasNode } from "./canvas-runtime";
import {
  clampDropPointToGroup,
  projectDropPointOutside,
  resolveDraggedNodeDropTargets,
  settleDraggedGroups,
  settleDraggedNodeBoundaries,
} from "./group-drop-settlement";
import { getWoohaa3CanvasNodeAbsolutePosition } from "./group-geometry";

const image = (id: string, x: number, y: number, extra: Partial<Woohaa3CanvasNode> = {}): Woohaa3CanvasNode => ({
  id, type: "image", position: { x, y }, width: 100, height: 60, data: {}, ...extra,
});
const group = (id: string, x: number, y: number, extra: Partial<Woohaa3CanvasNode> = {}): Woohaa3CanvasNode => ({
  id, type: "group", position: { x, y }, width: 300, height: 240, data: {}, ...extra,
});
const byId = (nodes: readonly Woohaa3CanvasNode[]) => new Map(nodes.map((node) => [node.id, node]));

describe("frozen group drop geometry", () => {
  it("collapsed backplates leave space free while scaled badges remain occupied", () => {
    const nodes = [group("g", 0, 0), image("n", 600, 600)];
    const options = { eligibleGroupIds: new Set<string>(), collapsedGroupIds: new Set(["g"]), groupBadgeScales: new Map([["g", 2]]) };
    const free = settleDraggedNodeBoundaries(nodes, ["n"], new Map([["n", {x: 100, y: 130}]]), options);
    expect(free.ok).toBe(true);
    expect(free.nodes.find(node => node.id === "n")?.position).toEqual({x: 100, y: 130});
    const occupied = settleDraggedNodeBoundaries(nodes, ["n"], new Map([["n", {x: 100, y: 280}]]), options);
    expect(occupied.ok).toBe(true);
    expect(occupied.nodes.find(node => node.id === "n")?.position).not.toEqual({x: 100, y: 280});
  });
  it("clamps an in-frame center at the structural boundary without refitting", () => {
    const nodes = [group("g", 0, 0, { width: 300, height: 220 }), image("n", 600, 600)];
    const result = settleDraggedNodeBoundaries(nodes, ["n"], new Map([["n", { x: 200, y: 120 }]]), {
      groupSizes: new Map([["g", { width: 300, height: 220 }]]), eligibleGroupIds: new Set(["g"]),
    });
    expect(result.ok).toBe(true);
    const next = result.nodes.find((node) => node.id === "n")!;
    expect(next.parentId).toBe("g");
    expect(next.position).toEqual({ x: 80, y: 76 });
    expect(result.nodes.find((node) => node.id === "g")).toMatchObject({ width: 300, height: 220 });
  });

  it("uses deepest candidate and document order for equal overlapping groups", () => {
    const nodes = [group("outer", 0, 0), group("inner", 20, 20, { parentId: "outer" }), image("n", 600, 600)];
    const result = settleDraggedNodeBoundaries(nodes, ["n"], new Map([["n", { x: 80, y: 80 }]]), {
      groupSizes: new Map([["outer", { width: 300, height: 240 }], ["inner", { width: 300, height: 240 }]]),
      eligibleGroupIds: new Set(["outer", "inner"]),
    });
    expect(result.nodes.find((node) => node.id === "n")?.parentId).toBe("inner");
  });

  it("projects an outside center that still crosses a frame", () => {
    const nodes = [group("g", 0, 0), image("n", 500, 0)];
    const result = settleDraggedNodeBoundaries(nodes, ["n"], new Map([["n", { x: 280, y: 20 }]]), {
      groupSizes: new Map([["g", { width: 300, height: 240 }]]), eligibleGroupIds: new Set(["g"]),
    });
    const next = result.nodes.find((node) => node.id === "n")!;
    expect(next.parentId).toBeUndefined();
    expect(next.position.x).toBeGreaterThanOrEqual(300);
  });

  it("rejects a non finite input and a node larger than the inner frame", () => {
    const huge = image("huge", 0, 0, { width: 400, height: 300 });
    const tooLarge = settleDraggedNodeBoundaries([group("g", 0, 0), huge], ["huge"], new Map([["huge", { x: 20, y: 20 }]]), {
      groupSizes: new Map([["g", { width: 300, height: 240 }]]), eligibleGroupIds: new Set(["g"]),
    });
    expect(tooLarge.ok).toBe(true);
    expect(tooLarge.nodes.find((node) => node.id === "huge")?.parentId).toBeUndefined();
    expect(settleDraggedNodeBoundaries([image("n", Number.NaN, 0)], ["n"], new Map([["n", { x: 1, y: 1 }]])).ok).toBe(false);
  });

  it("keeps projection ordering deterministic and zoom independent", () => {
    const a = projectDropPointOutside({ x: 100, y: 100 }, { width: 40, height: 40 }, { x: 0, y: 0, width: 200, height: 200 });
    const b = projectDropPointOutside({ x: 100, y: 100 }, { width: 40, height: 40 }, { x: 0, y: 0, width: 200, height: 200 });
    expect(a).toEqual(b);
    expect(clampDropPointToGroup({ x: 30, y: 30 }, { width: 40, height: 40 }, { x: 0, y: 0, width: 300, height: 240 })).toEqual({ x: 40, y: 40 });
  });

  it("resolves transient targets with the same deepest and stable ordering rule", () => {
    const nodes = [
      group("outer", 0, 0),
      group("inner", 20, 20, { parentId: "outer" }),
      image("a", 600, 600),
      image("b", 600, 700),
    ];
    const targets = resolveDraggedNodeDropTargets(
      nodes,
      ["a", "b"],
      new Map([["a", { x: 80, y: 80 }], ["b", { x: 30, y: -20 }]]),
      {
        groupSizes: new Map([["outer", { width: 300, height: 240 }], ["inner", { width: 300, height: 240 }]]),
        eligibleGroupIds: new Set(["outer", "inner"]),
      },
    );
    expect(targets).toEqual(["outer", "inner"]);
  });
});

describe("group release collision settlement", () => {
  it("moves an active group away from a fixed group without pushing ordinary nodes", () => {
    const nodes = [group("active", 0, 0), group("fixed", 400, 0), image("outside", 460, 80)];
    const result = settleDraggedGroups(nodes, ["active"], new Map([["active", { x: 400, y: 0 }]]), {
      groupSizes: new Map([["active", { width: 300, height: 240 }], ["fixed", { width: 300, height: 240 }]]),
      eligibleGroupIds: new Set(["active", "fixed"]),
    });
    expect(result.ok).toBe(true);
    expect(result.nodes.find((node) => node.id === "fixed")?.position).toEqual({ x: 400, y: 0 });
    // The node was only along the drag path; the final active group no longer
    // covers it, so it remains untouched.
    expect(result.nodes.find((node) => node.id === "outside")?.position.x).toBe(460);
  });

  it("preserves ordinary node positions and parent ownership", () => {
    const nodes = [group("active", 0, 0), image("a", 30, 30), image("b", 30, 30), image("inside", 20, 20, { parentId: "active" })];
    const result = settleDraggedGroups(nodes, ["active"], new Map([["active", { x: 0, y: 0 }]]), {
      groupSizes: new Map([["active", { width: 300, height: 240 }]]), eligibleGroupIds: new Set(["active"]),
    });
    expect(result.ok).toBe(true);
    expect(result.nodes.find((node) => node.id === "a")?.parentId).toBeUndefined();
    expect(result.nodes.find((node) => node.id === "b")?.parentId).toBeUndefined();
    expect(result.nodes.find((node) => node.id === "a")?.position).toEqual({ x: 30, y: 30 });
    expect(result.nodes.find((node) => node.id === "b")?.position).toEqual({ x: 30, y: 30 });
    expect(result.nodes.find((node) => node.id === "inside")?.position).toEqual({ x: 20, y: 20 });
  });

  it("does not move protected nodes and safely falls back when the budget is exhausted", () => {
    const nodes = [group("active", 0, 0), image("protected", 20, 20)];
    const protectedResult = settleDraggedGroups(nodes, ["active"], new Map([["active", { x: 0, y: 0 }]]), {
      groupSizes: new Map([["active", { width: 300, height: 240 }]]), eligibleGroupIds: new Set(["active"]), protectedNodeIds: new Set(["protected"]),
    });
    expect(protectedResult.nodes.find((node) => node.id === "protected")?.position).toEqual({ x: 20, y: 20 });
    const blocked = settleDraggedGroups([group("active", 0, 0), group("fixed", 0, 0)], ["active"], new Map([["active", { x: 0, y: 0 }]]), {
      groupSizes: new Map([["active", { width: 300, height: 240 }], ["fixed", { width: 300, height: 240 }]]), eligibleGroupIds: new Set(["active", "fixed"]), maxCandidates: 0,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.nodes).toEqual([expect.objectContaining({ id: "active", position: { x: 0, y: 0 } }), expect.objectContaining({ id: "fixed", position: { x: 0, y: 0 } })]);
  });

  it("returns absolute positions that convert back to the original parent coordinate system", () => {
    const nodes = [group("g", 100, 100), image("n", 20, 20, { parentId: "g" })];
    const result = settleDraggedNodeBoundaries(nodes, ["n"], new Map([["n", { x: 160, y: 160 }]]), {
      groupSizes: new Map([["g", { width: 300, height: 240 }]]), eligibleGroupIds: new Set(["g"]),
    });
    const next = result.nodes.find((node) => node.id === "n")!;
    expect(getWoohaa3CanvasNodeAbsolutePosition(next, byId(result.nodes))).toEqual({ x: 160, y: 160 });
  });
});

