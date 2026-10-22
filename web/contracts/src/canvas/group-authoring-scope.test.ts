import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { applyCanvasCommands } from "./command-reducer.js";
import { compileAgentPlan } from "./canvas-script/planner/compile.js";
import { canvasGroupMembers, projectCanvasGroup, validateCanvasGroupChange } from "./group-authoring-scope.js";
import { collectWoohaa3CanvasRemovalIds } from "./domain/core/node-removal.js";
import { decodeCanvasCreationRequest } from "../extension/canvas-creation.js";
import { sanitizeWoohaa3CanvasNodeData } from "./domain/core/document-schema.js";
import { serverCanvasToYDoc, yDocToServerCanvas } from "./yjs/mapping.js";
import { decodeAcceptTurnRequest } from "../extension/conversation-codec.js";

function fixture() {
  const canvas = createEmptyWoohaa3ServerCanvas("c", "2026-10-20T00:00:00Z");
  canvas.document.nodes = [
    { id: "root", type: "group", position: { x: 500, y: 200 }, width: 800, height: 600 },
    { id: "a", type: "text", parentId: "root", position: { x: 40, y: 40 } },
    { id: "outside", type: "text", position: { x: 2000, y: 0 } }
  ];
  canvas.nodeData = { root: { retainWhenEmpty: true }, a: { prompt: "inside" }, outside: { prompt: "private" } };
  return canvas;
}
describe("canvas group scope", () => {
  it("round trips retained empty groups through Yjs without private session fields", () => {
    const canvas = fixture();
    canvas.document.nodes = [canvas.document.nodes[0]!];
    canvas.nodeData = { root: { retainWhenEmpty: true } };
    const doc = serverCanvasToYDoc(canvas);
    const restored = yDocToServerCanvas(doc);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.canvas.nodeData.root).toEqual({ retainWhenEmpty: true });
    doc.destroy();
    expect(sanitizeWoohaa3CanvasNodeData({ root: { retainWhenEmpty: "true" } }).root).toEqual({});
    expect(sanitizeWoohaa3CanvasNodeData({ root: { title: "legacy" } }).root).toEqual({ title: "legacy" });
  });
  it("requires a group target and rejects unknown modes while preserving old model defaults", () => {
    const entry = { action: "generate", canvasId: "c", prompt: "scene" };
    expect(decodeAcceptTurnRequest({ requestId: "r", entry: { ...entry, mode: "canvas-group" } }).ok).toBe(false);
    expect(decodeAcceptTurnRequest({ requestId: "r", entry: { ...entry, mode: "canvas-group", nodeId: "root" } }).ok).toBe(true);
    expect(decodeAcceptTurnRequest({ requestId: "r", entry: { ...entry, mode: "future" } }).ok).toBe(false);
    expect(decodeAcceptTurnRequest({ requestId: "r", entry }).ok).toBe(true);
  });
  it("projects only live descendants, never cross edges, assets or global jobs", () => {
    const canvas = fixture();
    canvas.document.edges = [{ id: "cross", source: "a", target: "outside", data: {} }];
    const scoped = projectCanvasGroup(canvas, "root");
    expect([...canvasGroupMembers(scoped, "root")]).toEqual(["root", "a"]);
    expect(scoped.document.edges).toEqual([]);
    expect(scoped.nodeData.outside).toBeUndefined();
    expect(JSON.stringify(scoped)).not.toContain("private");
  });
  it("rejects outside implicit cascade, input mappings, root moves and escaping members", () => {
    const before = fixture();
    for (const modify of [
      (after: typeof before) => { after.nodeData.outside.prompt = "changed"; },
      (after: typeof before) => { after.nodeData.a.inputMapping = [{ sourceNodeId: "outside", role: "text" }]; },
      (after: typeof before) => { after.nodeData.a.inputMapping = [{ sourceNodeId: "a", sourceAssetIds: ["outside-asset"], role: "text" }]; },
      (after: typeof before) => { after.nodeData.a.outputAssetId = "outside-asset"; },
      (after: typeof before) => { after.document.nodes[1]!.position.x = -10; },
      (after: typeof before) => { after.document.nodes[0]!.position.x++; },
      (after: typeof before) => { after.document.nodes[1]!.parentId = undefined; },
      (after: typeof before) => { after.document.nodes.shift(); },
      (after: typeof before) => { after.document.edges.push({ id: "cross", source: "a", target: "outside", data: {} }); }
    ]) { const after = structuredClone(before); modify(after); expect(validateCanvasGroupChange(before, after, "root")).toBeTruthy(); }
    const after = structuredClone(before); after.nodeData.a.prompt = "updated";
    expect(validateCanvasGroupChange(before, after, "root")).toBeNull();
  });
  it("keeps retained empty ancestors while cleaning ordinary nested groups; explicit removal still cascades", () => {
    const canvas = fixture();
    canvas.document.nodes.push({ id: "nested", type: "group", parentId: "root", position: { x: 0, y: 0 } });
    canvas.document.nodes[1]!.parentId = "nested";
    expect([...collectWoohaa3CanvasRemovalIds(canvas.document.nodes, ["a"], canvas.nodeData)]).toEqual(["a", "nested"]);
    expect(collectWoohaa3CanvasRemovalIds(canvas.document.nodes, ["root"], canvas.nodeData)).toEqual(new Set(["root", "a", "nested"]));
    const result = applyCanvasCommands(canvas, [{ type: "node.remove", nodeIds: ["a"] }]);
    expect(result.ok && result.canvas.document.nodes.map(n => n.id)).toEqual(["root", "outside"]);
  });
  it("compiles local absolute/auto placement into root membership and expands only root dimensions", () => {
    const before = fixture();
    const projection = projectCanvasGroup(before, "root");
    const plan = compileAgentPlan({ canvasId: "c", requestId: "r", scope: "submit_canvas_script", principalId: "u", snapshot: { canvasId: "c", revision: 0, rootGroupId: "root", nodes: projection.document.nodes.map(n => ({ ...n, retainWhenEmpty: projection.nodeData[n.id]?.retainWhenEmpty })), edges: [] }, operations: [
      { op: "create_node", kind: "image", ref: "new", placement: { mode: "absolute", position: { x: 900, y: 40 } } },
      { op: "create_node", kind: "text", ref: "text" },
      { op: "create_group", ref: "nested", title: "nested", members: [{ ref: "new" }, { ref: "text" }] }
    ] });
    expect(plan.ok).toBe(true); if (!plan.ok) return;
    const result = applyCanvasCommands(before, plan.commands);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(validateCanvasGroupChange(before, result.canvas, "root")).toBeNull();
    expect(result.canvas.document.nodes.find(n => n.id === "root")!.position).toEqual({ x: 500, y: 200 });
    expect(canvasGroupMembers(result.canvas, "root").size).toBe(5);
  });
  it("rejects forged owner/scope and invalid retained group writes before mutation", () => {
    expect(decodeCanvasCreationRequest({ owner: "forged" }).ok).toBe(false);
    for (const value of ["true", 1, null]) expect(applyCanvasCommands(fixture(), [{ type: "nodeData.patch", nodeId: "root", value: { retainWhenEmpty: value } as never }]).ok).toBe(false);
    expect(applyCanvasCommands(fixture(), [{ type: "nodeData.patch", nodeId: "a", value: { retainWhenEmpty: true } }]).ok).toBe(false);
  });
});
