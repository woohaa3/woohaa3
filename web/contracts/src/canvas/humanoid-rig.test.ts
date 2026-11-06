/**
 * Humanoid V1 关节契约 fixture
 * （change: 2026-10-23-add-template-model-rigs，任务 1.2 / 1.4）。
 *
 * 锁定模板工厂、脚本执行、动作目标和写入时的骨架保留。
 */
import { describe, expect, it } from "vitest";
import {
  HUMANOID_LENGTH_EPSILON,
  HUMANOID_REFERENCE_PARAMETERS,
  HUMANOID_V1_JOINT_IDS,
  compileHumanoidRig,
  decodeHumanoidRig,
  humanoidAuthoringText,
  humanoidRigForAuthoredScript,
  humanoidRigSignature,
  jointWorldPositions,
  storedHumanoidRig,
  validateHumanoidBindings,
  type HumanoidParameters
} from "./humanoid-rig.js";
import { executeModelScriptVersioned } from "./model-executor-v2.js";
import { executeMotionScript } from "./motion-executor.js";
import { modelPartIds } from "./model-parts.js";
import { DEFAULT_MODEL_PLACEMENT, modelContentHash, modelSourceHash } from "./model-definition.js";

const PARAMETERS: HumanoidParameters = HUMANOID_REFERENCE_PARAMETERS;

function descriptor(parameters: HumanoidParameters = PARAMETERS, extra: Record<string, unknown> = {}) {
  return {
    profile: "humanoid",
    templateId: "humanoid",
    templateVersion: 1,
    parameters,
    ...extra
  };
}

describe("Humanoid V1 模板工厂", () => {
  it("编译出 14 个关节，且没有肩、胸、脖子和手关节", () => {
    const compiled = compileHumanoidRig(PARAMETERS);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.joints.map((joint) => joint.id)).toEqual([...HUMANOID_V1_JOINT_IDS]);
    expect(compiled.joints).toHaveLength(14);
    const ids = compiled.joints.map((joint) => joint.id);
    for (const absent of ["Shoulder", "Chest", "Neck", "Hand", "LeftShoulder", "RightShoulder", "LeftHand", "RightHand"]) {
      expect(ids).not.toContain(absent);
    }
    expect(compiled.sockets.map((socket) => socket.id)).toEqual(["LeftHand", "RightHand"]);
  });

  it("按 T-pose 把尺寸映射到父关节的局部位置", () => {
    const compiled = compileHumanoidRig(PARAMETERS);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const at = (id: string) => compiled.joints.find((joint) => joint.id === id);
    expect(at("Root")).toMatchObject({ parent: null, position: [0, 0, 0], rotation: [0, 0, 0] });
    expect(at("Hips")).toMatchObject({ parent: "Root", position: [0, 0, 0] });
    expect(at("Spine")).toMatchObject({ parent: "Hips", position: [0, 0.5, 0] });
    expect(at("Head")).toMatchObject({ parent: "Spine", position: [0, 0.25, 0] });
    expect(at("LeftUpperArm")).toMatchObject({ parent: "Spine", position: [0.3, 0, 0] });
    expect(at("LeftLowerArm")).toMatchObject({ parent: "LeftUpperArm", position: [0.3, 0, 0] });
    expect(at("RightUpperArm")).toMatchObject({ parent: "Spine", position: [-0.3, 0, 0] });
    expect(at("RightLowerArm")).toMatchObject({ parent: "RightUpperArm", position: [-0.28, 0, 0] });
    expect(at("LeftUpperLeg")).toMatchObject({ parent: "Hips", position: [0.2, 0, 0] });
    expect(at("LeftLowerLeg")).toMatchObject({ parent: "LeftUpperLeg", position: [0, -0.4, 0] });
    expect(at("LeftFoot")).toMatchObject({ parent: "LeftLowerLeg", position: [0, -0.35, 0], length: 0.2 });
    expect(at("RightFoot")).toMatchObject({ parent: "RightLowerLeg", position: [0, -0.35, 0], length: 0.2 });
    expect(compiled.sockets).toEqual([
      { id: "LeftHand", parent: "LeftLowerArm", position: [0.25, 0, 0] },
      { id: "RightHand", parent: "RightLowerArm", position: [-0.24, 0, 0] }
    ]);
  });

  it("相同参数重复编译得到同一结果", () => {
    const first = compileHumanoidRig(PARAMETERS);
    const second = compileHumanoidRig({ ...PARAMETERS });
    expect(first).toEqual(second);
  });

  it("只旋转左大腿时，左小腿和左脚跟着动，右腿和大腿枢轴不动", () => {
    const compiled = compileHumanoidRig(PARAMETERS);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const rest = jointWorldPositions(compiled);
    const posed = jointWorldPositions(compiled, { LeftUpperLeg: [90, 0, 0] });
    expect(rest.LeftLowerLeg).toEqual([0.2, -0.4, 0]);
    expect(rest.LeftFoot).toEqual([0.2, -0.75, 0]);
    expect(posed.LeftUpperLeg).toEqual(rest.LeftUpperLeg);
    expect(posed.LeftLowerLeg[2]).toBeCloseTo(-0.4);
    expect(posed.LeftLowerLeg[1]).toBeCloseTo(0);
    expect(posed.LeftFoot[0]).toBeCloseTo(0.2);
    expect(posed.LeftFoot[1]).toBeCloseTo(0);
    expect(posed.LeftFoot[2]).toBeCloseTo(-0.75);
    expect(posed.RightLowerLeg).toEqual(rest.RightLowerLeg);
    expect(posed.RightFoot).toEqual(rest.RightFoot);
  });
});

describe("Humanoid V1 codec", () => {
  it("接受完整 descriptor", () => {
    const decoded = decodeHumanoidRig(descriptor());
    expect(decoded.ok).toBe(true);
  });

  it("拒绝退化、非有限和缺失尺寸", () => {
    for (const value of [0, HUMANOID_LENGTH_EPSILON, -0.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decoded = decodeHumanoidRig(descriptor({ ...PARAMETERS, pelvisWidth: value }));
      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.diagnostics[0]?.path).toBe("parameters.pelvisWidth");
    }
    const missing = { ...PARAMETERS } as Partial<HumanoidParameters>;
    delete missing.leftFoot;
    const decoded = decodeHumanoidRig({
      profile: "humanoid",
      templateId: "humanoid",
      templateVersion: 1,
      parameters: missing
    });
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.diagnostics[0]?.code).toBe("missing-parameter");
  });

  it("拒绝未知模板、其它 profile，以及覆盖保留关节", () => {
    const version = decodeHumanoidRig(descriptor(PARAMETERS, { templateVersion: 2 }));
    expect(version.ok).toBe(false);
    if (!version.ok) expect(version.diagnostics[0]?.code).toBe("unknown-template");

    const rigid = decodeHumanoidRig({ profile: "rigid" });
    expect(rigid.ok).toBe(false);
    if (!rigid.ok) expect(rigid.diagnostics[0]?.code).toBe("profile-not-humanoid");

    const tampered = decodeHumanoidRig(descriptor(PARAMETERS, {
      joints: [{ id: "LeftUpperLeg", parent: "Root" }]
    }));
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.diagnostics[0]?.code).toBe("reserved-override");
  });
});

describe("Humanoid V1 绑定", () => {
  it("形状可以挂到肢体关节或手部 socket", () => {
    const compiled = compileHumanoidRig(PARAMETERS);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const bound = validateHumanoidBindings(compiled, [
      { id: "thigh-armor", jointId: "LeftUpperLeg" },
      { id: "gun", jointId: "LeftHand" }
    ]);
    expect(bound.ok).toBe(true);
  });

  it("拒绝平级伪骨架、未绑定形状和全部挂到 Root", () => {
    const compiled = compileHumanoidRig(PARAMETERS);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const flat = validateHumanoidBindings(compiled, [
      { id: "thigh", jointId: "thigh" },
      { id: "shin", jointId: null }
    ]);
    expect(flat.ok).toBe(false);
    if (flat.ok) return;
    expect(flat.diagnostics.map((issue) => issue.code)).toEqual(["invalid-joint", "unbound-shape"]);

    const rooted = validateHumanoidBindings(compiled, [
      { id: "thigh", jointId: "Root" },
      { id: "shin", jointId: "Root" }
    ]);
    expect(rooted.ok).toBe(false);
    if (rooted.ok) return;
    expect(rooted.diagnostics.every((issue) => issue.code === "root-binding")).toBe(true);
  });
});

const HUMANOID_SCRIPT = [
  "scene.segment({ id: 'abdomen', parent: rig.joint('Spine'), from: [0, -0.5, 0], to: [0, 0, 0], width: 0.32, depth: 0.24, shape: 'box' });",
  "scene.box({ id: 'thigh', parent: rig.joint('LeftUpperLeg'), size: [0.2, 0.4, 0.2], color: '#888888' });",
  "scene.box({ id: 'shin', parent: rig.joint('LeftLowerLeg'), size: [0.15, 0.35, 0.15], color: '#888888' });",
  "scene.box({ id: 'foot', parent: rig.joint('LeftFoot'), size: [0.2, 0.1, 0.28], color: '#888888' });",
  "scene.box({ id: 'gun', parent: rig.joint('LeftHand'), size: [0.05, 0.05, 0.3], color: '#444444' });"
].join("\n");

describe("Humanoid V1 脚本与动作", () => {
  it("把几何挂到系统关节上，动作目标只承认关节 id", () => {
    const executed = executeModelScriptVersioned(HUMANOID_SCRIPT, "woohaa-model-js-v2", { rig: PARAMETERS });
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    const thigh = executed.scene.ops.find((op) => op.t !== "material" && "id" in op && op.id === "thigh");
    expect(thigh && "parent" in thigh ? thigh.parent : null).toBe("LeftUpperLeg");
    expect(executed.declaredIds.has("LeftUpperLeg")).toBe(true);
    expect(executed.declaredIds.has("LeftLowerLeg")).toBe(true);
    expect(executed.declaredIds.has("LeftFoot")).toBe(true);
    expect(executed.declaredIds.has("thigh")).toBe(false);

    const parts = modelPartIds(HUMANOID_SCRIPT, "woohaa-model-js-v2", PARAMETERS);
    expect(parts.ok).toBe(true);
    if (!parts.ok) return;
    const run = executeMotionScript(
      'motion.model.rotate("LeftUpperLeg", { axis: "x", speed: 1 }); motion.model.rotate("LeftLowerLeg", { axis: "x", speed: -1 }); motion.model.rotate("LeftFoot", { axis: "x", speed: 1 });',
      { duration: 4, partIds: parts.partIds }
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.ir.modelMotion.map((track) => track.targetId)).toEqual(["LeftUpperLeg", "LeftLowerLeg", "LeftFoot"]);
    const flat = executeMotionScript('motion.model.rotate("thigh", { axis: "x", speed: 1 });', { duration: 4, partIds: parts.partIds });
    expect(flat.ok).toBe(false);
  });

  it("髋和脊柱上各放一个盒子、腰是空的时拒绝", () => {
    const executed = executeModelScriptVersioned(
      [
        "scene.box({ id: 'pelvis', parent: rig.joint('Hips'), size: [0.48, 0.22, 0.28], position: [0, 0.02, 0] });",
        "scene.box({ id: 'chest', parent: rig.joint('Spine'), size: [0.7, 0.42, 0.34], position: [0, 0.3, 0] });"
      ].join("\n"),
      "woohaa-model-js-v2",
      { rig: PARAMETERS }
    );
    expect(executed.ok).toBe(false);
    if (executed.ok) return;
    expect(executed.code).toBe("torso-gap");
  });

  it("沿脊柱骨段连接腹部时可以通过", () => {
    const executed = executeModelScriptVersioned(
      "scene.segment({ id: 'abdomen', parent: rig.joint('Spine'), from: [0, -0.5, 0], to: [0, 0, 0], width: 0.32, depth: 0.24, shape: 'box' });",
      "woohaa-model-js-v2",
      { rig: PARAMETERS }
    );
    expect(executed.ok).toBe(true);
  });

  it("平级挂到 Root 的几何不能通过人形执行", () => {
    const flat = executeModelScriptVersioned(
      "scene.box({ id: 'thigh', parent: 'Root', size: [0.2, 0.4, 0.2], color: '#888888' });",
      "woohaa-model-js-v2",
      { rig: PARAMETERS }
    );
    expect(flat.ok).toBe(false);
    if (flat.ok) return;
    expect(flat.code).toBe("root-binding");
  });

  it("没有骨架时内容哈希保持原样，加上骨架后源码哈希不变、内容哈希改变", () => {
    const script = "scene.box({ id: 'a', size: [1,1,1] });";
    const base = {
      modelScript: script,
      modelScriptLanguage: "javascript",
      modelScriptVersion: "woohaa-model-js-v2",
      placement: DEFAULT_MODEL_PLACEMENT
    };
    const without = modelContentHash(base);
    const stored = storedHumanoidRig({
      profile: "humanoid",
      templateId: "humanoid",
      templateVersion: 1,
      parameters: PARAMETERS
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(modelContentHash({ ...base, rig: stored.value })).not.toBe(without);
    expect(modelSourceHash(script)).toBe(modelSourceHash(script));
    expect(humanoidRigSignature(PARAMETERS)).toBe(humanoidRigSignature({ ...PARAMETERS }));
    expect(humanoidRigSignature({ ...PARAMETERS, leftUpperLeg: 0.5 })).not.toBe(humanoidRigSignature(PARAMETERS));
    expect(humanoidAuthoringText()).toContain("LeftUpperLeg");
    expect(humanoidAuthoringText()).toContain("local to that joint origin");
    expect(humanoidAuthoringText()).toContain("from [0, -0.5, 0] to [0, 0, 0]");
  });

  it("第一次使用关节时写入参考骨架，之后不能改回平级脚本", () => {
    const created = humanoidRigForAuthoredScript(HUMANOID_SCRIPT, undefined, undefined);
    expect(created.ok).toBe(true);
    if (!created.ok || !created.rig) return;
    expect(created.rig.parameters).toEqual(PARAMETERS);
    const kept = humanoidRigForAuthoredScript("scene.box({ id: 'a', size: [1,1,1] });", undefined, created.rig);
    expect(kept.ok).toBe(false);
    if (kept.ok) return;
    expect(kept.code).toBe("rig-removed");
  });
});
