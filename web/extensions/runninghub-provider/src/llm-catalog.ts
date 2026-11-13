/**
 * RunningHub 官方文字模型目录（change: 2026-11-07-add-runninghub-llm-and-provider-temporary-hosting）。
 *
 * 文字目录与图片／视频任务目录**完全分开**：
 * - 媒体目录来自公开端点 registry（`discovery.ts`），模型身份是 `api/<endpoint>`；
 * - 文字目录来自官方 OpenAI 兼容服务的 `/v1/models`（公开只读），身份是 `llm/<原始模型 ID>`。
 *
 * 目录只发布有证据的能力：`capabilities.chat` 为真才进入目录，工具／视觉／流式逐模型读取，
 * 缺少证据时按不支持处理。刷新失败不会清空已发布目录；完整成功后才原子替换。
 */
import { isAgentReasoningEffort, reasoningEffortsForModel, type AgentReasoningEffort, type GenerationModelDefinition } from "@woohaa3/contracts";
import fixture from "../data/llm-models.json";
import { RUNNINGHUB_PROVIDER_ID } from "./shared/identity.js";

/** 文字模型独立端点（与媒体任务 API 不同域）；由扩展声明给服务来源投影。 */
export const RUNNINGHUB_LLM_BASE_URL = "https://llm.runninghub.ai/v1";
/** 官方文字目录；公开只读，不需要 Key。 */
export const RUNNINGHUB_LLM_CATALOG_URL = `${RUNNINGHUB_LLM_BASE_URL}/models`;

const CATALOG_TIMEOUT_MS = 15_000;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

/** 一个文字模型的原始 ID 与逐模型能力证据。 */
export type RunningHubLanguageModel = {
  /** 提供商原始模型 ID，原样提交给上游。 */
  id: string;
  contextLength?: number;
  capabilities: {
    tools: boolean;
    vision: boolean;
    streaming: boolean;
    reasoning: boolean;
    webSearch: boolean;
  };
  /** 上游返回的精确档位；布尔能力不扩展成档位。 */
  reasoningEfforts?: readonly AgentReasoningEffort[];
};

export type RunningHubLanguageCatalogResult =
  | { ok: true; models: RunningHubLanguageModel[] }
  | { ok: false; message: string };

/** catalog 身份 `llm/<id>` → 官方原始 ID。 */
export const RUNNINGHUB_LANGUAGE_MODEL_PREFIX = "llm/";

export function runningHubLanguageModelId(model: RunningHubLanguageModel): string {
  return RUNNINGHUB_LANGUAGE_MODEL_PREFIX + model.id;
}

export function findRunningHubLanguageModel(providerModelId: string): RunningHubLanguageModel | undefined {
  if (!providerModelId.startsWith(RUNNINGHUB_LANGUAGE_MODEL_PREFIX)) return undefined;
  const id = providerModelId.slice(RUNNINGHUB_LANGUAGE_MODEL_PREFIX.length);
  return languageCatalog().find(model => model.id === id);
}

/** 逐模型能力供服务来源投影使用；未收录的模型没有证据。 */
export function runningHubLanguageCapabilities(providerModelId: string) {
  const model = findRunningHubLanguageModel(providerModelId);
  return model
    ? { tools: model.capabilities.tools, imageInput: model.capabilities.vision, streaming: model.capabilities.streaming }
    : undefined;
}

export function runningHubLanguageDefinitions(models: readonly RunningHubLanguageModel[] = languageCatalog()): GenerationModelDefinition[] {
  return models.map(model => {
    const efforts = model.reasoningEfforts?.length ? model.reasoningEfforts : reasoningEffortsForModel(model.id);
    const supported = model.capabilities.reasoning || !!efforts?.length;
    return {
      providerId: RUNNINGHUB_PROVIDER_ID,
      providerModelId: runningHubLanguageModelId(model),
      modelType: "language",
      title: model.id,
      promptRequirement: "required",
      cancel: "local",
      ...(supported ? { capabilityFacts: { reasoning: { supported: true, ...(efforts?.length ? { efforts } : {}) } } } : {})
    };
  });
}

/** 原始结构校验失败即拒绝整份目录：宁可保留上一次成功快照，也不发布半份。 */
export function parseRunningHubLanguageCatalog(payload: unknown): RunningHubLanguageCatalogResult {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null;
  if (!list) return { ok: false, message: "RunningHub 文字目录缺少模型数组" };

  const models: RunningHubLanguageModel[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || seen.has(id)) continue;
    const capabilities = record.capabilities && typeof record.capabilities === "object" && !Array.isArray(record.capabilities)
      ? record.capabilities as Record<string, unknown>
      : {};
    if (capabilities.chat !== true) continue;
    // 已下线或已给迁移目标的模型不再作为文字来源：它们的稳定 id 不应继续出现在助手目录里。
    if (record.deprecated === true) continue;
    if (typeof record.redirect_to === "string" && record.redirect_to.trim() !== "") continue;
    seen.add(id);
    const contextLength = typeof record.context_length === "number" && Number.isFinite(record.context_length) && record.context_length > 0
      ? record.context_length
      : undefined;
    const rawEfforts = [capabilities.reasoning_efforts, capabilities.reasoningEfforts].find((value) => Array.isArray(value)) as unknown[] | undefined;
    const reasoningEfforts = [...new Set((rawEfforts ?? []).filter(isAgentReasoningEffort))];
    models.push({
      id,
      ...(contextLength === undefined ? {} : { contextLength }),
      capabilities: {
        tools: capabilities.tools === true,
        vision: capabilities.vision === true,
        streaming: capabilities.streaming === true,
        reasoning: capabilities.reasoning === true || capabilities.thinking === true || reasoningEfforts.length > 0,
        webSearch: capabilities.webSearch === true || capabilities.web_search !== undefined && capabilities.web_search !== null
      },
      ...(reasoningEfforts.length ? { reasoningEfforts } : {})
    });
  }
  if (models.length === 0) return { ok: false, message: "RunningHub 文字目录没有可用模型" };
  return { ok: true, models };
}

/** 进程内已发布目录：初始为脱敏 fixture，完整刷新成功后原子替换。 */
let published: RunningHubLanguageModel[] = fixtureModels();
let revision = 1;

export function languageCatalog(): readonly RunningHubLanguageModel[] {
  return published;
}

/** 目录修订参与服务来源 revision：目录变化不能因 Key 未变而保留旧模型投影。 */
export function runningHubLanguageCatalogRevision(): number {
  return revision;
}

export function setRunningHubLanguageModels(models: readonly RunningHubLanguageModel[]): void {
  published = [...models];
  revision += 1;
}

/** 测试用：回到入库 fixture。 */
export function resetRunningHubLanguageModels(): void {
  published = fixtureModels();
  revision += 1;
}

function fixtureModels(): RunningHubLanguageModel[] {
  const parsed = parseRunningHubLanguageCatalog(fixture);
  return parsed.ok ? parsed.models : [];
}

/** 显式刷新：失败时返回原因，调用方保留当前目录。 */
export async function discoverRunningHubLanguageModels(options: {
  fetchImpl?: typeof globalThis.fetch;
  url?: string;
  timeoutMs?: number;
} = {}): Promise<RunningHubLanguageCatalogResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = options.url ?? RUNNINGHUB_LLM_CATALOG_URL;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? CATALOG_TIMEOUT_MS)
    });
    if (!response.ok) return { ok: false, message: `读取 RunningHub 文字目录失败（HTTP ${response.status}）` };
    const text = await response.text();
    if (text.length > MAX_CATALOG_BYTES) return { ok: false, message: "RunningHub 文字目录超出体积上限" };
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, message: "RunningHub 文字目录不是合法 JSON" };
    }
    return parseRunningHubLanguageCatalog(payload);
  } catch (error) {
    return { ok: false, message: `无法连接 RunningHub 文字目录：${error instanceof Error ? error.message : String(error)}` };
  }
}
