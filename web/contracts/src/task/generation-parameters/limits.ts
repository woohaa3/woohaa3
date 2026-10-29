/**
 * 模型约束：**`inputSchema` 表达不了的那部分能力边界**。
 *
 * 「参考图至少 1 张」「图和视频合计不超过 30」「单个素材 ≤ 10MB」都是跨字段或跨数组的
 * 总量规则——JSON Schema 要么写不出，要么写得没人看得懂。所以单独挂在卡片上。
 *
 * 生效值一律取 `min(部署级, 模型级)`：模型只能比部署更严，不能更宽。被截断时必须能被
 * 看见（`capped`），否则用户会问「面板写的 30，为什么只让我放 16」。
 */
import type { CanvasReferenceMediaKind } from "../dto.js";
import type { GenerationModelLimits } from "../model-capabilities.js";

export type ReferenceKind = CanvasReferenceMediaKind;

/** 部署级上限：与 `CANVAS_TASK_LIMITS` / `CapabilityLimits` 同义，模型级只能更低。 */
export type DeployLimits = {
  promptMaxChars: number;
  totalReferences: number;
  maxBytesPerItem: number;
};

export type EffectiveModelLimits = {
  promptMaxChars: number;
  promptCapped: boolean;
  references: Partial<
    Record<ReferenceKind, { min: number; max: number; maxBytesPerItem: number; capped: boolean }>
  >;
  total: { min: number; max: number } | null;
  combined: readonly NonNullable<GenerationModelLimits["combined"]>[number][];
};

export function effectiveModelLimits(
  declared: GenerationModelLimits | undefined,
  deploy: DeployLimits
): EffectiveModelLimits | null {
  if (declared === undefined) return null;
  const references: EffectiveModelLimits["references"] = {};
  for (const kind of ["image", "video", "audio"] as const) {
    const limit = declared.references?.[kind];
    if (limit === undefined) continue;
    references[kind] = {
      min: limit.min,
      max: Math.min(limit.max, deploy.totalReferences),
      capped: limit.max > deploy.totalReferences,
      maxBytesPerItem: Math.min(limit.maxBytesPerItem, deploy.maxBytesPerItem)
    };
  }
  const declaredPrompt = declared.promptMaxChars ?? deploy.promptMaxChars;
  return {
    promptMaxChars: Math.min(declaredPrompt, deploy.promptMaxChars),
    promptCapped: declaredPrompt > deploy.promptMaxChars,
    references,
    total:
      declared.total === undefined
        ? null
        : {
            min: declared.total.min ?? 0,
            max: Math.min(declared.total.max, deploy.totalReferences)
          },
    combined: declared.combined ?? []
  };
}
