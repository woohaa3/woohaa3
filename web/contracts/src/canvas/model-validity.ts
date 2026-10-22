/**
 * 自包含模型的可执行性与静态性校验
 * （change: 2026-10-06-fix-animation3d-runtime-and-authoring，任务 1.3 / design D1）。
 *
 * 权威写入边界复用一个受预算约束的版本化执行器验证：模型必须可编译、可执行、确定性且通过
 * Scene IR 校验。自包含模型只接受**静态定义**；若脚本仍声明旧动画（rotate/move/oscillate），
 * 必须显式迁移分离，不能静默丢弃动作或挂载旧动画组件。
 *
 * 本模块无副作用、不写 store：只返回稳定失败码与可读原因，由调用方决定整批拒绝。
 */
import { executeModelScriptVersioned } from "./model-executor-v2.js";
import type { SceneV2Op } from "./scene-ir-v2.js";

/** Scene IR 中表示旧动画的 op 类型（应迁移到运动脚本）。 */
const ANIMATION_OP_TYPES = new Set(["rotate", "move", "oscillate"]);

export type ModelValidityResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * 校验自包含模型脚本可执行且为静态定义。
 *
 * - 编译/执行/确定性/校验失败 → `model-script-<stage>`。
 * - 场景仍含旧动画 op → `legacy-animation-in-model`（引导显式迁移）。
 */
export function validateSelfContainedModel(modelScript: string, modelScriptVersion: unknown): ModelValidityResult {
  const execution = executeModelScriptVersioned(modelScript, modelScriptVersion);
  if (!execution.ok) {
    return { ok: false, code: `model-script-${execution.stage}:${execution.code}`, message: execution.message };
  }
  const ops = (execution.scene as { ops?: unknown }).ops;
  if (Array.isArray(ops)) {
    const animated = (ops as SceneV2Op[]).find((op) => ANIMATION_OP_TYPES.has(op.t));
    if (animated) {
      return {
        ok: false,
        code: "legacy-animation-in-model",
        message: `自包含模型不得包含旧动画声明（${animated.t}）；请迁移到运动脚本`
      };
    }
  }
  return { ok: true };
}

/** 场景 IR 是否包含旧动画 op（供迁移/诊断复用）。 */
export function sceneHasAnimationOps(ops: readonly SceneV2Op[]): boolean {
  return ops.some((op) => ANIMATION_OP_TYPES.has(op.t));
}
