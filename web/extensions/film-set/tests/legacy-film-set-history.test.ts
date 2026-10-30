import { describe, expect, it } from "vitest";
import {
  animationDefinitionSnapshotHash,
  createModelSnapshot, createMotionSnapshot, defaultInitialShotCamera, decodeFilmSetNodeData,
  hashModelScript, hashMotionScript,
} from "@woohaa3/contracts";
import { convertLegacyFilmSetHistoryEntry, legacyFilmSetHistoryInput } from "../src/authoring/backend/legacy/legacy-film-set-history.js";
import { planLegacyFilmSetItemIdentities } from "../src/authoring/backend/legacy/legacy-film-set-identities.js";

const now = "2026-10-11T00:00:00.000Z";
const options = { title: "片场", topModelItemId: "migrated-model-stable" };
const model = createModelSnapshot({ modelScript: "scene.box({ id: 'body' });", modelScriptVersion: "woohaa-model-js-v2", revision: 7,
  placement: { offset: { x: 1, y: 2, z: 3 }, scale: 2, yaw: 15 } });
const cameraScript = "motion.camera.tween({ id: 'camera', property: 'azimuth', from: 0, to: 1, startTime: 0, endTime: 5 });";
const objectScript = "motion.model.rotate('body', { id: 'turn', speed: 1, startTime: 0, endTime: 5 });";

function history(script = cameraScript): Record<string, unknown> {
  return {
    version: "woohaa-node-generation-history-v1", entryId: "entry-1", canvasId: "c", nodeId: "node-with-no-type-prefix",
    kind: "model", createdAt: now, sourceIdentity: "model-edit:original:original-snapshot", currentIdentity: "animation:old",
    recoverable: true, previewable: true, source: { label: "原始来源", sourceHash: model.contentVersion.sourceHash, runId: "run-1" },
    payload: {
      kind: "model", modelScript: model.modelScript, language: model.modelScriptLanguage,
      version: model.modelScriptVersion, sourceHash: model.contentVersion.sourceHash, placement: model.placement,
      animation: {
        modelContentVersion: model.contentVersion, motionScript: script, motionScriptVersion: "woohaa-motion-js-v1",
        motionRevision: 3, motionSourceHash: hashMotionScript(script), motionBasedOnModelVersion: model.contentVersion,
        initialCamera: defaultInitialShotCamera(), timeline: { duration: 5, loop: false },
      },
    },
  };
}

function converted(entry: unknown) {
  const result = convertLegacyFilmSetHistoryEntry(entry, options);
  if (!result.ok) throw new Error(result.reason);
  return result;
}
const payloadOf = (entry: Record<string, unknown>) => entry.payload as Record<string, unknown>;
const animationOf = (entry: Record<string, unknown>) => payloadOf(entry).animation as Record<string, unknown>;

describe("offline full film-set history conversion", () => {
  it("preserves stable metadata, source, actual model definition and camera-only motion", () => {
    const original = history(); const before = structuredClone(original);
    const result = converted(original);
    for (const key of ["version", "entryId", "canvasId", "nodeId", "kind", "createdAt", "sourceIdentity", "source", "recoverable", "previewable"] as const) {
      expect(result.entry[key]).toEqual(original[key]);
    }
    expect(result.entry.payload).toMatchObject({ kind: "model", modelScript: "", animation: { schemaVersion: 3 } });
    expect(result.entry.payload).not.toHaveProperty("placement");
    if (result.entry.payload.kind !== "model" || result.entry.payload.animation?.schemaVersion !== 3) throw new Error("wrong payload");
    const animation = result.entry.payload.animation;
    expect(animation.filmSetContent.items).toMatchObject([{ id: options.topModelItemId, kind: "model", model }]);
    expect(animation.filmSetAnimations.clips[0]!.cameraMotion.motionScript).toBe(cameraScript);
    expect(animation.filmSetAnimations.clips[0]!.bindings).toEqual([]);
    expect(result.entry.currentIdentity).not.toBe(original.currentIdentity);
    expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(result.entry), "utf8"));
    expect(original).toEqual(before);
    // 离线转换仍产出 schema 3 内容；坐标单位由启动迁移按节点尺寸升级为 schema 4
    // （change: 2026-10-23-isolate-film-set-camera-space）。
    expect(decodeFilmSetNodeData(result.nodeData, { acceptedContentVersions: [3] }).ok).toBe(true);
  });

  it("precollection is pure and supplies only the format-defined old motion language", () => {
    const entry = history(); const before = structuredClone(entry);
    const prepared = legacyFilmSetHistoryInput(entry.payload, "片场");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(prepared.nodeData.motionScriptLanguage).toBe("javascript");
    expect(entry).toEqual(before);
    animationOf(entry).motionScriptVersion = "unknown";
    expect(legacyFilmSetHistoryInput(entry.payload, "片场").ok).toBe(false);
  });

  it("mixed motion moves only model tracks to the mapped item's binding", () => {
    const result = converted(history(`${cameraScript}\n${objectScript}`));
    if (result.entry.payload.kind !== "model" || result.entry.payload.animation?.schemaVersion !== 3) throw new Error("wrong payload");
    const clip = result.entry.payload.animation.filmSetAnimations.clips[0]!;
    expect(clip.cameraMotion.motionScript).toBe(cameraScript);
    expect(clip.bindings).toMatchObject([{ itemId: options.topModelItemId, motion: { motionScript: objectScript } }]);
  });

  it("schema2 histories retain all clips, defaults, items and preset cameras", () => {
    const entry = history(); const payload = payloadOf(entry);
    const motion = createMotionSnapshot({ motionScript: cameraScript, basedOnModelVersion: model.contentVersion });
    payload.animation = {
      schemaVersion: 2, modelContentVersion: model.contentVersion,
      filmSetContent: { schemaVersion: 4, items: [{ id: "ground", kind: "ground", name: "地面", size: { width: 8, depth: 8 }, localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } }] },
      filmSetAnimations: { schemaVersion: 1, defaultClipId: "b", clips: ["a", "b"].map(id => ({ id, name: id,
        motion, timeline: { duration: 5, loop: false }, initialCamera: defaultInitialShotCamera(), bindings: [] })) },
    };
    payload.modelCameras = [{ id: "preset", name: "镜头", order: 0, ...defaultInitialShotCamera() }];
    const result = converted(entry);
    if (result.entry.payload.kind !== "model" || result.entry.payload.animation?.schemaVersion !== 3) throw new Error("wrong payload");
    const next = result.entry.payload.animation;
    expect(next.filmSetContent.items.map(item => item.id)).toEqual(["ground", options.topModelItemId]);
    expect(next.filmSetAnimations.defaultClipId).toBe("b");
    expect(next.filmSetAnimations.clips.map(clip => clip.id)).toEqual(["a", "b"]);
    expect(result.entry.payload.modelCameras).toEqual(payload.modelCameras);
  });

  it("origin and unrecoverable flags are preserved without fabricating a new entry", () => {
    const entry = history(); entry.recoverable = false; entry.previewable = false;
    const origin = { sourceCanvasId: "source-c", sourceNodeId: "source-n", importedModelContentHash: "imported", importedAt: now };
    animationOf(entry).origin = origin;
    const result = converted(entry);
    expect(result.entry).toMatchObject({ entryId: "entry-1", recoverable: false, previewable: false });
    expect(result.entry.payload.kind === "model" && result.entry.payload.animation?.origin).toEqual(origin);
    expect(result.nodeData.origin).toEqual(origin);
  });

  it("camera-only empty-top history does not create a phantom model", () => {
    const entry = history(); const payload = payloadOf(entry);
    payload.modelScript = ""; payload.sourceHash = hashModelScript("");
    animationOf(entry).modelContentVersion = createModelSnapshot({ modelScript: "", modelScriptVersion: "woohaa-model-js-v2", placement: model.placement }).contentVersion;
    const result = converted(entry);
    if (result.entry.payload.kind !== "model" || result.entry.payload.animation?.schemaVersion !== 3) throw new Error("wrong payload");
    expect(result.entry.payload.animation.filmSetContent.items).toEqual([]);
    expect(result.entry.payload.animation.filmSetAnimations.clips[0]!.cameraMotion.motionScript).toBe(cameraScript);
  });

  it("canonical second conversion is a byte/identity no-op", () => {
    const first = converted(history()); const second = converted(first.entry);
    expect(second.changed).toBe(false);
    expect(second.entry).toEqual(first.entry);
    expect(second.bytes).toBe(first.bytes);
  });

  it("hashes the normalized saved payload when legacy object key order differs", () => {
    const entry = history();
    const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)])) : value;
    const first = converted(reverseKeys(entry));
    if (first.entry.payload.kind !== "model" || first.entry.payload.animation?.schemaVersion !== 3) throw new Error("wrong payload");
    const expectedHash = animationDefinitionSnapshotHash(first.entry.payload.animation);
    expect(first.entry.payload.sourceHash).toBe(expectedHash);
    expect(first.entry.currentIdentity).toBe(`animation:${expectedHash}`);
    const second = converted(first.entry);
    expect(second.changed).toBe(false);
    expect(second.entry).toEqual(first.entry);
    expect(second.bytes).toBe(first.bytes);
  });

  it("model motion without actual top geometry blocks instead of making a phantom target", () => {
    const entry = history(objectScript); const payload = payloadOf(entry);
    payload.modelScript = ""; payload.sourceHash = hashModelScript("");
    expect(convertLegacyFilmSetHistoryEntry(entry, options)).toMatchObject({ ok: false });
  });

  it("global precollection includes a deleted owner's historical collision", () => {
    const current = legacyFilmSetHistoryInput(history().payload, "片场");
    const deletedEntry = history(); const deletedAnimation = animationOf(deletedEntry);
    deletedAnimation.filmSetContent = { schemaVersion: 1, items: [{ id: "old-reserved", kind: "ground", name: "地面", size: { width: 8, depth: 8 } }] };
    const deleted = legacyFilmSetHistoryInput(deletedEntry.payload, "旧片场");
    if (!current.ok || !deleted.ok) throw new Error("input failed");
    const plan = planLegacyFilmSetItemIdentities([{ canvasId: "c", nodeId: "current", nodeData: current.nodeData }, { canvasId: "c", nodeId: "deleted", nodeData: deleted.nodeData }]);
    expect(plan).toMatchObject({ ok: true, reservedItemIds: ["old-reserved"] });
    expect(plan.ok && plan.mappings).toHaveLength(2);
  });

  it.each(["payload", "animation", "metadata", "source"])("unknown %s fields block conversion rather than being dropped", scope => {
    const entry = history();
    const record = scope === "payload" ? payloadOf(entry) : scope === "animation" ? animationOf(entry) : scope === "source" ? entry.source as Record<string, unknown> : entry;
    record.future = "not discardable";
    expect(convertLegacyFilmSetHistoryEntry(entry, options).ok).toBe(false);
  });

  it("rejects source hash drift, unsupported schema, invalid flags and origin", () => {
    for (const mutate of [
      (entry: Record<string, unknown>) => { payloadOf(entry).sourceHash = "wrong"; },
      (entry: Record<string, unknown>) => { animationOf(entry).schemaVersion = 99; },
      (entry: Record<string, unknown>) => { entry.recoverable = 1; },
      (entry: Record<string, unknown>) => { animationOf(entry).origin = { sourceNodeId: "lost-metadata" }; },
    ]) { const entry = history(); mutate(entry); expect(convertLegacyFilmSetHistoryEntry(entry, options).ok).toBe(false); }
  });

  it("uses saved placement to derive missing model hashes and preserves mismatched motion adaptation", () => {
    const entry = history(objectScript); delete animationOf(entry).modelContentVersion;
    animationOf(entry).motionBasedOnModelVersion = { revision: 1, contentHash: "original-mismatch" };
    const result = converted(entry);
    if (result.entry.payload.kind !== "model" || result.entry.payload.animation?.schemaVersion !== 3) throw new Error("wrong payload");
    const item = result.entry.payload.animation.filmSetContent.items[0]!;
    expect(item.kind === "model" && item.model.contentVersion.contentHash).toBe(model.contentVersion.contentHash);
    expect(result.entry.payload.animation.filmSetAnimations.clips[0]!.bindings[0]!.motion?.basedOnModelVersion.contentHash).toBe("original-mismatch");
  });
});
