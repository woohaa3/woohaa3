import { describe, expect, it } from "vitest";
import { effectiveCanvasNodeSize } from "./node-dimensions.js";
import { buildCanvasRenderScene } from "./render-scene.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import {
  getWoohaa3CanvasNodeRect,
  getGroupRequiredMinSize,
  groupPadding,
} from "./domain/core/group-geometry.js";
import { compileAgentPlan } from "./canvas-script/planner/compile.js";
import { applyCanvasCommands } from "./command-reducer.js";
import { nodeWorldRect } from "./geometry.js";
import { projectAgentGraph } from "./agent-canvas-projection.js";
import type { AgentPlanOperation } from "./agent-canvas-protocol.js";
import type { ServerCanvas } from "./domain/types.js";

function empty() {
  return createEmptyWoohaa3ServerCanvas("dimensions", "2026-10-16T00:00:00Z");
}
function apply(canvas: ServerCanvas, operations: AgentPlanOperation[]) {
  const plan = compileAgentPlan({
    canvasId: canvas.id,
    requestId: "dimensions",
    principalId: "owner",
    scope: "submit_canvas_script",
    snapshot: {
      canvasId: canvas.id,
      revision: canvas.revision,
      nodes: canvas.document.nodes,
      edges: canvas.document.edges,
    },
    operations,
  });
  if (!plan.ok) throw Error(JSON.stringify(plan.error));
  const result = applyCanvasCommands(canvas, plan.commands);
  if (!result.ok) throw Error(JSON.stringify(result.rejection));
  return { canvas: result.canvas, plan };
}
function assertVisibleGeometry(canvas: ServerCanvas) {
  const graph = projectAgentGraph(canvas);
  if (!graph.ok) throw Error(graph.message);
  const scene = buildCanvasRenderScene({ canvas });
  for (const card of scene.nodes) {
    const projected = graph.graph.nodes.find((n) => n.nodeId === card.id)!;
    expect(projected.size).toEqual({ width: card.width, height: card.height });
    expect(projected.worldBounds).toEqual({
      x: card.x,
      y: card.y,
      width: card.width,
      height: card.height,
    });
    expect(
      nodeWorldRect(
        canvas.document.nodes.find((n) => n.id === card.id)!,
        new Map(canvas.document.nodes.map((n) => [n.id, n])),
      ),
    ).toEqual(projected.worldBounds);
    const node = canvas.document.nodes.find((n) => n.id === card.id)!;
    if (!node.parentId) continue;
    const parent = scene.nodes.find((n) => n.id === node.parentId)!;
    expect(card.x).toBeGreaterThanOrEqual(parent.x + groupPadding);
    expect(card.y).toBeGreaterThanOrEqual(parent.y + groupPadding);
    expect(card.x + card.width).toBeLessThanOrEqual(
      parent.x + parent.width - groupPadding,
    );
    expect(card.y + card.height).toBeLessThanOrEqual(
      parent.y + parent.height - groupPadding,
    );
  }
  return scene;
}

describe("shared effective canvas dimensions", () => {
  it("matches rendering and API for compact, missing, resized and clamped model dimensions", () => {
    const canvas = empty();
    const dimensions = [
      {},
      { width: 196, height: 64 },
      { width: 500, height: 116 },
      { width: 320, height: 117 },
      { width: 420, height: 350 },
    ];
    canvas.document.nodes = dimensions.map((size, i) => ({
      id: "m" + i,
      type: "model3d",
      position: { x: 600 * i, y: 0 },
      ...size,
    }));
    canvas.document.nodes.push({
      id: "composite",
      type: "composite-asset",
      position: { x: 4000, y: 0 },
      width: 196,
      height: 64,
    });
    const before = structuredClone(canvas.document.nodes);
    assertVisibleGeometry(canvas);
    expect(canvas.document.nodes).toEqual(before);
    expect(effectiveCanvasNodeSize(before[0])).toEqual({
      width: 248,
      height: 232,
    });
    expect(effectiveCanvasNodeSize(before[2])).toEqual({
      width: 248,
      height: 232,
    });
    expect(effectiveCanvasNodeSize(before[3])).toEqual({
      width: 320,
      height: 160,
    });
    expect(effectiveCanvasNodeSize(before[5])).toEqual({
      width: 196,
      height: 64,
    });
    const scene = buildCanvasRenderScene({
      canvas,
      sizeOverrides: new Map([["m1", { width: 300, height: 100 }]]),
    });
    expect(scene.nodes.find((n) => n.id === "m1")).toMatchObject({
      width: 300,
      height: 160,
    });
  });

  it("creates full preview cards and lays out nested groups using visible extents", () => {
    const operations: AgentPlanOperation[] = Array.from(
      { length: 6 },
      (_, i) => ({ op: "create_node", ref: "m" + i, kind: "model" }),
    );
    operations.push({
      op: "create_group",
      ref: "buildings",
      title: "建筑模块",
      members: Array.from({ length: 6 }, (_, i) => ({ ref: "m" + i })),
      layout: { mode: "grid", columns: 3, gapX: 20, gapY: 24 },
    });
    operations.push({
      op: "create_group",
      ref: "outer",
      title: "素材库",
      members: [{ ref: "buildings" }],
      placement: { mode: "absolute", position: { x: -1000, y: 200 } },
    });
    const { canvas, plan } = apply(empty(), operations);
    const scene = assertVisibleGeometry(canvas);
    expect(
      canvas.document.nodes
        .filter((n) => n.type === "model3d")
        .every((n) => n.width === 248 && n.height === 232),
    ).toBe(true);
    const first = scene.nodes.find((n) => n.id === plan.refs.m0)!;
    const second = scene.nodes.find((n) => n.id === plan.refs.m1)!;
    const nextRow = scene.nodes.find((n) => n.id === plan.refs.m3)!;
    expect(second.x - first.x).toBe(248 + 20);
    expect(nextRow.y - first.y).toBe(232 + 24);
    for (const group of plan.organization.groups) {
      const rendered = scene.nodes.find((n) => n.id === group.nodeId)!;
      expect(group.worldBounds).toEqual({
        x: rendered.x,
        y: rendered.y,
        width: rendered.width,
        height: rendered.height,
      });
    }
  });

  it("wraps existing compact cards without rewriting their stored dimensions", () => {
    const canvas = empty();
    canvas.document.nodes = [0, 344].map((y, i) => ({
      id: "m" + i,
      type: "model3d",
      position: { x: 0, y },
      width: 196,
      height: 64,
    }));
    const { canvas: grouped, plan } = apply(canvas, [
      {
        op: "create_group",
        ref: "buildings",
        title: "建筑模块",
        members: [{ nodeId: "m0" }, { nodeId: "m1" }],
      },
    ]);
    const scene = assertVisibleGeometry(grouped);
    const group = scene.nodes.find((n) => n.id === plan.refs.buildings)!;
    // The old calculation ended at 448 while the final card extended to 576.
    expect(group.y + group.height).toBe(576 + groupPadding);
    expect(
      grouped.document.nodes
        .filter((n) => n.type === "model3d")
        .every((n) => n.width === 196 && n.height === 64),
    ).toBe(true);
    const runtime = grouped.document.nodes.map((n) => ({ ...n, data: {} }));
    const byId = new Map(runtime.map((n) => [n.id, n]));
    expect(getWoohaa3CanvasNodeRect(byId.get("m1")!, byId)).toMatchObject({
      y: 344,
      width: 248,
      height: 232,
    });
    expect(
      getGroupRequiredMinSize(runtime, plan.refs.buildings).minHeight,
    ).toBe(group.height);
    const laidOut = apply(grouped, [
      {
        op: "layout",
        targets: [{ nodeId: "m0" }, { nodeId: "m1" }],
        layout: { mode: "grid", columns: 1, gapY: 12 },
      },
    ]);
    const cards = assertVisibleGeometry(laidOut.canvas).nodes.filter((n) =>
      n.id.startsWith("m"),
    );
    expect(cards[1].y - cards[0].y).toBe(232 + 12);
  });

  it("uses the visible size of existing model anchors for after/below placement", () => {
    for (const mode of ["after", "below"] as const) {
      const canvas = empty();
      canvas.document.nodes = [
        {
          id: "old",
          type: "model3d",
          position: { x: 100, y: 200 },
          width: 196,
          height: 64,
        },
      ];
      const { canvas: result, plan } = apply(canvas, [
        {
          op: "create_node",
          ref: "new",
          kind: "model",
          placement: { mode, anchor: { nodeId: "old" }, gap: 30 },
        },
      ]);
      const added = result.document.nodes.find((n) => n.id === plan.refs.new)!;
      expect(added.position).toEqual(
        mode === "after"
          ? { x: 100 + 248 + 30, y: 200 }
          : { x: 100, y: 200 + 232 + 30 },
      );
    }
  });
});
