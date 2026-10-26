import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";

import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { describe, expect, it } from "vitest";
import { filmSetNodeDataFields, animationSnapshotHash, createFilmSetSnapshot, createMotionSnapshot } from "./animation-snapshot.js";
import { decodeFilmSetNodeData, type FilmSetNodeData } from "./canvas-node-model.js";
import { FILM_SET_ANIMATIONS_LEGACY_VERSION, FILM_SET_ANIMATIONS_VERSION, decodeFilmSetAnimations, filmSetClipHash } from "./film-set-animations.js";
import { applyFilmSetClipPatch, filmSetClipPrecondition, type FilmSetClipPatchOp } from "./film-set-clip-ops.js";
import { canonicalFilmSetFields, resolveFilmSetClip } from "./film-set-clip-view.js";
import { compileFilmSetClip, filmSetCompiledBudget } from "./film-set-clip-compilation.js";
import { createFilmSetItemMotion, filmSetItemAdapterHash } from "./film-set-content.js";

const ITEM_ID = "model";

function cameraMotion(script = `motion.camera.tween({ id: "camera-orbit", property: "azimuth", startTime: 0, endTime: 5, from: 0, to: 1 });`) {
  return createMotionSnapshot({ motionScript: script, basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } });
}

/** items-only 片场：仅含一个 model item 与一个相机-only 片段（镜头动作独立于对象动作，D10）。 */
function fixture(): FilmSetNodeData {
  const base = createFilmSetSnapshot({
    title: "跑酷",
    model: { modelScript: `scene.box({id:"body",size:[1,1,1]});`, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: "",
    timeline: { duration: 5, loop: false }
  });
  return {
    ...base,
    filmSetAnimations: {
      schemaVersion: FILM_SET_ANIMATIONS_VERSION,
      defaultClipId: "legacy-default",
      clips: [{ id: "legacy-default", name: "默认镜头", kind: "dynamic", timeline: { duration: 5, loop: false }, initialCamera: base.camera, cameraMotion: cameraMotion(), bindings: [] }]
    }
  };
}
function patch(animation: FilmSetNodeData, op: FilmSetClipPatchOp, clipId = "legacy-default") {
  return applyFilmSetClipPatch({ animation, op, clipId, expectedHash: filmSetClipPrecondition(animation.filmSetAnimations!, clipId, op) });
}

describe("independent film set clips", () => {
  it("roundtrips canonical structure and rejects mixed top/item fields", () => {
    const animation = fixture();
    const fields = filmSetNodeDataFields(animation);
    expect(fields.motionScript).toBeUndefined();
    expect(decodeFilmSetNodeData(fields).ok).toBe(true);
    expect(decodeFilmSetNodeData({ ...fields, timeline: animation.timeline }).ok).toBe(false);
    const item = animation.filmSetContent.items[0]!;
    expect(decodeFilmSetNodeData({ ...fields, filmSetContent: { schemaVersion: 4, items: [{ ...item, playback: { duration: 0 } }] } }).ok).toBe(false);
  });

  it("duplicates only clip data and preserves shared item IDs", () => {
    const animation = fixture();
    const before = JSON.stringify(animation.filmSetContent);
    const result = patch(animation, { kind: "duplicate", newClipId: "jump", name: "跳跃" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clips).toHaveLength(2);
    expect(result.value.clips[1].bindings).toEqual(result.value.clips[0].bindings);
    expect(JSON.stringify(animation.filmSetContent)).toBe(before);
    expect(result.value.defaultClipId).toBe("legacy-default");
  });

  it("deleting final clip leaves editable scene and explicit empty collection", () => {
    const animation = fixture();
    const result = patch(animation, { kind: "delete" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ schemaVersion: FILM_SET_ANIMATIONS_VERSION, defaultClipId: null, clips: [] });
    const next = { ...animation, filmSetAnimations: result.value };
    expect(decodeFilmSetNodeData(canonicalFilmSetFields(next)).ok).toBe(true);
    expect(resolveFilmSetClip(next)).toBeNull();
  });

  it("field preconditions merge unrelated changes and reject stale same field", () => {
    const animation = fixture();
    const rename: FilmSetClipPatchOp = { kind: "rename", name: "改名" };
    const expectedHash = filmSetClipPrecondition(animation.filmSetAnimations!, "legacy-default", rename);
    const edited = patch(animation, { kind: "timeline", timeline: { duration: 8, loop: true } });
    if (!edited.ok) throw Error(edited.reason);
    const merged = applyFilmSetClipPatch({ animation: { ...animation, filmSetAnimations: edited.value }, clipId: "legacy-default", op: rename, expectedHash });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(applyFilmSetClipPatch({ animation: { ...animation, filmSetAnimations: merged.value }, clipId: "legacy-default", op: rename, expectedHash }).ok).toBe(false);
  });

  it("binding updates extend only selected clip and check item identity", () => {
    const animation = fixture();
    const duplicate = patch(animation, { kind: "duplicate", newClipId: "jump", name: "跳跃" });
    if (!duplicate.ok) throw Error(duplicate.reason);
    const item = animation.filmSetContent.items[0]!;
    const next = { ...animation, filmSetAnimations: duplicate.value };
    const op: FilmSetClipPatchOp = { kind: "binding", itemId: item.id, expectedAdapterHash: filmSetItemAdapterHash(item), binding: { itemId: item.id, playback: { startTime: 2, duration: 10, timeScale: 1, loop: false } } };
    const bound = patch(next, op, "jump");
    if (!bound.ok) throw Error(bound.reason);
    expect(bound.value.clips[0].timeline.duration).toBe(5);
    expect(bound.value.clips[1].timeline.duration).toBe(12);
    expect(patch({ ...next, filmSetAnimations: bound.value }, { kind: "timeline", timeline: { duration: 4, loop: false } }, "jump").ok).toBe(false);
    expect(patch(next, { ...op, expectedAdapterHash: "stale" }, "jump").ok).toBe(false);
  });

  it("selection is local; full identity includes other clips", () => {
    const animation = fixture();
    const duplicate = patch(animation, { kind: "duplicate", newClipId: "jump", name: "跳跃" });
    if (!duplicate.ok) throw Error(duplicate.reason);
    const next = { ...animation, filmSetAnimations: duplicate.value };
    const hash = filmSetClipHash(next.filmSetAnimations!.clips[0]);
    expect(resolveFilmSetClip(next, "jump")?.timeline.duration).toBe(5);
    expect(next.filmSetAnimations!.defaultClipId).toBe("legacy-default");
    expect(animationSnapshotHash(next)).not.toBe(animationSnapshotHash(animation));
    expect(filmSetClipHash(next.filmSetAnimations!.clips[0])).toBe(hash);
  });

  it("rejects unknown versions, bad references, duplicate IDs and legacy clip.motion", () => {
    const animation = fixture();
    const value = animation.filmSetAnimations!;
    for (const input of [{ ...value, schemaVersion: FILM_SET_ANIMATIONS_LEGACY_VERSION }, { ...value, defaultClipId: "missing" }, { ...value, clips: [value.clips[0], value.clips[0]] }]) expect(decodeFilmSetAnimations(input, animation.filmSetContent).ok).toBe(false);
    // 含旧 clip.motion 的片段严格拒绝（无兼容读取）。
    const legacyClip = { ...value.clips[0], id: "legacy", motion: cameraMotion() };
    expect(decodeFilmSetAnimations({ schemaVersion: FILM_SET_ANIMATIONS_VERSION, defaultClipId: "legacy", clips: [legacyClip] }, animation.filmSetContent).ok).toBe(false);
  });

  it("camera motion compiles against the clip without top authored scope", () => {
    const animation = fixture();
    const resolved = resolveFilmSetClip(animation)!;
    const compiled = compileFilmSetClip("scene", resolved);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.projection.cameraMotion.length).toBeGreaterThan(0);
    expect(compiled.diagnostics).toEqual([]);
  });

  it("malformed nested operations return rejection without mutating input", () => {
    const animation = fixture(), before = JSON.stringify(animation);
    for (const op of [{ kind: "create", clip: {} }, { kind: "replace", clip: {} }, { kind: "camera-motion", cameraMotion: {} }, { kind: "camera", initialCamera: {} }, { kind: "timeline", timeline: { duration: NaN } }, { kind: "binding", itemId: animation.filmSetContent.items[0].id, expectedAdapterHash: "", binding: {} }]) {
      expect(patch(animation, op as FilmSetClipPatchOp).ok).toBe(false);
      expect(JSON.stringify(animation)).toBe(before);
    }
  });

  it("accepts any number of clips without truncation (no clip quota)", () => {
    // change: 2026-10-22-remove-agent-execution-limits，任务 5.4：原 32 片段额度已删除。
    const animation = fixture();
    const clips = Array.from({ length: 40 }, (_, i) => ({ ...animation.filmSetAnimations!.clips[0], id: `c${i}` }));
    const value = { schemaVersion: FILM_SET_ANIMATIONS_VERSION, defaultClipId: "c0", clips };
    expect(decodeFilmSetAnimations(value, animation.filmSetContent).ok).toBe(true);
    expect(decodeFilmSetAnimations({ ...value, clips: [...clips, { ...clips[0], id: "c40" }] }, animation.filmSetContent).ok).toBe(true);
    expect(value.clips).toHaveLength(40);
  });

  it("enforces cumulative tracks across clips and the exact keyframe boundary", () => {
    const animation = fixture();
    const template = { ...animation.filmSetAnimations!.clips[0], cameraMotion: cameraMotion("") };
    const item = animation.filmSetContent.items.find(candidate => candidate.id === ITEM_ID)!;
    const bindingMotion = (script: string) => createFilmSetItemMotion({ item, motionScript: script });
    const trackScript = "for(let i=0;i<256;i++) motion.model.rotate('part'+i,{speed:1});";
    const binding = (script: string) => ({ itemId: ITEM_ID, motion: bindingMotion(script), playback: { startTime: 0, duration: 5, timeScale: 1, loop: false } });
    animation.filmSetAnimations!.clips = Array.from({ length: 4 }, (_, i) => ({ ...template, id: `c${i}`, bindings: [binding(trackScript)] }));
    expect(filmSetCompiledBudget(animation)).toBeNull();
    animation.filmSetAnimations!.clips.push({ ...template, id: "overflow", bindings: [binding(trackScript)] });
    expect(filmSetCompiledBudget(animation)).toContain("1024");
    const script = (n: number) => `const frames=[]; for(let i=0;i<1024;i++) frames.push({time:i*5/1023,value:[i,0,0]}); for(let j=0;j<${n};j++) motion.model.keyframes('part'+j,{property:'position',frames});`;
    animation.filmSetAnimations!.clips = [{ ...template, bindings: [binding(script(16))] }];
    expect(filmSetCompiledBudget(animation)).toBeNull();
    animation.filmSetAnimations!.clips[0].bindings[0]!.motion = bindingMotion(script(17));
    expect(filmSetCompiledBudget(animation)).toContain("16384");
  });

  it("large but valid source is not rejected or truncated (no byte quota)", () => {
    // change: 2026-10-22-remove-agent-execution-limits，任务 5.4：原 1/2 MiB 源码与内容
    // 额度已删除；大内容完整往返，不静默截断也不整份拒绝。
    const large = createFilmSetSnapshot({
      title: "large",
      model: { modelScript: "scene.box({id:'body'});", modelScriptVersion: "woohaa-model-js-v2" },
      motionScript: "//" + "汉".repeat(400000),
      timeline: { duration: 5, loop: false }
    });
    const fields = filmSetNodeDataFields(large);
    const before = JSON.stringify(fields);
    expect(decodeFilmSetNodeData(fields).ok).toBe(true);
    expect(JSON.stringify(fields)).toBe(before);
  });

  it("deleting a shared actor atomically clears every clip binding and complete undo restores all", () => {
    const animation = fixture(); const item = animation.filmSetContent.items.find(candidate => candidate.id === ITEM_ID)!;
    const first = animation.filmSetAnimations!.clips[0];
    const motion = createFilmSetItemMotion({ item, motionScript: `motion.model.rotate("body", { speed: 1 });` });
    first.bindings = [{ itemId: item.id, motion, playback: { startTime: 0, duration: 3, timeScale: 1, loop: false } }];
    animation.filmSetAnimations!.clips.push({ ...first, id: "other", name: "other" });
    const canvas = createEmptyWoohaa3ServerCanvas("c", "now");
    canvas.document.nodes.push({ id: "film", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 0, y: 0 } });
    canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
    const before = JSON.parse(JSON.stringify(canvas.nodeData.film));
    const result = applyCanvasCommands(canvas, [{ type: "filmSet.itemPatch", nodeId: "film", itemId: item.id, op: { kind: "delete" } }], { now: "later" });
    expect(result.ok).toBe(true); if (!result.ok) return;
    const after = decodeFilmSetNodeData(result.canvas.nodeData.film); expect(after.ok).toBe(true); if (!after.ok) return;
    expect(after.value.filmSetContent.items.some(entry => entry.id === item.id)).toBe(false);
    expect(after.value.filmSetAnimations!.clips.every(clip => clip.bindings.length === 0)).toBe(true);
    const undo = applyCanvasCommands(result.canvas, [{ type: "nodeData.patch", nodeId: "film", value: before }], { now: "undo" });
    expect(undo.ok).toBe(true); if (undo.ok) expect(undo.canvas.nodeData.film.filmSetAnimations).toEqual(before.filmSetAnimations);
  });

  it("requires explicit kind and enforces static/dynamic invariants", () => {
    const animation = fixture();
    const collection = animation.filmSetAnimations!;
    const dynamic = collection.clips[0];
    // 缺失 kind 整份拒绝。
    const missing = { ...collection, clips: [{ ...dynamic, kind: undefined }] };
    expect(decodeFilmSetAnimations(missing, animation.filmSetContent).ok).toBe(false);
    // 非法 kind 拒绝。
    expect(decodeFilmSetAnimations({ ...collection, clips: [{ ...dynamic, kind: "clip" }] }, animation.filmSetContent).ok).toBe(false);
    // 静态携带正时长/循环/镜头动作分别拒绝。
    expect(decodeFilmSetAnimations({ ...collection, clips: [{ ...dynamic, kind: "static" }] }, animation.filmSetContent).ok).toBe(false);
    expect(decodeFilmSetAnimations({ ...collection, clips: [{ ...dynamic, kind: "static", timeline: { duration: 0, loop: true } }] }, animation.filmSetContent).ok).toBe(false);
    expect(decodeFilmSetAnimations({ ...collection, clips: [{ ...dynamic, kind: "static", timeline: { duration: 0, loop: false } }] }, animation.filmSetContent).ok).toBe(false);
    // 合法静态：零时长、非循环、空镜头动作。
    const staticClip = { ...dynamic, kind: "static" as const, timeline: { duration: 0, loop: false }, cameraMotion: cameraMotion("") };
    expect(decodeFilmSetAnimations({ ...collection, clips: [staticClip] }, animation.filmSetContent).ok).toBe(true);
    // 动态固定机位、无动作仍合法（type 不靠 cameraMotion 推断）。
    expect(decodeFilmSetAnimations({ ...collection, clips: [{ ...staticClip, kind: "dynamic", timeline: { duration: 5, loop: false } }] }, animation.filmSetContent).ok).toBe(true);
    // 动态必须有正时长。
    expect(decodeFilmSetAnimations({ ...collection, clips: [{ ...staticClip, kind: "dynamic", timeline: { duration: 0, loop: false } }] }, animation.filmSetContent).ok).toBe(false);
  });

  it("static shots reject dynamic object motion and timed media in bindings", () => {
    const animation = fixture();
    const collection = animation.filmSetAnimations!;
    const item = animation.filmSetContent.items.find(candidate => candidate.id === ITEM_ID)!;
    const motion = createFilmSetItemMotion({ item, motionScript: `motion.model.rotate("body", { speed: 1 });` });
    const staticClip = { ...collection.clips[0], kind: "static" as const, timeline: { duration: 0, loop: false }, cameraMotion: cameraMotion("") };
    // 非空对象动作拒绝。
    expect(decodeFilmSetAnimations({ ...collection, clips: [{ ...staticClip, bindings: [{ itemId: item.id, motion, playback: { startTime: 0, duration: 0, timeScale: 1, loop: false } }] }] }, animation.filmSetContent).ok).toBe(false);
    // 正时长媒体播放拒绝。
    expect(decodeFilmSetAnimations({ ...collection, clips: [{ ...staticClip, bindings: [{ itemId: item.id, playback: { startTime: 0, duration: 3, timeScale: 1, loop: false } }] }] }, animation.filmSetContent).ok).toBe(false);
    // 静态绑定起点/首帧（零时序）合法。
    expect(decodeFilmSetAnimations({ ...collection, clips: [{ ...staticClip, bindings: [{ itemId: item.id, playback: { startTime: 0, duration: 0, timeScale: 1, loop: false } }] }] }, animation.filmSetContent).ok).toBe(true);
  });

  it("explicit kind conversion is atomic and reversible in shape", () => {
    const animation = fixture();
    const dynamic = animation.filmSetAnimations!.clips[0];
    expect(dynamic.kind).toBe("dynamic");
    // dynamic → static 无 confirm 时拒绝（含时序）。
    const refused = patch(animation, { kind: "set-kind", toKind: "static" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("invalid-kind");
    // 显式确认后原子清除动作与时序，保留 ID 与构图。
    const toStatic = patch(animation, { kind: "set-kind", toKind: "static", confirmClearContent: true });
    expect(toStatic.ok).toBe(true);
    if (!toStatic.ok) return;
    const converted = toStatic.value.clips[0];
    expect(converted.kind).toBe("static");
    expect(converted.id).toBe(dynamic.id);
    expect(converted.initialCamera).toEqual(dynamic.initialCamera);
    expect(converted.timeline).toEqual({ duration: 0, loop: false });
    expect(converted.cameraMotion.motionScript).toBe("");
    // static → dynamic 保留身份与构图并设置正时长。
    const next = { ...animation, filmSetAnimations: toStatic.value };
    const toDynamic = patch(next, { kind: "set-kind", toKind: "dynamic", duration: 6 });
    expect(toDynamic.ok).toBe(true);
    if (!toDynamic.ok) return;
    expect(toDynamic.value.clips[0].kind).toBe("dynamic");
    expect(toDynamic.value.clips[0].timeline.duration).toBe(6);
    expect(toDynamic.value.clips[0].initialCamera).toEqual(dynamic.initialCamera);
  });

  it("static shots never extend timeline or accept motion via binding/timeline/camera-motion", () => {
    const animation = fixture();
    const item = animation.filmSetContent.items.find(candidate => candidate.id === ITEM_ID)!;
    const staticNext = patch(animation, { kind: "set-kind", toKind: "static", confirmClearContent: true });
    if (!staticNext.ok) throw Error(staticNext.reason);
    const next = { ...animation, filmSetAnimations: staticNext.value };
    // 绑定不能暗中延长静态镜头。
    const bound = patch(next, { kind: "binding", itemId: item.id, expectedAdapterHash: filmSetItemAdapterHash(item), binding: { itemId: item.id, playback: { startTime: 0, duration: 0, timeScale: 1, loop: false } } });
    expect(bound.ok).toBe(true);
    if (bound.ok) expect(bound.value.clips[0].timeline.duration).toBe(0);
    // 静态不得写正时序媒体/对象动作。
    expect(patch(next, { kind: "binding", itemId: item.id, expectedAdapterHash: filmSetItemAdapterHash(item), binding: { itemId: item.id, playback: { startTime: 0, duration: 3, timeScale: 1, loop: false } } }).ok).toBe(false);
    const motion = createFilmSetItemMotion({ item, motionScript: `motion.model.rotate("body", { speed: 1 });` });
    expect(patch(next, { kind: "binding", itemId: item.id, expectedAdapterHash: filmSetItemAdapterHash(item), binding: { itemId: item.id, motion, playback: { startTime: 0, duration: 0, timeScale: 1, loop: false } } }).ok).toBe(false);
    // 静态不得改时间线或写镜头动作。
    expect(patch(next, { kind: "timeline", timeline: { duration: 3, loop: false } }).ok).toBe(false);
    expect(patch(next, { kind: "camera-motion", cameraMotion: cameraMotion() }).ok).toBe(false);
  });
});
