import { expect, it } from "vitest";
import { applyCanvasCommands, createEmptyWoohaa3ServerCanvas, createFilmSetGroupMarker, createModel3DNodeData, model3DNodeDataFields, prepareFilmSetGroup } from "@woohaa3/contracts";
import { InMemoryNodeHistoryRepository } from "./in-memory-node-history-repository.js";
import { NodeHistoryApplicationService } from "./node-history-service.js";
import type { CanvasRoom } from "../../sync/index.js";

it("schema 4 history restores orchestration and historical keys while preserving current cards and missing-source diagnostics", async () => {
  let canvas = createEmptyWoohaa3ServerCanvas("group-history");
  canvas.document.nodes = [{ id: "film", type: "group", position: { x: 0, y: 0 } }, { id: "model", type: "model3d", parentId: "film", position: { x: 20, y: 20 } }];
  canvas.nodeData.model = model3DNodeDataFields(createModel3DNodeData({ title: "Current card", model: { modelScript: "scene.box({id:'body'});", modelScriptVersion: "woohaa-model-js-v2" } })) as never;
  const marker = createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "actor", sourceNodeId: "model", kind: "model3d", visibility: true, contentKey: "historical-key", transform: { x: 1, y: 0, z: 0, scale: 1, yaw: 0 } }] });
  canvas.nodeData.film = { filmSetGroup: structuredClone(marker) };
  const room = {
    exportCanvas: () => ({ ok: true, canvas }),
    async submit(batch: { commands: Parameters<typeof applyCanvasCommands>[1] }) {
      const result = applyCanvasCommands(canvas, batch.commands);
      if (!result.ok) return { ok: false, status: "rejected", code: result.rejection.code, message: result.rejection.message };
      canvas = { ...result.canvas, revision: canvas.revision + 1 };
      return { ok: true, status: "accepted", revision: canvas.revision, noop: false, update: null };
    }
  } as unknown as CanvasRoom;
  const service = new NodeHistoryApplicationService({ repository: new InMemoryNodeHistoryRepository(), resolveRoom: async () => room });
  const { entryId } = await service.registerModelEdit({ canvasId: canvas.id, nodeId: "film", sourceHash: "unused", modelScript: "", language: "javascript", version: "woohaa-model-js-v2", placement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, animation: { schemaVersion: 4, filmSetGroup: marker }, createdAt: "2026-10-28T00:00:00Z" });
  const detail = await service.getDetail({ canvasId: canvas.id, nodeId: "film", entryId });
  expect(detail.kind === "model" && detail.animation).toEqual({ schemaVersion: 4, filmSetGroup: marker });
  canvas.nodeData.model.modelScript = "scene.sphere({id:'new-body',radius:2});";
  const currentCard = structuredClone(canvas.nodeData.model);
  canvas.nodeData.film.filmSetGroup!.sceneBindings[0]!.transform.x = 9;
  expect((await service.restore({ canvasId: canvas.id, nodeId: "film", entryId })).ok).toBe(true);
  expect(canvas.nodeData.film.filmSetGroup).toEqual(marker);
  expect(canvas.nodeData.model).toEqual(currentCard);
  expect(prepareFilmSetGroup(canvas, "film")!.bindings[0]!.contentKey).not.toBe("historical-key");
  canvas.document.nodes = canvas.document.nodes.filter(node => node.id !== "model");
  delete canvas.nodeData.model;
  canvas.nodeData.film.filmSetGroup!.sceneBindings[0]!.transform.x = 7;
  expect((await service.restore({ canvasId: canvas.id, nodeId: "film", entryId })).ok).toBe(true);
  expect(prepareFilmSetGroup(canvas, "film")!.diagnostics[0]!.code).toBe("missing-source");
  expect(canvas.document.nodes.map(node => node.type)).toEqual(["group"]);
});
