import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteExtensionDocumentStore } from "../../../services/application-service/src/repository/extension-document-store.js";
import { CanvasApplicationService } from "../../../services/canvas-service/src/storage/core/application-service.js";
import { InMemoryCanvasRepository } from "../../../services/canvas-service/src/storage/core/in-memory-repository.js";
import { CanvasRoomRegistry } from "../../../services/canvas-service/src/sync/room-registry.js";
import { InMemoryYjsDocumentRepository } from "../../../services/canvas-service/src/sync/in-memory-yjs-repository.js";
import type { CanvasService } from "@woohaa3/canvas-service";
import type { ExtensionCanvasCommitInput } from "@woohaa3/contracts";
import { createExtensionOwnedCanvases } from "./extension-canvases.js";
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function setup() {
  const store = createSqliteExtensionDocumentStore({ path: ":memory:", owners: ["registry"] });
  const service = new CanvasApplicationService({ repository: new InMemoryCanvasRepository() });
  const repository = new InMemoryYjsDocumentRepository();
  const registry = new CanvasRoomRegistry({ repository, bootstrap: id => service.getCanvas(id) });
  let permitted = true;
  const canvas = { composition: { service }, sync: { registry } } as unknown as CanvasService;
  const authority = { principal: async () => ({ subject: "instance-owner", identityProvider: "instance" }), authorize: async () => { if (!permitted) throw new Error("revoked"); } };
  const make = (extensionId: string) => createExtensionOwnedCanvases({ canvas, extensionId, registry: store.forExtension("registry")!, authority });
  cleanups.push(() => store.close(), () => registry.destroyAll());
  return { facade: make("one"), make, service, registry, repository, revoke: () => { permitted = false; } };
}
const input = (revision: number, requestId = "save-1"): ExtensionCanvasCommitInput => ({ canvasId: "owned", requestId, expectedRevision: revision,
  commands: [{ type: "node.add", node: { id: "group", type: "group", position: { x: 0, y: 0 } }, nodeData: { retainWhenEmpty: true } }] });
describe("extension owned canvases", () => {
  it("creates and writes without browser connections, keeps title, releases leases", async () => {
    const t = setup();
    const ensured = await Promise.all([t.facade.ensure({ canvasId: "owned", title: "Board" }), t.facade.ensure({ canvasId: "owned", title: "Board" })]);
    expect(ensured[0].canvasId).toBe("owned");
    expect((await t.facade.commit(input(ensured[0].revision))).ok).toBe(true);
    await t.facade.ensure({ canvasId: "owned", title: "Another" });
    const snapshot = await t.facade.read({ canvasId: "owned" });
    expect(snapshot.title).toBe("Board"); expect(snapshot.document.nodes.map(n => n.id)).toEqual(["group"]);
    expect(t.registry.refCount("owned")).toBe(0);
  });
  it("rejects ordinary canvases and another extension's ownership", async () => {
    const t = setup(); await t.service.createCanvas({ canvasId: "ordinary" });
    await expect(t.facade.ensure({ canvasId: "ordinary", title: "Board" })).rejects.toMatchObject({ code: "ownership-conflict" });
    await t.facade.ensure({ canvasId: "owned", title: "Board" });
    await expect(t.make("two").read({ canvasId: "owned" })).rejects.toMatchObject({ code: "ownership-conflict" });
    await expect(t.make("two").ensure({ canvasId: "owned", title: "Board" })).rejects.toMatchObject({ code: "ownership-conflict" });
  });
  it("replays a lost durable response before checking a now-stale revision", async () => {
    const t = setup(); const { revision } = await t.facade.ensure({ canvasId: "owned", title: "Board" });
    const request = input(revision); const first = await t.facade.commit(request);
    expect(first.ok).toBe(true);
    await t.registry.destroyAll();
    expect(await t.facade.commit(request)).toMatchObject({ ok: true, status: "duplicate" });
    expect(await t.facade.commit({ ...request, expectedRevision: revision + 1 })).toMatchObject({ ok: false, code: "request-id-reused" });
    expect(await t.facade.commit({ ...request, requestId: "new-stale" })).toMatchObject({ ok: false, code: "revision-conflict" });
  });
  it("does not claim success on storage failure, same input can retry", async () => {
    const t = setup(); const { revision } = await t.facade.ensure({ canvasId: "owned", title: "Board" });
    t.repository.failNextCommit(new Error("disk failure"));
    expect((await t.facade.commit(input(revision))).ok).toBe(false);
    expect((await t.facade.read({ canvasId: "owned" })).document.nodes).toHaveLength(0);
    expect(await t.facade.commit(input(revision))).toMatchObject({ ok: true, status: "committed" });
  });
  it("recovers a creation saved before the ownership activation response", async () => {
    const t = setup(); const create = t.service.createCanvas.bind(t.service);
    let lose = true;
    vi.spyOn(t.service, "createCanvas").mockImplementation(async value => {
      const saved = await create(value);
      if (lose) { lose = false; throw new Error("creation response lost"); }
      return saved;
    });
    await expect(t.facade.ensure({ canvasId: "owned", title: "Board" })).rejects.toThrow("creation response lost");
    expect(await t.make("one").ensure({ canvasId: "owned", title: "Board" })).toMatchObject({ canvasId: "owned" });
    expect((await t.facade.read({ canvasId: "owned" })).title).toBe("Board");
  });
  it("rejects revocation after enqueue, before the serialized write", async () => {
    const t = setup(); const { revision } = await t.facade.ensure({ canvasId: "owned", title: "Board" });
    const lease = await t.registry.acquire("owned");
    let release!: () => void;
    const blocked = new Promise<boolean>(resolve => { release = () => resolve(true); });
    const first = lease.room.submit({ protocolVersion: 1, canvasId: "owned", baseRevision: revision, actorId: "user", commandId: "user",
      commands: [{ type: "node.add", node: { id: "user", type: "text", position: { x: 0, y: 0 } } }] }, { authorize: () => blocked });
    let enqueued!: () => void;
    const queued = new Promise<void>(resolve => { enqueued = resolve; });
    const submit = lease.room.submitDerived.bind(lease.room);
    vi.spyOn(lease.room, "submitDerived").mockImplementation((...args) => { const result = submit(...args); enqueued(); return result; });
    const pending = t.facade.commit(input(revision));
    await queued; t.revoke(); release();
    await first; expect((await pending).ok).toBe(false);
    expect(lease.room.exportCanvas()).toMatchObject({ ok: true, canvas: { document: { nodes: [{ id: "user" }] } } });
    lease.release();
  });
  it("rechecks background permissions and rejects revoked reads/writes", async () => {
    const t = setup(); const { revision } = await t.facade.ensure({ canvasId: "owned", title: "Board" });
    t.revoke(); await expect(t.facade.commit(input(revision))).rejects.toThrow("revoked");
    await expect(t.facade.read({ canvasId: "owned" })).rejects.toThrow("revoked");
  });
});
