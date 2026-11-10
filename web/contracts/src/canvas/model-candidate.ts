/**
 * 模型候选输出契约（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 无工具模型候选是明确的输出契约，不是「讨论」的另一种说法。schema 放在 contracts，
 * 让角色实现、执行通道与领域解码共用同一份形状。
 */
import { PREFERRED_MODEL_SCRIPT_VERSION } from "./model-script.js";

/**
 * 结构化的模型候选 schema。
 *
 * 结构化输出要求每个 properties 键都出现在 required，可选字段用 nullable 表达；
 * 读取时把 null 归一为缺省。
 */
export function modelCandidateSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      modelScript: { type: ["string", "null"], description: "完整、自包含、确定性的静态 SceneBuilder JavaScript 源码；只调镜头时填 null" },
      modelScriptVersion: { type: ["string", "null"], description: `作者 API 版本；不确定填 null（缺省 ${PREFERRED_MODEL_SCRIPT_VERSION}）` },
    },
    required: ["modelScript", "modelScriptVersion"],
    additionalProperties: false
  };
}
