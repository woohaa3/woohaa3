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

/**
 * 单个素材种类的数量与体积约束。
 *
 * 放在能力事实里而不是 `inputSchema`：`maxItems` 只表达「最多几条」，表达不了
 * 「至少几条」「单个多大」，而这两条恰恰是用户最常在提交后才知道的。
 */
export type GenerationModelReferenceLimit = {
  min: number;
  max: number;
  /** 单个素材的字节上限。 */
  maxBytesPerItem: number;
};

/** `inputSchema` 表达不了的跨类合计（例如「图和视频加起来不超过 30」）。 */
export type GenerationModelCombinedReferenceLimit = {
  kinds: readonly CanvasReferenceMediaKind[];
  max: number;
  /** 人读标签，用于提示文案。 */
  label: string;
};

/**
 * 模型卡片声明的能力边界。字段缺省 = 未声明 = 前端不展示、不做本地拦截。
 *
 * 数量上限本身仍由 `bindings[].maxItems` 承载；这里出现同名字段时必须与之一致——
 * `maxItems` 是提交契约，`limits.references.max` 是展示与本地校验用的同一事实。
 * 生效值一律取 `min(部署级, 模型级)`。
 */
export type GenerationModelLimits = {
  promptMaxChars?: number;
  references?: Partial<Record<CanvasReferenceMediaKind, GenerationModelReferenceLimit>>;
  total?: { min?: number; max: number };
  combined?: readonly GenerationModelCombinedReferenceLimit[];
};

export type GenerationModelCapabilityFacts = {
  reasoning?: GenerationModelReasoningCapability;
  /**
   * 模型级能力边界。
   *
   * 只放 `inputSchema` / `bindings` 表达不了的：跨字段的总量与下限。
   */
  limits?: GenerationModelLimits;
};

/** catalog 归一后的能力读取结果（消费方唯一入口）。 */
export type CanvasModelCapabilities = {
  /** 参考媒体输入能力：由 bindings 派生（不是另一份声明）。 */
  inputs: Record<CanvasReferenceMediaKind, boolean>;
  reasoning?: GenerationModelReasoningCapability;
  /** 模型级能力边界；未声明时缺省（前端不展示任何提示）。 */
  limits?: GenerationModelLimits;
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
  const limits = normalizeLimits(facts?.limits);
  const declared = facts?.reasoning;
  const withLimits = limits === undefined ? {} : { limits };
  if (!declared) return { inputs, ...withLimits };
  const efforts = Array.isArray(declared.efforts) ? [...declared.efforts] : undefined;
  return {
    inputs,
    reasoning: {
      supported: declared.supported,
      ...(efforts && efforts.length > 0 ? { efforts } : {})
    },
    ...withLimits
  };
}

/**
 * 归一模型级约束：负数与非有限值丢弃该字段，不猜默认值；形状非法时整块丢弃。
 *
 * 与 `capabilityFacts` 现有处理一致：宁可让前端少显示一条提示，也不要按错误的数字
 * 禁用主操作。
 */
function normalizeLimits(value: unknown): GenerationModelLimits | undefined {
  const record = readObject(value);
  if (record === null) return undefined;
  const out: GenerationModelLimits = {};

  const promptMaxChars = readCount(record.promptMaxChars);
  if (promptMaxChars !== undefined) out.promptMaxChars = promptMaxChars;

  const references = readObject(record.references);
  if (references !== null) {
    const refs: Partial<Record<CanvasReferenceMediaKind, GenerationModelReferenceLimit>> = {};
    for (const kind of ["image", "video", "audio"] as const) {
      const entry = readObject(references[kind]);
      if (entry === null) continue;
      const min = readCount(entry.min);
      const max = readCount(entry.max);
      const maxBytesPerItem = readCount(entry.maxBytesPerItem);
      if (min === undefined || max === undefined || maxBytesPerItem === undefined) continue;
      if (min > max) continue;
      refs[kind] = { min, max, maxBytesPerItem };
    }
    if (Object.keys(refs).length > 0) out.references = refs;
  }

  const total = readObject(record.total);
  if (total !== null) {
    const max = readCount(total.max);
    if (max !== undefined) {
      const min = readCount(total.min);
      out.total = min === undefined ? { max } : { min, max };
    }
  }

  if (Array.isArray(record.combined)) {
    const combined: GenerationModelCombinedReferenceLimit[] = [];
    for (const entry of record.combined) {
      const item = readObject(entry);
      if (item === null) continue;
      const max = readCount(item.max);
      const label = typeof item.label === "string" && item.label !== "" ? item.label : undefined;
      const kinds = Array.isArray(item.kinds)
        ? item.kinds.filter(
            (kind): kind is CanvasReferenceMediaKind =>
              kind === "image" || kind === "video" || kind === "audio"
          )
        : [];
      if (max === undefined || label === undefined || kinds.length === 0) continue;
      combined.push({ kinds, max, label });
    }
    if (combined.length > 0) out.combined = combined;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}
