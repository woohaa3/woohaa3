import { expect, it } from "vitest";
import { canvasResourceStateRequest, CANVAS_RESOURCE_STATE_VERSION } from "./resource-state-update.js";
it("encodes only presentation flags and rejects invalid batches", () => {
  const node = { id: "a", texture: true, mediaLoading: false };
  expect(JSON.parse(canvasResourceStateRequest({baseSceneGeneration: 3, nodes: [node]})))
    .toEqual({version: CANVAS_RESOURCE_STATE_VERSION, baseSceneGeneration: 3, nodes: [node]});
  for (const nodes of [[], [node, node], [{...node, texture: 1}]])
    expect(() => canvasResourceStateRequest({baseSceneGeneration: 3, nodes: nodes as never})).toThrow();
  expect(() => canvasResourceStateRequest({baseSceneGeneration: 0, nodes: [node]})).toThrow();
});
