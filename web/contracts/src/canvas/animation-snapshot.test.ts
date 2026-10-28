/**
 * 动画/模型节点快照创建与导入测试
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 2.1–2.4；
 *  change: 2026-10-11-extract-film-set-extension，D7/D8/D10 —— items-only）。
 */
import { describe, expect, it } from "vitest";
import {
  advanceModelRevision,
  advanceMotionRevision,
  animationCaptureMetadata,
  filmSetNodeDataFields,
  animationSnapshotHash,
  createFilmSetSnapshot,
  createModel3DNodeData,
  createModelSnapshot,
  createMotionSnapshot,
  defaultInitialShotCamera,
  importModelSnapshot,
  model3DNodeDataFields,
  readStoredAnimation
} from "./animation-snapshot.js";
import { deriveModelContentVersion, DEFAULT_MODEL_PLACEMENT } from "./model-definition.js";
import { hashMotionScript } from "./motion-script.js";
import { hashModelScript } from "./model-executor.js";
import { applyFilmSetClipPatch, filmSetClipPrecondition } from "./film-set-clip-ops.js";
import { filmSetItemAdapterHash } from "./film-set-content.js";
import { SHOT_CAMERA_DEFAULT_ELEVATION } from "./model-cameras.js";

const SCRIPT = `scene.box({ id: "torso", size: [1, 2, 0.5] });`;
const MOTION = `motion.model.rotate("torso", { speed: 0.5 });`;
/** 旧顶层模型迁移后成为唯一 model item 的稳定 id（D8）。 */
const ITEM_ID = "model";

function snapshotInput(script = SCRIPT) {
  return { modelScript: script, modelScriptVersion: "woohaa-model-js-v2" as const };
}

function modelItem(animation: ReturnType<typeof createFilmSetSnapshot>) {
  const item = animation.filmSetContent.items.find(candidate => candidate.id === ITEM_ID);
  if (!item || item.kind !== "model") throw new Error("缺少 model item");
  return item;
}

function defaultBinding(animation: ReturnType<typeof createFilmSetSnapshot>) {
  const clip = animation.filmSetAnimations?.clips.find(candidate => candidate.id === animation.filmSetAnimations?.defaultClipId);
  return clip?.bindings.find(candidate => candidate.itemId === ITEM_ID);
}

describe("模型快照（任务 2.1）", () => {
  it("创建快照从 revision 1 开始并派生内容标识", () => {
    const model = createModelSnapshot(snapshotInput());
    expect(model.contentVersion.revision).toBe(1);
    expect(model.contentVersion.sourceHash).toBe(hashModelScript(SCRIPT));
    expect(model.placement).toEqual(DEFAULT_MODEL_PLACEMENT);
    expect(model.modelScriptLanguage).toBe("javascript");
  });

  it("内容不变不推进 revision，内容变化推进", () => {
    const first = deriveModelContentVersion({
      modelScript: SCRIPT,
      modelScriptLanguage: "javascript",
      modelScriptVersion: "woohaa-model-js-v2",
      placement: DEFAULT_MODEL_PLACEMENT,
      revision: 3
    });
    expect(advanceModelRevision(first, first.contentHash)).toBe(3);
    expect(advanceModelRevision(first, "different")).toBe(4);
    expect(advanceModelRevision(null, "x")).toBe(1);
  });
});

describe("动画快照创建与导入（任务 2.1–2.4）", () => {
  it("创建动画复制模型为 item 并建立本地适配绑定", () => {
    const animation = createFilmSetSnapshot({
      title: "挥手",
      model: snapshotInput(),
      motionScript: MOTION,
      timeline: { duration: 4, loop: false }
    });
    const item = modelItem(animation);
    expect(item.model.contentVersion.revision).toBe(1);
    const binding = defaultBinding(animation);
    expect(binding?.motion?.basedOnModelVersion.contentHash).toBe(item.model.contentVersion.contentHash);
    expect(binding?.motion?.revision).toBe(1);
    // 顶层不再保存 authored 模型。
    expect(filmSetNodeDataFields(animation).modelScript).toBeUndefined();
    expect(animation.camera.aspect).toBe("16:9");
    expect(animation.timeline).toEqual({ duration: 4, loop: false });
  });

  it("初始镜头按 AABB 派生且不保存在来源节点上", () => {
    const camera = defaultInitialShotCamera({ min: [-1, -1, -1], max: [1, 1, 1] });
    expect(camera.elevation).toBeCloseTo(SHOT_CAMERA_DEFAULT_ELEVATION, 6);
    expect(camera.distance).toBeGreaterThan(0);
  });

  it("时间线为 0 且无运动时是合法静态节点且无片段", () => {
    const animation = createFilmSetSnapshot({
      title: "静态",
      model: snapshotInput(),
      motionScript: "",
      timeline: { duration: 0, loop: false }
    });
    expect(animation.filmSetAnimations?.clips ?? []).toHaveLength(0);
    expect(readStoredAnimation(filmSetNodeDataFields(animation))?.timeline.duration).toBe(0);
  });

  it("导入模型快照保留绑定运动与旧适配版本", () => {
    const animation = createFilmSetSnapshot({
      title: "挥手",
      model: snapshotInput(),
      motionScript: MOTION,
      timeline: { duration: 4, loop: false }
    });
    const before = defaultBinding(animation)!;
    const imported = importModelSnapshot(animation, ITEM_ID, snapshotInput("scene.box({});"));
    const item = modelItem(imported);
    expect(item.model.modelScript).toBe("scene.box({});");
    const after = defaultBinding(imported)!;
    expect(after.motion?.sourceHash).toBe(before.motion?.sourceHash);
    expect(after.motion?.basedOnModelVersion.contentHash).toBe(before.motion?.basedOnModelVersion.contentHash);
    expect(after.motion?.basedOnModelVersion.contentHash).not.toBe(item.model.contentVersion.contentHash);
  });

  it("显式确认适配把 binding 关联对齐到当前 item 模型", () => {
    const animation = createFilmSetSnapshot({
      title: "挥手",
      model: snapshotInput(),
      motionScript: MOTION,
      timeline: { duration: 4, loop: false }
    });
    const imported = importModelSnapshot(animation, ITEM_ID, snapshotInput("scene.box({});"));
    const item = modelItem(imported);
    const clipId = imported.filmSetAnimations!.defaultClipId!;
    const op = { kind: "confirm-adaptation", itemId: ITEM_ID, expectedAdapterHash: filmSetItemAdapterHash(item) } as const;
    const patched = applyFilmSetClipPatch({
      animation: imported,
      clipId,
      op,
      expectedHash: filmSetClipPrecondition(imported.filmSetAnimations!, clipId, op)
    });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    const binding = patched.value.clips.find(candidate => candidate.id === clipId)!.bindings[0]!;
    expect(binding.motion?.basedOnModelVersion.contentHash).toBe(filmSetItemAdapterHash(item));
    expect(binding.motion?.basedOnModelVersion.contentHash).toBe(item.model.contentVersion.contentHash);
  });

  it("运动源码不变不推进 revision，变化推进", () => {
    const motion = createMotionSnapshot({
      motionScript: MOTION,
      basedOnModelVersion: deriveModelContentVersion({
        modelScript: SCRIPT,
        modelScriptLanguage: "javascript",
        modelScriptVersion: "woohaa-model-js-v2",
        placement: DEFAULT_MODEL_PLACEMENT,
        revision: 1
      })
    });
    expect(advanceMotionRevision(motion, MOTION)).toBe(1);
    expect(advanceMotionRevision(motion, MOTION + "\n")).toBe(2);
    expect(hashMotionScript(MOTION)).toBe(motion.sourceHash);
  });

  it("快照 hash 对模型/运动/镜头/时间线变化敏感，但不含标题", () => {
    const animation = createFilmSetSnapshot({
      title: "挥手",
      model: snapshotInput(),
      modelItemName: "人物",
      motionScript: MOTION,
      timeline: { duration: 4, loop: false }
    });
    const changed = createFilmSetSnapshot({
      title: "挥手",
      model: snapshotInput(),
      modelItemName: "人物",
      motionScript: MOTION,
      timeline: { duration: 5, loop: false }
    });
    expect(animationSnapshotHash(animation)).not.toBe(animationSnapshotHash(changed));
    expect(animationSnapshotHash(animation)).toBe(
      animationSnapshotHash(createFilmSetSnapshot({
        title: "其它标题",
        model: snapshotInput(),
        modelItemName: "人物",
        motionScript: MOTION,
        timeline: { duration: 4, loop: false }
      }))
    );
  });

  it("flat 字段 round-trip 可读回完整片场节点且无顶层模型字段", () => {
    const animation = createFilmSetSnapshot({
      title: "挥手",
      model: snapshotInput(),
      motionScript: MOTION,
      timeline: { duration: 4, loop: false },
      origin: { importedModelContentHash: "abc", importedAt: "2026-10-05T00:00:00.000Z" }
    });
    const fields = filmSetNodeDataFields(animation);
    const stored = readStoredAnimation(fields);
    expect(stored?.title).toBe("挥手");
    expect(stored?.origin?.importedModelContentHash).toBe("abc");
    expect(fields.modelScript).toBeUndefined();
    const item = modelItem(animation);
    expect(item.model.modelScript).toBe(SCRIPT);
  });

  it("模型节点 flat 字段可读回", () => {
    const model = createModel3DNodeData({ title: "身体", model: snapshotInput() });
    const fields = model3DNodeDataFields(model);
    expect(fields.modelScript).toBe(SCRIPT);
    expect(fields.title).toBe("身体");
  });

  it("截帧元数据记录实际片场内容与指定时间", () => {
    const animation = createFilmSetSnapshot({
      title: "挥手",
      model: snapshotInput(),
      motionScript: MOTION,
      timeline: { duration: 4, loop: false }
    });
    const imported = importModelSnapshot(animation, ITEM_ID, snapshotInput("scene.box({});"));
    const metadata = animationCaptureMetadata(imported, 2.5);
    expect(metadata.timeSeconds).toBe(2.5);
    expect(metadata.snapshotHash).toBe(animationSnapshotHash(imported));
    expect(metadata.initialCamera).toEqual(imported.camera);
    expect(metadata.timeline).toEqual(imported.timeline);
    // items-only 内容 hash 反映导入后的模型。
    expect(metadata.contentHash).not.toBe(animationCaptureMetadata(animation, 2.5).contentHash);
  });
});
