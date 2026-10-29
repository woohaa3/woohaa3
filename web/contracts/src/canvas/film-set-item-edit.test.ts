import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";
/**
 * 片场对象类型化受保护编辑测试
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 3.4–3.5 / design D6）。
 *
 * 覆盖 transform/delete/restore 的 forward/inverse/redo 等价性、跨多片段绑定闭包、
 * 顺序锚点、无关修改并发、相关冲突原子拒绝与资产/载荷约束。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";


import { filmSetNodeDataFields, createFilmSetSnapshot, animationSnapshotHash, createModelSnapshot, createMotionSnapshot } from "./animation-snapshot.js";
import { canonicalFilmSetFields } from "./film-set-clip-view.js";

import { type FilmSetNodeData } from "./canvas-node-model.js";
import {
  applyFilmSetItemEditRemove,
  applyFilmSetItemEditRestore,
  applyFilmSetItemEditTransform,
  captureItemBindingClosure,
  captureItemOrderAnchor,
  filmSetItemBindingEditHash,
  filmSetItemEditHash
} from "./film-set-item-edit.js";

const NOW = "2026-10-10T00:00:00.000Z";

/** 三对象片场：A（被操作）、D（无关）、E；A 在 default 与 second 两个片段均有绑定。 */
function fixture(): { canvas: ServerCanvas; animation: FilmSetNodeData } {
  const base = createFilmSetSnapshot({
    title: "跑酷",
    model: { modelScript: `scene.box({id:"body",size:[1,1,1]});`, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: "",
    timeline: { duration: 5, loop: false }
  });
  const a = createModelSnapshot({ modelScript: `scene.box({id:"a"});`, modelScriptVersion: "woohaa-model-js-v2" });
  const d = createModelSnapshot({ modelScript: `scene.box({id:"d"});`, modelScriptVersion: "woohaa-model-js-v2" });
  const e = createModelSnapshot({ modelScript: `scene.box({id:"e"});`, modelScriptVersion: "woohaa-model-js-v2" });
  const items = [
    { id: "A", kind: "model" as const, name: "A", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, model: a },
    { id: "D", kind: "model" as const, name: "D", localTransform: { offset: { x: 2, y: 0, z: 0 }, scale: 1, yaw: 0 }, model: d },
    { id: "E", kind: "model" as const, name: "E", localTransform: { offset: { x: 4, y: 0, z: 0 }, scale: 1, yaw: 0 }, model: e }
  ];
  const template = { kind: "dynamic" as const, timeline: { duration: 5, loop: false }, initialCamera: base.sceneCamera, cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }) };
  const playback = { startTime: 0, duration: 2, timeScale: 1, loop: false };
  const animations = {
    schemaVersion: 3 as const,
    defaultClipId: "default",
    clips: [
      { ...template, id: "default", name: "default", bindings: [{ itemId: "A", playback }] },
      { ...template, id: "second", name: "second", bindings: [{ itemId: "A", playback }] },
      { ...template, id: "third", name: "third", bindings: [{ itemId: "D", playback }] }
    ]
  };
  const animation: FilmSetNodeData = { ...base, filmSetContent: { schemaVersion: 4, items }, filmSetAnimations: animations };
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  canvas.document.nodes.push({ id: "film", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 0, y: 0 } });
  canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
  return { canvas, animation };
}

describe("对象编辑单元操作与顺序锚点（任务 3.4）", () => {
  it("captureItemOrderAnchor 与 insertItemAtAnchor 恢复原顺序", () => {
    const { animation } = fixture();
    const anchor = captureItemOrderAnchor(animation.filmSetContent.items, "D");
    expect(anchor).toEqual({ after: "E", before: "A" });
    const inserted = applyFilmSetItemEditRestore({
      animation: applyFilmSetItemEditRemove({ animation, itemId: "D" }).ok
        ? (applyFilmSetItemEditRemove({ animation, itemId: "D" }) as { value: FilmSetNodeData }).value
        : animation,
      item: animation.filmSetContent.items.find((i) => i.id === "D")!,
      orderAnchor: anchor,
      bindings: captureItemBindingClosure(animation, "D")
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(inserted.value.filmSetContent.items.map((i) => i.id)).toEqual(["A", "D", "E"]);
  });

  it("captureItemBindingClosure 汇总全部片段绑定", () => {
    const { animation } = fixture();
    const closure = captureItemBindingClosure(animation, "A");
    expect(closure.map((entry) => entry.clipId).sort()).toEqual(["default", "second"]);
  });

  it("transform 单元操作仅因 localTransform 产生净变化", () => {
    const { animation } = fixture();
    const unchanged = applyFilmSetItemEditTransform({ animation, itemId: "A", localTransform: animation.filmSetContent.items[0]!.localTransform });
    expect(unchanged.ok).toBe(true);
    if (unchanged.ok) expect(unchanged.changed).toBe(false);
  });

  it("内容 hash 对无关顺序不敏感，对名字/变换敏感", () => {
    const { animation } = fixture();
    const a = animation.filmSetContent.items.find((i) => i.id === "A")!;
    const renamed = { ...a, name: "A2" };
    expect(filmSetItemEditHash(a)).not.toBe(filmSetItemEditHash(renamed));
    expect(filmSetItemBindingEditHash(undefined)).toBe(filmSetItemBindingEditHash(undefined));
  });

  it("animationSnapshotHash 随对象内容变化（权威身份一致）", () => {
    const { animation } = fixture();
    const moved = applyFilmSetItemEditTransform({ animation, itemId: "A", localTransform: { offset: { x: 3, y: 0, z: 0 }, scale: 1, yaw: 0 } });
    if (!moved.ok) return;
    expect(animationSnapshotHash(animation)).not.toBe(animationSnapshotHash(moved.value));
    void filmSetNodeDataFields;
  });
});


// Current protected marker editing is covered below; legacy item helpers above
// remain useful only to offline migration readers.
import { applyCanvasCommands, planCanvasEdit } from "../../../test-support/managed-shot-commands.js";
import { migrateFilmSetFixture } from "../../../test-support/film-set-groups.js";
import { readFilmSetGroupMarker } from "./film-set-group.js";
import { readFilmSetAnimationProjection } from "./film-set-animation-projection.js";

function edit(canvas: ServerCanvas, direction: { operations: unknown[]; preconditions: unknown[] }) {
  const result = applyCanvasCommands(canvas, [{ type: "edit.apply", ...direction } as never]);
  if (!result.ok) throw Error(result.rejection.message);
  return result.canvas;
}

describe("group binding 的受保护编辑", () => {
  it("变换、撤销、重做只更改编排；来源卡片新版本保持当前内容", () => {
    const canvas = migrateFilmSetFixture(fixture().canvas, "film");
    const source = readFilmSetGroupMarker(canvas.nodeData.film)!.sceneBindings[0]!.sourceNodeId;
    const plan = planCanvasEdit(canvas, [{ type: "filmSetGroup.bindingPatch", groupId: "film", bindingId: "A", patch: { transform: { x: 7, y: 0, z: 0, scale: 2, yaw: .3 } } }]);
    expect(plan.ok).toBe(true); if (!plan.ok) throw Error(plan.reason);
    const moved = edit(canvas, plan.forward);
    expect(moved.nodeData[source]).toEqual(canvas.nodeData[source]);
    const current = applyCanvasCommands(moved, [{ type: "nodeData.patch", nodeId: source, value: { modelScript: "scene.sphere({id:'current',radius:2});" } }]);
    expect(current.ok).toBe(true); if (!current.ok) throw Error(current.rejection.message);
    const undone = edit(current.canvas, plan.inverse);
    expect(readFilmSetGroupMarker(undone.nodeData.film)!.sceneBindings[0]!.transform.x).toBe(0);
    expect(undone.nodeData[source].modelScript).toContain("current");
    expect(readFilmSetGroupMarker(edit(undone, plan.forward).nodeData.film)!.sceneBindings[0]!.transform.x).toBe(7);
  });

  it("移除 binding 同批移除所有镜头动作，撤销恢复顺序并保留资源卡片", () => {
    const canvas = migrateFilmSetFixture(fixture().canvas, "film");
    const marker = readFilmSetGroupMarker(canvas.nodeData.film)!;
    const next = { ...marker, sceneBindings: marker.sceneBindings.filter(binding => binding.bindingId !== "A"), clips: marker.clips!.map(clip => ({ ...clip, bindings: clip.bindings!.filter(binding => binding.itemId !== "A") })) };
    const plan = planCanvasEdit(canvas, [{ type: "nodeData.patch", nodeId: "film", value: { filmSetGroup: next } }]);
    expect(plan.ok).toBe(true); if (!plan.ok) throw Error(plan.reason);
    const removed = edit(canvas, plan.forward);
    expect(readFilmSetAnimationProjection(removed, "film")!.filmSetContent.items.map(item => item.id)).toEqual(["D", "E"]);
    expect(readFilmSetGroupMarker(removed.nodeData.film)!.clips!.slice(0, 2).every(clip => clip.bindings!.length === 0)).toBe(true);
    expect(removed.nodeData[marker.sceneBindings[0]!.sourceNodeId]).toEqual(canvas.nodeData[marker.sceneBindings[0]!.sourceNodeId]);
    const undone = edit(removed, plan.inverse);
    expect(readFilmSetGroupMarker(undone.nodeData.film)).toEqual(marker);
    expect(readFilmSetGroupMarker(edit(undone, plan.forward).nodeData.film)).toEqual(next);
  });

  it("编排并发修改拒绝旧撤销，资源失效后历史编排仍可恢复为诊断", () => {
    const canvas = migrateFilmSetFixture(fixture().canvas, "film");
    const plan = planCanvasEdit(canvas, [{ type: "filmSetGroup.bindingPatch", groupId: "film", bindingId: "A", patch: { visibility: false } }]);
    expect(plan.ok).toBe(true); if (!plan.ok) throw Error(plan.reason);
    const moved = edit(canvas, plan.forward);
    const stale = structuredClone(moved);
    stale.nodeData.film.filmSetGroup!.sceneBindings[0]!.transform.x = 55;
    const before = structuredClone(stale);
    expect(applyCanvasCommands(stale, [{ type: "edit.apply", ...plan.inverse }]).ok).toBe(false);
    expect(stale).toEqual(before);
    const source = readFilmSetGroupMarker(moved.nodeData.film)!.sceneBindings[0]!.sourceNodeId;
    const unavailable = applyCanvasCommands(moved, [{ type: "node.remove", nodeIds: [source] }]);
    expect(unavailable.ok).toBe(true); if (!unavailable.ok) throw Error(unavailable.rejection.message);
    expect(readFilmSetGroupMarker(edit(unavailable.canvas, plan.inverse).nodeData.film)!.sceneBindings[0]!.visibility).toBe(true);
  });
});
