import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type CanvasCommand } from "@woohaa3/contracts";
import { CanvasRoom } from "../sync/room.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { withCanvasGroupScope, canvasGroupEpoch } from "./group-scope.js";
import { CanvasScriptService } from "../canvas-script/service.js";

async function setup() {
  const room = new CanvasRoom({ canvasId: "scope-test", repository: new InMemoryYjsDocumentRepository(), verifyAssets: false });
  const canvas = createEmptyWoohaa3ServerCanvas("scope-test", new Date().toISOString());
  canvas.document.nodes = [{ id: "root", type: "group", position: { x: 0, y: 0 }, width: 600, height: 400 }, { id: "a", type: "text", position: { x: 40, y: 40 }, parentId: "root" }, { id: "outside", type: "text", position: { x: 800, y: 0 } }];
  canvas.nodeData = { root: { retainWhenEmpty: true }, a: { prompt: "old" }, outside: { prompt: "private" } };
  await room.initialize({ canvas, roomEpoch: "epoch" });
  let id = 0;
  const submit = (commands: CanvasCommand[]) => room.submit({ protocolVersion: 1, canvasId: canvas.id, commandId: `group-scope-${++id}`, baseRevision: room.currentRevision, actorId: "user", commands });
  return { room, submit, canvas };
}
describe("group authority queue", () => {
  it("runs scoped scripts through the same authority scope, rejects nested groups and root/outside bypasses", async () => {
    const { room, canvas } = await setup();
    const service = new CanvasScriptService({ resolveRoom: async () => room, authorizer: { authorize: async () => ({ allowed: true }) } });
    const scope = { owner: "u", canvasId: canvas.id, rootGroupId: "root", scopeEpoch: canvasGroupEpoch(canvas.id, "root"), valid: () => true };
    const input = { principalId: "u", canvasId: canvas.id, version: "woohaa-canvas-js-v1" };
    const submit = (requestId: string, source: string) => withCanvasGroupScope(scope, () => service.submit({ ...input, requestId, source }));
    const good = await submit("scoped", `const a = canvas.node("image", {key:"image", placement:{mode:"absolute",position:{x:80,y:90}}}); const b = canvas.node("text",{key:"brief"}); canvas.connect(b,a,{key:"reference"});`);
    expect(good.ok, JSON.stringify(good)).toBe(true);
    const revision = room.currentRevision;
    for (const [id, source] of [
      ["nested", 'const a=canvas.node("image",{key:"n"}); const b=canvas.node("text",{key:"t"}); canvas.group([a,b],{key:"nested",title:"Nested"});'],
      ["outside", 'canvas.setPrompt(canvas.existing("outside"), "bad");'],
      ["delete-root", 'canvas.remove(canvas.existing("root"));'],
      ["ungroup-root", 'canvas.ungroup(canvas.existing("root"));'],
      ["move-root", 'canvas.move(canvas.existing("root"),{x:50,y:50});']
    ]) expect((await submit(id!, source!)).ok).toBe(false);
    expect(room.currentRevision).toBe(revision);
  });
  it("grows the root upward when a script places content above the group", async () => {
    const { room, canvas } = await setup();
    const service = new CanvasScriptService({ resolveRoom: async () => room, authorizer: { authorize: async () => ({ allowed: true }) } });
    const scope = { owner: "u", canvasId: canvas.id, rootGroupId: "root", scopeEpoch: canvasGroupEpoch(canvas.id, "root"), valid: () => true };
    const result = await withCanvasGroupScope(scope, () => service.submit({
      principalId: "u", canvasId: canvas.id, version: "woohaa-canvas-js-v1", requestId: "above-root",
      source: 'canvas.node("text", {key:"above", placement:{mode:"absolute",position:{x:80,y:-200}}});'
    }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const exported = room.exportCanvas();
    expect(exported.ok).toBe(true); if (!exported.ok) return;
    const nodes = exported.canvas.document.nodes;
    const root = nodes.find(n => n.id === "root")!;
    const above = nodes.find(n => !["root", "a", "outside"].includes(n.id))!;
    const original = nodes.find(n => n.id === "a")!;
    expect(root.position.y).toBeLessThan(0);
    expect(above.position.y).toBeGreaterThanOrEqual(0);
    // 扩组不改变既有内容的世界坐标。
    expect(original.position.y + root.position.y).toBe(40);
  });
  it("splits legacy nested groups on load, then scopes the promoted root as a top-level group", async () => {
    const room = new CanvasRoom({ canvasId: "nested-scope", repository: new InMemoryYjsDocumentRepository(), verifyAssets: false });
    const canvas = createEmptyWoohaa3ServerCanvas("nested-scope", new Date().toISOString());
    canvas.document.nodes = [
      { id: "manager", type: "group", position: { x: 0, y: 0 }, width: 900, height: 700 },
      { id: "root", type: "group", parentId: "manager", position: { x: 20, y: 20 }, width: 600, height: 400 },
      { id: "a", type: "text", parentId: "root", position: { x: 40, y: 40 } },
    ];
    canvas.nodeData = { manager: { retainWhenEmpty: true }, root: { retainWhenEmpty: true }, a: { prompt: "old" } };
    await room.initialize({ canvas, roomEpoch: "epoch" });
    // 嵌套 group 已被禁止（change: 2026-10-28-order-canvas-layers-by-ground-anchor）：
    // 旧文档加载时把子组提升为顶层并烘焙绝对坐标，房间导出结果里 root 不再挂在 manager 下。
    const loaded = room.exportCanvas();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.canvas.document.nodes.find(n => n.id === "root")?.parentId).toBeUndefined();
    expect(loaded.canvas.document.nodes.find(n => n.id === "a")?.parentId).toBe("root");
    const service = new CanvasScriptService({ resolveRoom: async () => room, authorizer: { authorize: async () => ({ allowed: true }) } });
    const scope = { owner: "u", canvasId: canvas.id, rootGroupId: "root", scopeEpoch: canvasGroupEpoch(canvas.id, "root"), valid: () => true };
    const input = { principalId: "u", canvasId: canvas.id, version: "woohaa-canvas-js-v1" as const };
    const source = `const n=canvas.node("image",{key:"plane", placement:{mode:"absolute",position:{x:80,y:90}}}); canvas.reparent([n],canvas.existing("root"));`;
    const validated = await withCanvasGroupScope(scope, () => service.validate({ ...input, requestId: "nested-validate", source }));
    expect(validated.ok, JSON.stringify(validated)).toBe(true);
    const submitted = await withCanvasGroupScope(scope, () => service.submit({ ...input, requestId: "nested-submit", source }));
    expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
    const exported = room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.canvas.document.nodes.find(n => n.id === "root")?.parentId).toBeUndefined();
    expect(exported.canvas.document.nodes.find(n => n.id === "a")?.parentId).toBe("root");
    expect(exported.canvas.document.nodes.some(n => n.type === "image" && n.parentId === "root")).toBe(true);
  });
  it("rechecks membership after a queued user move, rejecting the whole batch", async () => {
    const { room, submit, canvas } = await setup();
    const scope = { owner: "u", canvasId: canvas.id, rootGroupId: "root", scopeEpoch: canvasGroupEpoch(canvas.id, "root"), valid: () => true };
    const moved = submit([{ type: "node.update", nodeId: "a", parentId: null }]);
    const write = withCanvasGroupScope(scope, () => submit([{ type: "nodeData.patch", nodeId: "a", value: { prompt: "bad" } }, { type: "nodeData.patch", nodeId: "outside", value: { prompt: "bad" } }]));
    expect((await moved).ok).toBe(true);
    expect((await write).ok).toBe(false);
    const result = room.exportCanvas();
    expect(result.ok && result.canvas.nodeData.a.prompt).toBe("old");
  });
  it("rejects deleting a member with a cross-boundary edge without removing any entity", async () => {
    const { room, submit, canvas } = await setup();
    expect((await submit([{ type: "edge.add", edge: { id: "cross", source: "a", target: "outside" } }])).ok).toBe(true);
    const result = await withCanvasGroupScope({ owner: "u", canvasId: canvas.id, rootGroupId: "root", scopeEpoch: 0, valid: () => true }, () => submit([{ type: "node.remove", nodeIds: ["a"] }]));
    expect(result.ok).toBe(false);
    expect(room.currentRevision).toBe(1);
  });
  it("deletion and restoration of the same ID never revive the old grant", async () => {
    const { submit, canvas } = await setup();
    const epoch = canvasGroupEpoch(canvas.id, "root");
    const scope = { owner: "u", canvasId: canvas.id, rootGroupId: "root", scopeEpoch: epoch, valid: () => canvasGroupEpoch(canvas.id, "root") === epoch };
    await submit([{ type: "node.remove", nodeIds: ["root"] }]);
    await submit([{ type: "node.add", node: canvas.document.nodes[0]!, nodeData: { retainWhenEmpty: true } }]);
    expect(scope.valid()).toBe(false);
    expect((await withCanvasGroupScope(scope, () => submit([{ type: "node.update", nodeId: "root", width: 900 }]))).ok).toBe(false);
  });
  it("checks revoked write access in the authority queue and records actual receipts only", async () => {
    const { submit, canvas } = await setup();
    const actions: unknown[] = [];
    const result = await withCanvasGroupScope({ owner: "u", canvasId: canvas.id, rootGroupId: "root", scopeEpoch: 0, valid: () => true, authorize: async () => false, onAction: action => actions.push(action) }, () => submit([{ type: "nodeData.patch", nodeId: "a", value: { prompt: "bad" } }]));
    expect(result.ok).toBe(false); expect(actions).toEqual([]);
  });
});
