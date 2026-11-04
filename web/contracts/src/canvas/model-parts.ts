/**
 * 模型脚本授权部件 ID 的稳定解析。
 *
 * 从已删除的片场门禁模块中抽出（change: 2026-10-11-extract-film-set-extension 的
 * `modelPartIds`）；人形骨架契约只依赖这一小块，不再依赖片场片段校验。
 */
import { executeModelScriptVersioned } from "./model-executor-v2.js";
import type { HumanoidParameters } from "./humanoid-rig.js";

/** 模型 Scene IR op 中承载稳定部件 ID 的类型（group 与实体几何）。 */
const PART_OP_TYPES = new Set(["group", "box", "cylinder", "mesh", "sphere", "capsule", "segment"]);

export type ModelPartsResult =
  | { ok: true; partIds: Set<string> }
  | { ok: false; code: string; message: string };

/**
 * 执行模型脚本，返回可被运动引用的稳定部件 ID 集合。
 *
 * 模型脚本非法时返回稳定失败。
 */
export function modelPartIds(modelScript: string, version: string, rig?: HumanoidParameters): ModelPartsResult {
  const result = executeModelScriptVersioned(modelScript, version, rig ? { rig } : undefined);
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  // 只接受作者显式声明的部件 ID：自动命名（如 box_1）不能作为运动目标。
  if ("declaredIds" in result && result.declaredIds instanceof Set) {
    return { ok: true, partIds: new Set(result.declaredIds) };
  }
  const ops = (result.scene as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) return { ok: true, partIds: new Set() };
  const partIds = new Set<string>();
  for (const op of ops as { t?: string; id?: unknown }[]) {
    if (typeof op.t === "string" && PART_OP_TYPES.has(op.t) && typeof op.id === "string") {
      partIds.add(op.id);
    }
  }
  return { ok: true, partIds };
}
