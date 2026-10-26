import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, ManagedNodeLifecycleRegistry, type CanvasCommand } from "@woohaa3/contracts";
import { serverCanvasToYDoc, yDocToServerCanvas, YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { WorkingProjectionStore } from "../../../../frontend/src/cordis/services/canvas-state/store/working-projection.js";
import { testManagedLifecycle, testManagedOwner } from "../../../../test-support/managed-test-extension.js";
import { applyCommandTransaction } from "./command-transaction.js";

const NOW = "2026-10-26T00:00:00.000Z";
describe("trusted lifecycle across speculative and authoritative hosts", () => {
  it("publishes identical entities, releases atomically, rejects forged commands, and recovers after teardown", async () => {
    const browser = new ManagedNodeLifecycleRegistry(), authority = new ManagedNodeLifecycleRegistry();
    const releaseBrowser = browser.register(testManagedLifecycle), releaseAuthority = authority.register(testManagedLifecycle);
    const base = createEmptyWoohaa3ServerCanvas("managed-hosts", NOW), doc = serverCanvasToYDoc(base);
    const store = new WorkingProjectionStore(browser); store.applyCanonical(base);
    let revision = 0, sequence = 0;
    async function execute(commands: CanvasCommand[]) {
      const commandId = `managed-${++sequence}`;
      const local = store.appendBatch({ commandId, baseRevision: revision, submittedAt: NOW, commands });
      const remote = await applyCommandTransaction({ doc, lifecycle: authority, now: NOW, verifyAssets: false,
        batch: { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: base.id, commandId, baseRevision: revision, actorId: "tester", commands } });
      expect(local.ok).toBe(remote.ok);
      if (local.ok && remote.ok) {
        expect({ ...store.workingCanvas, revision: remote.revision }).toEqual(remote.canvas);
        revision = remote.revision;
        store.applyCanonical(remote.canvas);
      }
      return remote;
    }
    try {
      const created = await execute([testManagedOwner]);
      expect(created.ok && created.canvas.document.nodes.map(n => n.id)).toEqual(["owner", "owner:one"]);
      const saved = yDocToServerCanvas(doc, { now: NOW });
      for (const commands of [
        [{ type: "node.remove", nodeIds: ["owner:one"], force: true }],
        [{ type: "nodeData.patch", nodeId: "owner:one", value: { managedBy: null } }],
        [{ type: "nodeData.patch", nodeId: "owner", value: { entries: 42 } }]
      ] as CanvasCommand[][]) {
        expect((await execute(commands)).ok).toBe(false);
        expect(yDocToServerCanvas(doc, { now: NOW })).toEqual(saved);
      }
      expect((await execute([{ type: "nodeData.patch", nodeId: "owner", value: { entries: [] } }])).ok).toBe(true);
      expect((await execute([{ type: "nodeData.patch", nodeId: "owner", value: { entries: ["one"] } }])).ok).toBe(true);
      releaseBrowser(); releaseAuthority();
      expect((await execute([{ type: "nodeData.patch", nodeId: "owner", value: { entries: [] } }])).ok).toBe(false);
      browser.register(testManagedLifecycle); authority.register(testManagedLifecycle);
      const retry = await execute([{ type: "nodeData.patch", nodeId: "owner", value: { entries: ["one"] } }]);
      expect(retry.ok && retry.changed).toBe(false);
      expect((await execute([{ type: "node.remove", nodeIds: ["owner", "owner:one"] }])).ok).toBe(true);
      expect(store.workingCanvas?.document.nodes).toEqual([]);
    } finally { doc.destroy(); }
  });
});
