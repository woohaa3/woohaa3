/**
 * 从端脑云 `GET /user-center/v1/models` 读取当前可调用模型。
 *
 * 平台对图片与视频只返回 `id` / `model_type` / `created` / `owned_by`；文本模型额外带
 * 上下文长度、`supports_vision` 与 `supported_openai_params`。**模态只看 `model_type`**：
 * `language` → 文本、`picture` → 图片、`video` → 视频；`reader` / `search` 与任何未知值都不注册
 * （没有协议就不注册，也不按 id 猜测）。
 */
import { reasoningEffortsForModel, type GenerationModelDefinition } from "@woohaa3/contracts";
import { CEPHALON_MODELS_PATH, CEPHALON_ORIGIN, CEPHALON_PROVIDER_ID } from "./shared.js";

/** 本 Provider 实现了执行协议的三种模态。 */
export type CephalonModelType = "language" | "image" | "video";

export type DiscoveredModel = {
  id: string;
  modelType: CephalonModelType;
  title: string;
  /** 平台声明支持视觉输入时才为 true；缺省不支持。 */
  supportsVision?: boolean;
  /** 平台声明的输出上限，作为 `maxTokens` 的合法上限。 */
  maxOutputTokens?: number;
};

export type DiscoveryResult =
  | { ok: true; models: DiscoveredModel[] }
  | { ok: false; message: string };

const DISCOVERY_TIMEOUT_MS = 13_000;

/** 平台 `model_type` → 本 Provider 的模态。集中一处，新增类型只改这里。 */
const MODEL_TYPE_MAP: Readonly<Record<string, CephalonModelType>> = {
  language: "language",
  picture: "image",
  video: "video"
};

/** 目录内模态顺序：先文本、再图片、再视频。 */
const TYPE_ORDER: Readonly<Record<CephalonModelType, number>> = { language: 0, image: 1, video: 2 };

/** 只按平台声明判定模态；`reader` / `search` / 未知值返回 undefined（跳过）。 */
export function classifyModelType(value: unknown): CephalonModelType | undefined {
  if (typeof value !== "string") return undefined;
  return MODEL_TYPE_MAP[value.trim().toLowerCase()];
}

/** 把模型列表响应映射成目录条目。无法识别的类型被跳过，同 id 只保留首次出现。 */
export function parseModelList(payload: unknown): DiscoveredModel[] {
  const list = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as {
      id?: unknown;
      model_type?: unknown;
      supports_vision?: unknown;
      max_output_tokens?: unknown;
    };
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const modelType = id ? classifyModelType(item.model_type) : undefined;
    if (!id || !modelType || seen.has(id)) continue;
    seen.add(id);
    const supportsVision = modelType === "language" && item.supports_vision === true;
    const maxOutputTokens =
      modelType === "language" && isPositiveInteger(item.max_output_tokens) ? item.max_output_tokens : undefined;
    models.push({
      id,
      modelType,
      title: id,
      ...(supportsVision ? { supportsVision } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {})
    });
  }
  return sortModels(models);
}

/** 稳定顺序：先文本、再图片、再视频；同模态内保持平台返回顺序。 */
export function sortModels(models: readonly DiscoveredModel[]): DiscoveredModel[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort((a, b) => TYPE_ORDER[a.model.modelType] - TYPE_ORDER[b.model.modelType] || a.index - b.index)
    .map(({ model }) => model);
}

export function cephalonModelDefinitions(models: readonly DiscoveredModel[]): GenerationModelDefinition[] {
  return models.map((model) => ({
    providerId: CEPHALON_PROVIDER_ID,
    providerModelId: model.id,
    modelType: model.modelType,
    title: model.title,
    promptRequirement: "required" as const,
    // 平台没有取消端点：从模型定义就声明不支持，面板不显示无法兑现的取消。
    cancel: "unsupported" as const,
    ...(model.modelType === "language" && reasoningEffortsForModel(model.id)
      ? { capabilityFacts: { reasoning: { supported: true, efforts: reasoningEffortsForModel(model.id) } } }
      : {})
  }));
}

/** 读取平台模型列表。失败只返回稳定原因，不含凭据与响应正文。 */
export async function discoverCephalonModels(options: {
  apiKey: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<DiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = `${CEPHALON_ORIGIN}${CEPHALON_MODELS_PATH}`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS)
    });
    if (!response.ok) return { ok: false, message: `读取端脑云模型目录失败（HTTP ${response.status}）` };
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, message: "读取端脑云模型目录失败：响应不是合法 JSON" };
    }
    if (!Array.isArray((payload as { data?: unknown } | null)?.data)) {
      return { ok: false, message: "读取端脑云模型目录失败：响应缺少模型列表" };
    }
    return { ok: true, models: parseModelList(payload) };
  } catch (error) {
    return { ok: false, message: `读取端脑云模型目录失败：${safeReason(error, options.apiKey)}` };
  }
}

/**
 * 错误原因脱敏。
 *
 * fetch 抛出的错误可能带 URL 或请求头片段；这里只保留稳定分类，并把真正出现的 Key 字符串
 * 替换掉，保证诊断与日志里没有明文凭据。
 */
export function safeReason(error: unknown, apiKey?: string): string {
  const name = error instanceof Error ? error.name : "";
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = apiKey && apiKey.length > 0 ? raw.split(apiKey).join("[redacted]") : raw;
  if (name === "TimeoutError" || name === "AbortError") return "请求超时";
  const trimmed = redacted.trim();
  return trimmed === "" ? "请求失败" : trimmed.slice(0, 200);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
