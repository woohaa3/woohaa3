import http from "node:http";
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, legacyModelGroundTransform, effectiveCanvasNodeSize } from "@woohaa3/contracts";
import { createCanvasService } from "../composition.js";
import { InMemoryCanvasRepository } from "../storage/core/in-memory-repository.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { createWorldConversionService, worldConversionNodeVersion } from "./conversion-service.js";
import type { CanvasRoom } from "../sync/room.js";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";

describe("world conversion preparation", () => {
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
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await service.close();
    }
  });

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
