import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "./command-reducer.js";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";
import { ManagedNodeLifecycleRegistry, type ManagedNodeLifecycleAdapter } from "./managed-node-lifecycle.js";
import type { CanvasCommand } from "./commands.js";

// An unrelated extension, with an opaque entity collection and no film-set codec.
const adapter: ManagedNodeLifecycleAdapter = {
  extensionId: "test.entities", schemaVersion: 1,
  plan({ canvas }) {
    return { nodes: canvas.document.nodes.filter(n => canvas.nodeData[n.id]?.extensionId === "test.entities").flatMap(owner => {
      const entries = canvas.nodeData[owner.id]?.entries;
      if (!Array.isArray(entries) || entries.some(e => typeof e !== "string")) throw Error("invalid-test-entities");
      return entries.map(entityId => {
        const id = `${owner.id}:${entityId}`;
        return { node: canvas.document.nodes.find(n => n.id === id) ?? { id, type: "image", position: { x: 300, y: 0 }, width: 200, height: 200, data: {} },
          data: { managedBy: { schemaVersion: 1 as const, extensionId: "test.entities", ownerNodeId: owner.id, entityId: String(entityId), lifecycle: "owner-managed" as const } } };
      });
    }) };
  }
};
const owner: CanvasCommand = { type: "node.add", node: { id: "owner", type: "text", position: { x: 0, y: 0 } }, nodeData: { extensionId: "test.entities", entries: ["one"] } };
function apply(canvas: ServerCanvas, commands: CanvasCommand[], lifecycle: ManagedNodeLifecycleRegistry) {
  const result = applyCanvasCommands(canvas, commands, { lifecycle, now: "2026-10-26" });
  if (!result.ok) throw Error(result.rejection.message);
  return result;
}

describe("trusted managed lifecycle transactions", () => {
  it("plans the same net change on separate hosts and retries without duplicates", () => {
    const browser = new ManagedNodeLifecycleRegistry(), authority = new ManagedNodeLifecycleRegistry();
    browser.register(adapter); authority.register(adapter);
    const base = createEmptyWoohaa3ServerCanvas("test", "2026-10-26");
    const local = apply(base, [owner], browser), remote = apply(base, [owner], authority);
    expect(local.canvas).toEqual(remote.canvas);
    expect(local.canvas.document.nodes.map(n => n.id)).toEqual(["owner", "owner:one"]);
    expect(apply(local.canvas, [{ type: "nodeData.patch", nodeId: "owner", value: { entries: ["one"] } }], browser).changed).toBe(false);
    expect(base.document.nodes).toEqual([]);
  });
  it("rejects registration conflicts, forged identities and planner failures atomically", () => {
    const registry = new ManagedNodeLifecycleRegistry(); registry.register(adapter);
    expect(() => registry.register(adapter)).toThrow("conflict");
    expect(() => registry.register({ ...adapter, schemaVersion: 2 } as never)).toThrow("invalid-registration");
    const base = apply(createEmptyWoohaa3ServerCanvas("test"), [owner], registry).canvas;
    for (const commands of [
      [{ type: "nodeData.patch", nodeId: "owner", value: { entries: 42 } }],
      [{ type: "node.add", node: { id: "forged", type: "image", position: { x: 0, y: 0 } }, nodeData: { managedBy: { schemaVersion: 1, extensionId: "test.entities", ownerNodeId: "owner", entityId: "forged", lifecycle: "owner-managed" } } }],
      [{ type: "nodeData.patch", nodeId: "owner:one", value: { managedBy: null } }],
      [{ type: "node.remove", nodeIds: ["owner:one"] }]
    ] as CanvasCommand[][]) {
      const before = structuredClone(base);
      expect(applyCanvasCommands(base, commands, { lifecycle: registry }).ok).toBe(false);
      expect(base).toEqual(before);
    }
  });
  it("keeps persistent protection after release, blocks source edits and recovers the same identities", () => {
    const registry = new ManagedNodeLifecycleRegistry(), release = registry.register(adapter);
    const base = apply(createEmptyWoohaa3ServerCanvas("test"), [owner], registry).canvas;
    release(); release();
    expect(applyCanvasCommands(base, [{ type: "node.remove", nodeIds: ["owner:one"] }], { lifecycle: registry }).ok).toBe(false);
    expect(applyCanvasCommands(base, [{ type: "nodeData.patch", nodeId: "owner", value: { entries: [] } }], { lifecycle: registry })).toMatchObject({ ok: false, rejection: { message: expect.stringContaining("lifecycle-unavailable") } });
    expect(apply(base, [{ type: "node.add", node: { id: "ordinary", type: "text", position: { x: 0, y: 200 } } }], registry).canvas.document.nodes).toHaveLength(3);
    expect(apply(base, [{ type: "node.remove", nodeIds: ["owner", "owner:one"] }], registry).canvas.document.nodes).toEqual([]);
    registry.register(adapter);
    expect(apply(base, [], registry).canvas.document.nodes.map(n => n.id)).toEqual(["owner", "owner:one"]);
    expect(apply(base, [{ type: "nodeData.patch", nodeId: "owner", value: { entries: [] } }], registry).canvas.document.nodes.map(n => n.id)).toEqual(["owner"]);
  });
});

it("keeps active-run gates for lifecycle removals and rejects malformed planner output", () => {
  const registry = new ManagedNodeLifecycleRegistry(); registry.register(adapter);
  const base = apply(createEmptyWoohaa3ServerCanvas("test"), [owner], registry).canvas;
  base.nodeData["owner:one"].taskStatus = "processing";
  expect(applyCanvasCommands(base, [{ type: "nodeData.patch", nodeId: "owner", value: { entries: [] } }], { lifecycle: registry })).toMatchObject({ ok: false, rejection: { message: expect.stringContaining("active-run") } });
  delete base.nodeData["owner:one"].taskStatus;
  for (const mutate of [
    (entry: ReturnType<typeof adapter.plan>["nodes"][number]) => { entry.node.position.x = Infinity; },
    (entry: ReturnType<typeof adapter.plan>["nodes"][number]) => { entry.node.width = 1; },
    (entry: ReturnType<typeof adapter.plan>["nodes"][number]) => { entry.data.mediaContent = { providerId: "bad", schemaVersion: 0, payload: {} }; },
    (entry: ReturnType<typeof adapter.plan>["nodes"][number]) => { entry.data.managedBy!.entityId = "forged"; }
  ]) {
    const broken = new ManagedNodeLifecycleRegistry(); broken.register({ ...adapter, plan(context) {
      const plan = structuredClone(adapter.plan(context)); mutate(plan.nodes[0]); return plan;
    } });
    expect(applyCanvasCommands(base, [{ type: "canvas.setTitle", title: "atomic" }], { lifecycle: broken }).ok).toBe(false);
    expect(base.title).not.toBe("atomic");
  }
});

it("cascades lifecycle releases through persisted ownership of an unloaded extension", () => {
  const registry = new ManagedNodeLifecycleRegistry(); registry.register(adapter);
  const base = apply(createEmptyWoohaa3ServerCanvas("test"), [owner], registry).canvas;
  base.document.nodes.push({ id: "nested", type: "image", position: { x: 600, y: 0 }, width: 200, height: 200 });
  base.nodeData.nested = { managedBy: { schemaVersion: 1, extensionId: "other.entities", ownerNodeId: "owner:one", entityId: "nested", lifecycle: "owner-managed" } };
  expect(apply(base, [{ type: "nodeData.patch", nodeId: "owner", value: { entries: [] } }], registry).canvas.document.nodes.map(n => n.id)).toEqual(["owner"]);
  base.nodeData.nested.taskStatus = "processing";
  expect(applyCanvasCommands(base, [{ type: "nodeData.patch", nodeId: "owner", value: { entries: [] } }], { lifecycle: registry }).ok).toBe(false);
});
