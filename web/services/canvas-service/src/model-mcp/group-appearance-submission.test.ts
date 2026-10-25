import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, readGroupAppearanceForNode, validateCanvasGroupChange, type ServerCanvas } from "@woohaa3/contracts";
import { CanvasRoom } from "../sync/room.js";
import { InMemoryYjsDocumentRepository } from "../sync/index.js";
import { withCanvasGroupScope } from "../agent-authoring/group-scope.js";
import { ModelMcpService } from "./service.js";
const source = 'scene.box({ id: "badge", size: [2, 1, 1] });';
async function fixture() {
  const repository = new InMemoryYjsDocumentRepository();
  const canvas = createEmptyWoohaa3ServerCanvas("appearance", "2026-10-25T00:00:00Z");
  canvas.document.nodes = [{ id: "root", type: "group", position: { x: 0, y: 0 }, width: 500, height: 500 }];
  canvas.nodeData.root = { title: "Original" };
  const room = new CanvasRoom({ canvasId: canvas.id, repository });
  await room.initialize({ canvas, roomEpoch: "appearance", createdAt: "2026-10-25T00:00:00Z" });
  const service = new ModelMcpService({ resolveRoom: async () => room });
  const input = { canvasId: canvas.id, nodeId: "root", resource: "group-appearance" as const, requestId: "first", source,
    expectedContentHash: readGroupAppearanceForNode({}).value.model.contentVersion.contentHash };
  return { room, repository, service, input, canvas };
}
describe("authoritative group appearance resource", () => {
  it("requires explicit role and reads the default without writing it", async () => {
    const { service, input, room } = await fixture();
    expect(await service.getModelNode({ canvasId: input.canvasId, nodeId: input.nodeId })).toMatchObject({ ok: false });
    expect(await service.getModelNode(input)).toMatchObject({ ok: true, resource: "group-appearance", appearanceSource: "default", contentHash: input.expectedContentHash });
    expect(room.exportCanvas()).toMatchObject({ ok: true, canvas: { nodeData: { root: { title: "Original" } } } });
  });
  it("returns the original durable receipt after later edits, rejects reused input and stale concurrent candidates", async () => {
    const { service, input, room } = await fixture();
    const first = await service.submitScript(input);
    expect(first).toMatchObject({ ok: true, idempotent: false });
    expect(await service.submitScript(input)).toMatchObject({ ...first, idempotent: true });
    expect(await service.submitScript({ ...input, source: source + '\nscene.sphere({id:"second"});' })).toMatchObject({ ok: false, code: "request-id-reused" });
    expect(await service.submitScript({ ...input, requestId: "stale" })).toMatchObject({ ok: false, code: "stale-source" });
    const read = await service.getModelNode(input);
    if (!read.ok) throw Error(read.message);
    expect(await service.submitScript({ ...input, requestId: "manual", source: 'scene.box({id:"manual"});', expectedContentHash: read.contentHash })).toMatchObject({ ok: true });
    expect(await service.submitScript(input)).toMatchObject({ ok: true, commandId: first.ok ? first.commandId : "", idempotent: true });
    const snapshot = room.exportCanvas();
    expect(snapshot.ok && snapshot.canvas.nodeData.root.groupAppearance?.model.modelScript).toContain('manual');
  });
  it("permits only the root appearance delta and rejects bundled structure/data escape", async () => {
    const { canvas, service, input, room } = await fixture();
    let valid = true;
    await withCanvasGroupScope({ owner: "owner", canvasId: canvas.id, rootGroupId: "root", scopeEpoch: 0, valid: () => valid }, async () => {
      expect(await service.submitScript(input)).toMatchObject({ ok: true });
      valid = false;
      expect(await service.submitScript({ ...input, requestId: "late" })).toMatchObject({ ok: false, code: "group-scope-revoked" });
    });
    const exported = room.exportCanvas();
    if (!exported.ok) throw Error(exported.message);
    expect(validateCanvasGroupChange(canvas, exported.canvas, "root")).toBeNull();
    for (const mutate of [
      (c: ServerCanvas) => { c.nodeData.root.title = "Smuggled"; },
      (c: ServerCanvas) => { c.document.nodes[0].position.x = 1; },
      (c: ServerCanvas) => { c.document.nodes[0].parentId = "outside"; },
    ]) {
      const changed = structuredClone(exported.canvas); mutate(changed);
      expect(validateCanvasGroupChange(canvas, changed, "root")).not.toBeNull();
    }
  });
});

it("retains committed appearance and original receipts across a fresh authority room", async () => {
  const { service, input, repository, room } = await fixture();
  const receipt = await service.submitScript(input); expect(receipt.ok).toBe(true);
  const reloaded = new CanvasRoom({ canvasId: input.canvasId, repository });
  expect((await reloaded.load()).ok).toBe(true);
  const fresh = new ModelMcpService({ resolveRoom: async () => reloaded });
  expect(await fresh.getModelNode(input)).toMatchObject({ ok: true, source });
  expect(await fresh.submitScript(input)).toMatchObject({ ok: true, idempotent: true, commandId: receipt.ok ? receipt.commandId : "" });
  const before = reloaded.exportCanvas();
  expect(await fresh.submitScript({ ...input, requestId: "external", source: 'fetch("https://invalid.test/model");' })).toMatchObject({ ok: false });
  expect(reloaded.exportCanvas()).toEqual(before);
  room.dispose(); reloaded.dispose();
});
