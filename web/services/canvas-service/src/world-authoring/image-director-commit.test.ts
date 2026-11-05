import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, IMAGE_DIRECTOR_SCENE_VERSION, SHARED_WORLD_VERSION } from "@woohaa3/contracts";
import { createCanvasService } from "../composition.js";
import { InMemoryCanvasRepository } from "../storage/core/in-memory-repository.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { commitImageDirectorScene, lookupImageDirectorScene } from "./image-director-commit.js";
import { reserveImageDirectorScene } from "./image-director-reservation.js";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";

describe("image director room commit", () => {
  it("commits all nodes once and refuses a reused command with different intent", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("canvas");
    canvas.document.nodes.push({ id: "image", type: "image", position: { x: 0, y: 0 } });
    const repository = new InMemoryCanvasRepository();
    await repository.createCanvas(canvas);
    const service = await createCanvasService({ repository, yjsRepository: new InMemoryYjsDocumentRepository(), storageConfig: { backend: "sqlite", sqlitePath: ":memory:", limits: {} }, mediaClient: { async verify() { return { exists: true, matches: true }; } } });
    try {
      const room = await service.sync!.registry.resolve("canvas");
      const input = { canvasId: "canvas", operationId: "op", commandId: "command", source: { sourceNodeId: "image", assetId: "asset", contentVersion: "v", checksum: "sum", mimeType: "image/png", width: 4, height: 3 }, candidate: { version: IMAGE_DIRECTOR_SCENE_VERSION, models: [{ key: "subject", name: "Subject", script: "scene.box({ id: 'body', size: [2, 2, 2] });", transform: { version: SHARED_WORLD_VERSION, position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1] as const, scale: 1 } }], camera: { position: { u: 0, v: 2, h: 1 }, rotation: [0, 0, 0, 1] as const, projection: { kind: "perspective" as const, verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 } } }, delta: { u: 0, v: 0 }, bounds: { min: { u: -2, v: -2 }, max: { u: 2, v: 3 } } };
      const before = room.exportCanvas();
      expect(await commitImageDirectorScene(room, input, { authorize: async () => false })).toMatchObject({ ok: false, code: "write-forbidden" });
      expect(await commitImageDirectorScene(room, { ...input, source: { ...input.source, sourceNodeId: "deleted" } }, { authorize: async () => true })).toMatchObject({ ok: false, code: "source-missing" });
      const controller = new AbortController(); controller.abort();
      expect((await commitImageDirectorScene(room, input, { authorize: async () => true, signal: controller.signal })).ok).toBe(false);
      expect(room.exportCanvas()).toEqual(before);
      const reservation = await reserveImageDirectorScene(room, input, async () => true);
      expect(await reserveImageDirectorScene(room, input, async () => true)).toEqual(reservation);
      const reserved = room.exportCanvas();
      if (!reserved.ok) throw new Error(reserved.message);
      expect(reserved.canvas.document.nodes).toHaveLength(2);
      expect(reserved.canvas.nodeData[reservation.nodeId]?.title).toBe("导演区 · 生成中");
      const committedInput = { ...input, reservation };
      const [result, concurrent] = await Promise.all([
        commitImageDirectorScene(room, committedInput, { authorize: async () => true }),
        commitImageDirectorScene(room, { ...input, operationId: "concurrent", commandId: "concurrent" }, { authorize: async () => true })
      ]);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(concurrent).toMatchObject({ ok: false, code: "placement-conflict" });
      expect(await commitImageDirectorScene(room, committedInput, { authorize: async () => true })).toMatchObject({ ok: true, duplicate: true });
      expect(await commitImageDirectorScene(room, committedInput, { authorize: async () => true, signal: controller.signal })).toMatchObject({ ok: true, duplicate: true });
      expect(await commitImageDirectorScene(room, { ...input, operationId: "different" }, { authorize: async () => true })).toMatchObject({ ok: false });
      const after = room.exportCanvas();
      if (!after.ok) throw new Error(after.message);
      expect(after.canvas.document.nodes).toHaveLength(4);
      if (!result.ok) throw new Error(result.message);
      expect(result.receipt.areaNodeId).toBe(reservation.nodeId);
      for (const condition of result.receipt.inverse.preconditions) if (condition.kind === "node-data-equals") expect(after.canvas.nodeData[condition.nodeId]).toEqual(condition.value);
      const undo = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "canvas", commandId: "undo", actorId: "test", baseRevision: after.canvas.revision, commands: [{ type: "edit.apply", ...result.receipt.inverse }] });
      expect(undo.ok, JSON.stringify(undo)).toBe(true);
      expect(await lookupImageDirectorScene(room, "command", async () => true)).toMatchObject({ ok: true, receipt: result.receipt });
      expect(await commitImageDirectorScene(room, committedInput, { authorize: async () => true })).toMatchObject({ ok: true, duplicate: true });
      const undone = room.exportCanvas();
      if (!undone.ok) throw new Error(undone.message);
      expect(undone.canvas.document.nodes).toHaveLength(1);
      const redo = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "canvas", commandId: "redo", actorId: "test", baseRevision: undone.canvas.revision, commands: [{ type: "edit.apply", ...result.receipt.forward }] });
      expect(redo.ok, JSON.stringify(redo)).toBe(true);
      expect(await commitImageDirectorScene(room, { ...input, operationId: "other", commandId: "other" }, { authorize: async () => true })).toMatchObject({ ok: false, code: "placement-conflict" });
      if (!redo.ok) throw new Error(redo.message);
      const removed = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "canvas", commandId: "remove-source", actorId: "test", baseRevision: redo.revision, commands: [{ type: "node.remove", nodeIds: ["image"] }] });
      expect(removed.ok).toBe(true);
      if (!removed.ok) throw new Error(removed.message);
      const independent = room.exportCanvas();
      if (!independent.ok) throw new Error(independent.message);
      expect(independent.canvas.document.nodes).toHaveLength(3);
      const edited = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "canvas", commandId: "edit", actorId: "test", baseRevision: removed.revision, commands: [{ type: "nodeData.patch", nodeId: result.receipt.modelNodeIds[0]!, value: { title: "edited" } }] });
      expect(edited.ok).toBe(true);
      if (!edited.ok) throw new Error(edited.message);
      const conflict = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "canvas", commandId: "undo-conflict", actorId: "test", baseRevision: edited.revision, commands: [{ type: "edit.apply", ...result.receipt.inverse }] });
      expect(conflict.ok).toBe(false);
    } finally { await service.close(); }
  });
});
