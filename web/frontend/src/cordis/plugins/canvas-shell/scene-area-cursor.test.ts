import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, SHARED_WORLD_VERSION, type ServerCanvas } from "@woohaa3/contracts";
import { resizeCursorForEdge, sceneAreaCursorTargets, sceneAreaEdgeCursor, workflowGroupCursor } from "./scene-area-cursor.js";

const BOUNDS = { min: { u: -2, v: -2 }, max: { u: 2, v: 2 } };

function canvasWithArea(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("c1");
  canvas.document.nodes.push({ id: "area", type: "scene-area", position: { x: 0, y: 0 } });
  canvas.nodeData.area = {
    sceneArea: {
      kind: "scene-area",
      version: SHARED_WORLD_VERSION,
      areaId: "area",
      scopeVersion: "v1",
      bounds: BOUNDS
    }
  };
  return canvas;
}

describe("scene area edge cursor", () => {
  it("finds scene areas and returns a resize cursor only on their border", () => {
    const areas = sceneAreaCursorTargets(canvasWithArea());
    expect(areas).toHaveLength(1);
    const edge = sceneAreaEdgeCursor({ areas, ground: { u: -1.98, v: 0 }, tolerance: 0.1 });
    expect(edge).toMatch(/^(nwse|nesw|ew|ns)-resize$/);
    expect(sceneAreaEdgeCursor({ areas, ground: { u: 0, v: 0 }, tolerance: 0.1 })).toBeNull();
    expect(sceneAreaEdgeCursor({ areas, ground: { u: 3, v: 0 }, tolerance: 0.1 })).toBeNull();
  });

  it("uses the drag axis (not the border direction) for the resize cursor", () => {
    const uEdge = resizeCursorForEdge(BOUNDS, { u: -1, v: 0 });
    const vEdge = resizeCursorForEdge(BOUNDS, { u: 0, v: 1 });
    expect(uEdge).toMatch(/^(nwse|nesw)-resize$/);
    expect(vEdge).toMatch(/^(nwse|nesw)-resize$/);
    expect(uEdge).not.toBe(vEdge);
  });

  it("matches opposite corner axes and accepts the outside half of an edge", () => {
    expect(resizeCursorForEdge(BOUNDS, { u: 1, v: 1 })).toBe(resizeCursorForEdge(BOUNDS, { u: -1, v: -1 }));
    expect(resizeCursorForEdge(BOUNDS, { u: 1, v: -1 })).not.toBe(resizeCursorForEdge(BOUNDS, { u: 1, v: 1 }));
    expect(sceneAreaEdgeCursor({ areas: sceneAreaCursorTargets(canvasWithArea()), ground: { u: -2.05, v: 0 }, tolerance: 0.1 })).not.toBeNull();
  });

  it("prefers the selected overlapping area", () => {
    const areas = sceneAreaCursorTargets(canvasWithArea());
    const overlapping = [{ nodeId: "other", bounds: BOUNDS }, ...areas];
    expect(sceneAreaEdgeCursor({
      areas: overlapping,
      ground: { u: -1.98, v: 0 },
      tolerance: 0.1,
      preferredNodeId: "other"
    })).not.toBeNull();
  });
});

describe("workflow group border cursor", () => {
  const groups = new Map([["g", { x: 10, y: 20, width: 300, height: 200 }]]);
  const hit = { kind: "node", nodeId: "g" } as const;
  it("shows resize on the border and the move hand only on the title", () => {
    expect(workflowGroupCursor(groups, hit, { x: 270, y: 20 }, 1)).toBe("ns-resize");
    expect(workflowGroupCursor(groups, hit, { x: 100, y: 15 }, 1)).toBe("grab");
    expect(workflowGroupCursor(groups, { kind: "resize", nodeId: "g" }, { x: 310, y: 220 }, 1)).toBe("nwse-resize");
    expect(workflowGroupCursor(groups, hit, { x: 150, y: 100 }, 1)).toBeNull();
  });
  it("keeps the border tolerance in screen pixels across zooms", () => {
    for (const zoom of [0.5, 1, 2]) {
      expect(workflowGroupCursor(groups, hit, { x: 270, y: 20 + 5 / zoom }, zoom)).toBe("ns-resize");
      expect(workflowGroupCursor(groups, hit, { x: 270, y: 20 + 8 / zoom }, zoom)).toBeNull();
    }
  });
  it("honors member and control hits instead of the group's enclosing rectangle", () => {
    const point = { x: 100, y: 20 };
    expect(workflowGroupCursor(groups, { kind: "node", nodeId: "member" }, point, 1)).toBeNull();
    expect(workflowGroupCursor(groups, { kind: "port", nodeId: "g", side: "input" }, point, 1)).toBeNull();
    expect(workflowGroupCursor(groups, null, point, 1)).toBeNull();
  });
});

it("enlarged group titles remain move targets while nearby frame edges resize", () => {
  const groups = new Map([["g", { x: 0, y: 0, width: 5000, height: 2000 }]]);
  const hit = { kind: "node" as const, nodeId: "g" };
  expect(workflowGroupCursor(groups, hit, { x: 700, y: -60 }, 0.1)).toBe("grab");
  expect(workflowGroupCursor(groups, hit, { x: 700, y: -60 }, 1)).toBeNull();
  expect(workflowGroupCursor(groups, hit, { x: 2200, y: 0 }, 0.1)).toBe("ns-resize");
});
