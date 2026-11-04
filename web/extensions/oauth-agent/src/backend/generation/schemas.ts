/**
 * ChatGPT 生成编排：结构化输出 schema
 * （自 `generation.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R09）。
 */
import { PREFERRED_MODEL_SCRIPT_VERSION } from "@woohaa3/contracts";

/** 结构化的模型候选 schema。 */
export function modelSchema(): Record<string, unknown> {
  // OpenAI 结构化输出（response_format）要求：properties 的每个键都必须出现在 required，
  // 且 additionalProperties:false。可选字段用 `["type","null"]` 表达，读取时把 null 归一为缺省。
  return {
    type: "object",
    properties: {
      modelScript: { type: ["string", "null"], description: "完整、自包含、确定性的静态 SceneBuilder JavaScript 源码；只调镜头时填 null" },
      modelScriptVersion: { type: ["string", "null"], description: `作者 API 版本；不确定填 null（缺省 ${PREFERRED_MODEL_SCRIPT_VERSION}）` },
      cameraMutations: cameraMutationsSchema()
    },
    required: ["modelScript", "modelScriptVersion", "cameraMutations"],
    additionalProperties: false
  };
}

/** 受限镜头变更列表 schema（nullable 数组；null/空表示不改镜头）。 */
function cameraMutationsSchema(): Record<string, unknown> {
  return {
    type: ["array", "null"],
    description: "可选的受限镜头变更；不改镜头填 null 或 []",
    items: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["create", "update", "remove", "rename", "reset"] },
        id: { type: ["string", "null"] },
        name: { type: ["string", "null"] },
        azimuth: { type: ["number", "null"] },
        elevation: { type: ["number", "null"] },
        distance: { type: ["number", "null"] },
        aspect: { type: ["string", "null"] },
        focusOffset: {
          type: ["object", "null"],
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
          required: ["x", "y", "z"],
          additionalProperties: false
        }
      },
      required: ["kind", "id", "name", "azimuth", "elevation", "distance", "aspect", "focusOffset"],
      additionalProperties: false
    }
  };
}

export function cameraSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { mutations: cameraMutationsSchema() },
    required: ["mutations"],
    additionalProperties: false
  };
}
