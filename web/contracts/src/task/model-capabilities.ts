/**
 * 生成模型事实能力（generation 侧）
 * （change: 2026-10-20-declare-generation-model-capabilities）。
 *
 * 这里只放**无法由 inputSchema / bindings 表达**的能力事实（本期是推理/思考）。
 * 参考媒体输入能力仍以 `CanvasTaskInputBinding` 为唯一提交契约（`catalogModelBindings`），
 * 不在此复制第二份 image/video/audio 开关，避免双真相漂移。
 *
 * 语义：字段缺省 = Provider 未声明 = 消费者按「不支持」处理；Provider MUST NOT 猜测。
 */
import { catalogModelBindings,
  type CanvasReferenceMediaKind,
  type CanvasTaskCatalogModel } from "./dto.js";

/** 推理/思考能力：`efforts` 缺省或空数组表示「支持但上游未列档位」。 */
export type GenerationModelReasoningCapability = {
  supported: boolean;
  efforts?: readonly string[];
};

export type GenerationModelCapabilityFacts = {
  reasoning?: GenerationModelReasoningCapability;
};

/** catalog 归一后的能力读取结果（消费方唯一入口）。 */
export type CanvasModelCapabilities = {
  /** 参考媒体输入能力：由 bindings 派生（不是另一份声明）。 */
  inputs: Record<CanvasReferenceMediaKind, boolean>;
  reasoning?: GenerationModelReasoningCapability;
};

/**
 * 校验 Provider 声明的能力事实。
 *
 * 只核对已知字段的形状；未知字段忽略（cross-process 契约只增不改）。
 * 非法形状由目录构建方整体丢弃，不影响模型可执行性。
 */
export function isGenerationModelCapabilityFacts(
  value: unknown
): value is GenerationModelCapabilityFacts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const reasoning = (value as Record<string, unknown>).reasoning;
  if (reasoning === undefined) return true;
  if (typeof reasoning !== "object" || reasoning === null || Array.isArray(reasoning)) return false;
  const record = reasoning as Record<string, unknown>;
  if (typeof record.supported !== "boolean") return false;
  const efforts = record.efforts;
  if (efforts === undefined) return true;
  return Array.isArray(efforts) && efforts.every((effort) => typeof effort === "string" && effort !== "");
}

/**
 * 从 catalog 模型派生能力读取结果。
 *
 * - `inputs` 由 bindings 派生：bindings 是提交契约，也是「是否接受某种参考媒体」的
 *   唯一事实来源；
 * - `reasoning` 取 Provider 声明的事实；缺省或非法时不出现（消费者按不支持处理）。
 */
export function canvasModelCapabilities(
  model: Pick<CanvasTaskCatalogModel, "bindings" | "capabilityFacts">
): CanvasModelCapabilities {
  const inputs: Record<CanvasReferenceMediaKind, boolean> = { image: false, video: false, audio: false };
  for (const binding of catalogModelBindings(model)) {
    for (const kind of binding.mediaKinds) inputs[kind] = true;
  }
  const facts = isGenerationModelCapabilityFacts(model.capabilityFacts) ? model.capabilityFacts : undefined;
  const declared = facts?.reasoning;
  if (!declared) return { inputs };
  const efforts = Array.isArray(declared.efforts) ? [...declared.efforts] : undefined;
  return {
    inputs,
    reasoning: {
      supported: declared.supported,
      ...(efforts && efforts.length > 0 ? { efforts } : {})
    }
  };
}
