/**
 * Provider 内部思考档位定义。
 *
 * 上游目录只有布尔能力、或完全没有 reasoning 字段时，Provider 用这里按模型身份匹配
 * 自己的产品定义；上游返回精确档位时永远优先使用上游值。定义只覆盖厂商公开过
 * reasoning effort 的模型家族，不做“任意模型都给档位”的猜测。
 */
import { type AgentReasoningEffort } from "./conversation.js";

export type ReasoningModelDefinition = {
  /** 归一化后的模型 id（小写、去掉 provider 前缀）匹配规则。 */
  test: RegExp;
  efforts: readonly AgentReasoningEffort[];
};

export const REASONING_MODEL_DEFINITIONS: readonly ReasoningModelDefinition[] = [
  { test: /(^|[/])gpt-([5-9]|1[0-9])([.-]|$)/, efforts: ["low", "medium", "high"] },
  { test: /(^|[/])o[1-9]([.-]|$)/, efforts: ["low", "medium", "high"] },
  { test: /claude-(opus|sonnet)-([4-9]|[1-9][0-9])/, efforts: ["low", "medium", "high"] },
  { test: /gemini-(2\.5|[3-9])([.-]|$)/, efforts: ["low", "high"] },
  { test: /(^|[/])glm-([4-9]|[1-9][0-9])([.-]|$)/, efforts: ["low", "medium", "high"] },
  { test: /(^|[/])kimi-?(k[2-9]|[3-9])([.-]|$)/, efforts: ["low", "medium", "high"] },
  { test: /(^|[/])qwen-?([3-9])([.-]|$)/, efforts: ["low", "medium", "high"] },
  { test: /deepseek/, efforts: ["low", "medium", "high"] }
];

/** 归一化模型 id：去掉来源前缀与大小写差异；不改变模型本身。 */
export function normalizedReasoningModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/^[a-z0-9_-]+\//, "");
}

/** 上游没有精确档位时的 Provider 内部匹配；没有定义返回 undefined。 */
export function reasoningEffortsForModel(
  modelId: string,
  definitions: readonly ReasoningModelDefinition[] = REASONING_MODEL_DEFINITIONS
): readonly AgentReasoningEffort[] | undefined {
  const normalized = normalizedReasoningModelId(modelId);
  if (!normalized) return undefined;
  return definitions.find((definition) => definition.test.test(normalized))?.efforts;
}
