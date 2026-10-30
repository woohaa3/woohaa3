import { planCanvasEdit } from "./edit-plan.js";
import { readFilmSetAnimationProjection } from "./film-set-animation-projection.js";
import { readFilmSetContentForSession } from "./film-set-group-projection.js";
import { filmSetClipPrecondition } from "./film-set-clip-ops.js";
import { filmSetAnimationsOf } from "./film-set-clip-view.js";
import { staticShotCameraMotion } from "./film-set-animations.js";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyCanvasCommands } from "./command-reducer.js";
import { createEmptyWoohaa3CanvasDocument } from "./domain/core/document-schema.js";
import type { ServerCanvas } from "./domain/types.js";
import {
  createFilmSetGroupMarker,
  decodeFilmSetGroupMarker,
  ensureFilmSetGroupBadgeScale,
  migrateLegacyFilmSetToGroup,
  prepareFilmSetGroup,
  FilmSetGroupPreparationCache,
  validateFilmSetGroupBindings,
} from "./film-set-group.js";
import { serverCanvasToYDoc, yDocToServerCanvas } from "./yjs/mapping.js";

function canvas(): ServerCanvas {
  return {
    id: "canvas",
    title: "测试",
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    document: createEmptyWoohaa3CanvasDocument(),
    nodeData: {},
    assets: [],
    jobs: [],
  };
}

describe("film-set group contract", () => {
  it("requires an explicit marker and keeps ordinary groups ordinary", () => {
    const marker = createFilmSetGroupMarker({ sceneBindings: [] });
    expect(decodeFilmSetGroupMarker(marker).ok).toBe(true);
    expect(decodeFilmSetGroupMarker({ schemaVersion: 1, sceneBindings: [{ bindingId: "b", sourceNodeId: "s", kind: "model3d", transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 0 }, visibility: true, contentKey: "k" }] }).ok).toBe(false);
  });

  it("updates a binding atomically and rejects forged sources", () => {
    const before = canvas();
    before.document.nodes.push(
      { id: "group", type: "group", position: { x: 0, y: 0 }, width: 600, height: 400 },
      { id: "model", type: "model3d", parentId: "group", position: { x: 20, y: 20 } },
    );
    before.nodeData.group = { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "binding", sourceNodeId: "model", kind: "model3d", transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true, contentKey: "model3d:v1" }] }) };
    before.nodeData.model = { modelScript: "scene.box({ id: 'x', size: [1, 1, 1] });", modelContentVersion: { contentHash: "v1" } };
    const result = applyCanvasCommands(before, [{ type: "filmSetGroup.bindingPatch", groupId: "group", bindingId: "binding", expectedContentKey: "model3d:v1", patch: { transform: { x: 2, y: 0, z: 0, yaw: 0, scale: 1 } } }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.canvas.nodeData.group.filmSetGroup?.sceneBindings[0]?.transform.x).toBe(2);
    const animation = { motion: { motionScript: "", motionScriptLanguage: "javascript" as const, motionScriptVersion: "woohaa-motion-js-v1" as const, revision: 1, sourceHash: "motion-v1", basedOnModelVersion: { revision: 1, contentHash: "v1" } }, playback: { startTime: 0, duration: 2, timeScale: 1, loop: false } };
    const animated = applyCanvasCommands(before, [{ type: "filmSetGroup.bindingPatch", groupId: "group", bindingId: "binding", expectedContentKey: "model3d:v1", patch: { animation } }]);
    expect(animated.ok).toBe(true);
    if (animated.ok) {
      expect(animated.canvas.nodeData.group.filmSetGroup?.sceneBindings[0]?.animation).toEqual(animation);
      expect(animated.canvas.nodeData.model).toEqual(before.nodeData.model);
    }
    const invalidAnimation = applyCanvasCommands(before, [{ type: "filmSetGroup.bindingPatch", groupId: "group", bindingId: "binding", patch: { animation: { ...animation, playback: { ...animation.playback, duration: -1 } } } }]);
    expect(invalidAnimation.ok).toBe(false);
    expect(before.nodeData.group.filmSetGroup?.sceneBindings[0]?.animation).toBeUndefined();
    const forged = applyCanvasCommands(before, [{ type: "nodeData.patch", nodeId: "group", value: { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "bad", sourceNodeId: "outside", kind: "model3d", transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true, contentKey: "k" }] }) } }]);
    expect(forged.ok).toBe(false);
    // 伪造 detached binding：来源真实存在且类型匹配，但从未属于该片场，仍拒绝。
    before.document.nodes.push({ id: "outside", type: "model3d", position: { x: 700, y: 0 } });
    before.nodeData.outside = { modelScript: "scene.box({ id: 'outside' });", modelContentVersion: { contentHash: "v-outside" } };
    const forgedDetached = applyCanvasCommands(before, [{ type: "nodeData.patch", nodeId: "group", value: { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "bad", sourceNodeId: "outside", kind: "model3d", transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true, contentKey: "k", detached: true }] }) } }]);
    expect(forgedDetached.ok).toBe(false);
    if (!forgedDetached.ok) expect(forgedDetached.rejection.message).toContain("来源必须属于片场 group");
  });

  it("soft-detaches an owned binding when its card leaves and restores it when the card returns", () => {
    const value = canvas();
    value.document.nodes.push(
      { id: "group", type: "group", position: { x: 0, y: 0 }, width: 600, height: 400 },
      { id: "model", type: "model3d", parentId: "group", position: { x: 20, y: 20 } },
    );
    const motion = {
      motionScript: "motion.model.rotate('root', { speed: 1 });",
      motionScriptLanguage: "javascript" as const,
      motionScriptVersion: "woohaa-motion-js-v1" as const,
      revision: 1,
      sourceHash: "motion-v1",
      basedOnModelVersion: { revision: 1, contentHash: "model-v1" }
    };
    const playback = { startTime: 0, duration: 2, timeScale: 1, loop: false };
    const marker = createFilmSetGroupMarker({
      sceneBindings: [{ bindingId: "binding", sourceNodeId: "model", kind: "model3d", transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true, contentKey: "model3d:v1", animation: { motion, playback } }],
      clips: [{ id: "shot", name: "镜头", duration: 2, cameraMotion: staticShotCameraMotion(), bindings: [{ itemId: "binding", motion, playback }] }]
    });
    value.nodeData.group = { filmSetGroup: marker };
    value.nodeData.model = { title: "模型", modelScript: "scene.box({ id: 'root' });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: "s1", contentHash: "model-v1" }, modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } };

    // 拖出不带 detached 补丁仍被拒绝。
    expect(applyCanvasCommands(value, [{ type: "node.update", nodeId: "model", parentId: null }]).ok).toBe(false);

    const detachedMarker = createFilmSetGroupMarker({ ...marker, sceneBindings: marker.sceneBindings.map(binding => ({ ...binding, detached: true })) });
    const out = applyCanvasCommands(value, [
      { type: "node.update", nodeId: "model", parentId: null, position: { x: 700, y: 500 } },
      { type: "nodeData.patch", nodeId: "group", value: { filmSetGroup: detachedMarker } }
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.canvas.document.nodes.find(node => node.id === "model")?.parentId).toBeUndefined();
    expect(out.canvas.nodeData.group.filmSetGroup?.sceneBindings[0]?.detached).toBe(true);
    expect(out.canvas.nodeData.group.filmSetGroup?.sceneBindings[0]?.animation?.motion.motionScript).toBe(motion.motionScript);
    // 软摘除后内容、镜头与预览投影都不再包含该对象，但片场保存的动作仍在。
    expect(readFilmSetContentForSession(out.canvas, "group").items).toHaveLength(0);
    expect(readFilmSetAnimationProjection(out.canvas, "group")?.filmSetContent.items).toHaveLength(0);
    expect(out.canvas.nodeData.group.filmSetGroup?.clips?.[0]?.bindings).toHaveLength(1);

    const back = applyCanvasCommands(out.canvas, [
      { type: "node.update", nodeId: "model", parentId: "group", position: { x: 20, y: 20 } },
      { type: "nodeData.patch", nodeId: "group", value: { filmSetGroup: marker } }
    ]);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.canvas.nodeData.group.filmSetGroup?.sceneBindings[0]?.detached).toBeUndefined();
    expect(readFilmSetContentForSession(back.canvas, "group").items).toHaveLength(1);
    const restored = readFilmSetAnimationProjection(back.canvas, "group");
    expect(restored && filmSetAnimationsOf(restored).clips[0]?.bindings?.[0]?.motion?.motionScript).toBe(motion.motionScript);
  });

  it("validates group-owned animation without copying source geometry", () => {
    const animation = { motion: { motionScript: "", motionScriptLanguage: "javascript" as const, motionScriptVersion: "woohaa-motion-js-v1" as const, revision: 1, sourceHash: "motion-v1", basedOnModelVersion: { revision: 1, contentHash: "model-v1" } }, playback: { startTime: 0, duration: 2, timeScale: 1, loop: false } };
    const marker = createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "b", sourceNodeId: "model", kind: "model3d", transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true, contentKey: "model-v1", animation }] });
    const decoded = decodeFilmSetGroupMarker(marker);
    expect(decoded.ok).toBe(true);
    animation.playback.duration = -1;
    expect(marker.sceneBindings[0]?.animation?.playback.duration).toBe(2);
    marker.sceneBindings[0]!.animation!.playback.timeScale = 0;
    expect(decodeFilmSetGroupMarker(marker).ok).toBe(false);
  });

  it("retains a binding and diagnostic after source deletion across later commands", () => {
    const value = canvas();
    value.document.nodes.push({ id: "group", type: "group", position: { x: 0, y: 0 } }, { id: "source", type: "image", parentId: "group", position: { x: 0, y: 0 } });
    value.nodeData.source = { outputAssetId: "image-v1" };
    value.nodeData.group = { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "b", sourceNodeId: "source", kind: "image", transform: { x: 0, y: 0, z: 0, scale: 1, yaw: 0 }, visibility: true, contentKey: "image:image-v1" }] }) };
    const deleted = applyCanvasCommands(value, [{ type: "node.remove", nodeIds: ["source"] }]);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(prepareFilmSetGroup(deleted.canvas, "group")?.diagnostics[0]?.code).toBe("missing-source");
    const later = applyCanvasCommands(deleted.canvas, [{ type: "canvas.setTitle", title: "after deletion" }, { type: "filmSetGroup.bindingPatch", groupId: "group", bindingId: "b", patch: { visibility: false } }]);
    expect(later.ok).toBe(true);
    if (later.ok) expect(later.canvas.nodeData.group.filmSetGroup?.sceneBindings[0]?.sourceNodeId).toBe("source");
  });

  it("rejects legacy composite creation and content writes without deriving object containers", () => {
    const value = canvas();
    const legacy = { extensionId: "film-set", filmSetContent: { schemaVersion: 4, items: [] } };
    expect(applyCanvasCommands(value, [{ type: "node.add", node: { id: "film", type: "composite-asset", position: { x: 0, y: 0 } }, nodeData: legacy }]).ok).toBe(false);
    value.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
    value.nodeData.film = legacy;
    const before = JSON.stringify(value);
    expect(applyCanvasCommands(value, [{ type: "nodeData.patch", nodeId: "film", value: { title: "changed" } }]).ok).toBe(false);
    expect(applyCanvasCommands(value, [{ type: "filmSet.itemPatch", nodeId: "film", itemId: "actor", op: { kind: "delete" } }]).ok).toBe(false);
    const metadata = applyCanvasCommands(value, [{ type: "canvas.setTitle", title: "Canvas title" }]);
    expect(metadata.ok).toBe(true);
    if (metadata.ok) expect(metadata.canvas.document.nodes).toHaveLength(1);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("preserves source cards when deleting or explicitly ungrouping", () => {
    const before = canvas();
    before.document.nodes.push(
      { id: "group", type: "group", position: { x: 100, y: 50 }, width: 600, height: 400 },
      { id: "model", type: "model3d", parentId: "group", position: { x: 20, y: 30 } },
    );
    before.nodeData.group = { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "binding", sourceNodeId: "model", kind: "model3d", transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true, contentKey: "model3d:v1" }] }) };
    const deleted = applyCanvasCommands(before, [{ type: "node.remove", nodeIds: ["group"] }]);
    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      expect(deleted.canvas.document.nodes.some(node => node.id === "group")).toBe(false);
      expect(deleted.canvas.document.nodes.find(node => node.id === "model")?.parentId).toBeUndefined();
    }
    const ungrouped = applyCanvasCommands(before, [{ type: "filmSetGroup.ungroup", groupId: "group" }]);
    expect(ungrouped.ok).toBe(true);
    if (ungrouped.ok) expect(ungrouped.canvas.document.nodes.find(node => node.id === "model")?.parentId).toBeUndefined();
  });

  it("prepares new source versions without dropping unavailable bindings", () => {
    const value = canvas();
    value.document.nodes.push({ id: "group", type: "group", position: { x: 0, y: 0 } }, { id: "image", type: "image", parentId: "group", position: { x: 0, y: 0 } });
    value.nodeData.group = { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "b", sourceNodeId: "image", kind: "image", transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true, contentKey: "old" }] }) };
    expect(prepareFilmSetGroup(value, "group")?.diagnostics[0]?.code).toBe("content-unavailable");
    value.nodeData.image = { outputAssetId: "asset-new" };
    value.assets.push({ id: "asset-new", mediaKind: "image", status: "ready" } as never);
    expect(prepareFilmSetGroup(value, "group")?.bindings[0]?.contentKey).toMatch(/^image:asset-new:/);
  });

  it("preserves independent clip motion, playback, loop and backdrop through migration and Yjs", () => {
    const value = canvas();
    value.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
    const motion = staticShotCameraMotion();
    const playback = { startTime: 1, duration: 2, timeScale: 0.5, loop: true };
    value.nodeData.film = { extensionId: "film-set", filmSetContent: { schemaVersion: 4, items: [{ id: "item", kind: "image", name: "海报", assetId: "asset-1", aspectRatio: 1, localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } }] }, filmSetAnimations: { schemaVersion: 3, defaultClipId: "shot", clips: [{ id: "shot", name: "镜头", kind: "dynamic", timeline: { duration: 4, loop: true }, initialCamera: { azimuth: 1, elevation: 0.4, distance: 5, focusOffset: { x: 1, y: 2, z: 3 }, aspect: "1:1" }, cameraMotion: motion, bindings: [{ itemId: "item", motion, playback }], backdrop: "#123456" }] } };
    const before = JSON.stringify(value);
    const migrated = migrateLegacyFilmSetToGroup(value, "film", { commandId: "migration", groupId: "group" });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    const doc = serverCanvasToYDoc(migrated.canvas);
    const restored = yDocToServerCanvas(doc);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.canvas.nodeData.group?.filmSetGroup).toMatchObject({ clips: [{ id: "shot", duration: 4, loop: true, backdrop: "#123456", cameraMotion: motion, bindings: [{ itemId: "item", motion, playback }] }] });
    expect(JSON.stringify(value)).toBe(before);
    doc.destroy();
  });

  it("writes camera and clip edits only to the group marker", () => {
    const value = canvas();
    value.document.nodes.push({ id: "film", type: "group", position: { x: 0, y: 0 } });
    value.nodeData.film = { filmSetGroup: createFilmSetGroupMarker({ activeClip: "shot", clips: [{ id: "shot", name: "原名", duration: 0 }], sceneBindings: [] }) };
    const renamed = applyCanvasCommands(value, [{ type: "filmSet.clipPatch", nodeId: "film", clipId: "shot", expectedHash: filmSetClipPrecondition(filmSetAnimationsOf(readFilmSetAnimationProjection(value, "film")!), "shot", { kind: "rename", name: "新名" }), op: { kind: "rename", name: "新名" } }]);
    expect(renamed, JSON.stringify(renamed)).toMatchObject({ ok: true });
    if (!renamed.ok) return;
    expect(renamed.canvas.nodeData.film.filmSetGroup?.clips?.[0]?.name).toBe("新名");
    expect(renamed.canvas.nodeData.film.filmSetAnimations).toBeUndefined();
    expect(renamed.canvas.nodeData.film.filmSetContent).toBeUndefined();
    expect(value.nodeData.film.filmSetGroup?.clips?.[0]?.name).toBe("原名");
    const changed = applyCanvasCommands(renamed.canvas, [{ type: "filmSet.clipPatch", nodeId: "film", clipId: "shot", expectedHash: filmSetClipPrecondition(filmSetAnimationsOf(readFilmSetAnimationProjection(renamed.canvas, "film")!), "shot", { kind: "camera", initialCamera: { azimuth: 1, elevation: 0.3, distance: 8, aspect: "1:1", focusOffset: { x: 2, y: 0, z: 0 } } }), op: { kind: "camera", initialCamera: { azimuth: 1, elevation: 0.3, distance: 8, aspect: "1:1", focusOffset: { x: 2, y: 0, z: 0 } } } }]);
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.canvas.nodeData.film.filmSetGroup?.cameras?.[0]).toMatchObject({ azimuth: 1, distance: 8, aspect: "1:1" });
  });

  it("records binding transforms with protected undo and rejects stale undo atomically", () => {
    const value = canvas();
    value.document.nodes.push({ id: "film", type: "group", position: { x: 0, y: 0 } }, { id: "source", type: "image", parentId: "film", position: { x: 0, y: 0 } });
    value.nodeData.source = { outputAssetId: "asset" };
    value.nodeData.film = { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "actor", sourceNodeId: "source", kind: "image", contentKey: "image:asset", visibility: true, transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 } }] }) };
    const plan = planCanvasEdit(value, [{ type: "filmSetGroup.bindingPatch", groupId: "film", bindingId: "actor", patch: { transform: { x: 3, y: 2, z: 1, yaw: 0.4, scale: 2 } } }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const moved = applyCanvasCommands(value, [{ type: "edit.apply", ...plan.forward }]);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.canvas.nodeData.film.filmSetGroup?.sceneBindings[0]?.transform.x).toBe(3);
    const undo = applyCanvasCommands(moved.canvas, [{ type: "edit.apply", ...plan.inverse }]);
    expect(undo.ok).toBe(true);
    if (undo.ok) expect(undo.canvas.nodeData.film.filmSetGroup).toEqual(value.nodeData.film.filmSetGroup);
    const stale = structuredClone(moved.canvas);
    stale.nodeData.film.filmSetGroup!.sceneBindings[0]!.transform.x = 7;
    const before = JSON.stringify(stale);
    expect(applyCanvasCommands(stale, [{ type: "edit.apply", ...plan.inverse }]).ok).toBe(false);
    expect(JSON.stringify(stale)).toBe(before);
    expect(moved.canvas.nodeData.source).toEqual(value.nodeData.source);
  });

  it("migrates old snapshots into a group and is idempotent", () => {
    const value = canvas();
    value.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 10, y: 20 }, width: 400, height: 300 });
    value.nodeData.film = { extensionId: "film-set", filmSetContent: { schemaVersion: 4, items: [{ id: "item", kind: "image", name: "海报", assetId: "asset-1", aspectRatio: 1, localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } }] } };
    const migrated = migrateLegacyFilmSetToGroup(value, "film", { commandId: "migrate-1", groupId: "film-group" });
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      expect(migrated.canvas.document.nodes.some(node => node.id === "film-group" && node.type === "group")).toBe(true);
      expect(migrated.canvas.document.nodes.some(node => node.type === "composite-asset")).toBe(false);
      // 场景改在 3D 徽标里显示：迁移给出可见的默认倍率，否则片场看起来会突然很小。
      expect(migrated.canvas.nodeData["film-group"]?.groupBadgeScale).toBe(3);
      const again = migrateLegacyFilmSetToGroup(migrated.canvas, "film-group", { commandId: "migrate-1", groupId: "film-group" });
      expect(again.ok && again.duplicate).toBe(true);
    }
  });

  it("backfills the default badge scale once and keeps explicit values", () => {
    const before = canvas();
    before.document.nodes.push(
      { id: "group", type: "group", position: { x: 0, y: 0 }, width: 600, height: 400 },
      { id: "scaled", type: "group", position: { x: 0, y: 500 }, width: 600, height: 400 },
      { id: "ordinary", type: "group", position: { x: 0, y: 1000 }, width: 600, height: 400 },
    );
    before.nodeData.group = { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [] }) };
    before.nodeData.scaled = { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [] }), groupBadgeScale: 8 };
    const first = ensureFilmSetGroupBadgeScale(before);
    expect(first.changed).toBe(true);
    expect(first.canvas.nodeData.group?.groupBadgeScale).toBe(3);
    expect(first.canvas.nodeData.scaled?.groupBadgeScale).toBe(8);
    expect(first.canvas.nodeData.ordinary?.groupBadgeScale).toBeUndefined();
    expect(ensureFilmSetGroupBadgeScale(first.canvas).changed).toBe(false);
  });

  it("hoists a nested legacy film set to the top level so the migrated canvas round-trips", () => {
    const value = canvas();
    value.document.nodes.push(
      { id: "outer", type: "group", position: { x: 500, y: 300 }, width: 900, height: 600 },
      { id: "film", type: "composite-asset", parentId: "outer", position: { x: 40, y: 60 }, width: 400, height: 300 }
    );
    value.nodeData.film = { extensionId: "film-set", filmSetContent: { schemaVersion: 4, items: [{ id: "item", kind: "image", name: "海报", assetId: "asset-1", aspectRatio: 1, localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } }] } };
    const migrated = migrateLegacyFilmSetToGroup(value, "film", { commandId: "nested", groupId: "film" });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    const group = migrated.canvas.document.nodes.find(node => node.id === "film");
    // 嵌套 group 不是规范形态：转换结果必须是顶层 group，并已烘焙世界坐标。
    expect(group).toMatchObject({ type: "group", position: { x: 540, y: 360 } });
    expect(group?.parentId).toBeUndefined();
    // 规范化过程（Y.Doc 往返）不得再改写迁移结果，否则启动迁移的自检会拒绝开放画布。
    const doc = serverCanvasToYDoc(migrated.canvas);
    const restored = yDocToServerCanvas(doc, { now: value.updatedAt });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      const restoredNodes = new Map(restored.canvas.document.nodes.map(node => [node.id, node]));
      expect([...restoredNodes.keys()].sort()).toEqual(migrated.canvas.document.nodes.map(node => node.id).sort());
      for (const node of migrated.canvas.document.nodes) expect(restoredNodes.get(node.id)).toEqual(node);
      expect(restored.canvas.nodeData).toEqual(migrated.canvas.nodeData);
    }
    doc.destroy();
  });

  it("copies a source card owned by another container instead of stealing its membership", () => {
    const value = canvas();
    const modelData = { modelScript: "scene.box({ id: 'body', size: [1, 1, 1] });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: "s1", contentHash: "c1" } };
    value.document.nodes.push(
      { id: "other", type: "group", position: { x: 0, y: 0 }, width: 600, height: 400 },
      { id: "shared", type: "model3d", parentId: "other", position: { x: 20, y: 20 }, width: 180, height: 64 },
      { id: "film", type: "composite-asset", position: { x: 900, y: 0 }, width: 400, height: 300 }
    );
    value.nodeData.shared = { ...modelData };
    value.nodeData.film = {
      extensionId: "film-set",
      filmSetContent: {
        schemaVersion: 4,
        items: [{ id: "item", kind: "model", name: "房", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, model: { ...modelData, contentVersion: { contentHash: "v1" } }, origin: { sourceNodeId: "shared", kind: "model" } }]
      }
    };
    const migrated = migrateLegacyFilmSetToGroup(value, "film", { commandId: "shared", groupId: "film" });
    expect(migrated.ok, migrated.ok ? "" : migrated.reason).toBe(true);
    if (!migrated.ok) return;
    // 别的 group 保留自己的成员，片场改用内容相同的新卡片。
    expect(migrated.canvas.document.nodes.find(node => node.id === "shared")?.parentId).toBe("other");
    const marker = migrated.canvas.nodeData.film?.filmSetGroup;
    const binding = marker?.sceneBindings[0];
    expect(binding?.sourceNodeId).not.toBe("shared");
    expect(migrated.createdNodeIds).toContain(binding?.sourceNodeId);
    expect(migrated.canvas.document.nodes.find(node => node.id === binding?.sourceNodeId)?.parentId).toBe("film");
    expect(migrated.diagnostics.some(diagnostic => diagnostic.code === "shared-source")).toBe(true);
    expect(migrated.canvas.nodeData[binding!.sourceNodeId]?.modelScript).toBe(modelData.modelScript);
    expect(validateFilmSetGroupBindings(migrated.canvas, "film", marker!)).toBeNull();
  });

  it("reuses a card left by an interrupted migration instead of failing the boot", () => {
    const value = canvas();
    const modelData = { modelScript: "scene.box({ id: 'body', size: [1, 1, 1] });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: "s1", contentHash: "c1" } };
    value.document.nodes.push(
      { id: "other", type: "group", position: { x: 0, y: 0 }, width: 600, height: 400 },
      { id: "shared", type: "model3d", parentId: "other", position: { x: 20, y: 20 }, width: 180, height: 64 },
      { id: "film", type: "composite-asset", position: { x: 900, y: 0 }, width: 400, height: 300 },
      // 上一次迁移已经建好这张副本，但标记没落盘就中断了（进程被杀/崩溃）。
      { id: "film-model3d-1", type: "model3d", parentId: "film", position: { x: 900, y: 0 }, width: 180, height: 64 }
    );
    value.nodeData.shared = { ...modelData };
    value.nodeData["film-model3d-1"] = { ...modelData };
    value.nodeData.film = {
      extensionId: "film-set",
      filmSetContent: {
        schemaVersion: 4,
        items: [{ id: "item", kind: "model", name: "房", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, model: { ...modelData, contentVersion: { contentHash: "v1" } }, origin: { sourceNodeId: "shared", kind: "model" } }]
      }
    };

    // 关键：不再以「资源卡片 ID 冲突」失败——否则宿主每次启动都会拒绝开画布。
    const migrated = migrateLegacyFilmSetToGroup(value, "film", { commandId: "retry", groupId: "film" });
    expect(migrated.ok, migrated.ok ? "" : migrated.reason).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.createdNodeIds).toEqual([]);
    const binding = migrated.canvas.nodeData.film?.filmSetGroup?.sceneBindings[0];
    expect(binding?.sourceNodeId).toBe("film-model3d-1");
    expect(migrated.diagnostics.some(diagnostic => diagnostic.code === "reused-existing-card")).toBe(true);
    expect(validateFilmSetGroupBindings(migrated.canvas, "film", migrated.canvas.nodeData.film!.filmSetGroup!)).toBeNull();
  });

  it("does not mutate preview/media owners when migration validation fails", () => {
    const value = canvas();
    value.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
    value.nodeData.film = { filmSetContent: { schemaVersion: 4, items: [{ id: "item", kind: "model", model: { modelScript: "" }, localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } }] } } as never;
    value.nodeData.preview = { managedBy: { schemaVersion: 1, extensionId: "film-set", ownerNodeId: "film", entityId: "clip", lifecycle: "owner-managed" } };
    const before = JSON.stringify(value.nodeData.preview);
    const result = migrateLegacyFilmSetToGroup(value, "film", { commandId: "rollback", groupId: "film" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(value.nodeData.preview)).toBe(before);
  });

  it("returns a diagnostic and leaves the source untouched on id collision", () => {
    const value = canvas();
    value.document.nodes.push(
      { id: "film", type: "composite-asset", position: { x: 0, y: 0 } },
      { id: "target", type: "text", position: { x: 0, y: 0 } },
    );
    value.nodeData.film = { filmSetContent: { schemaVersion: 4, items: [] } };
    const before = JSON.stringify(value);
    const result = migrateLegacyFilmSetToGroup(value, "film", { commandId: "collision", groupId: "target" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("group ID 冲突");
    expect(JSON.stringify(value)).toBe(before);
  });

  it("rewrites managed preview and media owners during migration", () => {
    const value = canvas();
    value.document.nodes.push(
      { id: "film", type: "composite-asset", position: { x: 0, y: 0 } },
      { id: "preview", type: "image", position: { x: 20, y: 20 } }
    );
    value.nodeData.film = { filmSetContent: { schemaVersion: 4, items: [], } };
    value.nodeData.preview = {
      managedBy: { schemaVersion: 1, extensionId: "film-set", ownerNodeId: "film", entityId: "clip", lifecycle: "owner-managed" },
      mediaContent: { providerId: "film-set.shot", schemaVersion: 1, payload: { filmSetNodeId: "film", clipId: "clip" } }
    };
    const migrated = migrateLegacyFilmSetToGroup(value, "film", { commandId: "migrate-owner", groupId: "group" });
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      expect(migrated.canvas.nodeData.preview?.managedBy?.ownerNodeId).toBe("group");
      expect((migrated.canvas.nodeData.preview?.mediaContent?.payload as { filmSetNodeId?: string }).filmSetNodeId).toBe("group");
    }
  });

  it("does not allow stale async preparations to win", async () => {
    const cache = new FilmSetGroupPreparationCache<string>();
    let resolveOld!: (value: string) => void;
    const old = cache.prepare("g", "b", "old", () => new Promise(resolve => { resolveOld = resolve; }));
    await Promise.resolve();
    const next = cache.prepare("g", "b", "new", async () => "new-value");
    resolveOld("old-value");
    await expect(next).resolves.toBe("new-value");
    await expect(old).rejects.toThrow("stale-film-set-group-preparation");
  });

  it("roundtrips marker and bindings through Yjs and preserves history snapshots", () => {
    const value = canvas();
    value.document.nodes.push(
      { id: "group", type: "group", position: { x: 0, y: 0 } },
      { id: "model", type: "model3d", parentId: "group", position: { x: 0, y: 0 } }
    );
    value.nodeData.group = { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "b", sourceNodeId: "model", kind: "model3d", transform: { x: 1, y: 2, z: 3, yaw: 0.1, scale: 1 }, visibility: true, contentKey: "model3d:v1" }] }) };
    value.nodeData.model = { modelScript: "scene.box({ id: 'body', size: [1, 1, 1] });", modelContentVersion: { contentHash: "v1" } };
    const doc = serverCanvasToYDoc(value, new Y.Doc());
    const restored = yDocToServerCanvas(doc, { now: value.updatedAt });
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.canvas.nodeData.group?.filmSetGroup?.sceneBindings[0]?.contentKey).toBe("model3d:v1");
    const edited = applyCanvasCommands(value, [{ type: "filmSetGroup.bindingPatch", groupId: "group", bindingId: "b", patch: { visibility: false } }]);
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      const history = serverCanvasToYDoc(edited.canvas);
      const historical = yDocToServerCanvas(history, { now: value.updatedAt });
      expect(historical.ok && historical.canvas.nodeData.group?.filmSetGroup?.sceneBindings[0]?.visibility).toBe(false);
      expect(value.nodeData.group?.filmSetGroup?.sceneBindings[0]?.visibility).toBe(true);
    }
  });
});
