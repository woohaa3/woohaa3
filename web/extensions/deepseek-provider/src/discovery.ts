/**
 * 从 DeepSeek 官方 `GET /models` 读取当前可调用模型。
 *
 * 官方返回的是**自描述**目录：除 id / owned_by 外还带 `name`、`context_window`、
 * `max_output_tokens`、`input_modalities`、`output_modalities`、`effort`
 * （思考档位）与 `api_capabilities`。所以模态、视觉输入与推理档位都只按响应判定，
 * 不按模型 id 猜。
 *
 * 只注册**文本输出**模型：本期 Provider 只实现 `/chat/completions`，向量、语音之类
 * 没有执行协议，注册进来只会得到一个点了就报错的面板。字段缺省时按「未声明」处理
 * （不推断视觉、不推断档位），但不会因为缺少元数据就丢掉模型——官方文档明确说
 * 某些模型可能缺省这些字段。
 */
import type { GenerationModelDefinition } from "@woohaa3/contracts";
import { DEEPSEEK_MODELS_PATH, DEEPSEEK_ORIGIN, DEEPSEEK_PROVIDER_ID } from "./shared.js";

export type DeepSeekModel = {
  /** 官方模型 id，原样提交给上游（`model` 字段）。 */
  id: string;
  /** 展示名；官方没有时回落 id。 */
  title: string;
  /** 目录声明的输入模态里含 `image` 才允许参考图。 */
  supportsVision: boolean;
  /** 目录声明的输出上限，作为 `maxTokens` 的合法上限。 */
  maxOutputTokens?: number;
  /** 思考档位；空数组表示支持但官方未列档位，undefined 表示未声明。 */
  reasoningEfforts?: readonly string[];
  /** 未指定档位时官方采用的档位。 */
  defaultReasoningEffort?: string;
};

export type DiscoveryResult =
  | { ok: true; models: DeepSeekModel[] }
  | { ok: false; message: string };

const DISCOVERY_TIMEOUT_MS = 15_000;

/** 目录里能识别成一个条目的原始形状（字段缺省是合法的）。 */
type RawModel = {
  id?: unknown;
  name?: unknown;
  max_output_tokens?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  effort?: unknown;
};

/**
 * 官方只有文本输出；`output_modalities` 缺省时仍按文本处理（那是「未声明」，不是「不支持」）。
 * 声明了非文本输出（如未来的 `audio`）的模型不注册：本期没有对应执行协议。
 */
export function isTextOutput(model: RawModel): boolean {
  const modalities = model.output_modalities;
  if (!Array.isArray(modalities)) return true;
  const values = modalities.filter((item): item is string => typeof item === "string");
  return values.length === 0 || values.includes("text");
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return values.length > 0 ? values : undefined;
}

/** 把模型列表响应映射成目录条目；同 id 只保留首次出现，顺序沿用官方返回顺序。 */
export function parseModelList(payload: unknown): DeepSeekModel[] {
  const list = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const models: DeepSeekModel[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as RawModel;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id) || !isTextOutput(item)) continue;
    seen.add(id);
    const inputs = Array.isArray(item.input_modalities) ? stringList(item.input_modalities) : undefined;
    const effort = item.effort && typeof item.effort === "object" && !Array.isArray(item.effort)
      ? (item.effort as { supported_levels?: unknown; default_level?: unknown })
      : undefined;
    const efforts = stringList(effort?.supported_levels);
    const defaultEffort = typeof effort?.default_level === "string" && effort.default_level.trim() !== ""
      ? effort.default_level.trim()
      : undefined;
    const maxOutputTokens = positiveInteger(item.max_output_tokens);
    const title = typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : id;
    models.push({
      id,
      title,
      supportsVision: inputs?.includes("image") === true,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
      ...(defaultEffort === undefined ? {} : { defaultReasoningEffort: defaultEffort })
    });
  }
  return models;
}

export function deepSeekModelDefinitions(models: readonly DeepSeekModel[]): GenerationModelDefinition[] {
  return models.map((model) => ({
    providerId: DEEPSEEK_PROVIDER_ID,
    providerModelId: model.id,
    modelType: "language" as const,
    title: model.title,
    promptRequirement: "required" as const,
    cancel: "local" as const,
    // 推理能力是目录事实：官方列了档位才算支持，缺省即未声明（消费者按不支持处理）。
    ...(model.reasoningEfforts === undefined
      ? {}
      : {
          capabilityFacts: {
            reasoning: {
              supported: true,
              ...(model.reasoningEfforts.length > 0 ? { efforts: model.reasoningEfforts } : {})
            }
          }
        })
  }));
}

/** 逐模型能力证据：官方文档明确支持 Tool Calls / 图像理解（后者按目录声明）。 */
export function deepSeekLanguageCapabilities(
  models: readonly DeepSeekModel[],
  providerModelId: string
): { tools: boolean; imageInput: boolean; streaming: boolean } | undefined {
  const model = models.find((item) => item.id === providerModelId);
  return model === undefined ? undefined : { tools: true, imageInput: model.supportsVision, streaming: true };
}

export async function discoverDeepSeekModels(options: {
  apiKey: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<DiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = `${DEEPSEEK_ORIGIN}${DEEPSEEK_MODELS_PATH}`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS)
    });
    if (!response.ok) return { ok: false, message: `读取 DeepSeek 模型目录失败（HTTP ${response.status}）` };
    const models = parseModelList(await response.json());
    if (models.length === 0) return { ok: false, message: "DeepSeek 模型目录没有可用的文本模型" };
    return { ok: true, models };
  } catch (error) {
    return { ok: false, message: `读取 DeepSeek 模型目录失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
