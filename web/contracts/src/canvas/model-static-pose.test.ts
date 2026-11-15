/**
 * 静态姿势作者 API、IR 规范化和有效求值测试
 * （change: 2026-11-15-add-model-script-static-poses，任务 1.3 / 1.4 / 1.5）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { serverCanvasToYDoc, yDocToServerCanvas } from "./yjs/mapping.js";
import { executeModelScriptV2, SceneBuilderV2 } from "./model-executor-v2.js";
import { validateModelSceneIrV2 } from "./scene-ir-v2.js";
import { createSomaHumanoid } from "./soma-humanoid/template.js";
import { modelGroundAnchorLocal } from "./world-animation-spatial.js";
import { somaSkeletonIdentity } from "./soma-humanoid/validation.js";
import { modelContentHash, DEFAULT_MODEL_PLACEMENT } from "./model-definition.js";
import {
  composeModelHierarchy,
  describeModelStaticPose,
  effectiveGroupTransform,
  evaluateModelPoseGeometry
} from "./model-static-pose.js";
import type { SceneV2Op } from "./scene-ir-v2.js";
import type { PoseAnimationChannels } from "./model-static-pose.js";
import type { SceneV2GroupOp } from "./scene-ir-v2.js";
import type { Transform } from "./model-transform.js";

const channelFixtures = JSON.parse(readFileSync(new URL("../../../../bevy/tests/fixtures/model-static-pose/channels.json", import.meta.url), "utf8")) as Array<{
  name: string;
  group: SceneV2GroupOp;
  animation?: PoseAnimationChannels;
  expected: Transform;
}>;

describe("shared Rust/TypeScript static pose channel vectors", () => {
  for (const vector of channelFixtures) it(vector.name, () => {
    const actual = effectiveGroupTransform(vector.group, vector.animation);
    for (const channel of ["translation", "rotation", "scale"] as const) {
      actual[channel].forEach((value, index) => expect(value).toBeCloseTo(vector.expected[channel][index]!, 6));
    }
  });
});

it("preserves pose source and independent copies through binary Yjs sync and JSON reopening", () => {
  const source = `const g=scene.group({id:'root'});scene.box({parent:g,size:[1,2,1]});scene.pose(g,{rotation:[15,0,0]});`;
  const canvas = createEmptyWoohaa3ServerCanvas("static-pose-sync", "2026-11-15T00:00:00Z");
  for (const id of ["first", "copy"]) {
    canvas.document.nodes.push({id,type:"model3d",position:{x:0,y:0}});
    canvas.nodeData[id] = {modelScript:source,modelScriptLanguage:"javascript",modelScriptVersion:"woohaa-model-js-v2",
      sharedWorldInstance:{kind:"world-instance",version:"shared-world-v1",instanceId:id,transform:{version:"shared-world-v1",position:{u:0,v:0,h:0},rotation:[0,0,0,1],scale:1}}};
  }
  const doc = serverCanvasToYDoc(canvas);
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
  const reopened = yDocToServerCanvas(replica);
  expect(reopened.ok).toBe(true);
  if (!reopened.ok) return;
  const saved = JSON.parse(JSON.stringify(reopened.canvas));
  expect(saved.nodeData.first.modelScript).toBe(source);
  expect(saved.nodeData.copy.modelScript).toBe(source);
  const first = compile(saved.nodeData.first.modelScript);
  const copy = compile(saved.nodeData.copy.modelScript);
  expect(first.ok && copy.ok).toBe(true);
  if (first.ok && copy.ok) expect(first.json).toBe(copy.json);
  saved.nodeData.copy.modelScript += `scene.pose(g,{rotation:[0,0,0]});`;
  const resetCopy = compile(saved.nodeData.copy.modelScript);
  expect(resetCopy.ok).toBe(true);
  if (resetCopy.ok) expect(resetCopy.json).not.toContain('"pose"');
  expect(saved.nodeData.first.modelScript).toBe(source);
  doc.destroy();replica.destroy();
});

function compile(source: string) {
  return executeModelScriptV2(source);
}

describe("scene.pose 作者 API", () => {
  it("records a pose on an existing group without creating ops", () => {
    const builder = new SceneBuilderV2();
    const group = builder.group({});
    builder.pose(group, { rotation: [10, 0, 0] });
    const raw = builder.raw();
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ t: "group", pose: { rotation: [10, 0, 0] } });
  });

  it("merges repeated declarations per channel instead of accumulating", () => {
    const builder = new SceneBuilderV2();
    const group = builder.group({});
    builder.pose(group, { rotation: [10, 0, 0], position: [0, 0.2, 0] });
    builder.pose(group, { rotation: [20, 0, 0] });
    expect(builder.raw()[0]).toMatchObject({ pose: { rotation: [20, 0, 0], position: [0, 0.2, 0] } });
    builder.pose(group, { rotation: [20, 0, 0] });
    expect(builder.raw()[0]).toMatchObject({ pose: { rotation: [20, 0, 0] } });
  });

  it("clears a channel with a zero vector and drops the empty pose", () => {
    const builder = new SceneBuilderV2();
    const group = builder.group({});
    builder.pose(group, { rotation: [10, 0, 0], position: [0, 0.2, 0] });
    builder.pose(group, { rotation: [0, 0, 0] });
    expect(builder.raw()[0]).toMatchObject({ pose: { position: [0, 0.2, 0] } });
    expect((builder.raw()[0] as { pose?: unknown }).pose).not.toHaveProperty("rotation");
    builder.pose(group, { position: [0, 0, 0] });
    expect((builder.raw()[0] as { pose?: unknown }).pose).toBeUndefined();
  });

  it("rejects unknown targets, non-groups, unknown fields and empty declarations", () => {
    const builder = new SceneBuilderV2();
    const group = builder.group({});
    const box = builder.box({ parent: group, size: [1, 1, 1] });
    expect(() => builder.pose("nope", { rotation: [1, 0, 0] })).toThrow(/尚未声明/);
    expect(() => builder.pose(box, { rotation: [1, 0, 0] })).toThrow(/不是 group/);
    expect(() => builder.pose(group, {})).toThrow(/至少/);
    expect(() => builder.pose(group, { rotation: [1, 0, 0], time: 1 } as never)).toThrow(/不接受字段/);
    expect(() => builder.pose(group, { rotation: [1, Number.NaN, 0] })).toThrow(/非法数值/);
    expect(() => builder.pose(group, { position: [1, 0] as never })).toThrow(/三个数字/);
    // 显式给 undefined 不是省略通道，必须按非法向量拒绝。
    expect(() => builder.pose(group, { rotation: undefined })).toThrow(/三个数字/);
    expect(() => builder.pose(group, { position: undefined })).toThrow(/三个数字/);
    expect((builder.raw()[0] as { pose?: unknown }).pose).toBeUndefined();
  });

  it("keeps old no-pose scripts byte-identical and deterministic", () => {
    const source = `const g = scene.group({ id: "root" }); scene.box({ parent: g, size: [1, 2, 3] });`;
    const first = compile(source);
    const second = compile(source);
    expect(first.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.json).toBe(second.json);
    expect(first.json).not.toContain("pose");
  });

  it("is deterministic with poses", () => {
    const source = `const g = scene.group({ id: "root" }); scene.pose(g, { rotation: [15, 0, 0] });`;
    const first = compile(source);
    const second = compile(source);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.json).toBe(second.json);
  });
});

describe("Scene IR pose 校验", () => {
  const group = (id: string, extra: Record<string, unknown> = {}) => ({
    t: "group", id, parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null, ...extra
  });

  it("rejects empty, unknown-field, non-finite and non-group poses", () => {
    const empty = validateModelSceneIrV2({ version: "woohaa-model-scene-ir-v2", ops: [group("g", { pose: {} })] });
    expect(empty.ok).toBe(false);
    const unknown = validateModelSceneIrV2({ version: "woohaa-model-scene-ir-v2", ops: [group("g", { pose: { scale: [1, 1, 1] } })] });
    expect(unknown.ok).toBe(false);
    const nonFinite = validateModelSceneIrV2({ version: "woohaa-model-scene-ir-v2", ops: [group("g", { pose: { rotation: [Number.POSITIVE_INFINITY, 0, 0] } })] });
    expect(nonFinite.ok).toBe(false);
    const box = validateModelSceneIrV2({
      version: "woohaa-model-scene-ir-v2",
      ops: [{ t: "box", id: "b", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#ffffff", size: [1, 1, 1], pose: { rotation: [1, 0, 0] } }]
    });
    expect(box.ok).toBe(false);
    if (!box.ok) expect(box.code).toBe("invalid-pose");
  });

  it("normalizes zero channels away", () => {
    const result = validateModelSceneIrV2({ version: "woohaa-model-scene-ir-v2", ops: [group("g", { pose: { rotation: [0, 0, 0] } })] });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.scene.ops[0] as { pose?: unknown }).pose).toBeUndefined();
  });

  it("rejects SOMA position on non-Hips joints and any pose on the SOMA root", () => {
    const builder = new SceneBuilderV2();
    const actor = createSomaHumanoid(builder, { id: "actor", style: "humanoid" });
    builder.pose(actor.joint("Hips"), { position: [0, -0.2, 0], rotation: [5, 0, 0] });
    builder.pose(actor.joint("Spine1"), { rotation: [15, 0, 0] });
    const valid = validateModelSceneIrV2({ version: "woohaa-model-scene-ir-v2", ops: builder.raw() as SceneV2Op[] });
    expect(valid.ok).toBe(true);

    const illegal = new SceneBuilderV2();
    const other = createSomaHumanoid(illegal, { id: "actor", style: "humanoid" });
    illegal.pose(other.joint("Spine1"), { position: [0, 0.1, 0] });
    const rejected = validateModelSceneIrV2({ version: "woohaa-model-scene-ir-v2", ops: illegal.raw() as SceneV2Op[] });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("invalid-pose");

    const rootPose = new SceneBuilderV2();
    const third = createSomaHumanoid(rootPose, { id: "actor", style: "humanoid" });
    rootPose.pose(third.root, { rotation: [0, 10, 0] });
    const rootRejected = validateModelSceneIrV2({ version: "woohaa-model-scene-ir-v2", ops: rootPose.raw() as SceneV2Op[] });
    expect(rootRejected.ok).toBe(false);
  });

  it("validates every SOMA skeleton root instead of only the first match", () => {
    const builder = new SceneBuilderV2();
    const first = createSomaHumanoid(builder, { id: "a", style: "humanoid" });
    const second = createSomaHumanoid(builder, { id: "b", style: "humanoid" });
    builder.pose(first.joint("Hips"), { position: [0, -0.1, 0] });
    builder.pose(second.joint("Spine1"), { position: [0, 0.1, 0] });
    const rejected = validateModelSceneIrV2({ version: "woohaa-model-scene-ir-v2", ops: builder.raw() as SceneV2Op[] });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.message).toContain("b.Spine1");
  });

  it("leaves ordinary groups under a SOMA prefix on the generic pose rules", () => {
    const builder = new SceneBuilderV2();
    const actor = createSomaHumanoid(builder, { id: "actor", style: "humanoid" });
    const helper = builder.group({ id: "actor.helper", parent: actor.root });
    builder.pose(actor.joint("Spine1"), { rotation: [10, 0, 0] });
    builder.pose(helper, { position: [0, 0.2, 0], rotation: [0, 5, 0] });
    const accepted = validateModelSceneIrV2({ version: "woohaa-model-scene-ir-v2", ops: builder.raw() as SceneV2Op[] });
    expect(accepted.ok).toBe(true);
  });

  it("rejects an explicit undefined channel in imported IR", () => {
    const imported = validateModelSceneIrV2({
      version: "woohaa-model-scene-ir-v2",
      ops: [group("g", { pose: { rotation: undefined } })]
    });
    expect(imported.ok).toBe(false);
  });
});

describe("有效姿势求值", () => {
  it("preserves body identity and the bind membership anchor while changing actual skin bounds", () => {
    const source = 'const a = scene.somaHumanoid({id:"actor",style:"humanoid",bodyPreset:"soma-body-v2/female"});';
    const bind = compile(source), posed = compile(source + 'scene.pose(a.joint("Hips"),{position:[0,-0.2,0]}); scene.pose(a.joint("LeftArm"),{rotation:[0,0,45]});');
    expect(bind.ok && posed.ok).toBe(true);
    if (!bind.ok || !posed.ok) return;
    expect(somaSkeletonIdentity(posed.scene.ops.filter(op=>op.t==='group'))).toEqual({prefix:'actor',bodyPreset:'soma-body-v2/female'});
    expect(modelGroundAnchorLocal(posed.scene.ops,null)).toEqual(modelGroundAnchorLocal(bind.scene.ops,null));
    const before = evaluateModelPoseGeometry(bind.scene.ops), after = evaluateModelPoseGeometry(posed.scene.ops);
    expect(after.footSurface.left).toBeCloseTo(before.footSurface.left! - .2, 5);
    expect(after.aabb).not.toEqual(before.aabb);
    const restored = compile(source+'scene.pose(a.joint("Hips"),{position:[0,-.2,0]});scene.pose(a.joint("Hips"),{position:[0,0,0]});');
    if (restored.ok) expect(restored.json).toBe(bind.json);
    const hash = (modelScript:string)=>modelContentHash({modelScript,modelScriptLanguage:'javascript',modelScriptVersion:'woohaa-model-js-v2',placement:DEFAULT_MODEL_PLACEMENT});
    expect(hash(source)).not.toBe(hash(source+'scene.pose(a.joint("Hips"),{position:[0,-.2,0]});'));
    // Saved JSON and independent copies retain pose without mutating the original instance.
    const copied = validateModelSceneIrV2(JSON.parse(posed.json));
    expect(copied.ok).toBe(true);
    if(copied.ok) expect(evaluateModelPoseGeometry(copied.scene.ops)).toEqual(after);
    expect(evaluateModelPoseGeometry(bind.scene.ops)).toBe(before);
  });
  const base = { position: [1, 2, 3] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 2, 1] as [number, number, number] };

  it("multiplies binding rotation by the delta and adds parent-space translation once", () => {
    const transform = effectiveGroupTransform({ ...base, pose: { rotation: [0, 90, 0], position: [0, 0.5, 0] } });
    expect(transform.translation).toEqual([1, 2.5, 3]);
    expect(transform.scale).toEqual([1, 2, 1]);
    const twice = effectiveGroupTransform({ ...base, pose: { rotation: [0, 90, 0], position: [0, 0.5, 0] } });
    expect(twice.rotation).toEqual(transform.rotation);
  });

  it("lets explicit animation channels override static channels, including zero values", () => {
    const pose = { rotation: [30, 0, 0] as [number, number, number], position: [0, -0.2, 0] as [number, number, number] };
    const overridden = effectiveGroupTransform({ ...base, pose }, { rotation: [0, 0, 0], position: [0, 0, 0] });
    expect(overridden.translation).toEqual([1, 2, 3]);
    expect(overridden.rotation).toEqual(effectiveGroupTransform(base).rotation);
    const partial = effectiveGroupTransform({ ...base, pose }, { rotation: [0, 0, 0] });
    expect(partial.translation).toEqual([1, 1.8, 3]);
    expect(composeModelHierarchy([
      { t: "group", id: "root", parent: null, ...base, material: null, color: null },
      { t: "group", id: "child", parent: "root", position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null, pose: { rotation: [0, 90, 0] } }
    ]).get("child")!.translation).toEqual([1, 4, 3]);
  });

  it("derives geometry from the posed hierarchy, not from the bind AABB", () => {
    const ops: SceneV2Op[] = [
      { t: "group", id: "root", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null },
      { t: "group", id: "arm", parent: "root", position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null, pose: { position: [0, -0.5, 0] } },
      { t: "box", id: "hand", parent: "arm", position: [0, 0.1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null, size: [0.2, 0.2, 0.2] }
    ];
    const poseFree = evaluateModelPoseGeometry(ops.map((op) => op.t === "group" ? { ...op, pose: undefined } : op));
    const posed = evaluateModelPoseGeometry(ops);
    expect(poseFree.aabb!.min[1]).toBeCloseTo(1, 5);
    expect(posed.aabb!.min[1]).toBeCloseTo(0.5, 5);
    expect(posed.footSurface.classification).toBe("unknown");
    expect(posed.verification).toBe("sampled-data-only");
    expect(describeModelStaticPose(ops).affectedJoints).toEqual(["arm"]);
  });

  it("deforms skinned vertices with posed joint transforms", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const ops: SceneV2Op[] = [
      { t: "group", id: "root", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null },
      { t: "group", id: "root.Hips", parent: "root", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null, pose: { position: [0, -0.5, 0] } },
      { t: "group", id: "root.LeftFoot", parent: "root.Hips", position: [0, 0.2, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null },
      {
        t: "mesh", id: "skin", parent: "root", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null,
        vertices: [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
        faces: [[0, 1, 2]],
        skin: {
          jointIds: ["root.Hips", "root.LeftFoot"],
          inverseBindMatrices: [identity, identity],
          indices: [[0], [1], [1]],
          weights: [[1], [1], [1]]
        }
      }
    ];
    const geometry = evaluateModelPoseGeometry(ops);
    expect(geometry.skinnedVertexCount).toBe(3);
    // Hips 下移 0.5；脚顶点按 LeftFoot 绑定（局部 0.2）随层级一起到 -0.3。
    expect(geometry.aabb!.min[1]).toBeCloseTo(-0.5, 5);
    expect(geometry.footSurface.classification).toBe("skin-weights");
    expect(geometry.footSurface.left).toBeCloseTo(-0.3, 5);
    const approximateWeights = structuredClone(ops);
    const mesh = approximateWeights[3]!;
    if (mesh.t !== "mesh" || !mesh.skin) throw new Error("skin fixture");
    mesh.skin.weights = [[0.9995], [0.9995], [0.9995]];
    // The protocol accepts this sum; CPU diagnostics must match renderer LBS without renormalizing.
    expect(evaluateModelPoseGeometry(approximateWeights).aabb!.min[1]).toBeCloseTo(-0.49975, 7);
    mesh.skin.indices = [[0, 1], [0, 1], [0, 1]];
    mesh.skin.weights = [[0.51, 0.49], [0.51, 0.49], [0.51, 0.49]];
    const weakFootWeights = evaluateModelPoseGeometry(structuredClone(approximateWeights));
    expect(weakFootWeights.footSurface.classification).toBe("unknown");
    expect(weakFootWeights.footSurface.left).toBeNull();
  });

  it("multiplies the complete inverse bind matrix instead of decomposing its rotation", () => {
    const scaleTwo = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    const ops: SceneV2Op[] = [
      { t: "group", id: "root", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null },
      { t: "group", id: "root.Hips", parent: "root", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null, pose: { position: [0, 1, 0] } },
      {
        t: "mesh", id: "skin", parent: "root", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null,
        vertices: [[0, 1, 0], [0, 0, 0], [0, 0, 0]],
        faces: [[0, 1, 2]],
        skin: { jointIds: ["root.Hips"], inverseBindMatrices: [scaleTwo], indices: [[0], [0], [0]], weights: [[1], [1], [1]] }
      }
    ];
    const geometry = evaluateModelPoseGeometry(ops);
    // inverseBind 的 2× 缩放在 LBS 中必须保留：(0,2,0) + Hips (0,1,0)。
    expect(geometry.aabb!.max[1]).toBeCloseTo(3, 5);
  });

  it("keeps segment authoring transform (center/rotation) in the posed hierarchy", () => {
    const ops: SceneV2Op[] = [
      { t: "group", id: "root", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null, pose: { rotation: [0, 90, 0] } },
      { t: "segment", id: "seg", parent: "root", position: [9, 9, 9], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null, from: [0, 0, 0], to: [1, 0, 0], width: 0.1, depth: 0.1, shape: "box", overlap: 0 }
    ];
    const world = composeModelHierarchy(ops);
    // segment 的权威中心来自 from/to 中点，而不是 op.position；祖先旋转照常传播。
    expect(world.get("seg")!.translation.map((value) => Number(value.toFixed(5)))).toEqual([0, 0, -0.5]);
    const bindWorld = composeModelHierarchy([{ ...ops[0]!, pose: undefined } as SceneV2Op, ops[1]!]);
    expect(bindWorld.get("seg")!.translation.map((value) => Number(value.toFixed(5)))).toEqual([0.5, 0, 0]);
  });
});
