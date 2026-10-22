/**
 * Scene IR V2：全局 validator
 * （自 `scene-ir-v2.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R14）。
 *
 * 聚合局部 reader，并保留全局 ID 唯一性、先后引用、层级深度/环及累计资源预算检查；返回统一
 * 规范化结果。不写规范 Y.Doc，仅运行时 DTO。
 */
import {
  SCENE_IR_V2_MAX_ESTIMATED_VERTICES,
  SCENE_IR_V2_MAX_HIERARCHY_DEPTH,
  SCENE_IR_V2_MAX_MATERIALS,
  SCENE_IR_V2_MAX_OPS,
  SCENE_IR_V2_MAX_TOTAL_MESH_FACES,
  SCENE_IR_V2_MAX_TOTAL_MESH_VERTICES,
  SCENE_IR_V2_VERSION,
  V2_ANIMATION_OPS,
  V2_SHAPE_OPS,
  estimatePrimitiveVertices,
  fail,
  isRecord,
  type SceneV2Op,
  type SceneIrV2Validation
} from "./types.js";
import { readAnimation, readMaterial, readShape } from "./reader.js";

export function validateModelSceneIrV2(input: unknown): SceneIrV2Validation {
  if (!isRecord(input)) return fail("not-object", "Scene IR 必须是对象");
  if (input.version !== SCENE_IR_V2_VERSION) {
    return fail("version-mismatch", `未知 Scene IR 版本 ${String(input.version)}`);
  }
  if (!Array.isArray(input.ops)) return fail("ops-not-array", "ops 必须是数组");
  if (input.ops.length > SCENE_IR_V2_MAX_OPS) {
    return fail("too-many-ops", `op 数量 ${input.ops.length} 超过上限 ${SCENE_IR_V2_MAX_OPS}`);
  }

  const ops: SceneV2Op[] = [];
  const shapeIds = new Set<string>();
  const materialIds = new Set<string>();
  const parentOf = new Map<string, string | null>();
  const depthOf = new Map<string, number>();
  let totalMeshVertices = 0;
  let totalMeshFaces = 0;
  let estimatedVertices = 0;

  for (let index = 0; index < input.ops.length; index += 1) {
    const raw = input.ops[index];
    if (!isRecord(raw)) return fail("unknown-op", `第 ${index} 个 op 不是对象`);
    const t = raw.t;
    if (typeof t !== "string") return fail("unknown-op", `第 ${index} 个 op 缺少类型`);

    if (t === "material") {
      const material = readMaterial(raw, index, materialIds);
      if (!material.ok) return material;
      materialIds.add(material.value.id);
      if (materialIds.size > SCENE_IR_V2_MAX_MATERIALS) {
        return fail("render-budget-exceeded", `material 数量超过上限 ${SCENE_IR_V2_MAX_MATERIALS}`);
      }
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
    const depth = op.parent === null ? 1 : (depthOf.get(op.parent) ?? 1) + 1;
    if (depth > SCENE_IR_V2_MAX_HIERARCHY_DEPTH) {
      return fail(
        "hierarchy-too-deep",
        `对象 ${op.id} 的层级深度 ${depth} 超过上限 ${SCENE_IR_V2_MAX_HIERARCHY_DEPTH}`
      );
    }
    depthOf.set(op.id, depth);

    if (op.t === "mesh") {
      totalMeshVertices += op.vertices.length;
      totalMeshFaces += op.faces.length;
      if (totalMeshVertices > SCENE_IR_V2_MAX_TOTAL_MESH_VERTICES) {
        return fail("scene-too-large", `累计 mesh 顶点数超过上限 ${SCENE_IR_V2_MAX_TOTAL_MESH_VERTICES}`);
      }
      if (totalMeshFaces > SCENE_IR_V2_MAX_TOTAL_MESH_FACES) {
        return fail("scene-too-large", `累计 mesh 面数超过上限 ${SCENE_IR_V2_MAX_TOTAL_MESH_FACES}`);
      }
    }
    if (op.t !== "group") {
      estimatedVertices += estimatePrimitiveVertices(op);
      if (estimatedVertices > SCENE_IR_V2_MAX_ESTIMATED_VERTICES) {
        return fail(
          "render-budget-exceeded",
          `估算渲染顶点 ${estimatedVertices} 超过上限 ${SCENE_IR_V2_MAX_ESTIMATED_VERTICES}`
        );
      }
    }
    ops.push(op);
  }

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
