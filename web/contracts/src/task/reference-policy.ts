/**
 * 生成任务的身份一致性参考策略（change: 2026-11-06-require-identity-reference）。
 *
 * `optional`：参考图可选，普通文生图/风景/抽象图沿用旧行为。
 * `identity-required`：任务必须带至少一张 ready 的图片参考，并在提交快照里固定
 * assetId / 来源 nodeId / slot / 顺序。缺失或失效时由面板和 Canvas Service 阻止提交。
 *
 * 策略来源只有两处：模型描述（catalog `referencePolicy`，缺省 optional）与节点设置
 * （`nodeData.referencePolicy`）。节点设置优先，因此身份敏感预设可在节点上显式切换。
 */
export const CANVAS_REFERENCE_POLICIES = ["optional", "identity-required"] as const;

export type CanvasReferencePolicy = (typeof CANVAS_REFERENCE_POLICIES)[number];

export function isCanvasReferencePolicy(value: unknown): value is CanvasReferencePolicy {
  return typeof value === "string" && (CANVAS_REFERENCE_POLICIES as readonly string[]).includes(value);
}

/** 缺省与非法值都收敛为 `optional`（旧画布/旧 catalog 不需要迁移）。 */
export function normalizeReferencePolicy(value: unknown): CanvasReferencePolicy {
  return isCanvasReferencePolicy(value) ? value : "optional";
}

/** 节点设置优先于模型声明；两者都缺省时是 optional。 */
export function effectiveReferencePolicy(
  nodePolicy: unknown,
  modelPolicy: unknown
): CanvasReferencePolicy {
  if (isCanvasReferencePolicy(nodePolicy)) return nodePolicy;
  return normalizeReferencePolicy(modelPolicy);
}

/** 提交输入里是否已有 ready 的图片参考（mediaKind 优先，旧数据按 mediaType 兜底）。 */
export function hasReadyImageReference(
  inputs: readonly { mediaKind?: unknown; mediaType?: unknown }[]
): boolean {
  return inputs.some(
    (input) =>
      input.mediaKind === "image" ||
      (typeof input.mediaType === "string" && input.mediaType.toLowerCase().startsWith("image/"))
  );
}

export const IDENTITY_REFERENCE_REQUIRED_REASON =
  "身份敏感任务需要至少一张已就绪的参考图；请先连接参考素材并等待其就绪";

export const IDENTITY_REFERENCE_INVALID_REASON =
  "身份参考已失效或被删除；请重新选择参考图后再提交";
