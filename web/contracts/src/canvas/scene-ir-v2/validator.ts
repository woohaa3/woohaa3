/**
 * Scene IR V2：全局 validator
 * （自 `scene-ir-v2.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R14）。
 *
 * 聚合局部 reader，并保留全局 ID 唯一性、先后引用与无环层级检查；返回统一规范化结果。
 * 不写规范 Y.Doc，仅运行时 DTO。
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 6.2 / design D6：删除 op 数、材质数、
 * 层级深度、累计/估算几何数量等应用侧总量拒绝；完整权威几何交给渲染端分块/渐进准备。
 */
import {
  SCENE_IR_V2_VERSION,
  V2_ANIMATION_OPS,
  V2_SHAPE_OPS,
  fail,
  isRecord,
  type SceneV2Op,
  type SceneIrV2Validation
} from "./types.js";
import { readAnimation, readMaterial, readShape } from "./reader.js";
import { somaSkeletonIdentity } from "../soma-humanoid/validation.js";
import { somaBodyJoints } from "../soma-humanoid/body-presets.js";
import { SOMA77_JOINTS } from "../soma-humanoid/skeleton.js";
import type { SceneV2GroupOp } from "./types.js";

/**
 * 标准 SOMA 骨架只允许关节 rotation 与 Hips 的 position（change:
 * 2026-11-15-add-model-script-static-poses）。姿势是独立增量，绑定身份/骨长校验不看它，
 * 但也不能用它移动非骨盆关节来改变肢长或整体位置。
 *
 * 逐个真实骨架根核验：同一模型可以包含多套 SOMA（双人摆姿）。只有该骨架精确匹配的
 * 77 个关节 ID 受此限制；前缀下的其它普通 group 仍按普通程序化 group 处理。
 */
function validateSomaPoses(groups: readonly SceneV2GroupOp[]): { ok: true } | { ok: false; code: "invalid-pose"; message: string } {
  const posed = groups.filter((group) => group.pose !== undefined);
  if (posed.length === 0) return { ok: true };
  // 候选骨架根：拥有直接子节点 `<root>.Hips`（SOMA 模板与体型预设都如此）。
  const hipsParents = new Set(groups.filter((group) => group.id.endsWith(".Hips")).map((group) => group.parent));
  for (const root of groups) {
    if (!hipsParents.has(root.id)) continue;
    const identity = somaSkeletonIdentity(groups, root.id);
    if (!identity) continue;
    const joints = new Set<string>(
      identity.bodyPreset
        ? somaBodyJoints(identity.bodyPreset).map((joint) => joint.name)
        : SOMA77_JOINTS.map((joint) => joint.name)
    );
    const prefix = `${identity.prefix}.`;
    for (const group of posed) {
      if (group.id === identity.prefix) {
        return { ok: false, code: "invalid-pose", message: `SOMA 根 ${group.id} 不能声明 pose；整体位置/朝向用实例 transform` };
      }
      if (!group.id.startsWith(prefix)) continue;
      const name = group.id.slice(prefix.length);
      // 只有精确匹配该骨架关节 ID 的 group 受 SOMA 通道限制。
      if (!joints.has(name)) continue;
      if (group.pose?.position !== undefined && name !== "Hips") {
        return { ok: false, code: "invalid-pose", message: `SOMA 关节 ${group.id} 只允许 rotation，position 仅限 Hips` };
      }
    }
  }
  return { ok: true };
}

export function validateModelSceneIrV2(input: unknown): SceneIrV2Validation {
  if (!isRecord(input)) return fail("not-object", "Scene IR 必须是对象");
  if (input.version !== SCENE_IR_V2_VERSION) {
    return fail("version-mismatch", `未知 Scene IR 版本 ${String(input.version)}`);
  }
  if (!Array.isArray(input.ops)) return fail("ops-not-array", "ops 必须是数组");

  const ops: SceneV2Op[] = [];
  const shapeIds = new Set<string>();
  const materialIds = new Set<string>();
  const parentOf = new Map<string, string | null>();

  for (let index = 0; index < input.ops.length; index += 1) {
    const raw = input.ops[index];
    if (!isRecord(raw)) return fail("unknown-op", `第 ${index} 个 op 不是对象`);
    const t = raw.t;
    if (typeof t !== "string") return fail("unknown-op", `第 ${index} 个 op 缺少类型`);

    if (t === "material") {
      const material = readMaterial(raw, index, materialIds);
      if (!material.ok) return material;
      materialIds.add(material.value.id);
      ops.push(material.value);
      continue;
    }

    if (V2_ANIMATION_OPS.has(t)) {
      const animation = readAnimation(raw, index, shapeIds);
      if (!animation.ok) return animation;
      ops.push(animation.value);
      continue;
    }

    if (!V2_SHAPE_OPS.has(t)) return fail("unknown-op", `第 ${index} 个 op 类型未知：${t}`);
    const shape = readShape(raw, index, t, shapeIds, materialIds, parentOf);
    if (!shape.ok) return shape;
    const op = shape.value;

    shapeIds.add(op.id);
    parentOf.set(op.id, op.parent);
    // 层级深度不再是应用额度；无环与 parent 先出现由下面的环检测与 readShape 保证。

    ops.push(op);
  }

  for(const op of ops){if(op.t==="mesh"&&op.skin?.jointIds.some(id=>!shapeIds.has(id)))return fail("invalid-mesh",`mesh ${op.id} 引用未知 joint`);}

  const somaPoses = validateSomaPoses(ops.filter((op): op is SceneV2GroupOp => op.t === "group"));
  if (!somaPoses.ok) return fail(somaPoses.code, somaPoses.message);

  // 父引用环检测（readShape 已保证 parent 先出现，这里再防御 future 变更）。
  for (const id of shapeIds) {
    const seen = new Set<string>([id]);
    let cursor = parentOf.get(id) ?? null;
    while (cursor !== null) {
      if (seen.has(cursor)) return fail("parent-cycle", `父子关系存在环：${id}`);
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }

  return { ok: true, scene: { version: SCENE_IR_V2_VERSION, ops } };
}
