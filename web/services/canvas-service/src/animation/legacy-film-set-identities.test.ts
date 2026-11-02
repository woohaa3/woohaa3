import { describe, expect, it } from "vitest";
import { canonicalFilmSetFields, createModelSnapshot, hashMotionScript } from "@woohaa3/contracts";
import { planLegacyFilmSetItemIdentities } from "../../../../../scripts/lib/legacy-film-set/legacy-film-set-identities.js";
import { readLegacyFilmSetNodeData } from "../../../../../scripts/lib/legacy-film-set/legacy-film-set-reader.js";

const model = createModelSnapshot({ modelScript: "scene.box({ id: 'body' });", modelScriptVersion: "woohaa-model-js-v2" });
const motion = "motion.model.rotate('body', { speed: 1 });";
const ground = (id: string) => ({ id, kind: "ground", name: "Ground", size: { width: 4, depth: 4 } });
function legacy(items: unknown[] = []) {
  return {
    title: "Old scene", modelScript: model.modelScript, modelScriptLanguage: model.modelScriptLanguage,
    modelScriptVersion: model.modelScriptVersion, modelContentVersion: model.contentVersion, modelPlacement: model.placement,
    filmSetContent: { schemaVersion: 1, items },
    motionScript: motion, motionScriptLanguage: "javascript", motionScriptVersion: "woohaa-motion-js-v1",
    motionRevision: 1, motionSourceHash: hashMotionScript(motion), motionBasedOnModelVersion: model.contentVersion,
    timeline: { duration: 5, loop: false }
  };
}
const record = (nodeData: unknown, nodeId = "n", canvasId = "c") => ({ canvasId, nodeId, nodeData });

function converted(input: unknown, topModelItemId: string) {
  const result = readLegacyFilmSetNodeData(input, { topModelItemId });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe("offline global migration item identities", () => {
  it("precollects historical collisions and uses one ID for canonical content and every motion binding", () => {
    const canonical = legacy();
    const history = legacy([ground("model")]);
    const before = JSON.stringify([canonical, history]);
    const plan = planLegacyFilmSetItemIdentities([record(canonical), record(history)]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.mappings).toHaveLength(1);
    const itemId = plan.mappings[0]!.topModelItemId;
    const values = [canonical, history].map(input => converted(input, itemId));
    for (const value of values) {
      expect(value.filmSetContent.items.filter(item => item.kind === "model").map(item => item.id)).toEqual([itemId]);
      expect(value.filmSetAnimations!.clips[0]!.bindings.map(binding => binding.itemId)).toEqual([itemId]);
      const again = readLegacyFilmSetNodeData(canonicalFilmSetFields(value), { topModelItemId: itemId });
      expect(again).toMatchObject({ ok: true, changed: false });
    }
    expect(values[1]!.filmSetContent.items[0]!.id).toBe("model");
    expect(JSON.stringify([canonical, history])).toBe(before);
  });

  it("allocation is input-order independent and reserves IDs from other nodes and all payloads", () => {
    const initial = planLegacyFilmSetItemIdentities([record(legacy())]);
    if (!initial.ok) throw new Error(initial.reason);
    const base = initial.mappings[0]!.topModelItemId;
    const records = [record(legacy()), record(legacy([ground(base), ground(`${base}-2`)]), "other")];
    const forward = planLegacyFilmSetItemIdentities(records);
    const backward = planLegacyFilmSetItemIdentities([...records].reverse());
    expect(forward).toEqual(backward);
    if (!forward.ok) throw new Error(forward.reason);
    expect(forward.mappings.find(mapping => mapping.nodeId === "n")!.topModelItemId).toBe(`${base}-3`);
    expect(new Set(forward.mappings.map(mapping => mapping.topModelItemId)).size).toBe(2);
  });

  it("persisted manifest mappings remain stable after migrated items enter the reservation set", () => {
    const first = planLegacyFilmSetItemIdentities([record(legacy())]);
    if (!first.ok) throw new Error(first.reason);
    const target = canonicalFilmSetFields(converted(legacy(), first.mappings[0]!.topModelItemId));
    const second = planLegacyFilmSetItemIdentities([record(target)], first.mappings);
    expect(second).toMatchObject({ ok: true, mappings: first.mappings });
    expect(readLegacyFilmSetNodeData(target, { topModelItemId: first.mappings[0]!.topModelItemId })).toMatchObject({ ok: true, changed: false });
  });

  it("manifest collision blocks conversion instead of selecting a different historical item ID", () => {
    const result = readLegacyFilmSetNodeData(legacy([ground("reserved")]), { topModelItemId: "reserved" });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("冲突") });
  });

  it("malformed history or duplicated manifest identities block the entire plan", () => {
    expect(planLegacyFilmSetItemIdentities([record(legacy()), record({ filmSetContent: { schemaVersion: 1, items: "broken" } })])).toMatchObject({ ok: false });
    expect(planLegacyFilmSetItemIdentities([record(null)])).toMatchObject({ ok: false });
    expect(planLegacyFilmSetItemIdentities([record(legacy())], [
      { canvasId: "c", nodeId: "n", topModelItemId: "same" },
      { canvasId: "c", nodeId: "other", topModelItemId: "same" }
    ])).toMatchObject({ ok: false });
    expect(readLegacyFilmSetNodeData(legacy(), { topModelItemId: "" })).toMatchObject({ ok: false });
  });

  it("distinct owner tuples cannot alias through separator-containing IDs", () => {
    const plan = planLegacyFilmSetItemIdentities([record(legacy(), "b:c", "a"), record(legacy(), "c", "a:b")]);
    if (!plan.ok) throw new Error(plan.reason);
    expect(new Set(plan.mappings.map(mapping => mapping.topModelItemId)).size).toBe(2);
  });

  it("preallocated IDs never create a phantom item for a camera-only empty scene", () => {
    const input = { filmSetContent: { schemaVersion: 1, items: [] }, motionScript: "motion.camera.tween({ property: 'azimuth', startTime: 0, endTime: 2, from: 0, to: 1 });", motionScriptLanguage: "javascript",
      motionScriptVersion: "woohaa-motion-js-v1", motionRevision: 1, motionSourceHash: hashMotionScript("motion.camera.tween({ property: 'azimuth', startTime: 0, endTime: 2, from: 0, to: 1 });"),
      motionBasedOnModelVersion: { revision: 1, contentHash: "camera" }, timeline: { duration: 2, loop: false } };
    expect(converted(input, "preallocated").filmSetContent.items).toEqual([]);
  });
});
