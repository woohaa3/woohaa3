import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";

import { compileAgentPlan } from "./canvas-script/planner/compile.js";
import { filmSetObjectContainerData, filmSetObjectContainerId } from "./film-set-object-container.js";
import { canvasGroupMembers, projectCanvasGroup, validateCanvasGroupChange } from "./group-authoring-scope.js";
import { collectWoohaa3CanvasRemovalIds } from "./domain/core/node-removal.js";
import { decodeCanvasCreationRequest } from "../extension/assistant/canvas-creation.js";
import { sanitizeWoohaa3CanvasNodeData } from "./domain/core/document-schema.js";
import { serverCanvasToYDoc, yDocToServerCanvas } from "./yjs/mapping.js";
import { decodeAcceptTurnRequest } from "../extension/assistant/conversation-codec.js";

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
  it("accepts a new in-group image asset and rejects assets owned outside the group", () => {
    const before = fixture();
    before.assets = [{ id: "outside-asset", nodeId: "outside", title: "外", mediaKind: "image", source: "uploaded", status: "ready", createdAt: "2026-10-20T00:00:00Z", metadata: { storageKey: "outside-key" } }];
    const after = structuredClone(before);
    after.document.nodes.push({ id: "shot", type: "image", parentId: "root", position: { x: 48, y: 48 }, width: 320, height: 320 });
    after.nodeData.shot = { title: "Codex 图片", codexImageImport: true, outputAssetId: "shot-asset", resourceKind: "image", taskStatus: "successed" };
    after.assets.push({ id: "shot-asset", nodeId: "shot", title: "Codex 图片", mediaKind: "image", source: "uploaded", status: "ready", createdAt: "2026-10-20T00:00:00Z", url: "/api/media/new-key", metadata: { storageKey: "new-key" } });
    expect(validateCanvasGroupChange(before, after, "root")).toBeNull();

    const stolen = structuredClone(after);
    stolen.nodeData.shot.outputAssetId = "outside-asset";
    expect(validateCanvasGroupChange(before, stolen, "root")).toMatch(/引用了组外输入/);

    const global = structuredClone(before);
    global.assets.push({ id: "loose", title: "无主", mediaKind: "image", source: "uploaded", status: "ready", createdAt: "2026-10-20T00:00:00Z" });
    expect(validateCanvasGroupChange(before, global, "root")).toMatch(/全局资产/);
  });
  it("accepts a root grown up/left to contain derived film-set cards, but not unneeded growth or negative local coordinates", () => {
    const before = fixture();
    before.document.nodes.push({ id: "film", type: "composite-asset", parentId: "root", position: { x: 40, y: 40 } });
    before.nodeData.film = { extensionId: "film-set" };
    const containerId = filmSetObjectContainerId("film", "cube");
    const after = structuredClone(before);
    // reducer refit：根组向上扩 280，直属成员局部坐标同步下移，世界坐标保持不变。
    const root = after.document.nodes.find(n => n.id === "root")!;
    root.position.y = -80;
    root.height = 880;
    after.document.nodes.find(n => n.id === "a")!.position.y = 320;
    after.document.nodes.find(n => n.id === "film")!.position.y = 320;
    after.document.nodes.push({ id: containerId, type: "composite-asset", parentId: "root", position: { x: 40, y: 40 }, width: 248, height: 232 });
    after.nodeData[containerId] = filmSetObjectContainerData("film", "cube");
    expect(validateCanvasGroupChange(before, after, "root")).toBeNull();

    // 不先扩组、直接把派生卡片写在负局部坐标上仍然拒绝。
    const raw = structuredClone(before);
    raw.document.nodes.push({ id: containerId, type: "composite-asset", parentId: "root", position: { x: 40, y: -240 }, width: 248, height: 232 });
    raw.nodeData[containerId] = filmSetObjectContainerData("film", "cube");
    expect(validateCanvasGroupChange(before, raw, "root")).toBeTruthy();

    // 直接平移根组（成员局部坐标不变）仍然拒绝；扩组必须由成员世界位置驱动。
    const moved = structuredClone(before);
    moved.document.nodes.find(n => n.id === "root")!.position.y = 120;
    moved.document.nodes.find(n => n.id === "root")!.height = 680;
    expect(validateCanvasGroupChange(before, moved, "root")).toBeTruthy();

    after.document.nodes.at(-1)!.position.y = Number.NaN;
    expect(validateCanvasGroupChange(before, after, "root")).toBeTruthy();
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
  it("compiles local absolute/auto placement into root membership, expands the root and rejects nested groups", () => {
    const before = fixture();
    const projection = projectCanvasGroup(before, "root");
    const snapshot = {
      canvasId: "c",
      revision: 0,
      rootGroupId: "root",
      nodes: projection.document.nodes.map(n => ({ ...n, retainWhenEmpty: projection.nodeData[n.id]?.retainWhenEmpty })),
      edges: [],
    };
    const plan = compileAgentPlan({ canvasId: "c", requestId: "r", scope: "submit_canvas_script", principalId: "u", snapshot, operations: [
      { op: "create_node", kind: "image", ref: "new", placement: { mode: "absolute", position: { x: 900, y: 40 } } },
      { op: "create_node", kind: "text", ref: "text" },
    ] });
    expect(plan.ok).toBe(true); if (!plan.ok) return;
    const result = applyCanvasCommands(before, plan.commands);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(validateCanvasGroupChange(before, result.canvas, "root")).toBeNull();
    // 组内新增内容可以向上/向左撑大根组，但不允许缩小既有边界。
    const root = result.canvas.document.nodes.find(n => n.id === "root")!;
    const created = result.canvas.document.nodes.filter(n => !before.document.nodes.some(old => old.id === n.id));
    expect(created.map(n => n.type).sort()).toEqual(["image", "text"]);
    const image = created.find(n => n.type === "image")!;
    expect(root.position.x).toBeLessThanOrEqual(500);
    expect(root.position.y).toBeLessThanOrEqual(200);
    expect(root.position.x + (root.width ?? 0)).toBeGreaterThanOrEqual(image.position.x + (image.width ?? 0));
    expect(root.position.y + (root.height ?? 0)).toBeGreaterThanOrEqual(image.position.y + (image.height ?? 0));
    expect(canvasGroupMembers(result.canvas, "root").size).toBe(4);
    // group 不能嵌套（change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D7）：
    // 在根组内再建 group 或把 group 当成员，计划层直接给出 invalid-parent。
    const nested = compileAgentPlan({ canvasId: "c", requestId: "r2", scope: "submit_canvas_script", principalId: "u", snapshot, operations: [
      { op: "create_node", kind: "image", ref: "x", placement: { mode: "absolute", position: { x: 1200, y: 40 } } },
      { op: "create_group", ref: "nested", title: "nested", members: [{ ref: "x" }] },
    ] });
    expect(nested).toMatchObject({ ok: false, error: { code: "invalid-parent" } });
  });
  it("rejects forged owner/scope and invalid retained group writes before mutation", () => {
    expect(decodeCanvasCreationRequest({ owner: "forged" }).ok).toBe(false);
    for (const value of ["true", 1, null]) expect(applyCanvasCommands(fixture(), [{ type: "nodeData.patch", nodeId: "root", value: { retainWhenEmpty: value } as never }]).ok).toBe(false);
    expect(applyCanvasCommands(fixture(), [{ type: "nodeData.patch", nodeId: "a", value: { retainWhenEmpty: true } }]).ok).toBe(false);
  });
});
