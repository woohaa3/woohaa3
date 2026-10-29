import { describe, expect, it } from "vitest";
import { canonicalFilmSetFields, canonicalShotPreviewFields, createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, shotPreviewNodeId } from "@woohaa3/contracts";
import { filmSetManagedMediaMigration } from "../src/state/shared/managed-shot-media-migration.js";
function fixture() {
  const canvas = createEmptyWoohaa3ServerCanvas("legacy-media", "2026-10-26");
  const snapshot = createFilmSetSnapshot({ title: "Source", model: { modelScript: 'scene.box({id:"body"});', modelScriptVersion: "woohaa-model-js-v2" }, motionScript: 'motion.model.rotate("body", {speed:1});', timeline: { duration: 4, loop: false } });
  const id = shotPreviewNodeId("film", "clip-1");
  canvas.document.nodes.push(
    { id: "group", type: "group", position: { x: 20, y: 30 }, width: 1600, height: 1000 },
    { id: "film", type: "composite-asset", parentId: "group", position: { x: 40, y: 50 }, width: 260, height: 195, zIndex: 2 },
    { id, type: "film-set-shot-preview", parentId: "group", position: { x: 560, y: 230 }, width: 320, height: 240, zIndex: 19 },
    { id: "independent", type: "video", position: { x: 1100, y: 100 }, width: 320, height: 240 },
    { id: "target", type: "video", position: { x: 1100, y: 600 }, width: 320, height: 240 }
  );
  canvas.nodeData.film = canonicalFilmSetFields(snapshot) as never;
  canvas.nodeData[id] = { ...canonicalShotPreviewFields({ shotPreview: { schemaVersion: 1, filmSetNodeId: "film", clipId: "clip-1" } }), outputAssetId: "old-immutable", status: "ready" } as never;
  canvas.nodeData.independent = { mediaContent: { providerId: "film-set.shot", schemaVersion: 1, payload: { filmSetNodeId: "film", clipId: "clip-1" } } };
  canvas.nodeData.target = { inputMapping: [{ id: "mapping", sourceNodeId: id, role: "shot_reference" }] } as never;
  canvas.document.edges.push({ id: "reference", source: id, target: "target", sourceHandle: null, targetHandle: null, data: { label: "shot", role: "shot-reference" } });
  return { canvas, id };
}
describe("extension-owned explicit managed media migration", () => {
  it("upgrades in place with exact layout, topology, mapping, caches and independent media; reruns without change", () => {
    const { canvas, id } = fixture(), original = structuredClone(canvas);
    const migrated = filmSetManagedMediaMigration.migrate(canvas);
    expect(migrated.changed).toBe(true);
    expect(canvas).toEqual(original);
    // 旧片场嵌套在普通 group 里时，转换后它是顶层 group（规范文档禁止嵌套 group），受管的
    // 镜头预览必须跟着提升到顶层并烘焙世界坐标，才能继续与 owner 保持同级。
    expect(migrated.canvas.document.nodes.find(n => n.id === id)).toEqual({ ...original.document.nodes.find(n => n.id === id), type: "video", parentId: undefined, position: { x: 580, y: 260 } });
    expect(migrated.canvas.document.edges).toEqual(original.document.edges);
    expect(migrated.canvas.nodeData.target).toEqual(original.nodeData.target);
    expect(migrated.canvas.nodeData.independent).toEqual(original.nodeData.independent);
    expect(migrated.canvas.nodeData[id]).toMatchObject({ outputAssetId: "old-immutable", managedBy: { ownerNodeId: "film", entityId: "clip-1" } });
    expect(migrated.canvas.nodeData[id].shotPreview).toBeUndefined();
    expect(filmSetManagedMediaMigration.migrate(migrated.canvas)).toEqual({ canvas: migrated.canvas, changed: false });
    // JSON key order is not an ownership conflict.
    const ref = migrated.canvas.nodeData[id].managedBy!;
    migrated.canvas.nodeData[id].managedBy = { lifecycle: ref.lifecycle, entityId: ref.entityId, ownerNodeId: ref.ownerNodeId, extensionId: ref.extensionId, schemaVersion: ref.schemaVersion };
    expect(filmSetManagedMediaMigration.migrate(migrated.canvas).changed).toBe(false);
  });
  it.each(["source", "duplicate", "ownership", "foreign-owner", "payload"])("refuses %s conflicts without touching the input", kind => {
    const { canvas, id } = fixture();
    if (kind === "source") canvas.document.nodes = canvas.document.nodes.filter(n => n.id !== "film");
    if (kind === "duplicate") canvas.document.nodes.push({ ...canvas.document.nodes.find(n => n.id === id)!, id: "duplicate" });
    if (kind === "foreign-owner") canvas.nodeData[id].managedBy = { schemaVersion: 1, extensionId: "other.extension", ownerNodeId: "film", entityId: "clip-1", lifecycle: "owner-managed" };
    if (kind === "ownership") canvas.nodeData[id].managedBy = { schemaVersion: 1, extensionId: "film-set", ownerNodeId: "other", entityId: "clip-1", lifecycle: "owner-managed" };
    if (kind === "payload") {
      const migrated = filmSetManagedMediaMigration.migrate(canvas).canvas;
      Object.assign(canvas, migrated);
      canvas.nodeData[id].mediaContent!.payload.clipId = "forged";
    }
    const original = structuredClone(canvas);
    expect(() => filmSetManagedMediaMigration.migrate(canvas)).toThrow("managed-media-migration");
    expect(canvas).toEqual(original);
  });
});
