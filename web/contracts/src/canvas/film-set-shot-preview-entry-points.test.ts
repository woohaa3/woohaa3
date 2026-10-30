import { migrateFilmSetFixture } from "../../../test-support/film-set-groups.js";
import { readFilmSetAnimationProjection } from "./film-set-animation-projection.js";
import { createFilmSetGroupMarker } from "./film-set-group.js";
import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
/**
 * 拍摄镜头预览闭包的**全部权威写入口**回归测试
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 2.6）。
 *
 * 覆盖：完整历史恢复（同 clipId 保留布局、重现镜头建立布局、消失镜头清理）、转换占位成功写回、
 * 片场粘贴/导入批次（新 clipId 建立独立预览）。这些入口都只写片场 nodeData，预览闭包由共享
 * reducer 在同一批次内维护，不依赖前端 effect 或扩展启动后补节点。
 */
import { describe, expect, it } from "vitest";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";

import { createFilmSetSnapshot } from "./animation-snapshot.js";
import { canonicalFilmSetFields } from "./film-set-clip-view.js";
import { filmSetClipPrecondition, type FilmSetClipPatchOp } from "./film-set-clip-ops.js";
import { filmSetClipPatchCommand } from "./film-set-content.js";
import { decodeFilmSetNodeData, type FilmSetNodeData } from "./canvas-node-model.js";
import { staticShotCameraMotion, type FilmSetAnimationClip } from "./film-set-animations.js";
import { FILM_SET_SHOT_PREVIEW_NODE_TYPE, shotPreviewNodeId } from "./film-set-shot-preview.js";
import { managedNodeRelationOf } from "./managed-node.js";

const NOW = "2026-10-15T00:00:00.000Z";
const CLIP_1 = "clip-1";
const CLIP_2 = "clip-2";
const PREVIEW_1 = shotPreviewNodeId("film", CLIP_1);
const PREVIEW_2 = shotPreviewNodeId("film", CLIP_2);

function apply(canvas: ServerCanvas, commands: unknown[]): ServerCanvas {
  const result = applyCanvasCommands(canvas, commands as never, { now: NOW });
  if (!result.ok) throw new Error(`期望成功，实际 ${result.rejection.code}: ${result.rejection.message}`);
  return result.canvas;
}

function reject(canvas: ServerCanvas, commands: unknown[]) {
  return applyCanvasCommands(canvas, commands as never, { now: NOW });
}

function animation(canvas: ServerCanvas): FilmSetNodeData {
  const decoded = decodeFilmSetNodeData(canonicalFilmSetFields(readFilmSetAnimationProjection(canvas, "film")!));
  if (!decoded.ok) throw new Error(decoded.reason);
  return decoded.value;
}

function preview(canvas: ServerCanvas, nodeId: string) {
  return canvas.document.nodes.find((node) => node.id === nodeId && managedNodeRelationOf(canvas.nodeData[node.id])?.extensionId === "film-set");
}

function staticClip(id: string, name: string): FilmSetAnimationClip {
  return {
    id,
    name,
    kind: "static",
    timeline: { duration: 0, loop: false },
    initialCamera: { azimuth: 0, elevation: 0.3, distance: 6, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } },
    cameraMotion: staticShotCameraMotion(),
    bindings: []
  };
}

function clipPatch(canvas: ServerCanvas, op: FilmSetClipPatchOp, clipId = CLIP_1) {
  const decoded = decodeFilmSetNodeData(canonicalFilmSetFields(readFilmSetAnimationProjection(canvas, "film")!));
  if (!decoded.ok) throw new Error(decoded.reason);
  return filmSetClipPatchCommand({
    nodeId: "film",
    clipId,
    expectedHash: filmSetClipPrecondition(decoded.value.filmSetAnimations!, clipId, op),
    op
  });
}

function withFilmSet(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  canvas.document.nodes.push({ id: "film", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 100, y: 50 }, width: 320, height: 240 });
  const animation = createFilmSetSnapshot({
    title: "片场",
    model: { modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: `motion.model.rotate("body", { speed: 1 });`,
    timeline: { duration: 5, loop: false }
  });
  canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
  return apply(migrateFilmSetFixture(canvas, "film"), []);
}

describe("完整历史恢复（任务 2.6）", () => {
  it("同 clipId 保留当前布局，重现镜头建立布局，消失镜头清理预览", () => {
    const base = withFilmSet();
    const twoClips = apply(base, [clipPatch(base, { kind: "create", clip: staticClip(CLIP_2, "第二镜头") }, CLIP_2)]);
    // 用户自定义预览 1 的布局。
    const custom = apply(twoClips, [{ type: "node.update", nodeId: PREVIEW_1, position: { x: 900, y: 640 }, width: 300, height: 220 }]);
    const customLayout = preview(custom, PREVIEW_1)!;

    // 历史版本：clip-1 改名，clip-2 仍存在。
    const history = structuredClone(custom.nodeData.film.filmSetGroup!);
    history.clips!.find(clip => clip.id === CLIP_1)!.name = "历史名称";
    const restoreValue = { filmSetGroup: history };

    // 后来删除了 clip-2。
    const deleted = apply(custom, [clipPatch(custom, { kind: "delete" }, CLIP_2)]);
    expect(preview(deleted, PREVIEW_2)).toBeUndefined();

    // 恢复历史版本：同 clipId 保留布局，重现的 clip-2 建立独立预览。
    const restored = apply(deleted, [{ type: "nodeData.patch", nodeId: "film", value: restoreValue }]);
    expect(animation(restored).filmSetAnimations!.clips.find((clip) => clip.id === CLIP_1)!.name).toBe("历史名称");
    const kept = preview(restored, PREVIEW_1)!;
    expect(kept.position).toEqual(customLayout.position);
    expect(kept.width).toBe(customLayout.width);
    expect(kept.height).toBe(customLayout.height);
    const revived = preview(restored, PREVIEW_2);
    expect(revived).toBeDefined();
    expect(revived!.id).toBe(PREVIEW_2);
  });

  it("恢复旧版本时消失镜头的预览连同归属数据一同清理", () => {
    const base = withFilmSet();
    const twoClips = apply(base, [clipPatch(base, { kind: "create", clip: staticClip(CLIP_2, "第二镜头") }, CLIP_2)]);
    const restoreValue = { filmSetGroup: structuredClone(base.nodeData.film.filmSetGroup!) };
    const restored = apply(twoClips, [{ type: "nodeData.patch", nodeId: "film", value: restoreValue }]);
    expect(preview(restored, PREVIEW_2)).toBeUndefined();
    expect(restored.nodeData[PREVIEW_2]).toBeUndefined();
    expect(preview(restored, PREVIEW_1)).toBeDefined();
  });
});

describe("转换占位成功写回（任务 2.6）", () => {
  it("占位片场无镜头无预览；成功写回完整定义后同批建立预览闭包", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
    const placeholder = { title: "转换中", filmSetGroup: createFilmSetGroupMarker() };
    const created = apply(canvas, [{
      type: "node.add",
      node: { id: "film", type: "group", position: { x: 0, y: 0 }, width: 320, height: 240 },
      nodeData: placeholder
    }]);
    expect(created.document.nodes.filter((node) => managedNodeRelationOf(created.nodeData[node.id])?.extensionId === "film-set")).toHaveLength(0);

    // 成功写回完整片场定义（含两个镜头）。
    const full = createFilmSetSnapshot({
      title: "转换完成",
      model: { modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" },
      motionScript: `motion.model.rotate("body", { speed: 1 });`,
      timeline: { duration: 4, loop: false }
    });
    const collection = full.filmSetAnimations!;
    collection.clips.push({ ...structuredClone(collection.clips[0]!), id: CLIP_2, name: "第二镜头" });
    const converted = migratedDefinition(full);
    const patched = apply(created, [
      ...converted.document.nodes.filter(node => node.id !== "film").map(node => ({ type: "node.add", node, nodeData: converted.nodeData[node.id] })),
      { type: "nodeData.patch", nodeId: "film", value: { filmSetGroup: converted.nodeData.film.filmSetGroup } }
    ]);
    expect(preview(patched, PREVIEW_1)).toBeDefined();
    expect(preview(patched, PREVIEW_2)).toBeDefined();
  });
});

describe("片场粘贴/导入批次（任务 2.6）", () => {
  it("以新 clipId 粘贴的片场为每个镜头建立独立归属的预览节点", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
    // 粘贴规划器会重映射 clipId：这里直接提交新 clipId 的完整定义。
    const remapped = createFilmSetSnapshot({
      title: "来源片场",
      model: { modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" },
      motionScript: `motion.model.rotate("body", { speed: 1 });`,
      timeline: { duration: 4, loop: false }
    });
    remapped.filmSetAnimations!.clips[0]!.id = "clip-pasted";
    remapped.filmSetAnimations!.defaultClipId = "clip-pasted";

    const converted = migratedDefinition(remapped);
    const pasted = apply(canvas, converted.document.nodes.slice().sort((a, b) => Number(b.id === "film") - Number(a.id === "film")).map(node => ({ type: "node.add", node, nodeData: converted.nodeData[node.id] })));
    const pastedPreview = preview(pasted, shotPreviewNodeId("film", "clip-pasted"));
    expect(pastedPreview).toBeDefined();
    const ownership = pastedPreview ? pasted.nodeData[pastedPreview.id] : undefined;
    expect(ownership).toMatchObject({ managedBy: { schemaVersion: 1, extensionId: "film-set", ownerNodeId: "film", entityId: "clip-pasted", lifecycle: "owner-managed" }, mediaContent: { providerId: "film-set.shot", payload: { filmSetNodeId: "film", clipId: "clip-pasted" } } });
  });

  it("携带旧画布归属的预览节点不能被粘贴进新画布（整批拒绝）", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
    const result = reject(canvas, [{
      type: "node.add",
      node: { id: PREVIEW_1, type: FILM_SET_SHOT_PREVIEW_NODE_TYPE, position: { x: 0, y: 0 } },
      nodeData: { shotPreview: { schemaVersion: 1, filmSetNodeId: "other-film", clipId: CLIP_1 } }
    }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("invalid-shot-preview");
  });
});

function migratedDefinition(animation: FilmSetNodeData): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  canvas.document.nodes.push({ id: "film", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 200, y: 120 }, width: 320, height: 240 });
  canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
  return migrateFilmSetFixture(canvas, "film");
}
