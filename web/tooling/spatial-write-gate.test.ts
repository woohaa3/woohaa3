import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom } from "../services/canvas-service/src/sync/room.js";
import { SqliteYjsRepository } from "../services/canvas-service/src/storage/sqlite/yjs.js";
import { SqliteSpatialLeaseStore } from "../services/canvas-service/src/storage/sqlite/spatial-leases.js";
import { loadNodeSqlite } from "../services/canvas-service/src/storage/sqlite/sqlite-loader.js";
import { createCanvasService } from "../services/canvas-service/src/composition.js";
import { InMemoryCanvasRepository } from "../services/canvas-service/src/storage/core/in-memory-repository.js";
import { createInMemoryWriterLock } from "../services/canvas-service/src/sync/index.js";

describe("SQLite room spatial gate", () => {
  it("arbitrates complete sets across two service rooms and keeps capabilities local", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spatial-services-"));
    const file = join(dir, "canvas.sqlite");
    const canvas = createEmptyWoohaa3ServerCanvas("canvas");
    const makeInstance = (id: string) => ({ kind: "world-instance", version: "shared-world-v1", instanceId: id, transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } });
    for (const id of ["a", "b", "c", "reference"]) {
      canvas.document.nodes.push({ id, type: "model3d", position: { x: 0, y: 0 } });
      canvas.nodeData[id] = { sharedWorldInstance: makeInstance(id), modelScript: "scene.box({ id: 'body' });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: "same-resource", contentHash: "same-resource" }, modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } };
    }
    const target = (id: string) => ({ kind: "instance" as const, instanceId: id, version: JSON.stringify(canvas.nodeData[id]) });
    const scope = { scope: { kind: "scene-area" as const, areaId: "area" }, scopeVersion: "1" };
    const authority = {
      eligible: () => true,
      stopped: () => true,
      resolve: (_intent: unknown, before: typeof canvas, after: typeof canvas, targets: Array<{ kind: "instance"; instanceId: string }>) => ({
        scope,
        previous: targets.map(t => ({ ...t, version: JSON.stringify(before.nodeData[t.instanceId]) })),
        next: targets.map(t => ({ ...t, version: JSON.stringify(after.nodeData[t.instanceId]) }))
      })
    };
    const catalog = new InMemoryCanvasRepository();
    await catalog.createCanvas(canvas);
    const repositories = [new SqliteYjsRepository({ path: file, spatialAuthority: authority as never }), new SqliteYjsRepository({ path: file, spatialAuthority: authority as never })];
    await new CanvasRoom({ canvasId: canvas.id, repository: repositories[0] }).initialize({ canvas, roomEpoch: "initial" });
    const services = await Promise.all(repositories.map(yjsRepository => createCanvasService({ repository: catalog, yjsRepository, storageConfig: { backend: "sqlite", sqlitePath: file, limits: {} }, writerLock: createInMemoryWriterLock() })));
    try {
      const rooms = [await services[0].sync!.registry.resolve(canvas.id), await services[1].sync!.registry.resolve(canvas.id)];
      expect(rooms.map(room => room.diagnostics)).toEqual([null, null]);
      const intent = (id: string, writable: string[]) => ({ canvasId: canvas.id, requestId: id, runId: id, epoch: 1, executionId: id, scope, writable: writable.map(target), readOnly: [target("reference")] });
      const results = await Promise.allSettled([services[0].spatialWrites!.acquire(intent("first", ["a", "b"])), services[1].spatialWrites!.acquire(intent("second", ["b", "c"]))]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
      const winner = results[0].status === "fulfilled" ? 0 : 1;
      const loser = 1 - winner;
      const free = winner === 0 ? "c" : "a";
      const independent = await services[loser].spatialWrites!.acquire(intent("independent", [free]));
      const capability = (results[winner] as PromiseFulfilledResult<object>).value;
      const patch = (id: string, node: string) => ({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: canvas.id, commandId: id, actorId: "tool", baseRevision: 0, commands: [{ type: "nodeData.patch", nodeId: node, value: { sharedWorldInstance: { ...makeInstance(node), transform: { ...makeInstance(node).transform, scale: 2 } } } }] }) as never;
      expect(await services[loser].spatialWrites!.submit(canvas.id, capability, patch("foreign", winner === 0 ? "a" : "c"))).toMatchObject({ ok: false, code: "spatial-rejected" });
      expect(await services[loser].spatialWrites!.submit(canvas.id, independent, patch("readonly", "reference"))).toMatchObject({ ok: false, code: "spatial-rejected" });
      expect(await services[winner].spatialWrites!.submit(canvas.id, capability, patch("valid", winner === 0 ? "a" : "c"))).toMatchObject({ ok: true, revision: 1 });
      expect(await repositories[loser].getCommandRecord(canvas.id, "foreign")).toBeNull();
      expect(await repositories[loser].getCommandRecord(canvas.id, "readonly")).toBeNull();
      expect(rooms).toHaveLength(2);
      expect((await repositories[0].loadYjsState(canvas.id))?.projection?.revision).toBe(1);
    } finally {
      await Promise.all(services.map(service => service.close()));
      repositories.forEach(repository => repository.close());
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("fences real tool commits and retains cancelled locks until exact stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spatial-tool-"));
    const file = join(dir, "canvas.sqlite");
    const now = "2026-01-01T00:00:00Z";
    const canvas = createEmptyWoohaa3ServerCanvas("canvas", now);
    const instance = { kind: "world-instance", version: "shared-world-v1", instanceId: "i", transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } };
    canvas.document.nodes.push({ id: "model", type: "model3d", position: { x: 0, y: 0 } });
    canvas.nodeData.model = { sharedWorldInstance: instance, modelScript: "scene.box({ id: 'body' });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "c" }, modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } };
    const scope = { scope: { kind: "scene-area" as const, areaId: "a" }, scopeVersion: "s" };
    const target = { kind: "instance" as const, instanceId: "i" };
    const version = (snapshot: typeof canvas) => JSON.stringify(snapshot.nodeData.model);
    let scopeVersion = "s";
    let eligible = true;
    const authority = { eligible: () => eligible, stopped: (_identity: unknown, evidence: unknown) => evidence === "confirmed", resolve: (_intent: unknown, before: typeof canvas, after: typeof canvas, targets: Array<{ kind: "instance"; instanceId: string }>) => ({ scope: { ...scope, scopeVersion }, previous: targets.map(t => ({ ...t, version: t.instanceId === "i" ? version(before) : "absent" })), next: targets.map(t => ({ ...t, version: t.instanceId === "i" ? version(after) : "new" })) }) };
    let fail = false;
    const repository = new SqliteYjsRepository({ path: file, spatialAuthority: authority as never, failWrites: () => fail });
    const db = new (loadNodeSqlite().DatabaseSync)(file);
    const other = new SqliteSpatialLeaseStore(db, authority);
    let published = 0;
    try {
      const room = new CanvasRoom({ canvasId: "canvas", repository, broadcast: () => { published++; } });
      await room.initialize({ canvas, roomEpoch: "e", createdAt: now });
      const context = repository.acquireSpatialContext({ canvasId: "canvas", requestId: "r", runId: "run", epoch: 1, executionId: "exec", scope, writable: [{ ...target, version: version(canvas) }], readOnly: [] });
      const submit = (id: string, scale: number, capability: object) => room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "canvas", commandId: id, actorId: "tool", baseRevision: 0, commands: [{ type: "nodeData.patch", nodeId: "model", value: { sharedWorldInstance: { ...instance, transform: { ...instance.transform, scale } } } }] } as never, { spatialContext: capability });
      expect(await submit("forged", 2, {})).toMatchObject({ ok: false, code: "spatial-rejected" });
      expect(await submit("one", 2, context)).toMatchObject({ ok: true, revision: 1 });
      fail = true;
      const newIdentity = { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "canvas", commandId: "new-failed", actorId: "tool", baseRevision: 0, commands: [{ type: "nodeData.patch", nodeId: "model", value: { sharedWorldInstance: { ...instance, instanceId: "new" } } }] } as never;
      expect(await room.submit(newIdentity, { spatialContext: context })).toMatchObject({ ok: false });
      expect(await repository.getCommandRecord("canvas", "new-failed")).toBeNull();
      other.acquire({ canvasId: "canvas", requestId: "new-owner", runId: "new-owner", epoch: 1, executionId: "new-owner", scope, writable: [{ kind: "instance", instanceId: "new", version: "absent" }], readOnly: [] });
      fail = false;
      other.acquire({ canvasId: "canvas", requestId: "other", runId: "other", epoch: 2, executionId: "other", scope, writable: [{ kind: "instance", instanceId: "busy", version: "absent" }], readOnly: [] });
      const replacement = { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "canvas", commandId: "replace", actorId: "tool", baseRevision: 0, commands: [{ type: "nodeData.patch", nodeId: "model", value: { sharedWorldInstance: { ...instance, instanceId: "busy" } } }] } as never;
      expect(await room.submit(replacement, { spatialContext: context })).toMatchObject({ ok: false, code: "lease-conflict", conflict: { runId: "other" } });
      expect(await repository.getCommandRecord("canvas", "replace")).toBeNull();
      scopeVersion = "changed";
      expect(await submit("stale-scope", 3, context)).toMatchObject({ ok: false, code: "spatial-rejected" });
      scopeVersion = "s";
      eligible = false;
      expect(await submit("ineligible", 3, context)).toMatchObject({ ok: false, code: "spatial-rejected" });
      eligible = true;
      fail = true;
      expect(await submit("failed", 3, context)).toMatchObject({ ok: false });
      expect(await repository.getCommandRecord("canvas", "failed")).toBeNull();
      fail = false;
      expect(await submit("two", 3, context)).toMatchObject({ ok: true, revision: 2 });
      const restarted = new SqliteYjsRepository({ path: file, spatialAuthority: authority as never });
      try {
        expect(restarted.pendingSpatialRuns()).toEqual(expect.arrayContaining([expect.objectContaining({ state: "active", intent: expect.objectContaining({ runId: "run", epoch: 1 }) })]));
        expect(() => restarted.acquireSpatialContext({ canvasId: "canvas", requestId: "r", runId: "run", epoch: 1, executionId: "exec", scope, writable: [{ ...target, version: version(canvas) }], readOnly: [] })).toThrow("unavailable");
      } finally { restarted.close(); }
      repository.cancelSpatialRun("canvas", "r");
      expect(await submit("cancelled", 4, context)).toMatchObject({ ok: false, code: "spatial-rejected" });
      expect(() => repository.acquireSpatialContext({ canvasId: "canvas", requestId: "contender", runId: "contender", epoch: 2, executionId: "contender", scope, writable: [{ ...target, version: "v" }], readOnly: [] })).toThrow("lease-conflict");
      expect(() => repository.confirmSpatialStopped("canvas", "r", "run", 1, "exec", true)).toThrow("unverified-stop");
      repository.confirmSpatialStopped("canvas", "r", "run", 1, "exec", "confirmed");
      const current = (await repository.loadYjsState("canvas"))!.projection!;
      const newer = repository.acquireSpatialContext({ canvasId: "canvas", requestId: "newer", runId: "newer", epoch: 2, executionId: "newer", scope, writable: [{ ...target, version: version(current) }], readOnly: [] });
      expect(await submit("newer-write", 4, newer)).toMatchObject({ ok: true, revision: 3 });
      expect(await submit("late", 5, context)).toMatchObject({ ok: false, code: "spatial-rejected" });
      expect(published).toBe(3);
      expect((await repository.loadYjsState("canvas"))?.projection?.revision).toBe(3);
      other.confirmStopped("canvas", "new-owner", "new-owner", 1, "new-owner", "confirmed");
      const extension = { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "canvas", commandId: "new-success", actorId: "tool", baseRevision: 0, commands: [{ type: "nodeData.patch", nodeId: "model", value: { sharedWorldInstance: { ...instance, instanceId: "new" } } }] } as never;
      expect(await room.submit(extension, { spatialContext: newer })).toMatchObject({ ok: true, revision: 4 });
      expect(() => other.validateUnoccupied("canvas", [{ kind: "instance", instanceId: "new" }])).toThrow("lease-conflict");
    } finally { db.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("rejects an occupied model modification without a receipt or publication, including after reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spatial-room-"));
    const file = join(dir, "canvas.sqlite");
    const { DatabaseSync } = loadNodeSqlite();
    const db = new DatabaseSync(file);
    const leases = new SqliteSpatialLeaseStore(db, { eligible: () => true, stopped: () => true });
    const repository = new SqliteYjsRepository({ path: file });
    const now = "2026-01-01T00:00:00Z";
    const canvas = createEmptyWoohaa3ServerCanvas("canvas", now);
    const instance = { kind: "world-instance", version: "shared-world-v1", instanceId: "i", transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } };
    canvas.document.nodes.push({ id: "model", type: "model3d", position: { x: 0, y: 0 } });
    canvas.nodeData.model = { sharedWorldInstance: instance, modelScript: "scene.box({ id: 'body' });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "c" }, modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } };
    let published = 0;
    try {
      const room = new CanvasRoom({ canvasId: "canvas", repository, broadcast: () => { published++; } });
      await room.initialize({ canvas, roomEpoch: "e", createdAt: now });
      leases.acquire({ canvasId: "canvas", requestId: "r", runId: "run", epoch: 1, executionId: "exec", scope: { scope: { kind: "scene-area", areaId: "a" }, scopeVersion: "s" }, writable: [{ kind: "instance", instanceId: "i", version: "v" }], readOnly: [] });
      const submit = (activeRoom: CanvasRoom, commandId: string) => activeRoom.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "canvas", commandId, actorId: "manual", baseRevision: 0, commands: [{ type: "nodeData.patch", nodeId: "model", value: { sharedWorldInstance: { ...instance, transform: { ...instance.transform, scale: 2 } } } }] } as never);
      expect(await submit(room, "blocked")).toMatchObject({ ok: false, code: "lease-conflict", conflict: { target: { kind: "instance", instanceId: "i" }, runId: "run", epoch: 1 } });
      expect(await repository.getCommandRecord("canvas", "blocked")).toBeNull();
      expect(published).toBe(0);
      repository.close();
      const reopened = new SqliteYjsRepository({ path: file });
      try {
        expect(reopened.pendingSpatialRuns()).toMatchObject([{ state: "active", intent: { runId: "run", epoch: 1 } }]);
        expect(() => reopened.acquireSpatialContext({ canvasId: "canvas", requestId: "r", runId: "run", epoch: 1, executionId: "exec", scope: { scope: { kind: "scene-area", areaId: "a" }, scopeVersion: "s" }, writable: [{ kind: "instance", instanceId: "i", version: "v" }], readOnly: [] })).toThrow("unavailable");
        const restored = new CanvasRoom({ canvasId: "canvas", repository: reopened });
        expect((await restored.load()).ok).toBe(true);
        expect(await submit(restored, "blocked-again")).toMatchObject({ ok: false, code: "lease-conflict" });
        expect((await reopened.loadYjsState("canvas"))?.projection?.revision).toBe(0);
      } finally { reopened.close(); }
    } finally { repository.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
