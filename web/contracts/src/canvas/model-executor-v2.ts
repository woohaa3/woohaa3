import {createSomaHumanoid, type SomaHumanoidHandle} from "./soma-humanoid/template.js";
/**
 * `woohaa-model-js-v2` SceneBuilder recorder 与版本化 executor dispatch
 * （change: enhance-model-scene-authoring-api，任务 1.1 / 1.3 / 2.4）。
 *
 * V2 在 V1 之上增加：
 * - `material`：声明稳定 ID 的受控 PBR 材质，返回 material ID 供 shape 引用；
 * - `sphere` / `capsule`：原生连续 primitive；
 * - `segment`：端点式部件，保存 from/to/width/depth/shape/overlap 作者意图，
 *   不在 recorder 中展开（design D4）。
 *
 * 与 V1 一致：id 缺失时按 `<prefix>_<seq>` 生成稳定序列；数值原样记录，校验交给
 * `validateModelSceneIrV2`；同一脚本执行两次必须得到逐字节相同的规范化 Scene IR。
 * V1 与 V2 共用 `runVersionedModelScript` 的四阶段骨架（编译/执行/校验/确定性重跑）。
 */
import {
  MODEL_SCRIPT_SCENE_IR_V2_VERSION,
  MODEL_SCRIPT_V2_VERSION,
  isSupportedModelScriptVersion
} from "./model-script.js";
import {
  runVersionedModelScript,
  type ModelScriptFailure,
  type RawSceneOp
} from "./model-executor.js";
import { validateModelSceneIrV2, SCENE_IR_V2_COORD_LIMIT, type ModelSceneIrV2, type SceneV2Op } from "./scene-ir-v2.js";
import {
  compileHumanoidRig,
  HUMANOID_REFERENCE_PARAMETERS,
  humanoidMotionTargetIds,
  humanoidSceneOps,
  scriptOverridesReservedIds,
  scriptUsesHumanoidRig,
  storedHumanoidRig,
  validateHumanoidScene,
  type HumanoidParameters
} from "./humanoid-rig.js";

/** V2 recorder 记录的一个原始 op（未校验）。 */
export type RawSceneV2Op = RawSceneOp;

/** V2 SceneBuilder 版本常量。 */
export const SCENE_BUILDER_V2_VERSION = MODEL_SCRIPT_V2_VERSION;

/** V2 执行结果：成功时 `scene` 为规范化 V2 IR。 */
export type ModelScriptV2Result =
  | { ok: true; scene: ModelSceneIrV2; json: string; declaredIds: ReadonlySet<string> }
  | ModelScriptFailure;

/** executor 结果（V2-only）。 */
export type VersionedModelScriptResult = ModelScriptV2Result;

/**
 * V2 SceneBuilder recorder。
 *
 * `material()` 返回声明的 ID（脚本据此引用）；其余方法返回对象 ID。`segment()` 保留
 * 端点与作者意图，由运行时确定性求中心/朝向。
 */
export class SceneBuilderV2 {
  private readonly ops: RawSceneOp[] = [];
  private readonly explicitIds = new Set<string>();
  private sequence = 0;

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }

  private shape(t: string, options: Record<string, unknown> = {}): string {
    const explicit = asExplicitId(options.id);
    const id = explicit ?? this.nextId(t);
    if (explicit) this.explicitIds.add(id);
    const { id: _ignored, ...rest } = options;
    this.ops.push({ ...rest, t, id } as RawSceneOp);
    return id;
  }

  material(options: Record<string, unknown> = {}): string {
    const explicit = asExplicitId(options.id);
    const id = explicit ?? this.nextId("material");
    if (explicit) this.explicitIds.add(id);
    const { id: _ignored, ...rest } = options;
    this.ops.push({ ...rest, t: "material", id });
    return id;
  }

  somaHumanoid(options: Record<string, unknown> = {}): SomaHumanoidHandle {
    return createSomaHumanoid(this, options);
  }

  group(options: Record<string, unknown> = {}): string {
    return this.shape("group", options);
  }

  box(options: Record<string, unknown> = {}): string {
    return this.shape("box", options);
  }

  cylinder(options: Record<string, unknown> = {}): string {
    return this.shape("cylinder", options);
  }

  sphere(options: Record<string, unknown> = {}): string {
    return this.shape("sphere", options);
  }

  capsule(options: Record<string, unknown> = {}): string {
    return this.shape("capsule", options);
  }

  segment(options: Record<string, unknown> = {}): string {
    return this.shape("segment", options);
  }

  mesh(options: Record<string, unknown> = {}): string {
    return this.shape("mesh", options);
  }

  /**
   * 声明无时间的静态姿势（change: 2026-11-15-add-model-script-static-poses）。
   *
   * 目标是**本脚本已经声明**的 group（含 `somaHumanoid()` 生成的关节）。只记录
   * rotation/position 两个通道，按通道后写覆盖；零向量清除该通道；等价空 pose 移除。
   * 语法/目标错误直接抛错（执行阶段失败），数值与骨架能力由 validator 复检。
   */
  pose(groupId: string, options: Record<string, unknown> = {}): void {
    if (typeof groupId !== "string" || groupId.length === 0) {
      throw new Error("scene.pose 需要已声明的 group id");
    }
    const target = this.ops.find((op) => op.id === groupId);
    if (!target) throw new Error(`scene.pose 目标 ${groupId} 尚未声明`);
    if (target.t !== "group") throw new Error(`scene.pose 目标 ${groupId} 不是 group`);
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("scene.pose 选项必须是对象");
    }
    const keys = Object.keys(options);
    if (keys.length === 0) throw new Error("scene.pose 至少需要 rotation 或 position");
    for (const key of keys) {
      if (key !== "rotation" && key !== "position") throw new Error(`scene.pose 不接受字段 ${key}`);
    }
    // `{rotation: undefined}` 不是“省略通道”，而是非法向量；显式声明了就必须给三个数字。
    const pose: { rotation?: [number, number, number]; position?: [number, number, number] } =
      { ...((target.pose ?? {}) as { rotation?: [number, number, number]; position?: [number, number, number] }) };
    for (const channel of keys as Array<"rotation" | "position">) {
      const vector = readPoseVector(options[channel], channel);
      // 零向量清除该通道（恢复绑定），不保留等价零值。
      if (vector.some((value) => value !== 0)) pose[channel] = vector;
      else delete pose[channel];
    }
    if (pose.rotation || pose.position) target.pose = pose;
    else delete target.pose;
  }

  oscillate(id: string, options: Record<string, unknown> = {}): string {
    return this.animation("oscillate", id, options);
  }

  move(id: string, options: Record<string, unknown> = {}): string {
    return this.animation("move", id, options);
  }

  rotate(id: string, options: Record<string, unknown> = {}): string {
    return this.animation("rotate", id, options);
  }

  private animation(t: string, id: string, options: Record<string, unknown>): string {
    const { id: _ignored, ...rest } = options;
    this.ops.push({ ...rest, t, id });
    return id;
  }

  /** 原始 op 列表（校验前）。 */
  raw(): RawSceneOp[] {
    return [...this.ops];
  }

  /** 作者显式声明的部件 ID 集合（change: 2026-10-06，任务 1.5）。 */
  declaredIds(): ReadonlySet<string> {
    return this.explicitIds;
  }
}

/** 执行一份 `woohaa-model-js-v2` 脚本，返回校验通过的规范化 V2 Scene IR。 */
export function executeModelScriptV2(source: string): ModelScriptV2Result {
  return runVersionedModelScript(source, () => new SceneBuilderV2(), (ops) => {
    const validation = validateModelSceneIrV2({ version: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops });
    if (!validation.ok) {
      return { ok: false, code: validation.code, message: validation.message };
    }
    return { ok: true, scene: validation.scene, json: JSON.stringify(validation.scene) };
  });
}

/**
 * 按脚本版本执行（V2-only）。
 *
 * 未知/不支持版本返回稳定的 `version-mismatch` 失败（change:
 * 2026-10-07-remove-residual-compatibility —— 不再支持 V1）。
 */
export function executeModelScriptVersioned(
  source: string,
  version: unknown,
  options?: { rig?: HumanoidParameters }
): VersionedModelScriptResult {
  if (!isSupportedModelScriptVersion(version)) {
    return {
      ok: false,
      stage: "compile",
      code: "version-mismatch",
      message: `不支持的 modelScriptVersion ${String(version)}`
    };
  }
  const rig = options?.rig ?? (scriptUsesHumanoidRig(source) ? HUMANOID_REFERENCE_PARAMETERS : undefined);
  return rig ? executeHumanoidModelScript(source, rig) : executeModelScriptV2(source);
}

/** 节点上保存的 modelRig。缺失时走普通脚本；非法骨架直接失败，不退回无骨架执行。 */
export function executeModelWithStoredRig(source: string, version: unknown, modelRig: unknown): VersionedModelScriptResult {
  if (modelRig == null) return executeModelScriptVersioned(source, version);
  const stored = storedHumanoidRig(modelRig);
  if (!stored.ok) {
    const first = stored.diagnostics[0];
    return {
      ok: false,
      stage: "validate",
      code: first?.code ?? "invalid-rig",
      message: first ? `${first.path}: 期望 ${first.expected}，实际 ${first.actual}` : "骨架非法"
    };
  }
  return executeModelScriptVersioned(source, version, { rig: stored.value.parameters });
}

function executeHumanoidModelScript(source: string, parameters: HumanoidParameters): ModelScriptV2Result {
  const compiled = compileHumanoidRig(parameters);
  if (!compiled.ok) {
    const first = compiled.diagnostics[0];
    return {
      ok: false,
      stage: "validate",
      code: first?.code ?? "invalid-rig",
      message: first ? `${first.path}: 期望 ${first.expected}，实际 ${first.actual}` : "骨架参数非法"
    };
  }
  const targets = humanoidMotionTargetIds(compiled);
  const rig = {
    joint(id: string) {
      if (!targets.has(id) || id === "Root") throw new Error(`rig.joint 不可用: ${id}`);
      return id;
    }
  };
  return runVersionedModelScript(source, () => new SceneBuilderV2(), (ops) => {
    const reserved = scriptOverridesReservedIds(ops, compiled);
    if (!reserved.ok) {
      const first = reserved.diagnostics[0];
      return { ok: false, code: first?.code ?? "reserved-override", message: `脚本不能占用骨架 id ${first?.actual ?? ""}` };
    }
    const merged = [...humanoidSceneOps(compiled), ...ops];
    const binding = validateHumanoidScene(compiled, merged);
    if (!binding.ok) {
      const first = binding.diagnostics[0];
      return { ok: false, code: first?.code ?? "unbound-shape", message: first ? `${first.path}: 期望 ${first.expected}，实际 ${first.actual}` : "形状未绑定关节" };
    }
    const validation = validateModelSceneIrV2({ version: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops: merged });
    if (!validation.ok) return { ok: false, code: validation.code, message: validation.message };
    return { ok: true, scene: validation.scene, json: JSON.stringify(validation.scene) };
  }, { rig, declaredIds: targets });
}

/** 脚本版本 → 该版本 Scene IR op 类型（判别用）。 */
export type VersionedSceneV2Ops = SceneV2Op[];

function asExplicitId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 作者侧姿势向量校验：三元有限数组，绝对值受 Scene IR 坐标上限约束。
 * 与 validator 的 `readVec3` 同一正确性边界；返回副本以免后续脚本原地改写。
 */
function readPoseVector(input: unknown, field: string): [number, number, number] {
  if (!Array.isArray(input) || input.length !== 3) throw new Error(`scene.pose.${field} 必须是三个数字`);
  const values = input.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > SCENE_IR_V2_COORD_LIMIT) {
      throw new Error(`scene.pose.${field} 含非法数值`);
    }
    return value;
  });
  return [values[0]!, values[1]!, values[2]!];
}
