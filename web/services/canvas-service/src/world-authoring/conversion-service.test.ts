import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, legacyModelGroundTransform, effectiveCanvasNodeSize, planCanvasEdit, type CanvasNodeData } from "@woohaa3/contracts";
import { createCanvasService } from "../composition.js";
import { InMemoryCanvasRepository } from "../storage/core/in-memory-repository.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { SqliteYjsRepository } from "../storage/sqlite/yjs.js";
import { createWorldConversionService, worldConversionNodeVersion } from "./conversion-service.js";
import type { CanvasRoom } from "../sync/room.js";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import * as scriptExecutor from "../model-mcp/script-executor.js";

describe("world conversion preparation", () => {
  it("rejects an invalid batch atomically and leaves unselected models unchanged", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("batch");
    for (const id of ["a", "b", "untouched"]) {
      canvas.document.nodes.push({ id, type: "model3d", position: { x: 0, y: 0 } });
      canvas.nodeData[id] = { modelScript: "scene.box({ id: 'body' });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: "source", contentHash: "content" }, modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } };
    }
    canvas.document.nodes.push({ id: "bad", type: "model3d", position: { x: 0, y: 0 } });
    canvas.nodeData.bad = { modelScript: "", modelScriptVersion: "woohaa-model-js-v2" };
    const repository = new InMemoryCanvasRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    await repository.createCanvas(canvas);
    const service = await createCanvasService({ repository, yjsRepository: yjs, storageConfig: { backend: "sqlite", sqlitePath: ":memory:", limits: {} }, mediaClient: { async verify() { return { exists: true, matches: true }; } } });
    try {
      const prepared = await service.worldConversion!.prepare({ canvasId: "batch", nodeIds: ["a", "b"] });
      if (!prepared.ok) throw new Error(prepared.message);
      const targets = prepared.nodes.map(node => ({ nodeId: node.nodeId, nodeVersion: node.nodeVersion, instanceId: `instance-${node.nodeId}` }));
      const intent = { canvasId: "batch", operationId: "batch-op", sourceVersion: prepared.sourceVersion, targets };
      const room = await service.sync!.registry.resolve("batch");
      const before = room.exportCanvas();
      expect(await service.worldConversion!.commit({ ...intent, targets: [targets[0]!, { ...targets[1]!, nodeVersion: "stale" }] })).toMatchObject({ ok: false, code: "version-conflict" });
      expect(await service.worldConversion!.commit({ ...intent, targets: [targets[0]!, { ...targets[1]!, instanceId: targets[0]!.instanceId }] })).toMatchObject({ ok: false });
      if (!before.ok) throw new Error(before.message);
      const bNode = before.canvas.document.nodes.find(node => node.id === "b")!;
      const bData = before.canvas.nodeData.b;
      for (const modified of [{ ...bData, modelScript: "scene.box({ id: 'changed' });" }, { ...bData, modelPlacement: { offset: { x: 1, y: 0, z: 0 }, scale: 1, yaw: 0 } }]) {
        expect(await service.worldConversion!.commit({ ...intent, targets: [targets[0]!, { ...targets[1]!, nodeVersion: worldConversionNodeVersion(bNode, modified) }] })).toMatchObject({ ok: false, code: "version-conflict" });
      }
      const badNode = before.canvas.document.nodes.find(node => node.id === "bad")!;
      expect(await service.worldConversion!.commit({ ...intent, targets: [targets[0]!, { nodeId: "bad", nodeVersion: worldConversionNodeVersion(badNode, before.canvas.nodeData.bad), instanceId: "instance-bad" }] })).toMatchObject({ ok: false, code: "not-ready" });
      expect(room.exportCanvas()).toEqual(before);
      expect(await yjs.getCommandRecord("batch", "world-conversion:batch-op")).toBeNull();
      const result = await service.worldConversion!.commit(intent);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const after = room.exportCanvas();
      if (!before.ok || !after.ok) throw new Error("canvas unavailable");
      expect(after.canvas.nodeData.untouched).toEqual(before.canvas.nodeData.untouched);
      expect(after.canvas.nodeData.a.modelScript).toBe(before.canvas.nodeData.a.modelScript);
      expect(after.canvas.nodeData.b.modelScript).toBe(before.canvas.nodeData.b.modelScript);
      const untouched = await service.worldConversion!.prepare({ canvasId: "batch", nodeIds: ["untouched"] });
      if (!untouched.ok) throw new Error(untouched.message);
      const collision = await service.worldConversion!.commit({ canvasId: "batch", operationId: "collision", sourceVersion: untouched.sourceVersion, targets: [{ nodeId: "untouched", nodeVersion: untouched.nodes[0]!.nodeVersion, instanceId: "instance-a" }] });
      expect(collision).toMatchObject({ ok: false, code: "instance-id-conflict" });
      expect(room.exportCanvas()).toEqual(after);
      expect(await yjs.getCommandRecord("batch", "world-conversion:collision")).toBeNull();
      let oldVersion = untouched.nodes[0]!.nodeVersion;
      let revision = Number(untouched.sourceVersion);
      const updates: CanvasNodeData[] = [{ modelScript: "scene.box({ id: 'new-body' });" }, { modelPlacement: { offset: { x: 2, y: 0, z: 0 }, scale: 1, yaw: 0 } }];
      for (const [index, value] of updates.entries()) {
        const update = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "batch", commandId: `change-${index}`, actorId: "test", baseRevision: revision, commands: [{ type: "nodeData.patch", nodeId: "untouched", value }] });
        if (!update.ok) throw new Error(update.message);
        revision = update.revision;
        const changed = room.exportCanvas();
        expect(await service.worldConversion!.commit({ canvasId: "batch", operationId: `stale-${index}`, sourceVersion: String(revision), targets: [{ nodeId: "untouched", nodeVersion: oldVersion, instanceId: "new-instance" }] })).toMatchObject({ ok: false, code: "version-conflict" });
        expect(room.exportCanvas()).toEqual(changed);
        expect(await yjs.getCommandRecord("batch", `world-conversion:stale-${index}`)).toBeNull();
        if (!changed.ok) throw new Error(changed.message);
        oldVersion = worldConversionNodeVersion(changed.canvas.document.nodes.find(node => node.id === "untouched"), changed.canvas.nodeData.untouched);
      }
    } finally { await service.close(); }
  });
  it("rejects stale fingerprints before scripts and cancels a disconnected commit", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("commit-cancel");
    canvas.document.nodes.push({ id: "model", type: "model3d", position: { x: 0, y: 0 } });
    canvas.nodeData.model = { modelScript: "while (true) {}", modelScriptVersion: "woohaa-model-js-v2" };
    const repository = new InMemoryCanvasRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    await repository.createCanvas(canvas);
    const service = await createCanvasService({ repository, yjsRepository: yjs, storageConfig: { backend: "sqlite", sqlitePath: ":memory:", limits: {} }, mediaClient: { async verify() { return { exists: true, matches: true }; } }, accessRuntime: { enabled: true }, authenticate: async () => ({ subject: "user", identityProvider: "test" }), access: { async authorize() { return { allowed: true }; } } });
    let finished!: () => void;
    const handled = new Promise<void>(resolve => { finished = resolve; });
    const server = http.createServer((req, res) => { void service.handle(req, res).finally(finished); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const room = await service.sync!.registry.resolve("commit-cancel");
      const snapshot = room.exportCanvas();
      if (!snapshot.ok) throw new Error(snapshot.message);
      const node = snapshot.canvas.document.nodes[0]!;
      const intent = { canvasId: "commit-cancel", operationId: "cancel-op", sourceVersion: String(snapshot.canvas.revision), targets: [{ nodeId: "model", nodeVersion: worldConversionNodeVersion(node, snapshot.canvas.nodeData.model), instanceId: "instance" }] };
      const execute = vi.spyOn(scriptExecutor, "executeSceneIr");
      expect(await Promise.race([service.worldConversion!.commit({ ...intent, targets: [{ ...intent.targets[0]!, nodeVersion: "stale" }] }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stale request executed script")), 2000))])).toMatchObject({ ok: false, code: "version-conflict" });
      expect(execute).not.toHaveBeenCalled();
      execute.mockRestore();
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      const request = http.request({ host: "127.0.0.1", port: address.port, path: "/api/canvases/commit-cancel/world-conversion-commit", method: "POST", headers: { "content-type": "application/json", authorization: "test" } });
      request.on("error", () => {});
      const { canvasId: _canvasId, ...body } = intent;
      request.end(JSON.stringify(body));
      await new Promise(resolve => setTimeout(resolve, 300));
      request.destroy();
      await Promise.race([handled, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("commit did not cancel")), 3000))]);
      await room.settle();
      expect(await yjs.getCommandRecord("commit-cancel", "world-conversion:cancel-op")).toBeNull();
      expect(room.exportCanvas()).toEqual(snapshot);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await service.close();
    }
  });
  it("rolls back failed SQLite writes and returns the frozen receipt after service restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "world-conversion-"));
    const dbPath = path.join(dir, "canvas.sqlite");
    const canvas = createEmptyWoohaa3ServerCanvas("restart");
    canvas.document.nodes.push({ id: "model", type: "model3d", position: { x: 0, y: 0 } });
    canvas.nodeData.model = { modelScript: "scene.box({ id: 'body' });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: "source", contentHash: "content" }, modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } };
    const repository = new InMemoryCanvasRepository();
    await repository.createCanvas(canvas);
    let fail = false;
    let yjs = new SqliteYjsRepository({ path: dbPath, failWrites: () => fail });
    const start = () => createCanvasService({ repository, yjsRepository: yjs, storageConfig: { backend: "sqlite", sqlitePath: dbPath, limits: {} }, mediaClient: { async verify() { return { exists: true, matches: true }; } } });
    let service = await start();
    try {
      const prepared = await service.worldConversion!.prepare({ canvasId: "restart", nodeIds: ["model"] });
      if (!prepared.ok) throw new Error(prepared.message);
      const intent = { canvasId: "restart", operationId: "restart-op", sourceVersion: prepared.sourceVersion, targets: [{ nodeId: "model", nodeVersion: prepared.nodes[0].nodeVersion, instanceId: "instance" }] };
      fail = true;
      expect(await service.worldConversion!.commit(intent)).toMatchObject({ ok: false, code: "storage-failed" });
      expect(await yjs.getCommandRecord("restart", "world-conversion:restart-op")).toBeNull();
      fail = false;
      const first = await service.worldConversion!.commit(intent);
      expect(first.ok).toBe(true);
      await service.close();
      yjs.close();
      yjs = new SqliteYjsRepository({ path: dbPath });
      service = await start();
      const retry = await service.worldConversion!.commit(intent);
      expect(retry).toMatchObject({ ...first, duplicate: true });
      expect(await service.worldConversion!.commit({ ...intent, sourceVersion: "other" })).toMatchObject({ ok: false, code: "request-id-reused" });
      if (!retry.ok) throw new Error(retry.message);
      const room = await service.sync!.registry.resolve("restart");
      const undo = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "restart", commandId: "restart-undo", actorId: "test", baseRevision: retry.revision, commands: [{ type: "edit.apply", ...retry.receipt.inverse }] });
      expect(undo.ok, JSON.stringify(undo)).toBe(true);
      if (!undo.ok) throw new Error(undo.message);
      const redo = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "restart", commandId: "restart-redo", actorId: "test", baseRevision: undo.revision, commands: [{ type: "edit.apply", ...retry.receipt.forward }] });
      expect(redo.ok, JSON.stringify(redo)).toBe(true);
      if (!redo.ok) throw new Error(redo.message);
      const current = room.exportCanvas();
      if (!current.ok) throw new Error(current.message);
      const instance = current.canvas.nodeData.model.sharedWorldInstance as Record<string, unknown>;
      const change = planCanvasEdit(current.canvas, [{ type: "nodeData.patch", nodeId: "model", value: { sharedWorldInstance: { ...instance, instanceId: "changed-instance" } } }]);
      if (!change.ok) throw new Error(change.reason);
      const changed = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "restart", commandId: "change-instance", actorId: "test", baseRevision: redo.revision, commands: [{ type: "edit.apply", ...change.forward }] });
      expect(changed.ok, JSON.stringify(changed)).toBe(true);
      if (!changed.ok) throw new Error(changed.message);
      const beforeConflict = room.exportCanvas();
      const conflict = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "restart", commandId: "conflicting-undo", actorId: "test", baseRevision: changed.revision, commands: [{ type: "edit.apply", ...retry.receipt.inverse }] });
      expect(conflict.ok).toBe(false);
      expect(room.exportCanvas()).toEqual(beforeConflict);
      expect(await yjs.getCommandRecord("restart", "conflicting-undo")).toBeNull();
    } finally {
      await service.close();
      yjs.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("uses a published room and production executor through the service and authenticated HTTP", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("conversion");
    const parent = { id: "parent", type: "text", position: { x: 100, y: 200 } };
    const node = { id: "model", type: "model3d", position: { x: 10, y: 20 }, parentId: "parent", width: 300, height: 200 };
    const data = { modelScript: "scene.box({ id: 'body' });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: "source", contentHash: "content" }, modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } };
    canvas.document.nodes.push(parent, node);
    canvas.nodeData.model = data;
    const repository = new InMemoryCanvasRepository();
    await repository.createCanvas(canvas);
    const stored = await repository.getCanvas("conversion");
    const service = await createCanvasService({ repository, yjsRepository: new InMemoryYjsDocumentRepository(), storageConfig: { backend: "sqlite", sqlitePath: ":memory:", limits: {} }, mediaClient: { async verify() { return { exists: true, matches: true }; } }, accessRuntime: { enabled: true }, authenticate: async req => req.headers.authorization ? { subject: "user", identityProvider: "test" } : null, access: { async authorize() { return { allowed: true }; } } });
    const server = http.createServer((req, res) => { void service.handle(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      const url = `http://127.0.0.1:${address.port}/api/canvases/conversion/world-conversion-prepare`;
      const request = (body: unknown, auth = true) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: "test" } : {}) }, body: JSON.stringify(body) });
      expect((await request({ nodeIds: ["model"] }, false)).status).toBe(401);
      expect((await request({ nodeIds: ["model"], bounds: {} })).status).toBe(400);
      expect((await request({ nodeIds: ["model", "model"] })).status).toBe(400);
      expect((await request({ nodeIds: ["model", "missing"] })).status).toBe(409);
      const response = await request({ nodeIds: ["model"] });
      expect(response.status).toBe(200);
      const result = await response.json() as Awaited<ReturnType<NonNullable<typeof service.worldConversion>["prepare"]>>;
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.sourceVersion).toBe(String(stored!.revision));
      expect(result.nodes[0].bounds).toBeTruthy();
      expect(result.nodes[0].transform).toEqual(legacyModelGroundTransform({ x: 110, y: 220, ...effectiveCanvasNodeSize(node), bounds: result.nodes[0].bounds, placement: data.modelPlacement }));
      expect(await service.worldConversion!.prepare({ canvasId: "conversion", nodeIds: ["model"] })).toEqual(result);
      expect(await repository.getCanvas("conversion")).toEqual(stored);
      const room = await service.sync!.registry.resolve("conversion");
      const before = room.exportCanvas();
      expect(before.ok).toBe(true);
      if (!before.ok) throw new Error(before.message);
      const edit = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "conversion", commandId: "move-parent", actorId: "test", baseRevision: before.canvas.revision, commands: [{ type: "node.update", nodeId: "parent", position: { x: 150, y: 200 } }] });
      expect(edit.ok).toBe(true);
      const after = await service.worldConversion!.prepare({ canvasId: "conversion", nodeIds: ["model"] });
      expect(after.ok).toBe(true);
      if (!after.ok) throw new Error(after.message);
      expect(after.sourceVersion).not.toBe(result.sourceVersion);
      expect(after.nodes[0].nodeVersion).toBe(result.nodes[0].nodeVersion);
      expect(after.nodes[0].transform).not.toEqual(result.nodes[0].transform);
      const moved = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "conversion", commandId: "move-model", actorId: "test", baseRevision: Number(after.sourceVersion), commands: [{ type: "node.update", nodeId: "model", position: { x: 30, y: 20 } }] });
      expect(moved.ok).toBe(true);
      const changed = await service.worldConversion!.prepare({ canvasId: "conversion", nodeIds: ["model"] });
      expect(changed.ok).toBe(true);
      if (!changed.ok) throw new Error(changed.message);
      expect(changed.nodes[0].nodeVersion).not.toBe(after.nodes[0].nodeVersion);
      const commitUrl = url.replace("world-conversion-prepare", "world-conversion-commit");
      const commit = (body: unknown) => fetch(commitUrl, { method: "POST", headers: { "content-type": "application/json", authorization: "test" }, body: JSON.stringify(body) });
      const intent = { operationId: "op", sourceVersion: changed.sourceVersion, targets: [{ nodeId: "model", nodeVersion: changed.nodes[0].nodeVersion, instanceId: "instance" }] };
      expect((await commit({ ...intent, bounds: {} })).status).toBe(400);
      expect((await commit({ ...intent, transform: {} })).status).toBe(400);
      expect((await commit({ ...intent, sourceVersion: "stale" })).status).toBe(409);
      expect((await commit({ ...intent, targets: [{ ...intent.targets[0], nodeVersion: "stale" }] })).status).toBe(409);
      const accepted = await commit(intent);
      const receipt = await accepted.json() as { receipt: unknown; revision: number; message?: string; code?: string };
      expect(accepted.status, JSON.stringify(receipt)).toBe(200);
      expect(receipt.receipt).toBeTruthy();
      const retry = await (await commit(intent)).json() as { duplicate: boolean; receipt: unknown; revision: number };
      expect(retry).toMatchObject({ duplicate: true, receipt: receipt.receipt, revision: receipt.revision });
      expect((await commit({ ...intent, sourceVersion: "different" })).status).toBe(409);
      if (!receipt.receipt || typeof receipt.receipt !== "object") throw new Error("missing receipt");
      const editReceipt = receipt.receipt as { forward: { preconditions: never[]; operations: never[] }; inverse: { preconditions: never[]; operations: never[] } };
      const undo = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "conversion", commandId: "undo-conversion", actorId: "test", baseRevision: receipt.revision, commands: [{ type: "edit.apply", ...editReceipt.inverse }] });
      expect(undo.ok, JSON.stringify(undo)).toBe(true);
      if (!undo.ok) throw new Error(undo.message);
      const redo = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "conversion", commandId: "redo-conversion", actorId: "test", baseRevision: undo.revision, commands: [{ type: "edit.apply", ...editReceipt.forward }] });
      expect(redo.ok, JSON.stringify(redo)).toBe(true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await service.close();
    }
  });

  it("cancels SQLite after asynchronous checksum preparation before the transaction", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "world-cancel-write-"));
    const canvas = createEmptyWoohaa3ServerCanvas("cancel-write");
    canvas.document.nodes.push({ id: "model", type: "model3d", position: { x: 0, y: 0 } });
    canvas.nodeData.model = { modelScript: "scene.box({ id: 'body' });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: "source", contentHash: "content" }, modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } };
    const repository = new InMemoryCanvasRepository();
    await repository.createCanvas(canvas);
    const yjs = new SqliteYjsRepository({ path: path.join(dir, "canvas.sqlite") });
    const service = await createCanvasService({ repository, yjsRepository: yjs, storageConfig: { backend: "sqlite", sqlitePath: ":memory:", limits: {} }, mediaClient: { async verify() { return { exists: true, matches: true }; } } });
    try {
      const prepared = await service.worldConversion!.prepare({ canvasId: "cancel-write", nodeIds: ["model"] });
      if (!prepared.ok) throw new Error(prepared.message);
      const intent = { canvasId: "cancel-write", operationId: "op", sourceVersion: prepared.sourceVersion, targets: [{ nodeId: "model", nodeVersion: prepared.nodes[0]!.nodeVersion, instanceId: "instance" }] };
      const original = yjs.getCommandRecord.bind(yjs);
      let reads = 0;
      let entered!: () => void, release!: () => void;
      const inside = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const spy = vi.spyOn(yjs, "getCommandRecord").mockImplementation(async (...args) => {
        const value = await original(...args);
        if (++reads === 3) { entered(); await gate; }
        return value;
      });
      const room = await service.sync!.registry.resolve("cancel-write");
      const before = room.exportCanvas();
      let finished!: () => void;
      const handled = new Promise<void>(resolve => { finished = resolve; });
      const server = http.createServer((req, res) => { void service.handle(req, res).finally(finished); });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      const request = http.request({ host: "127.0.0.1", port: address.port, path: "/api/canvases/cancel-write/world-conversion-commit", method: "POST", headers: { "content-type": "application/json" } });
      request.on("error", () => {});
      const { canvasId: _canvasId, ...body } = intent;
      request.end(JSON.stringify(body));
      await inside;
      request.destroy();
      await new Promise<void>(resolve => request.once("close", resolve));
      await new Promise(resolve => setTimeout(resolve, 50));
      release();
      await handled;
      await new Promise<void>(resolve => server.close(() => resolve()));
      spy.mockRestore();
      expect(await original("cancel-write", "world-conversion:op")).toBeNull();
      expect(room.exportCanvas()).toEqual(before);
      expect((await service.worldConversion!.commit(intent)).ok).toBe(true);
    } finally { await service.close(); yjs.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("allows a long-running valid script to complete a durable conversion", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("long-script");
    canvas.document.nodes.push({ id: "model", type: "model3d", position: { x: 0, y: 0 } });
    canvas.nodeData.model = { modelScript: "let n = 0; for (let i = 0; i < 100000000; i++) n = (n + i) % 997; scene.box({ id: 'body', size: [1 + n / 1000, 1, 1] });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: "source", contentHash: "content" }, modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } };
    const repository = new InMemoryCanvasRepository();
    await repository.createCanvas(canvas);
    const yjs = new InMemoryYjsDocumentRepository();
    const service = await createCanvasService({ repository, yjsRepository: yjs, storageConfig: { backend: "sqlite", sqlitePath: ":memory:", limits: {} }, mediaClient: { async verify() { return { exists: true, matches: true }; } } });
    try {
      const room = await service.sync!.registry.resolve("long-script");
      const snapshot = room.exportCanvas();
      if (!snapshot.ok) throw new Error(snapshot.message);
      const intent = { canvasId: "long-script", operationId: "long", sourceVersion: String(snapshot.canvas.revision), targets: [{ nodeId: "model", nodeVersion: worldConversionNodeVersion(snapshot.canvas.document.nodes[0], snapshot.canvas.nodeData.model), instanceId: "instance" }] };
      const started = Date.now();
      const result = await service.worldConversion!.commit(intent);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(Date.now() - started).toBeGreaterThan(300);
      expect(await service.worldConversion!.commit(intent)).toMatchObject({ ...result, duplicate: true });
    } finally { await service.close(); }
  }, 30000);

  it("hashes sorted JSON and changes for structural or data edits", () => {
    const node = { id: "n", position: { x: 1, y: 2 } };
    const hash = worldConversionNodeVersion(node, { b: 2, a: 1 });
    expect(worldConversionNodeVersion({ position: { y: 2, x: 1 }, id: "n" }, { a: 1, b: 2 })).toBe(hash);
    expect(worldConversionNodeVersion({ ...node, position: { x: 2, y: 2 } }, { a: 1, b: 2 })).not.toBe(hash);
    expect(worldConversionNodeVersion(node, { a: 2, b: 2 })).not.toBe(hash);
  });

  it("terminates production script execution when the HTTP client disconnects", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("cancel");
    canvas.document.nodes.push({ id: "model", type: "model3d", position: { x: 0, y: 0 } });
    canvas.nodeData.model = { modelScript: "while (true) {}", modelScriptVersion: "woohaa-model-js-v2" };
    const repository = new InMemoryCanvasRepository();
    await repository.createCanvas(canvas);
    const service = await createCanvasService({ repository, yjsRepository: new InMemoryYjsDocumentRepository(), storageConfig: { backend: "sqlite", sqlitePath: ":memory:", limits: {} }, mediaClient: { async verify() { return { exists: true, matches: true }; } } });
    let started!: () => void;
    let finished!: () => void;
    const preparing = new Promise<void>(resolve => { started = resolve; });
    const handled = new Promise<void>(resolve => { finished = resolve; });
    const port = service.worldConversion!;
    const prepare = port.prepare.bind(port);
    port.prepare = async (...args) => { started(); return prepare(...args); };
    const server = http.createServer((req, res) => { void service.handle(req, res).finally(finished); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      const request = http.request({ host: "127.0.0.1", port: address.port, path: "/api/canvases/cancel/world-conversion-prepare", method: "POST", headers: { "content-type": "application/json" } });
      request.on("error", () => {});
      request.end(JSON.stringify({ nodeIds: ["model"] }));
      await preparing;
      await new Promise(resolve => setTimeout(resolve, 200));
      request.destroy();
      await Promise.race([handled, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("disconnected request did not stop")), 3000))]);
      const controller = new AbortController();
      controller.abort();
      expect(await prepare({ canvasId: "cancel", nodeIds: ["model"] }, { signal: controller.signal })).toMatchObject({ ok: false, code: "cancelled" });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await service.close();
    }
  });

  it("rejects the whole selection for missing, empty, unsupported or failing models", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("invalid");
    canvas.document.nodes.push(...["good", "empty", "version", "failure", "geometry", "other"].map(id => ({ id, type: id === "other" ? "text" : "model3d", position: { x: 0, y: 0 } })));
    const good = { modelScript: "scene.box({ id: 'body' });", modelScriptVersion: "woohaa-model-js-v2" };
    canvas.nodeData.good = good;
    canvas.nodeData.empty = { ...good, modelScript: "" };
    canvas.nodeData.version = { ...good, modelScriptVersion: "unknown" };
    canvas.nodeData.failure = { ...good, modelScript: "throw new Error('failure')" };
    canvas.nodeData.geometry = { ...good, modelScript: "const x = 1;" };
    const room = { inspectPublished: async (fn: (snapshot: unknown) => unknown) => fn({ ok: true, canvas }) } as unknown as CanvasRoom;
    const service = createWorldConversionService(async () => room);
    for (const id of ["missing", "empty", "version", "failure", "geometry", "other"]) {
      const result = await service.prepare({ canvasId: "invalid", nodeIds: ["good", id] });
      expect(result).toMatchObject({ ok: false, code: "not-ready" });
      expect(result).not.toHaveProperty("nodes");
    }
  });
});
