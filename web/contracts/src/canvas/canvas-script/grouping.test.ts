import { describe, expect, it } from "vitest";
import { compileAgentPlan } from "./planner/compile.js";
import {
  organizationWorldBounds,
  projectCanvasOrganization,
} from "./organization.js";
import {
  decodeAgentPlanOperations,
  type AgentPlanOperation,
} from "../agent-canvas-protocol.js";
import { applyCanvasCommands } from "../command-reducer.js";
import { createEmptyWoohaa3ServerCanvas } from "../domain/index.js";
import {
  projectAgentGraph,
  computeAgentDelta,
} from "../agent-canvas-projection.js";
import type { PlannerSnapshot } from "./planner/types.js";

const node = (id: string, x = 0, y = 0, parentId?: string, type = "image") => ({
  id,
  type,
  position: { x, y },
  width: 248,
  height: 232,
  parentId,
});
const snapshot = (nodes: PlannerSnapshot["nodes"] = []): PlannerSnapshot => ({
  canvasId: "c",
  revision: 0,
  nodes,
  edges: [],
});
const compile = (ops: AgentPlanOperation[], snap = snapshot()) =>
  compileAgentPlan({
    canvasId: "c",
    requestId: "r",
    scope: "submit_canvas_script",
    principalId: "p",
    snapshot: snap,
    operations: ops,
  });
const ref = (key: string) => ({ ref: key });
const existing = (nodeId: string) => ({ nodeId });
function applied(operations: AgentPlanOperation[], snap = snapshot()) {
  const plan = compile(operations, snap);
  if (!plan.ok) throw new Error(JSON.stringify(plan));
  const canvas = createEmptyWoohaa3ServerCanvas("c", "2026-10-16T00:00:00Z");
  canvas.document.nodes = [...snap.nodes];
  const result = applyCanvasCommands(canvas, plan.commands);
  if (!result.ok) throw new Error(JSON.stringify(result));
  expect(
    result.canvas.document.nodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      position: n.position,
      width: n.width,
      height: n.height,
    })),
  ).toEqual(
    plan.finalNodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      position: n.position,
      width: n.width,
      height: n.height,
    })),
  );
  return { plan, canvas: result.canvas };
}
const build: AgentPlanOperation[] = [
  {
    op: "create_node",
    ref: "a",
    kind: "image",
    placement: { mode: "absolute", position: { x: 0, y: 0 } },
  },
  {
    op: "create_node",
    ref: "b",
    kind: "image",
    placement: { mode: "absolute", position: { x: 400, y: 0 } },
  },
  {
    op: "create_group",
    ref: "g1",
    title: "角色",
    members: [ref("a")],
    layout: { mode: "grid", columns: 3 },
  },
  { op: "create_group", ref: "g2", title: "环境", members: [ref("b")] },
  {
    op: "create_group",
    ref: "all",
    title: "素材库",
    members: [ref("g1"), ref("g2")],
    layout: { mode: "grid", columns: 2, gapX: 100 },
    placement: { mode: "absolute", position: { x: -2000, y: 0 } },
  },
];
describe("canvas classification groups", () => {
  it("warns about independent ungrouped assets and clipped membership without flagging containment or input chains", () => {
    const nodes = [
      node("g", 0, 0, undefined, "group"),
      ...Array.from({ length: 257 }, (_, i) => node("n" + i, 40, 40, "g")),
    ];
    const clipped = projectCanvasOrganization(nodes, ["g"]);
    expect(clipped.complete).toBe(false);
    expect(clipped.groups[0].memberIds).toHaveLength(256);
    expect(clipped.groups[0].membersComplete).toBe(false);
    expect(clipped.warnings.map((w) => w.code)).toEqual(["summary-truncated"]);
    expect(projectCanvasOrganization([node("a")], ["a"]).warnings[0].code).toBe(
      "ungrouped",
    );
    expect(
      projectCanvasOrganization(
        [node("a"), node("b")],
        ["a", "b"],
        [{ source: "a", target: "b" }],
      ).warnings,
    ).toEqual([]);
    expect(
      projectCanvasOrganization(
        [
          node("g", 0, 0, undefined, "group"),
          node("other", 10, 10, undefined, "group"),
        ],
        ["g"],
      ).warnings[0].code,
    ).toBe("overlap");
  });
  it("persists single-member and nested named groups, matching predicted world bounds", () => {
    const { plan, canvas } = applied(build);
    expect(plan.organization.groups).toHaveLength(3);
    const all = plan.organization.groups.find(
      (g) => g.nodeId === plan.refs.all,
    )!;
    expect(all.worldBounds.x).toBe(-2000);
    expect(all.memberIds).toEqual([plan.refs.g1, plan.refs.g2]);
    expect(canvas.document.edges).toHaveLength(0);
    const page = projectAgentGraph(canvas, {
      parentId: plan.refs.all,
      limit: 1,
    });
    if (!page.ok) throw new Error("graph");
    expect(page.graph.nodes).toHaveLength(1);
    expect(page.graph.nextCursor).toBeTruthy();
    const root = projectAgentGraph(canvas, { parentId: null });
    if (!root.ok) throw new Error("graph");
    expect(root.graph.nodes.map((n) => n.nodeId)).toEqual([plan.refs.all]);
    expect(root.graph.nodes[0]).toMatchObject({
      directMemberCount: 2,
      affordances: { canUngroup: true, canRun: false, canConnect: false },
    });
  });
  it("ungroup detaches members before removal and preserves existing content and real edges", () => {
    const snap = snapshot([
      node("g", 100, 100, undefined, "group"),
      node("a", 40, 40, "g"),
      node("b", 800, 100),
    ]);
    snap.edges = [{ id: "e", source: "a", target: "b" }];
    const plan = compile([{ op: "ungroup", target: existing("g") }], snap);
    if (!plan.ok) throw new Error("compile");
    expect(plan.finalNodes.find((n) => n.id === "a")).toMatchObject({
      position: { x: 140, y: 140 },
      parentId: undefined,
    });
    expect(plan.commands[0]).toMatchObject({
      type: "node.update",
      nodeId: "a",
      parentId: null,
    });
    const canvas = createEmptyWoohaa3ServerCanvas("c", "2026-10-16T00:00:00Z");
    canvas.document.nodes = [...snap.nodes];
    canvas.document.edges = snap.edges.map((e) => ({ ...e, data: {} }));
    canvas.nodeData.a = { prompt: "keep me" };
    const result = applyCanvasCommands(canvas, plan.commands);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canvas.document.edges).toHaveLength(1);
      expect(result.canvas.nodeData.a?.prompt).toBe("keep me");
      expect(result.canvas.document.nodes).toHaveLength(2);
    }
  });
  it("reparent and refit preserve unselected siblings in world coordinates; empty parents disappear", () => {
    const snap = snapshot([
      node("old", 0, 0, undefined, "group"),
      node("new", 1000, 0, undefined, "group"),
      node("a", 40, 40, "old"),
      node("b", 40, 40, "new"),
    ]);
    const { plan } = applied(
      [{ op: "reparent", targets: [existing("a")], parent: existing("new") }],
      snap,
    );
    const byId = new Map(plan.finalNodes.map((n) => [n.id, n]));
    expect(byId.has("old")).toBe(false);
    expect(organizationWorldBounds(byId.get("a")!, byId)).toMatchObject({
      x: 40,
      y: 40,
    });
    expect(organizationWorldBounds(byId.get("b")!, byId)).toMatchObject({
      x: 1040,
      y: 40,
    });
    expect(plan.touchedExistingNodeIds).toEqual(
      expect.arrayContaining(["old", "new", "a", "b"]),
    );
  });
  it("world move of nested group moves each descendant once; delta includes unchanged local children", () => {
    const { plan, canvas } = applied(build);
    const move = compile(
      [
        {
          op: "move_node",
          target: existing(plan.refs.all),
          position: { x: -1500, y: 500 },
          coordinateSpace: "world",
        },
      ],
      { ...snapshot(canvas.document.nodes), edges: [] },
    );
    if (!move.ok) throw new Error("move");
    const result = applyCanvasCommands(canvas, move.commands);
    if (!result.ok) throw new Error("apply");
    const delta = computeAgentDelta(canvas, result.canvas);
    expect(delta.nodes).toHaveLength(5);
    const before = projectAgentGraph(canvas),
      after = projectAgentGraph(result.canvas);
    if (!before.ok || !after.ok) throw new Error("graph");
    for (const n of before.graph.nodes) {
      const next = after.graph.nodes.find((v) => v.nodeId === n.nodeId)!;
      expect(next.worldBounds!.x - n.worldBounds!.x).toBe(500);
      expect(next.worldBounds!.y - n.worldBounds!.y).toBe(500);
    }
  });
  it("rejects cycles, mixed layers, duplicate targets and group connection/prompt", () => {
    const snap = snapshot([
      node("g", 0, 0, undefined, "group"),
      node("a", 40, 40, "g"),
      node("b", 800, 0),
    ]);
    for (const ops of [
      [{ op: "reparent", targets: [existing("g")], parent: existing("a") }],
      [
        {
          op: "create_group",
          ref: "bad",
          title: "bad",
          members: [existing("a"), existing("b")],
        },
      ],
      [
        {
          op: "layout",
          targets: [existing("a"), existing("a")],
          layout: { mode: "grid", columns: 2 },
        },
      ],
      [{ op: "connect", ref: "edge", from: existing("g"), to: existing("b") }],
      [{ op: "set_prompt", target: existing("g"), prompt: "no" }],
    ] as AgentPlanOperation[][])
      expect(compile(ops, snap).ok).toBe(false);
  });
  it("rejects a small operation with too many affected descendants", () => {
    const nodes = [
      node("g", 0, 0, undefined, "group"),
      ...Array.from({ length: 256 }, (_, i) =>
        node("n" + i, 40 + i * 300, 40, "g"),
      ),
    ];
    expect(
      compile(
        [
          {
            op: "move_node",
            target: existing("g"),
            coordinateSpace: "world",
            position: { x: 100, y: 100 },
          },
        ],
        snapshot(nodes),
      ),
    ).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
  });
  it("group placement uses final bounds to the left of an existing anchor", () => {
    const snap = snapshot([node("anchor", 1000, 100)]);
    const { plan } = applied(
      [
        ...build.slice(0, 3),
        {
          op: "create_group",
          ref: "outer",
          title: "左侧",
          members: [ref("g1")],
          placement: { mode: "before", anchor: existing("anchor"), gap: 200 },
        },
      ],
      snap,
    );
    const g = plan.organization.groups.find(
      (g) => g.nodeId === plan.refs.outer,
    )!;
    expect(g.worldBounds.x + g.worldBounds.width).toBe(800);
    expect(plan.touchedExistingNodeIds).not.toContain("anchor");
  });
  it("strict codec rejects malformed organization options", () => {
    expect(
      decodeAgentPlanOperations([
        {
          op: "create_group",
          ref: "g",
          title: "角色",
          members: [existing("a")],
          layout: { mode: "grid", columns: 1 },
        },
      ]).ok,
    ).toBe(true);
    for (const op of [
      { op: "create_group", ref: "g", title: " ", members: [existing("a")] },
      {
        op: "layout",
        targets: [existing("a")],
        layout: { mode: "grid", columns: 257 },
      },
      { op: "reparent", targets: [existing("a")], parent: null, nodeData: {} },
      {
        op: "move_node",
        target: existing("a"),
        position: { x: 0, y: 0 },
        coordinateSpace: "bad",
      },
    ])
      expect(decodeAgentPlanOperations([op]).ok).toBe(false);
  });
});
