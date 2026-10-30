import { describe, expect, it } from "vitest";
import { builtinNodeCapabilityResolver, createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, canonicalFilmSetFields, defaultGroupAppearance, encodeFilmSetPartId } from "@woohaa3/contracts";
import { migrateFilmSetFixture } from "../../../test-support/film-set-groups.js";
import { CompositeAssetRegistry } from "@woohaa3/frontend/extension-api";
import { createFilmSetModelAdapter } from "../src/preview/browser/model-adapter.js";

function fixture() {
  const legacy = createEmptyWoohaa3ServerCanvas("c");
  legacy.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
  legacy.nodeData.film = canonicalFilmSetFields(createFilmSetSnapshot({ title: "片场", timeline: { duration: 0, loop: false }, model: { modelScript: "scene.box({id:'actor-body',size:[1,2,1]});", modelScriptVersion: "woohaa-model-js-v2" }, modelItemId: "actor" })) as never;
  return { legacy, canvas: migrateFilmSetFixture(legacy, "film") };
}
describe("group adapter and canonical preparation", () => {
  it("routes only a real marked group and leaves ordinary groups and old owners unmatched", () => {
    const { legacy, canvas } = fixture();
    const registry = new CompositeAssetRegistry(); const adapter = createFilmSetModelAdapter();
    registry.register(adapter);
    expect(adapter.geometryQuality).toBe("overview-primitives-v1");
    expect(registry.resolve(canvas, "film")).toBe(adapter);
    expect(registry.resolve(legacy, "film")).toBeNull();
    canvas.nodeData.film = {};
    expect(registry.resolve(canvas, "film")).toBeNull();
  });
  it("prepares geometry through the group capability using live cards and ignores ordinary appearance", async () => {
    const { canvas } = fixture();
    const node = canvas.document.nodes.find(node => node.id === "film")!;
    const context = { canvas, node, data: canvas.nodeData.film };
    const preparation = builtinNodeCapabilityResolver.resolve(context).modelPreparation!;
    const before = JSON.stringify(canvas);
    const result = await preparation.prepare(context);
    expect(result.resource?.ops).toContainEqual(expect.objectContaining({ t: "box", id: encodeFilmSetPartId("actor", "actor-body") }));
    expect(result.resource?.ops.some(op => op.id.includes("group-base"))).toBe(false);
    expect(JSON.stringify(canvas)).toBe(before);
    const key = preparation.executionKey(context);
    canvas.nodeData.film.groupAppearance = defaultGroupAppearance();
    expect(preparation.executionKey(context)).toBe(key);
    expect(createFilmSetModelAdapter().prepare("film", canvas.nodeData.film)).toBeNull();
  });
  it("source replacement changes the preparation identity without changing bindings", () => {
    const { canvas } = fixture(); const node = canvas.document.nodes.find(node => node.id === "film")!;
    const context = { canvas, node, data: canvas.nodeData.film };
    const preparation = builtinNodeCapabilityResolver.resolve(context).modelPreparation!;
    const key = preparation.executionKey(context), marker = JSON.stringify(canvas.nodeData.film.filmSetGroup);
    const source = canvas.nodeData.film.filmSetGroup!.sceneBindings[0].sourceNodeId;
    canvas.nodeData[source] = { ...canvas.nodeData[source], modelScript: "scene.sphere({id:'new'});" } as never;
    expect(preparation.executionKey(context)).not.toBe(key);
    expect(JSON.stringify(canvas.nodeData.film.filmSetGroup)).toBe(marker);
  });
});
