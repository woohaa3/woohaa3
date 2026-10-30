import { migrateFilmSetFixture } from "../../../test-support/film-set-groups.js";
import { readFilmSetAnimationProjection } from "./film-set-animation-projection.js";
import { applyCanvasCommands, planCanvasEdit } from "../../../test-support/managed-shot-commands.js";
/**
 * 拍摄镜头受保护编辑（源镜头定义 + 预览布局闭包）测试
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 2.5）。
 *
 * 覆盖：重命名/类型转换/时间线与动作编辑进入受保护编辑日志并可逆；删除镜头撤销时恢复原预览
 * ID、位置与尺寸；预览布局变化可撤销；并发前置条件（镜头定义、预览布局）原子拒绝。
 */
import { describe, expect, it } from "vitest";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";

import { createFilmSetSnapshot } from "./animation-snapshot.js";
import { canonicalFilmSetFields, filmSetAnimationsOf } from "./film-set-clip-view.js";
import { filmSetClipPrecondition, type FilmSetClipPatchOp } from "./film-set-clip-ops.js";
import { filmSetClipPatchCommand } from "./film-set-content.js";
import { decodeFilmSetNodeData, type FilmSetNodeData } from "./canvas-node-model.js";
import { type EditPlan } from "./edit-plan.js";
import { staticShotCameraMotion, type FilmSetAnimationClip } from "./film-set-animations.js";
import { shotPreviewNodeId } from "./film-set-shot-preview.js";
import { managedNodeRelationOf } from "./managed-node.js";

const NOW = "2026-10-15T00:00:00.000Z";
const CLIP_1 = "clip-1";
const CLIP_2 = "clip-2";
const PREVIEW_1 = shotPreviewNodeId("film", CLIP_1);
const PREVIEW_2 = shotPreviewNodeId("film", CLIP_2);

/** 带一个动态拍摄镜头（`clip-1`，含对象动作）的片场画布，并已由 reconciliation 建立预览。 */
function withFilmSet(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  canvas.document.nodes.push({
    id: "film",
    type: COMPOSITE_ASSET_NODE_TYPE,
    position: { x: 100, y: 50 },
    width: 320,
    height: 240
  });
  const animation = createFilmSetSnapshot({
    title: "片场",
    model: { modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: `motion.model.rotate("body", { speed: 1 });`,
    timeline: { duration: 5, loop: true }
  });
  canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
  return materialize(migrateFilmSetFixture(canvas, "film"));
}

/** 触发一次同批 reconciliation 让预览节点就位（空批次也会收敛派生闭包）。 */
function materialize(canvas: ServerCanvas): ServerCanvas {
  return expectOk(apply(canvas, []));
}

function apply(canvas: ServerCanvas, commands: unknown[]): ReturnType<typeof applyCanvasCommands> {
  return applyCanvasCommands(canvas, commands as never, { now: NOW });
}

function expectOk(result: ReturnType<typeof applyCanvasCommands>): ServerCanvas {
  if (!result.ok) throw new Error(`期望成功，实际 ${result.rejection.code}: ${result.rejection.message}`);
  return result.canvas;
}

function animation(canvas: ServerCanvas): FilmSetNodeData {
  const decoded = decodeFilmSetNodeData(canonicalFilmSetFields(readFilmSetAnimationProjection(canvas, "film")!));
  if (!decoded.ok) throw new Error(decoded.reason);
  return decoded.value;
}

function clip(canvas: ServerCanvas, clipId: string): FilmSetAnimationClip {
  const found = filmSetAnimationsOf(animation(canvas)).clips.find((entry) => entry.id === clipId);
  if (!found) throw new Error(`镜头 ${clipId} 不存在`);
  return found;
}

function previewNode(canvas: ServerCanvas, nodeId: string) {
  return canvas.document.nodes.find((node) => node.id === nodeId && managedNodeRelationOf(canvas.nodeData[node.id])?.extensionId === "film-set");
}

function clipPatch(canvas: ServerCanvas, op: FilmSetClipPatchOp, clipId = CLIP_1) {
  return filmSetClipPatchCommand({
    nodeId: "film",
    clipId,
    expectedHash: filmSetClipPrecondition(filmSetAnimationsOf(animation(canvas)), clipId, op),
    op
  });
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

/** 通过受保护编辑回放 forward/inverse（与 CanvasEditService 的提交路径一致）。 */
function applyPlan(canvas: ServerCanvas, plan: EditPlan["forward"]): ServerCanvas {
  return expectOk(apply(canvas, [{ type: "edit.apply", preconditions: plan.preconditions, operations: plan.operations }]));
}

function planOrThrow(canvas: ServerCanvas, commands: unknown[]): EditPlan {
  const plan = planCanvasEdit(canvas, commands as never);
  if (!plan.ok) throw new Error(`规划失败：${plan.reason}`);
  return plan;
}

describe("源镜头定义的受保护编辑（任务 2.5）", () => {
  it("重命名可逆，且预览身份与布局不变", () => {
    const canvas = withFilmSet();
    const plan = planOrThrow(canvas, [clipPatch(canvas, { kind: "rename", name: "新名称" })]);

    const renamed = applyPlan(canvas, plan.forward);
    expect(clip(renamed, CLIP_1).name).toBe("新名称");
    expect(previewNode(renamed, PREVIEW_1)!.position).toEqual(previewNode(canvas, PREVIEW_1)!.position);

    const undone = applyPlan(renamed, plan.inverse);
    expect(clip(undone, CLIP_1).name).toBe(clip(canvas, CLIP_1).name);
    expect(previewNode(undone, PREVIEW_1)!.id).toBe(PREVIEW_1);

    const redone = applyPlan(undone, plan.forward);
    expect(clip(redone, CLIP_1).name).toBe("新名称");
  });

  it("动态转静态撤销后恢复原动作、时长与循环；预览身份保持", () => {
    const canvas = withFilmSet();
    const before = clip(canvas, CLIP_1);
    expect(before.kind).toBe("dynamic");
    const plan = planOrThrow(canvas, [clipPatch(canvas, { kind: "set-kind", toKind: "static", confirmClearContent: true })]);

    const converted = applyPlan(canvas, plan.forward);
    const staticClipAfter = clip(converted, CLIP_1);
    expect(staticClipAfter.kind).toBe("static");
    expect(staticClipAfter.timeline).toEqual({ duration: 0, loop: false });
    expect(staticClipAfter.cameraMotion.motionScript).toBe("");
    expect(staticClipAfter.bindings.every((binding) => binding.playback.duration === 0 && !binding.motion)).toBe(true);
    expect(previewNode(converted, PREVIEW_1)!.id).toBe(PREVIEW_1);

    const undone = applyPlan(converted, plan.inverse);
    const restored = clip(undone, CLIP_1);
    expect(restored.kind).toBe("dynamic");
    expect(restored.timeline).toEqual(before.timeline);
    expect(restored.cameraMotion.motionScript).toBe(before.cameraMotion.motionScript);
    expect(restored.bindings).toEqual(before.bindings);
    expect(previewNode(undone, PREVIEW_1)!.id).toBe(PREVIEW_1);
  });
});

describe("删除镜头的撤销恢复预览布局（任务 2.5）", () => {
  it("撤销删除镜头恢复原预览 ID、位置与尺寸", () => {
    const base = withFilmSet();
    const created = applyPlan(base, planOrThrow(base, [clipPatch(base, { kind: "create", clip: staticClip(CLIP_2, "静态镜头") }, CLIP_2)]).forward);
    // 单独移动预览，形成非初始自定义布局。
    const moved = expectOk(apply(created, [{ type: "node.update", nodeId: PREVIEW_2, position: { x: 700, y: 520 }, width: 260, height: 200 }]));
    const beforeDelete = previewNode(moved, PREVIEW_2)!;

    const plan = planOrThrow(moved, [clipPatch(moved, { kind: "delete" }, CLIP_2)]);
    const deleted = applyPlan(moved, plan.forward);
    expect(filmSetAnimationsOf(animation(deleted)).clips.some((entry) => entry.id === CLIP_2)).toBe(false);
    expect(previewNode(deleted, PREVIEW_2)).toBeUndefined();
    expect(deleted.nodeData[PREVIEW_2]).toBeUndefined();

    const undone = applyPlan(deleted, plan.inverse);
    const restored = previewNode(undone, PREVIEW_2);
    expect(restored).toBeDefined();
    expect(restored!.position).toEqual(beforeDelete.position);
    expect(restored!.width).toBe(beforeDelete.width);
    expect(restored!.height).toBe(beforeDelete.height);
    expect(clip(undone, CLIP_2).name).toBe("静态镜头");
  });

  it("创建镜头撤销后清理预览，重做得到同一落点", () => {
    const canvas = withFilmSet();
    const plan = planOrThrow(canvas, [clipPatch(canvas, { kind: "create", clip: staticClip(CLIP_2, "静态镜头") }, CLIP_2)]);
    const created = applyPlan(canvas, plan.forward);
    const layout = previewNode(created, PREVIEW_2)!;

    const undone = applyPlan(created, plan.inverse);
    expect(previewNode(undone, PREVIEW_2)).toBeUndefined();

    const redone = applyPlan(undone, plan.forward);
    expect(previewNode(redone, PREVIEW_2)!.position).toEqual(layout.position);
    expect(previewNode(redone, PREVIEW_2)!.width).toBe(layout.width);
  });
});

describe("预览布局进入受保护编辑日志（任务 2.5）", () => {
  it("单独移动预览可撤销/重做，片场不动", () => {
    const canvas = withFilmSet();
    const filmBefore = canvas.document.nodes.find((node) => node.id === "film")!;
    const plan = planOrThrow(canvas, [{ type: "node.update", nodeId: PREVIEW_1, position: { x: 620, y: 500 } }]);

    const moved = applyPlan(canvas, plan.forward);
    expect(previewNode(moved, PREVIEW_1)!.position).toEqual({ x: 620, y: 500 });
    expect(moved.document.nodes.find((node) => node.id === "film")!.position).toEqual(filmBefore.position);

    const undone = applyPlan(moved, plan.inverse);
    expect(previewNode(undone, PREVIEW_1)!.position).toEqual(previewNode(canvas, PREVIEW_1)!.position);
    expect(undone.document.nodes.find((node) => node.id === "film")!.position).toEqual(filmBefore.position);
  });
});

describe("并发前置条件原子拒绝（任务 2.5）", () => {
  it("镜头定义被并发修改时删除整批拒绝", () => {
    const canvas = withFilmSet();
    const plan = planOrThrow(canvas, [clipPatch(canvas, { kind: "delete" })]);
    const tampered = expectOk(apply(canvas, [clipPatch(canvas, { kind: "rename", name: "并发改名" })]));
    const result = apply(tampered, [{ type: "edit.apply", preconditions: plan.forward.preconditions, operations: plan.forward.operations }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("edit-precondition-failed");
    // 冲突不改动原状态：镜头与预览仍在。
    expect(clip(tampered, CLIP_1).name).toBe("并发改名");
    expect(previewNode(tampered, PREVIEW_1)).toBeDefined();
  });

  it("预览布局被并发修改时撤销整批拒绝", () => {
    const canvas = withFilmSet();
    const plan = planOrThrow(canvas, [{ type: "node.update", nodeId: PREVIEW_1, position: { x: 620, y: 500 } }]);
    const moved = applyPlan(canvas, plan.forward);
    const concurrentlyMoved = expectOk(apply(moved, [{ type: "node.update", nodeId: PREVIEW_1, position: { x: 900, y: 900 } }]));
    const result = apply(concurrentlyMoved, [{ type: "edit.apply", preconditions: plan.inverse.preconditions, operations: plan.inverse.operations }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("edit-precondition-failed");
    expect(previewNode(concurrentlyMoved, PREVIEW_1)!.position).toEqual({ x: 900, y: 900 });
  });

  it("预览归属被绕过删除时以节点数据快照条件拒绝", () => {
    const canvas = withFilmSet();
    // 受保护编辑用通用 nodeData 快照保护预览归属：预览已被删除时整批拒绝。
    const tampered = structuredClone(canvas);
    tampered.document.nodes = tampered.document.nodes.filter((node) => node.id !== PREVIEW_1);
    delete tampered.nodeData[PREVIEW_1];
    const result = apply(tampered, [
      {
        type: "edit.apply",
        preconditions: [{ kind: "node-data-equals", nodeId: PREVIEW_1, present: true, value: canvas.nodeData[PREVIEW_1] }],
        operations: [{ kind: "node-update", nodeId: PREVIEW_1, position: { x: 1, y: 1 } }]
      }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("edit-precondition-failed");
  });
});
